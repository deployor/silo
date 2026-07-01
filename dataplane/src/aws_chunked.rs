use std::{
    collections::VecDeque,
    io,
    pin::Pin,
    task::{Context, Poll},
};

use axum::http::HeaderMap;
use bytes::{Buf, Bytes, BytesMut};
use futures_util::Stream;

const MAX_CHUNK_HEADER_BYTES: usize = 4096;

type BoxByteStream = Pin<Box<dyn Stream<Item = Result<Bytes, io::Error>> + Send>>;

pub(crate) struct AwsChunkedDecoder {
    input: BoxByteStream,
    buffer: BytesMut,
    phase: Phase,
    out: VecDeque<Bytes>,
    done: bool,
}

enum Phase {
    Size,
    Data(usize),
    Crlf,
}

enum DecodeStep {
    Output(Bytes),
    NeedInput,
    Done,
}

impl AwsChunkedDecoder {
    pub(crate) fn new<S>(input: S) -> Self
    where
        S: Stream<Item = Result<Bytes, io::Error>> + Send + 'static,
    {
        Self {
            input: Box::pin(input),
            buffer: BytesMut::new(),
            phase: Phase::Size,
            out: VecDeque::new(),
            done: false,
        }
    }

    fn decode_available(&mut self) -> io::Result<DecodeStep> {
        if let Some(bytes) = self.out.pop_front() {
            return Ok(DecodeStep::Output(bytes));
        }
        if self.done {
            return Ok(DecodeStep::Done);
        }

        loop {
            match self.phase {
                Phase::Size => {
                    let Some(line_end) = find_crlf(&self.buffer) else {
                        if self.buffer.len() > MAX_CHUNK_HEADER_BYTES {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "aws-chunked header exceeded maximum size",
                            ));
                        }
                        return Ok(DecodeStep::NeedInput);
                    };
                    if line_end > MAX_CHUNK_HEADER_BYTES {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "aws-chunked header exceeded maximum size",
                        ));
                    }

                    let line = std::str::from_utf8(&self.buffer[..line_end]).map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidData, "invalid aws-chunked header")
                    })?;
                    let size_text = line.split_once(';').map(|(size, _)| size).unwrap_or(line);
                    let size = usize::from_str_radix(size_text.trim(), 16).map_err(|_| {
                        io::Error::new(io::ErrorKind::InvalidData, "invalid aws-chunked size")
                    })?;
                    self.buffer.advance(line_end + 2);

                    if size == 0 {
                        self.done = true;
                        self.buffer.clear();
                        return Ok(DecodeStep::Done);
                    }
                    self.phase = Phase::Data(size);
                }
                Phase::Data(remaining) => {
                    if self.buffer.is_empty() {
                        return Ok(DecodeStep::NeedInput);
                    }
                    let take = remaining.min(self.buffer.len());
                    let bytes = self.buffer.split_to(take).freeze();
                    if take == remaining {
                        self.phase = Phase::Crlf;
                    } else {
                        self.phase = Phase::Data(remaining - take);
                    }
                    return Ok(DecodeStep::Output(bytes));
                }
                Phase::Crlf => {
                    if self.buffer.len() < 2 {
                        return Ok(DecodeStep::NeedInput);
                    }
                    if self.buffer[0] != b'\r' || self.buffer[1] != b'\n' {
                        return Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "missing aws-chunked data terminator",
                        ));
                    }
                    self.buffer.advance(2);
                    self.phase = Phase::Size;
                }
            }
        }
    }
}

impl Stream for AwsChunkedDecoder {
    type Item = Result<Bytes, io::Error>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        loop {
            match self.decode_available() {
                Ok(DecodeStep::Output(bytes)) => return Poll::Ready(Some(Ok(bytes))),
                Ok(DecodeStep::Done) => return Poll::Ready(None),
                Ok(DecodeStep::NeedInput) => {}
                Err(error) => {
                    self.done = true;
                    return Poll::Ready(Some(Err(error)));
                }
            }

            match self.input.as_mut().poll_next(cx) {
                Poll::Ready(Some(Ok(bytes))) => {
                    self.buffer.extend_from_slice(&bytes);
                }
                Poll::Ready(Some(Err(error))) => {
                    self.done = true;
                    return Poll::Ready(Some(Err(error)));
                }
                Poll::Ready(None) => {
                    self.done = true;
                    if self.buffer.is_empty() && matches!(self.phase, Phase::Size) {
                        return Poll::Ready(None);
                    }
                    return Poll::Ready(Some(Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "incomplete aws-chunked body",
                    ))));
                }
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

pub(crate) fn is_aws_chunked(headers: &HeaderMap) -> bool {
    header_value(headers, "content-encoding")
        .is_some_and(|value| value.eq_ignore_ascii_case("aws-chunked"))
        || header_value(headers, "x-amz-content-sha256")
            .is_some_and(|value| value.starts_with("STREAMING-"))
}

pub(crate) fn decoded_content_length(headers: &HeaderMap) -> Option<u64> {
    header_value(headers, "x-amz-decoded-content-length")
        .and_then(|value| value.parse::<u64>().ok())
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.to_str().ok())
}

fn find_crlf(bytes: &BytesMut) -> Option<usize> {
    bytes.windows(2).position(|pair| pair == b"\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::{stream, TryStreamExt};

    #[tokio::test]
    async fn decodes_signed_chunk_frames() {
        let chunks = vec![
            Ok(Bytes::from_static(
                b"5;chunk-signature=abc\r\nhello\r\n6;chunk-signature=def\r\n world\r\n",
            )),
            Ok(Bytes::from_static(b"0;chunk-signature=end\r\n\r\n")),
        ];
        let decoded = AwsChunkedDecoder::new(stream::iter(chunks))
            .try_collect::<Vec<_>>()
            .await
            .unwrap()
            .concat();
        assert_eq!(decoded, b"hello world");
    }

    #[tokio::test]
    async fn rejects_incomplete_chunk() {
        let chunks = vec![Ok(Bytes::from_static(b"5\r\nabc"))];
        let result = AwsChunkedDecoder::new(stream::iter(chunks))
            .try_collect::<Vec<_>>()
            .await;
        assert!(result.is_err());
    }
}

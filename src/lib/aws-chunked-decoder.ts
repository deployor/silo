
export class AwsChunkedDecoder extends TransformStream<Uint8Array, Uint8Array> {
	private buffer: Uint8Array = new Uint8Array(0);
	private phase: "size" | "data" | "crlf" = "size";
	private chunkSize = 0;

	constructor() {
		super({
			transform: (chunk, controller) => {
				this.processChunk(chunk, controller);
			},
			flush: (controller) => {
				if (this.buffer.length > 0) {
					// Should ideally be empty if stream ended cleanly
					// But if we have leftover bytes that don't form a complete structure, we might warn or ignore
					// For now, if we are in "size" phase and buffer is empty, it's fine.
					// If we have data left, it's a truncated stream.
				}
			},
		});
	}

	private processChunk(
		chunk: Uint8Array,
		controller: TransformStreamDefaultController<Uint8Array>,
	) {
		// Append new chunk to buffer
		const newBuffer = new Uint8Array(this.buffer.length + chunk.length);
		newBuffer.set(this.buffer);
		newBuffer.set(chunk, this.buffer.length);
		this.buffer = newBuffer;

		while (true) {
			if (this.phase === "size") {
				// Look for \r\n
				const idx = this.indexOfCRLF(this.buffer);
				if (idx === -1) {
					// Need more data
					return;
				}

				// Parse line: hex-size;key=value...
				const line = new TextDecoder().decode(this.buffer.slice(0, idx));
				const semiColon = line.indexOf(";");
				const sizeStr = semiColon === -1 ? line : line.slice(0, semiColon);
				const size = parseInt(sizeStr, 16);

				if (isNaN(size)) {
					throw new Error(`Invalid chunk size: ${sizeStr}`);
				}

				this.chunkSize = size;
				this.buffer = this.buffer.slice(idx + 2); // Skip \r\n

				if (this.chunkSize === 0) {
					// End of stream
					// There might be trailers after this, but we can stop emitting data
					// We could consume the rest of the stream (trailers) if strictly needed,
					// but for PUT body, we just want the content.
					// The strict format is: 0;...\r\n\r\n
					// We are at the start of trailers.
					// We can just terminate.
					return;
				}

				this.phase = "data";
			} else if (this.phase === "data") {
				if (this.buffer.length < this.chunkSize) {
					// Need more data
					// Optimization: if we have SOME data, can we emit it?
					// Yes, but we need to track how much of the chunk we've emitted.
					// For simplicity in this implementation, we buffer the whole chunk.
					// BUT for large chunks (which can be MBs), this might be memory heavy.
					// Let's implement partial emission.
					if (this.buffer.length > 0) {
						controller.enqueue(this.buffer);
						this.chunkSize -= this.buffer.length;
						this.buffer = new Uint8Array(0);
					}
					return;
				}

				// We have enough data for the full (remaining) chunk
				const data = this.buffer.slice(0, this.chunkSize);
				controller.enqueue(data);
				this.buffer = this.buffer.slice(this.chunkSize);
				this.chunkSize = 0;
				this.phase = "crlf";
			} else if (this.phase === "crlf") {
				if (this.buffer.length < 2) {
					return;
				}
				if (this.buffer[0] !== 13 || this.buffer[1] !== 10) {
					throw new Error("Expected CRLF after chunk data");
				}
				this.buffer = this.buffer.slice(2);
				this.phase = "size";
			}
		}
	}

	private indexOfCRLF(buf: Uint8Array): number {
		for (let i = 0; i < buf.length - 1; i++) {
			if (buf[i] === 13 && buf[i + 1] === 10) {
				return i;
			}
		}
		return -1;
	}
}

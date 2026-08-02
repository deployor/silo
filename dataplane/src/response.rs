use anyhow::Result;
use axum::{
    body::Body,
    http::{HeaderMap, HeaderName, HeaderValue, Response, StatusCode},
    response::IntoResponse,
};
use futures_util::StreamExt;

use crate::AuthorizeResponse;

pub(crate) fn s3_passthrough_error(auth: AuthorizeResponse) -> Response<Body> {
    let status = StatusCode::from_u16(auth.status.unwrap_or(403)).unwrap_or(StatusCode::FORBIDDEN);
    let body = auth.body.unwrap_or_else(|| {
        r#"<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"#.into()
    });
    Response::builder()
        .status(status)
        .header("content-type", "application/xml")
        .body(Body::from(body))
        .unwrap()
}

async fn reqwest_to_axum(res: reqwest::Response) -> Result<Response<Body>> {
    let status = StatusCode::from_u16(res.status().as_u16())?;
    let mut builder = Response::builder().status(status);
    for (k, v) in res.headers() {
        if let Ok(name) = HeaderName::from_bytes(k.as_str().as_bytes()) {
            if let Ok(value) = HeaderValue::from_bytes(v.as_bytes()) {
                builder = builder.header(name, value);
            }
        }
    }
    let stream = res
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    Ok(builder.body(Body::from_stream(stream))?)
}

pub(crate) async fn reqwest_to_s3_response(
    res: reqwest::Response,
    auth: &AuthorizeResponse,
) -> Result<Response<Body>> {
    Ok(with_s3_headers(reqwest_to_axum(res).await?, auth))
}

pub(crate) fn buffered_reqwest_to_s3_response(
    status: u16,
    headers: &reqwest::header::HeaderMap,
    body: bytes::Bytes,
    auth: &AuthorizeResponse,
) -> Result<Response<Body>> {
    let mut builder = Response::builder().status(StatusCode::from_u16(status)?);
    for (key, value) in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(key.as_str().as_bytes()),
            HeaderValue::from_bytes(value.as_bytes()),
        ) {
            builder = builder.header(name, value);
        }
    }
    Ok(with_s3_headers(builder.body(Body::from(body))?, auth))
}

pub(crate) fn with_s3_headers(res: Response<Body>, auth: &AuthorizeResponse) -> Response<Body> {
    let (mut parts, body) = res.into_parts();
    let mut headers = parts.headers;

    headers.insert(
        axum::http::header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );

    if let Some(cors_headers) = &auth.cors_headers {
        for (key, value) in cors_headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(key.as_bytes()),
                HeaderValue::from_str(value),
            ) {
                headers.insert(name, value);
            }
        }
    }

    let is_object_read = matches!(auth.action.as_deref(), Some("GetObject" | "HeadObject"));
    if parts.status.is_success() && is_object_read && is_dangerous_content_type(&headers) {
        headers.insert(
            axum::http::header::CONTENT_DISPOSITION,
            HeaderValue::from_static("attachment"),
        );
        headers.insert(
            axum::http::header::CONTENT_TYPE,
            HeaderValue::from_static("application/octet-stream"),
        );
    }

    if !headers.contains_key(axum::http::header::CACHE_CONTROL) {
        let value = if auth.user.is_none() && parts.status.is_success() {
            HeaderValue::from_static("public, max-age=3600")
        } else {
            HeaderValue::from_static("private, no-cache")
        };
        headers.insert(axum::http::header::CACHE_CONTROL, value);
    }

    headers.insert(
        axum::http::header::ACCEPT_RANGES,
        HeaderValue::from_static("bytes"),
    );

    parts.headers = headers;
    Response::from_parts(parts, body)
}

fn is_dangerous_content_type(headers: &HeaderMap) -> bool {
    let Some(content_type) = headers
        .get(axum::http::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_ascii_lowercase)
    else {
        return false;
    };

    [
        "text/html",
        "application/xhtml+xml",
        "image/svg+xml",
        "text/xml",
        "application/xml",
        "text/javascript",
        "application/javascript",
        "application/ecmascript",
        "text/ecmascript",
    ]
    .iter()
    .any(|dangerous| content_type.contains(dangerous))
}

pub(crate) fn s3_error(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{}</Code><Message>{}</Message></Error>",
        xml_escape(code), xml_escape(message)
    );
    (status, [("content-type", "application/xml")], body).into_response()
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

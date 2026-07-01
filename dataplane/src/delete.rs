use std::collections::{BTreeMap, BTreeSet};

use anyhow::{anyhow, Result};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue, Method, Response, StatusCode},
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{stream, StreamExt};
use md5::{Digest, Md5};

use crate::{
    cache::{invalidate_object_caches, try_redis_object_size},
    quota::release_storage,
    response::{s3_error, with_s3_headers},
    upstream::signed_upstream_request,
    AppState, AuthBucket, AuthorizeResponse,
};

pub(crate) async fn fast_delete_objects(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response<Body>> {
    let Some(bucket) = auth.bucket.as_ref() else {
        return Ok(access_denied(&auth));
    };
    let Some(root_prefix) = auth.root_prefix.as_deref() else {
        return Ok(access_denied(&auth));
    };

    let bytes = read_body_limited(body, 10 * 1024 * 1024).await?;
    let xml = std::str::from_utf8(&bytes).map_err(|_| anyhow!("delete xml is not utf-8"))?;
    let requested_keys = parse_delete_keys(xml)?;
    for key in &requested_keys {
        ensure_no_traversal(key)?;
    }

    let existing_sizes = head_existing_sizes(&state, bucket, root_prefix, &requested_keys).await;
    let rewritten_body = rewrite_delete_request(xml, root_prefix, &requested_keys);
    let md5 = BASE64.encode(Md5::digest(rewritten_body.as_bytes()));
    let mut upstream_headers = headers.clone();
    upstream_headers.insert("content-md5", HeaderValue::from_str(&md5)?);
    upstream_headers.insert("content-type", HeaderValue::from_static("application/xml"));

    let upstream = signed_upstream_request(
        &state,
        Method::POST,
        "?delete",
        &upstream_headers,
        Some(rewritten_body.len() as u64),
    )?
    .body(rewritten_body.clone());
    let res = upstream.send().await?;
    let status = res.status();
    let response_xml = res.text().await?;
    let rewritten_response = rewrite_delete_result(&response_xml, root_prefix);

    if status.is_success() {
        let deleted_keys: BTreeSet<_> =
            successful_delete_keys(&response_xml, root_prefix, &requested_keys)
                .into_iter()
                .collect();
        let mut deleted_bytes = 0u64;
        for key in &deleted_keys {
            if let Some(size) = existing_sizes.get(key) {
                deleted_bytes = deleted_bytes.saturating_add(*size);
            }
            invalidate_object_caches(&state, bucket, key).await;
        }
        if !deleted_keys.is_empty() {
            bump_list_cache(&state, bucket).await;
        }
        if deleted_bytes > 0 {
            if let Some(user) = auth.user.as_ref() {
                let _ = release_storage(&state, &user.id, deleted_bytes).await;
            }
            commit_deleted_bytes(&state, bucket, deleted_bytes).await?;
        }
    }

    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::from_u16(status.as_u16())?)
            .header("content-type", "application/xml")
            .body(Body::from(rewritten_response))?,
        &auth,
    ))
}

async fn head_existing_sizes(
    state: &AppState,
    bucket: &AuthBucket,
    root_prefix: &str,
    keys: &[String],
) -> BTreeMap<String, u64> {
    stream::iter(keys.iter().cloned())
        .map(|key| {
            let state = state.clone();
            let bucket = bucket.clone();
            let path = format!("{root_prefix}{key}");
            async move {
                let size = cached_existing_size(&state, &bucket, &key, &path)
                    .await
                    .unwrap_or(0);
                (key, size)
            }
        })
        .buffer_unordered(32)
        .filter_map(|(key, size)| async move {
            if size > 0 {
                Some((key, size))
            } else {
                None
            }
        })
        .collect()
        .await
}

async fn cached_existing_size(
    state: &AppState,
    bucket: &AuthBucket,
    key: &str,
    path: &str,
) -> Result<u64> {
    if let Some(size) = try_redis_object_size(state, bucket, key).await {
        return Ok(size);
    }
    if let Some(size) = state.disk_cache.object_size(bucket, key).await {
        return Ok(size);
    }
    head_existing_size(state, path).await
}

async fn head_existing_size(state: &AppState, path: &str) -> Result<u64> {
    let empty = HeaderMap::new();
    let req = signed_upstream_request(state, Method::HEAD, path, &empty, None)?;
    let res = req.send().await?;
    if !res.status().is_success() {
        return Ok(0);
    }
    Ok(res
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0))
}

fn parse_delete_keys(xml: &str) -> Result<Vec<String>> {
    let keys = extract_tags(xml, "Key");
    if keys.len() > 1000 {
        return Err(anyhow!("too many delete keys"));
    }
    Ok(keys)
}

fn rewrite_delete_request(xml: &str, root_prefix: &str, keys: &[String]) -> String {
    let mut out = String::with_capacity(xml.len().saturating_add(keys.len() * root_prefix.len()));
    let mut rest = xml;
    let mut key_iter = keys.iter();
    while let Some(start) = rest.find("<Key>") {
        let value_start = start + "<Key>".len();
        out.push_str(&rest[..value_start]);
        rest = &rest[value_start..];
        let Some(end) = rest.find("</Key>") else {
            out.push_str(rest);
            return out;
        };
        let key = key_iter.next().map(String::as_str).unwrap_or("");
        out.push_str(&xml_escape(&format!("{root_prefix}{key}")));
        out.push_str("</Key>");
        rest = &rest[end + "</Key>".len()..];
    }
    out.push_str(rest);
    out
}

fn successful_delete_keys(
    response_xml: &str,
    root_prefix: &str,
    requested: &[String],
) -> Vec<String> {
    let deleted = extract_tags(response_xml, "Key")
        .into_iter()
        .filter_map(|key| key.strip_prefix(root_prefix).map(str::to_string))
        .collect::<Vec<_>>();
    if !deleted.is_empty() {
        return deleted;
    }

    let errored = extract_error_keys(response_xml, root_prefix);
    requested
        .iter()
        .filter(|key| !errored.contains(*key))
        .cloned()
        .collect()
}

fn extract_error_keys(response_xml: &str, root_prefix: &str) -> BTreeSet<String> {
    extract_blocks(response_xml, "Error")
        .into_iter()
        .flat_map(|block| extract_tags(block, "Key"))
        .filter_map(|key| key.strip_prefix(root_prefix).map(str::to_string))
        .collect()
}

fn rewrite_delete_result(xml: &str, root_prefix: &str) -> String {
    if xml.is_empty() || root_prefix.is_empty() {
        return xml.to_string();
    }
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(start) = rest.find("<Key>") {
        let value_start = start + "<Key>".len();
        out.push_str(&rest[..value_start]);
        rest = &rest[value_start..];
        let Some(end) = rest.find("</Key>") else {
            out.push_str(rest);
            return out;
        };
        let key = &rest[..end];
        out.push_str(key.strip_prefix(root_prefix).unwrap_or(key));
        out.push_str("</Key>");
        rest = &rest[end + "</Key>".len()..];
    }
    out.push_str(rest);
    out
}

async fn commit_deleted_bytes(state: &AppState, bucket: &AuthBucket, bytes: u64) -> Result<()> {
    let bytes = i64::try_from(bytes)?;
    sqlx::query(
        "UPDATE buckets SET total_bytes = GREATEST(0, total_bytes - $1) WHERE id = $2::uuid",
    )
    .bind(bytes)
    .bind(&bucket.id)
    .execute(&state.pg)
    .await?;
    Ok(())
}

async fn bump_list_cache(state: &AppState, bucket: &AuthBucket) {
    let mut conn = state.redis.clone();
    let _: redis::RedisResult<i64> = redis::cmd("INCR")
        .arg(format!("s3:listver:{}", bucket.id))
        .query_async(&mut conn)
        .await;
}

async fn read_body_limited(body: Body, limit: usize) -> Result<Bytes> {
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if out.len().saturating_add(chunk.len()) > limit {
            return Err(anyhow!("request body too large"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(out))
}

fn extract_tags(xml: &str, tag: &str) -> Vec<String> {
    extract_blocks(xml, tag)
        .into_iter()
        .map(xml_unescape)
        .collect()
}

fn extract_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let Some(open_end) = rest[start..].find('>') else {
            break;
        };
        let value_start = start + open_end + 1;
        let Some(end) = rest[value_start..].find(&close) else {
            break;
        };
        out.push(&rest[value_start..value_start + end]);
        rest = &rest[value_start + end + close.len()..];
    }
    out
}

fn ensure_no_traversal(value: &str) -> Result<()> {
    let lower = value.to_ascii_lowercase();
    if lower.contains("%2e%2e") || lower.contains("%2e.") || lower.contains(".%2e") {
        return Err(anyhow!("path traversal denied"));
    }
    let decoded = decode_repeated(value, 3);
    if decoded.split('/').any(|part| part == "..") {
        return Err(anyhow!("path traversal denied"));
    }
    Ok(())
}

fn decode_repeated(value: &str, rounds: usize) -> String {
    let mut out = value.to_string();
    for _ in 0..rounds {
        match percent_decode(&out) {
            Some(decoded) => out = decoded,
            None => break,
        }
    }
    out
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut changed = false;
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex_value(bytes[i + 1]), hex_value(bytes[i + 2])) {
                out.push((high << 4) | low);
                i += 3;
                changed = true;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    if changed {
        String::from_utf8(out).ok()
    } else {
        Some(value.to_string())
    }
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn xml_escape(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn xml_unescape(input: &str) -> String {
    input
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn access_denied(auth: &AuthorizeResponse) -> Response<Body> {
    with_s3_headers(
        s3_error(StatusCode::FORBIDDEN, "AccessDenied", "Access Denied"),
        auth,
    )
}

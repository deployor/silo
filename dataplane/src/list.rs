use anyhow::{anyhow, Result};
use axum::{
    body::Body,
    http::{HeaderMap, Method, Response, StatusCode},
};
use tracing::warn;

use crate::{
    response::{s3_error, with_s3_headers},
    upstream::signed_upstream_request,
    AppState, AuthorizeResponse,
};

pub(crate) async fn fast_list_objects(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let Some(bucket) = auth.bucket.as_ref() else {
        return Ok(s3_error(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        ));
    };
    let query = list_objects_query(&auth)?;
    let list_version = get_list_cache_version(&state, &bucket.id).await;
    let list_type = query_param_value(&query, "list-type").unwrap_or_else(|| "1".to_string());
    let cache_key = format!(
        "s3:list:{}:{}:{}:{}",
        bucket.id, list_version, list_type, query
    );

    if let Some(cached) = try_redis_string(&state, &cache_key, "list cache read failed").await {
        return Ok(with_s3_headers(
            Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/xml")
                .header("x-cache", "REDIS-HIT")
                .body(Body::from(cached))?,
            &auth,
        ));
    }

    let upstream =
        signed_upstream_request(&state, Method::GET, &format!("?{query}"), headers, None)?;
    let res = upstream.send().await?;
    let status = res.status();
    let xml = res.text().await?;
    let root_prefix = auth.root_prefix.as_deref().unwrap_or("");
    let rewritten = rewrite_list_xml_prefixes(&xml, root_prefix);

    if status == reqwest::StatusCode::OK {
        set_redis_string(
            &state,
            &cache_key,
            &rewritten,
            21_600,
            "list cache write failed",
        )
        .await;
    }

    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::from_u16(status.as_u16())?)
            .header("content-type", "application/xml")
            .body(Body::from(rewritten))?,
        &auth,
    ))
}

pub(crate) async fn fast_bucket_location(
    state: AppState,
    auth: AuthorizeResponse,
) -> Result<Response<Body>> {
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<LocationConstraint xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">{}</LocationConstraint>",
        state.cfg.s3_region
    );
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/xml")
            .body(Body::from(body))?,
        &auth,
    ))
}

fn list_objects_query(auth: &AuthorizeResponse) -> Result<String> {
    let root_prefix = auth
        .root_prefix
        .as_deref()
        .ok_or_else(|| anyhow!("missing root prefix"))?;
    let raw_query = auth
        .path_with_query
        .as_deref()
        .and_then(|path| path.split_once('?').map(|(_, query)| query))
        .unwrap_or("");
    let mut pairs = url::form_urlencoded::parse(raw_query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();

    set_list_prefix_param(&mut pairs, "prefix", root_prefix)?;
    set_list_prefix_param(&mut pairs, "start-after", root_prefix)?;
    set_list_prefix_param(&mut pairs, "marker", root_prefix)?;

    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(&key, &value);
    }
    Ok(serializer.finish())
}

fn set_list_prefix_param(
    pairs: &mut Vec<(String, String)>,
    name: &str,
    root_prefix: &str,
) -> Result<()> {
    let mut found = false;
    for (key, value) in pairs.iter_mut() {
        if key == name {
            ensure_no_traversal(value)?;
            *value = format!("{root_prefix}{value}");
            found = true;
        }
    }
    if !found && name == "prefix" {
        pairs.push((name.to_string(), root_prefix.to_string()));
    }
    Ok(())
}

fn query_param_value(query: &str, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.as_bytes()).find_map(|(key, value)| {
        if key == name {
            Some(value.into_owned())
        } else {
            None
        }
    })
}

fn rewrite_list_xml_prefixes(xml: &str, root_prefix: &str) -> String {
    if xml.is_empty() || root_prefix.is_empty() {
        return xml.to_string();
    }
    let mut rewritten = xml.to_string();
    for tag in [
        "Prefix",
        "Marker",
        "NextMarker",
        "StartAfter",
        "Key",
    ] {
        rewritten = strip_prefix_from_xml_tag(&rewritten, tag, root_prefix);
    }
    rewritten
}

fn strip_prefix_from_xml_tag(xml: &str, tag: &str, root_prefix: &str) -> String {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut out = String::with_capacity(xml.len());
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let value_start = start + open.len();
        out.push_str(&rest[..value_start]);
        rest = &rest[value_start..];
        let Some(end) = rest.find(&close) else {
            out.push_str(rest);
            return out;
        };
        let value = &rest[..end];
        out.push_str(value.strip_prefix(root_prefix).unwrap_or(value));
        out.push_str(&close);
        rest = &rest[end + close.len()..];
    }
    out.push_str(rest);
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

async fn get_list_cache_version(state: &AppState, bucket_id: &str) -> String {
    try_redis_string(
        state,
        &format!("s3:listver:{bucket_id}"),
        "list version cache read failed",
    )
    .await
    .unwrap_or_else(|| "0".to_string())
}

async fn try_redis_string(state: &AppState, key: &str, log_message: &str) -> Option<String> {
    let mut conn = state.redis.clone();
    match redis::cmd("GET").arg(key).query_async(&mut conn).await {
        Ok(value) => value,
        Err(error) => {
            warn!(error = %error, "{log_message}");
            None
        }
    }
}

async fn set_redis_string(
    state: &AppState,
    key: &str,
    value: &str,
    ttl_seconds: u64,
    log_message: &str,
) {
    let mut conn = state.redis.clone();
    let result: redis::RedisResult<()> = redis::cmd("SETEX")
        .arg(key)
        .arg(ttl_seconds)
        .arg(value)
        .query_async(&mut conn)
        .await;
    if let Err(error) = result {
        warn!(error = %error, "{log_message}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_list_prefix_traversal() {
        assert!(ensure_no_traversal("photos/2026").is_ok());
        assert!(ensure_no_traversal("../secret").is_err());
        assert!(ensure_no_traversal("%2e%2e/secret").is_err());
        assert!(ensure_no_traversal("%252e%252e/secret").is_err());
    }

    #[test]
    fn rewrites_list_xml_prefixes_without_touching_other_fields() {
        let xml = "<ListBucketResult><Prefix>users/u1/b/photos/</Prefix><Contents><Key>users/u1/b/photos/a.jpg</Key><ETag>users/u1/b/photos/not-a-key</ETag></Contents><CommonPrefixes><Prefix>users/u1/b/photos/nested/</Prefix></CommonPrefixes></ListBucketResult>";
        let rewritten = rewrite_list_xml_prefixes(xml, "users/u1/b/");
        assert!(rewritten.contains("<Prefix>photos/</Prefix>"));
        assert!(rewritten.contains("<Key>photos/a.jpg</Key>"));
        assert!(rewritten.contains("<Prefix>photos/nested/</Prefix>"));
        assert!(rewritten.contains("<ETag>users/u1/b/photos/not-a-key</ETag>"));
    }
}

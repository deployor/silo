use std::collections::BTreeMap;

use anyhow::Result;
use axum::{
    body::Body,
    http::{HeaderMap, Response, StatusCode},
};
use tracing::warn;

use crate::{
    quota::reserve_egress, response::s3_error, stats::record_egress, AppState, AuthBucket,
    AuthorizeResponse,
};

pub(crate) async fn try_redis_object_cache(
    state: &AppState,
    auth: &AuthorizeResponse,
    headers: &HeaderMap,
    bucket: &AuthBucket,
    key: &str,
) -> Result<Option<Response<Body>>> {
    let body_key = object_cache_body_key(&bucket.id, key);
    let meta_key = object_cache_meta_key(&bucket.id, key);
    let mut conn = state.redis.clone();
    let (body, meta): (Option<Vec<u8>>, Option<String>) = match redis::pipe()
        .get(body_key)
        .get(meta_key)
        .query_async(&mut conn)
        .await
    {
        Ok(hit) => hit,
        Err(error) => {
            warn!(error = %error, "object cache read failed");
            return Ok(None);
        }
    };

    let (Some(body), Some(meta)) = (body, meta) else {
        return Ok(None);
    };
    let meta_headers = serde_json::from_str::<BTreeMap<String, String>>(&meta).unwrap_or_default();

    if if_none_match_matches(headers, &meta_headers) {
        let mut builder = Response::builder().status(StatusCode::NOT_MODIFIED);
        if let Some(etag) = header_value_case_insensitive(&meta_headers, "etag") {
            builder = builder.header("etag", etag);
        }
        if let Some(last_modified) = header_value_case_insensitive(&meta_headers, "last-modified") {
            builder = builder.header("last-modified", last_modified);
        }
        return Ok(Some(builder.body(Body::empty())?));
    }

    if let Some(range_header) = headers
        .get(axum::http::header::RANGE)
        .and_then(|value| value.to_str().ok())
    {
        let total_size = body.len() as u64;
        let Some(range) = parse_range_header(range_header, total_size) else {
            return Ok(Some(
                Response::builder()
                    .status(StatusCode::RANGE_NOT_SATISFIABLE)
                    .header("content-range", format!("bytes */{total_size}"))
                    .body(Body::empty())?,
            ));
        };
        let bytes_to_send = range.end - range.start + 1;
        if let Some(user) = &auth.user {
            if reserve_egress(state, user, bytes_to_send).await.is_err() {
                return Ok(Some(s3_error(
                    StatusCode::FORBIDDEN,
                    "QuotaExceeded",
                    "You have exceeded your egress quota.",
                )));
            }
        }
        record_egress(state, auth, bytes_to_send).await;

        let sliced = body[range.start as usize..=range.end as usize].to_vec();
        let mut builder = Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("content-length", bytes_to_send.to_string())
            .header(
                "content-range",
                format!("bytes {}-{}/{total_size}", range.start, range.end),
            )
            .header("accept-ranges", "bytes")
            .header("x-cache", "REDIS-HIT");
        for (key, value) in meta_headers {
            if !header_name_eq(&key, "content-length") && !header_name_eq(&key, "content-range") {
                builder = builder.header(key, value);
            }
        }
        return Ok(Some(builder.body(Body::from(sliced))?));
    }

    if let Some(user) = &auth.user {
        if reserve_egress(state, user, body.len() as u64)
            .await
            .is_err()
        {
            return Ok(Some(s3_error(
                StatusCode::FORBIDDEN,
                "QuotaExceeded",
                "You have exceeded your egress quota.",
            )));
        }
    }
    record_egress(state, auth, body.len() as u64).await;

    let mut builder = Response::builder().status(StatusCode::OK);
    for (key, value) in meta_headers {
        builder = builder.header(key, value);
    }
    builder = builder
        .header("content-length", body.len().to_string())
        .header("accept-ranges", "bytes")
        .header("x-cache", "REDIS-HIT");
    Ok(Some(builder.body(Body::from(body))?))
}

pub(crate) async fn try_redis_object_meta(
    state: &AppState,
    bucket: &AuthBucket,
    key: &str,
) -> Result<Option<Response<Body>>> {
    let meta_key = object_cache_meta_key(&bucket.id, key);
    let mut conn = state.redis.clone();
    let meta: Option<String> = match redis::cmd("GET").arg(meta_key).query_async(&mut conn).await {
        Ok(meta) => meta,
        Err(error) => {
            warn!(error = %error, "object metadata cache read failed");
            return Ok(None);
        }
    };
    let Some(meta) = meta else {
        return Ok(None);
    };
    let headers = serde_json::from_str::<BTreeMap<String, String>>(&meta).unwrap_or_default();

    let mut builder = Response::builder().status(StatusCode::OK);
    for (key, value) in headers {
        builder = builder.header(key, value);
    }
    Ok(Some(builder.body(Body::empty())?))
}

pub(crate) async fn try_redis_object_size(
    state: &AppState,
    bucket: &AuthBucket,
    key: &str,
) -> Option<u64> {
    let meta_key = object_cache_meta_key(&bucket.id, key);
    let mut conn = state.redis.clone();
    let meta: Option<String> = redis::cmd("GET")
        .arg(meta_key)
        .query_async(&mut conn)
        .await
        .ok()?;
    let headers = serde_json::from_str::<BTreeMap<String, String>>(&meta?).ok()?;
    header_value_case_insensitive(&headers, "content-length")
        .and_then(|value| value.parse::<u64>().ok())
}

pub(crate) async fn buffer_small_get_and_cache(
    state: &AppState,
    res: reqwest::Response,
    bucket: &AuthBucket,
    key: &str,
) -> Result<Response<Body>> {
    let status = StatusCode::from_u16(res.status().as_u16())?;
    let mut headers = BTreeMap::new();
    let mut builder = Response::builder().status(status);
    for (name, value) in res.headers() {
        if let Ok(value_str) = value.to_str() {
            headers.insert(name.as_str().to_string(), value_str.to_string());
            builder = builder.header(name.as_str(), value_str);
        }
    }

    let body = res.bytes().await?;
    let body_key = object_cache_body_key(&bucket.id, key);
    let meta_key = object_cache_meta_key(&bucket.id, key);
    let mut conn = state.redis.clone();
    let cache_result: redis::RedisResult<()> = redis::pipe()
        .set_ex(meta_key, serde_json::to_string(&headers)?, 21_600)
        .set_ex(body_key, body.as_ref(), 21_600)
        .query_async(&mut conn)
        .await;
    if let Err(error) = cache_result {
        warn!(error = %error, "object cache write failed");
    }

    Ok(builder.body(Body::from(body))?)
}

pub(crate) async fn cache_object_meta(
    state: &AppState,
    bucket: &AuthBucket,
    key: &str,
    headers: &HeaderMap,
    ttl_seconds: u64,
) -> Result<()> {
    let mut meta = BTreeMap::new();
    for (name, value) in headers {
        if let Ok(value_str) = value.to_str() {
            meta.insert(name.as_str().to_string(), value_str.to_string());
        }
    }
    let mut conn = state.redis.clone();
    let cache_result: redis::RedisResult<()> = redis::cmd("SETEX")
        .arg(object_cache_meta_key(&bucket.id, key))
        .arg(ttl_seconds)
        .arg(serde_json::to_string(&meta)?)
        .query_async(&mut conn)
        .await;
    if let Err(error) = cache_result {
        warn!(error = %error, "object metadata cache write failed");
    }
    Ok(())
}

pub(crate) async fn invalidate_object_caches(state: &AppState, bucket: &AuthBucket, key: &str) {
    state.disk_cache.invalidate(&bucket.id, key).await;

    let mut conn = state.redis.clone();
    let result: redis::RedisResult<()> = redis::pipe()
        .del(object_cache_body_key(&bucket.id, key))
        .del(object_cache_meta_key(&bucket.id, key))
        .incr(format!("s3:listver:{}", bucket.id), 1)
        .query_async(&mut conn)
        .await;
    if let Err(error) = result {
        warn!(error = %error, "object cache invalidation failed");
    }
}

fn object_cache_body_key(bucket_id: &str, key: &str) -> String {
    format!("s3:body:{bucket_id}:{key}")
}

fn object_cache_meta_key(bucket_id: &str, key: &str) -> String {
    format!("s3:meta:{bucket_id}:{key}")
}

#[derive(Clone, Copy)]

struct ByteRange {
    start: u64,
    end: u64,
}

fn parse_range_header(range_header: &str, total_size: u64) -> Option<ByteRange> {
    if total_size == 0 {
        return None;
    }
    let range = range_header.strip_prefix("bytes=")?;
    if range.contains(',') {
        return None;
    }
    let (start_raw, end_raw) = range.split_once('-')?;
    if start_raw.is_empty() && end_raw.is_empty() {
        return None;
    }

    let (start, mut end) = if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<u64>().ok()?;
        if suffix_len == 0 {
            return None;
        }
        (total_size.saturating_sub(suffix_len), total_size - 1)
    } else {
        let start = start_raw.parse::<u64>().ok()?;
        let end = if end_raw.is_empty() {
            total_size - 1
        } else {
            end_raw.parse::<u64>().ok()?
        };
        (start, end)
    };

    if start >= total_size || start > end {
        return None;
    }
    end = end.min(total_size - 1);
    Some(ByteRange { start, end })
}

pub(crate) fn has_conditional_headers(headers: &HeaderMap) -> bool {
    headers.contains_key(axum::http::header::IF_MATCH)
        || headers.contains_key(axum::http::header::IF_NONE_MATCH)
        || headers.contains_key(axum::http::header::IF_MODIFIED_SINCE)
        || headers.contains_key(axum::http::header::IF_UNMODIFIED_SINCE)
}

fn if_none_match_matches(headers: &HeaderMap, meta: &BTreeMap<String, String>) -> bool {
    let Some(if_none_match) = headers
        .get(axum::http::header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    if if_none_match.trim() == "*" {
        return true;
    }
    let Some(etag) = header_value_case_insensitive(meta, "etag") else {
        return false;
    };
    let normalized_etag = normalize_etag(&etag);
    if_none_match
        .split(',')
        .map(str::trim)
        .any(|candidate| normalize_etag(candidate) == normalized_etag)
}

fn normalize_etag(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_string()
}

fn header_value_case_insensitive(headers: &BTreeMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| header_name_eq(key, name))
        .map(|(_, value)| value.clone())
}

fn header_name_eq(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_s3_byte_ranges() {
        let range = parse_range_header("bytes=10-19", 100).unwrap();
        assert_eq!((range.start, range.end), (10, 19));

        let range = parse_range_header("bytes=90-", 100).unwrap();
        assert_eq!((range.start, range.end), (90, 99));

        let range = parse_range_header("bytes=-10", 100).unwrap();
        assert_eq!((range.start, range.end), (90, 99));

        assert!(parse_range_header("bytes=100-200", 100).is_none());
        assert!(parse_range_header("bytes=20-10", 100).is_none());
        assert!(parse_range_header("bytes=0-1,3-4", 100).is_none());
    }
}

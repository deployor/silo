use std::{
    env,
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use axum::{
    body::Body,
    http::{header, HeaderMap, HeaderValue, Response, StatusCode},
};
use sha2::{Digest, Sha256};

use crate::{response::s3_error, AppState, AuthorizeResponse};

const GIB: u64 = 1024 * 1024 * 1024;

const FIXED_WINDOW_LUA: &str = r#"
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])

local current = redis.call('INCRBY', key, amount)
if current == amount then
  redis.call('EXPIRE', key, ttl)
end

if current > limit then
  local retryAfter = redis.call('TTL', key)
  if retryAfter < 1 then retryAfter = ttl end
  return retryAfter
end

return 0
"#;

#[derive(Clone, Copy)]
struct RateLimitConfig {
    enabled: bool,
    client_requests_per_minute: u64,
    user_requests_per_minute: u64,
    bucket_requests_per_minute: u64,
    user_ingress_bytes_per_minute: u64,
    bucket_ingress_bytes_per_minute: u64,
    user_egress_bytes_per_minute: u64,
    bucket_egress_bytes_per_minute: u64,
}

pub(crate) fn client_identity(headers: &HeaderMap) -> String {
    header_text(headers, "cf-connecting-ip")
        .or_else(|| header_text(headers, "x-real-ip"))
        .or_else(|| {
            header_text(headers, "x-forwarded-for").map(|value| {
                value
                    .split(',')
                    .next()
                    .unwrap_or(value.as_str())
                    .trim()
                    .to_string()
            })
        })
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

pub(crate) async fn check_client_request_rate(
    state: &AppState,
    client_id: &str,
) -> Result<Option<Response<Body>>> {
    let cfg = config();
    if !cfg.enabled || cfg.client_requests_per_minute == 0 {
        return Ok(None);
    }
    check_window(
        state,
        &window_key("client:req", client_id, 60),
        1,
        cfg.client_requests_per_minute,
        60,
        "Please reduce your request rate.",
    )
    .await
}

pub(crate) async fn check_request_rate(
    state: &AppState,
    auth: &AuthorizeResponse,
) -> Result<Option<Response<Body>>> {
    let cfg = config();
    if !cfg.enabled {
        return Ok(None);
    }

    if let Some(bucket) = auth.bucket.as_ref() {
        if let Some(res) = check_window(
            state,
            &window_key("bucket:req", &bucket.id, 60),
            1,
            cfg.bucket_requests_per_minute,
            60,
            "Please reduce your request rate for this bucket.",
        )
        .await?
        {
            return Ok(Some(res));
        }
    }

    if let Some(user) = auth.user.as_ref() {
        if let Some(res) = check_window(
            state,
            &window_key("user:req", &user.id, 60),
            1,
            cfg.user_requests_per_minute,
            60,
            "Please reduce your request rate.",
        )
        .await?
        {
            return Ok(Some(res));
        }
    }

    Ok(None)
}

pub(crate) async fn check_ingress_bytes(
    state: &AppState,
    auth: &AuthorizeResponse,
    bytes: u64,
) -> Result<Option<Response<Body>>> {
    check_transfer_bytes(
        state,
        auth,
        bytes,
        "ingress",
        config().bucket_ingress_bytes_per_minute,
        config().user_ingress_bytes_per_minute,
        "Please slow down uploads to this bucket.",
    )
    .await
}

pub(crate) async fn check_egress_bytes(
    state: &AppState,
    auth: &AuthorizeResponse,
    bytes: u64,
) -> Result<Option<Response<Body>>> {
    check_transfer_bytes(
        state,
        auth,
        bytes,
        "egress",
        config().bucket_egress_bytes_per_minute,
        config().user_egress_bytes_per_minute,
        "Please slow down downloads from this bucket.",
    )
    .await
}

async fn check_transfer_bytes(
    state: &AppState,
    auth: &AuthorizeResponse,
    bytes: u64,
    direction: &str,
    bucket_limit: u64,
    user_limit: u64,
    message: &str,
) -> Result<Option<Response<Body>>> {
    let cfg = config();
    if !cfg.enabled || bytes == 0 {
        return Ok(None);
    }

    if let Some(bucket) = auth.bucket.as_ref() {
        if let Some(res) = check_window(
            state,
            &window_key(&format!("bucket:{direction}"), &bucket.id, 60),
            bytes,
            bucket_limit,
            60,
            message,
        )
        .await?
        {
            return Ok(Some(res));
        }
    }

    if let Some(user) = auth.user.as_ref() {
        if let Some(res) = check_window(
            state,
            &window_key(&format!("user:{direction}"), &user.id, 60),
            bytes,
            user_limit,
            60,
            message,
        )
        .await?
        {
            return Ok(Some(res));
        }
    }

    Ok(None)
}

async fn check_window(
    state: &AppState,
    key: &str,
    amount: u64,
    limit: u64,
    window_seconds: u64,
    message: &str,
) -> Result<Option<Response<Body>>> {
    if limit == 0 || amount == 0 {
        return Ok(None);
    }
    let mut conn = state.redis.clone();
    let retry_after: i64 = redis::Script::new(FIXED_WINDOW_LUA)
        .key(key)
        .arg(amount)
        .arg(limit)
        .arg(window_seconds)
        .invoke_async(&mut conn)
        .await?;

    if retry_after > 0 {
        return Ok(Some(slow_down_response(message, retry_after as u64)));
    }
    Ok(None)
}

fn slow_down_response(message: &str, retry_after: u64) -> Response<Body> {
    let mut res = s3_error(StatusCode::SERVICE_UNAVAILABLE, "SlowDown", message);
    if let Ok(value) = HeaderValue::from_str(&retry_after.to_string()) {
        res.headers_mut().insert(header::RETRY_AFTER, value);
    }
    res
}

fn window_key(prefix: &str, id: &str, window_seconds: u64) -> String {
    let bucket = now_seconds() / window_seconds;
    format!("rl:{}:{}:{}", prefix, key_part(id), bucket)
}

fn key_part(value: &str) -> String {
    let value = value.trim();
    if value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.:@!".contains(&byte))
    {
        return value.to_string();
    }
    format!("sha256:{}", hex::encode(Sha256::digest(value.as_bytes())))
}

fn header_text(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn config() -> &'static RateLimitConfig {
    static CONFIG: OnceLock<RateLimitConfig> = OnceLock::new();
    CONFIG.get_or_init(|| RateLimitConfig {
        enabled: env_bool("DATAPLANE_RL_ENABLED", true),
        client_requests_per_minute: env_u64("DATAPLANE_RL_CLIENT_REQUESTS_PER_MINUTE", 12_000),
        user_requests_per_minute: env_u64("DATAPLANE_RL_USER_REQUESTS_PER_MINUTE", 0),
        bucket_requests_per_minute: env_u64("DATAPLANE_RL_BUCKET_REQUESTS_PER_MINUTE", 60_000),
        user_ingress_bytes_per_minute: env_u64("DATAPLANE_RL_USER_INGRESS_BYTES_PER_MINUTE", 0),
        bucket_ingress_bytes_per_minute: env_u64(
            "DATAPLANE_RL_BUCKET_INGRESS_BYTES_PER_MINUTE",
            512 * GIB,
        ),
        user_egress_bytes_per_minute: env_u64("DATAPLANE_RL_USER_EGRESS_BYTES_PER_MINUTE", 0),
        bucket_egress_bytes_per_minute: env_u64(
            "DATAPLANE_RL_BUCKET_EGRESS_BYTES_PER_MINUTE",
            1024 * GIB,
        ),
    })
}

fn env_bool(name: &str, fallback: bool) -> bool {
    env::var(name)
        .ok()
        .map(|value| {
            matches!(
                value.as_str(),
                "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
            )
        })
        .unwrap_or(fallback)
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(fallback)
}

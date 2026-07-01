use anyhow::{anyhow, Result};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, Response, StatusCode},
};
use sqlx::Row;

use crate::{
    cache::{invalidate_object_caches, try_redis_object_size},
    quota::{release_storage, reserve_storage},
    response::{reqwest_to_s3_response, s3_error, with_s3_headers},
    upstream::signed_upstream_request,
    AppState, AuthBucket, AuthorizeResponse,
};

pub(crate) async fn fast_copy_object(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let (Some(user), Some(target_bucket), Some(target_key)) =
        (auth.user.as_ref(), auth.bucket.as_ref(), auth.key.as_ref())
    else {
        return Ok(with_s3_headers(
            s3_error(StatusCode::FORBIDDEN, "AccessDenied", "Access Denied"),
            &auth,
        ));
    };
    let Some(copy_source) = header_value(headers, "x-amz-copy-source") else {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "Missing x-amz-copy-source header",
            ),
            &auth,
        ));
    };

    let source = match resolve_copy_source(&state, copy_source, user, target_bucket).await {
        Ok(source) => source,
        Err(_) => {
            return Ok(with_s3_headers(
                s3_error(StatusCode::FORBIDDEN, "AccessDenied", "Access Denied"),
                &auth,
            ));
        }
    };
    let target_path = auth.path_with_query.as_deref().unwrap_or("");
    let (source_size, target_size) = tokio::join!(
        cached_existing_size(&state, &source.bucket, &source.key, &source.internal_path),
        cached_existing_size(&state, target_bucket, target_key, target_path),
    );
    let source_size = source_size.unwrap_or(0);
    let target_size = target_size.unwrap_or(0);
    let delta = source_size.saturating_sub(target_size);
    let mut reserved = 0;
    if delta > 0 && reserve_storage(&state, user, delta).await.is_err() {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::FORBIDDEN,
                "QuotaExceeded",
                "You have exceeded your storage quota.",
            ),
            &auth,
        ));
    } else if delta > 0 {
        reserved = delta;
    }

    let mut upstream_headers = headers.clone();
    upstream_headers.insert(
        "x-amz-copy-source",
        HeaderValue::from_str(&format!(
            "/{}/{}",
            state.cfg.s3_bucket, source.internal_path
        ))?,
    );

    let upstream = signed_upstream_request(
        &state,
        Method::PUT,
        auth.path_with_query.as_deref().unwrap_or(""),
        &upstream_headers,
        Some(0),
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    if !status.is_success() {
        if reserved > 0 {
            let _ = release_storage(&state, &user.id, reserved).await;
        }
    } else {
        invalidate_object_caches(&state, target_bucket, target_key).await;
        bump_list_cache(&state, target_bucket).await;
        if let Err(error) =
            commit_bucket_delta(&state, target_bucket, source_size, target_size).await
        {
            tracing::warn!(error = %error, "copy object bucket byte commit failed");
        }
    }
    reqwest_to_s3_response(res, &auth).await
}

async fn resolve_copy_source(
    state: &AppState,
    header_value: &str,
    user: &crate::AuthUser,
    target_bucket: &AuthBucket,
) -> Result<CopySource> {
    let clean = header_value.trim_start_matches('/');
    let clean = clean.split_once('?').map(|(path, _)| path).unwrap_or(clean);
    let (bucket_name, key) = clean
        .split_once('/')
        .ok_or_else(|| anyhow!("invalid copy source"))?;
    ensure_no_traversal(key)?;

    let bucket = if bucket_name == target_bucket.name {
        SourceBucket {
            id: target_bucket.id.clone(),
            name: target_bucket.name.clone(),
            user_id: Some(user.id.clone()),
            is_public: false,
            is_system: false,
        }
    } else {
        let row = sqlx::query(
            r#"
            SELECT id::text AS id, name, user_id, is_public, is_system
            FROM buckets
            WHERE name = $1
            LIMIT 1
            "#,
        )
        .bind(bucket_name)
        .fetch_optional(&state.pg)
        .await?
        .ok_or_else(|| anyhow!("copy source bucket not found"))?;
        SourceBucket {
            id: row.try_get("id")?,
            name: row.try_get("name")?,
            user_id: row.try_get("user_id")?,
            is_public: row.try_get("is_public")?,
            is_system: row.try_get("is_system")?,
        }
    };

    if bucket.id != target_bucket.id {
        let owns_source = bucket.user_id.as_deref() == Some(user.id.as_str());
        if !bucket.is_public && !owns_source {
            return Err(anyhow!("copy source denied"));
        }
    }

    let internal_path = if bucket.is_system && bucket.user_id.is_none() {
        format!("system/{}/{}", bucket.name, key)
    } else {
        let Some(source_user_id) = bucket.user_id.as_ref() else {
            return Err(anyhow!("copy source bucket owner missing"));
        };
        format!(
            "users/{}/{}/{}",
            sanitize_user_id(source_user_id),
            bucket.name,
            key
        )
    };
    Ok(CopySource {
        bucket: AuthBucket {
            id: bucket.id,
            name: bucket.name,
        },
        key: key.to_string(),
        internal_path,
    })
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

async fn bump_list_cache(state: &AppState, bucket: &AuthBucket) {
    let mut conn = state.redis.clone();
    let _: redis::RedisResult<i64> = redis::cmd("INCR")
        .arg(format!("s3:listver:{}", bucket.id))
        .query_async(&mut conn)
        .await;
}

async fn commit_bucket_delta(
    state: &AppState,
    bucket: &AuthBucket,
    final_size: u64,
    existing_size: u64,
) -> Result<()> {
    let delta = i128::from(final_size) - i128::from(existing_size);
    if delta == 0 {
        return Ok(());
    }
    if delta > 0 {
        let delta = i64::try_from(delta)?;
        sqlx::query("UPDATE buckets SET total_bytes = total_bytes + $1 WHERE id = $2::uuid")
            .bind(delta)
            .bind(&bucket.id)
            .execute(&state.pg)
            .await?;
    } else {
        let delta = i64::try_from(-delta)?;
        sqlx::query(
            "UPDATE buckets SET total_bytes = GREATEST(0, total_bytes - $1) WHERE id = $2::uuid",
        )
        .bind(delta)
        .bind(&bucket.id)
        .execute(&state.pg)
        .await?;
    }
    Ok(())
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.to_str().ok())
}

fn sanitize_user_id(user_id: &str) -> String {
    user_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect()
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
        match percent_decode_path(&out) {
            Some(decoded) => out = decoded,
            None => break,
        }
    }
    out
}

fn percent_decode_path(value: &str) -> Option<String> {
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

struct SourceBucket {
    id: String,
    name: String,
    user_id: Option<String>,
    is_public: bool,
    is_system: bool,
}

struct CopySource {
    bucket: AuthBucket,
    key: String,
    internal_path: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_encoded_copy_source_traversal() {
        assert!(ensure_no_traversal("safe/file.txt").is_ok());
        assert!(ensure_no_traversal("../secret.txt").is_err());
        assert!(ensure_no_traversal("%2e%2e/secret.txt").is_err());
        assert!(ensure_no_traversal("%252e%252e/secret.txt").is_err());
    }
}

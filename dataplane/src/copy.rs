use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    http::{HeaderMap, HeaderValue, Method, Response, StatusCode},
};
use sqlx::Row;

use crate::{
    cache::{invalidate_object_caches, try_redis_object_size},
    quota::{release_storage_reservation, reserve_storage},
    response::{buffered_reqwest_to_s3_response, s3_error, with_s3_headers},
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
    if source.bucket.resolved_region != target_bucket.resolved_region {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "CopyObject across storage regions is not supported. Download and upload the object to migrate it explicitly.",
            ),
            &auth,
        ));
    }
    let target_path = auth.path_with_query.as_deref().unwrap_or("");
    let (source_size, target_size) = tokio::join!(
        cached_existing_size(&state, &source.bucket, &source.key, &source.internal_path),
        cached_existing_size(&state, target_bucket, target_key, target_path),
    );
    let source_size = match source_size? {
        Some(size) => size,
        None => {
            return Ok(with_s3_headers(
                s3_error(
                    StatusCode::NOT_FOUND,
                    "NoSuchKey",
                    "The source key does not exist.",
                ),
                &auth,
            ));
        }
    };
    let target_size = target_size?.unwrap_or(0);
    let delta = source_size.saturating_sub(target_size);
    let mut reservation = if delta > 0 {
        match reserve_storage(&state, user, delta).await {
            Ok(reservation) => Some(reservation),
            Err(_) => {
                return Ok(with_s3_headers(
                    s3_error(
                        StatusCode::FORBIDDEN,
                        "QuotaExceeded",
                        "You have exceeded your storage quota.",
                    ),
                    &auth,
                ));
            }
        }
    } else {
        None
    };

    let mut upstream_headers = headers.clone();
    let target_storage = state.cfg.regions.backend(
        &target_bucket.resolved_region,
        &target_bucket.active_backend()?.id,
    )?;
    upstream_headers.insert(
        "x-amz-copy-source",
        HeaderValue::from_str(&format!(
            "/{}/{}",
            target_storage.bucket, source.internal_path
        ))?,
    );

    let replication_events = match crate::replication::prepare(
        &state,
        target_bucket,
        &[auth.path_with_query.as_deref().unwrap_or("").to_string()],
        crate::replication::Operation::Put,
    )
    .await
    {
        Ok(events) => events,
        Err(error) => {
            if let Some(reservation) = reservation.take() {
                let _ = release_storage_reservation(&state, reservation).await;
            }
            return Err(error).context("failed to prepare provider replication for copy");
        }
    };
    let mutation_intent = match crate::accounting::prepare_mutation_intent(
        &state,
        &target_bucket.resolved_region,
        &target_bucket.id,
        Some(&user.id),
        target_path
            .split_once('?')
            .map(|(path, _)| path)
            .unwrap_or(target_path),
        "put",
        target_size,
        source_size,
        reservation.and_then(|reservation| reservation.id()),
        replication_events
            .first()
            .map(crate::replication::PreparedEvent::event_id),
    )
    .await
    {
        Ok(intent) => intent,
        Err(error) => {
            crate::replication::cancel(
                &state,
                &replication_events,
                "accounting intent preparation failed",
            )
            .await?;
            if let Some(reservation) = reservation.take() {
                let _ = release_storage_reservation(&state, reservation).await;
            }
            return Err(error).context("failed to prepare durable copy accounting intent");
        }
    };

    let upstream = signed_upstream_request(
        &state,
        target_bucket,
        Method::PUT,
        auth.path_with_query.as_deref().unwrap_or(""),
        &upstream_headers,
        Some(0),
    )?;
    let res = match upstream.send().await {
        Ok(response) => response,
        Err(error) => {
            // The provider outcome is ambiguous. Keep the prepared event so
            // promotion remains blocked until an operator reconciles it. The
            // durable quota reservation is retained conservatively as well.
            return Err(error.into());
        }
    };
    let status = res.status();
    let response_headers = res.headers().clone();
    let response_body = res.bytes().await?;
    let embedded_error = {
        let body = String::from_utf8_lossy(&response_body);
        body.contains("<Error>") || body.contains("<Error ")
    };
    if !status.is_success() || embedded_error {
        crate::accounting::cancel_mutation_intent(
            &state,
            mutation_intent,
            "authoritative copy was rejected",
        )
        .await?;
        crate::replication::cancel(
            &state,
            &replication_events,
            "authoritative copy was rejected",
        )
        .await?;
    } else {
        let actual_size = head_existing_size(&state, target_bucket, target_path)
            .await?
            .ok_or_else(|| anyhow!("copied object could not be verified"))?;
        if actual_size != source_size {
            crate::accounting::correct_prepared_mutation_size(&state, mutation_intent, actual_size)
                .await?;
            return Err(anyhow!(
                "copy result size changed during the operation; reconciliation is required"
            ));
        }
        crate::accounting::commit_mutation_intent(&state, mutation_intent).await?;
        crate::replication::commit(&state, &replication_events).await?;
        invalidate_object_caches(&state, target_bucket, target_key).await;
        bump_list_cache(&state, target_bucket).await;
        reservation.take();
    }
    buffered_reqwest_to_s3_response(status.as_u16(), &response_headers, response_body, &auth)
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
            resolved_region: target_bucket.resolved_region.clone(),
        }
    } else {
        let row = sqlx::query(
            r#"
            SELECT id::text AS id, name, user_id, is_public, is_system, resolved_region
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
            resolved_region: row.try_get("resolved_region")?,
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
            resolved_region: bucket.resolved_region,
            active_backend: target_bucket.active_backend.clone(),
            writer_generation: target_bucket.writer_generation,
        },
        key: key.to_string(),
        internal_path,
    })
}

async fn head_existing_size(
    state: &AppState,
    bucket: &AuthBucket,
    path: &str,
) -> Result<Option<u64>> {
    let empty = HeaderMap::new();
    let req = signed_upstream_request(state, bucket, Method::HEAD, path, &empty, None)?;
    let res = req.send().await?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(anyhow!(
            "object size probe returned status {}",
            res.status()
        ));
    }
    let size = res
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("object size probe omitted Content-Length"))?;
    Ok(Some(size))
}

async fn cached_existing_size(
    state: &AppState,
    bucket: &AuthBucket,
    key: &str,
    path: &str,
) -> Result<Option<u64>> {
    if let Some(size) = try_redis_object_size(state, bucket, key).await {
        return Ok(Some(size));
    }
    if let Some(size) = state.disk_cache.object_size(bucket, key).await {
        return Ok(Some(size));
    }
    head_existing_size(state, bucket, path).await
}

async fn bump_list_cache(state: &AppState, bucket: &AuthBucket) {
    if !state.cfg.redis_object_cache_enabled || !state.cfg.regions.is_local(&bucket.resolved_region)
    {
        return;
    }
    let Ok(namespace) = bucket.cache_namespace(&state.cfg) else {
        return;
    };
    let Some(mut conn) = state.redis.connection().await else {
        return;
    };
    let _: redis::RedisResult<i64> = redis::cmd("INCR")
        .arg(format!("s3:{namespace}:listver:{}", bucket.id))
        .query_async(&mut conn)
        .await;
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
    resolved_region: String,
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

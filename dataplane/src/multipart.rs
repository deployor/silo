use anyhow::{anyhow, Result};
use axum::{
    body::Body,
    http::{HeaderMap, Method, Response, StatusCode},
};
use futures_util::StreamExt;
use tracing::warn;

use crate::{
    cache::{invalidate_object_caches, try_redis_object_size},
    quota::{clear_multipart_upload, register_multipart_upload, release_multipart_upload},
    response::{reqwest_to_s3_response, s3_error, with_s3_headers},
    upstream::signed_upstream_request,
    AppState, AuthBucket, AuthorizeResponse,
};

pub(crate) async fn fast_list_multipart_uploads(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let query = list_multipart_uploads_query(&auth)?;
    let upstream =
        signed_upstream_request(&state, Method::GET, &format!("?{query}"), headers, None)?;
    let res = upstream.send().await?;
    let status = res.status();
    let xml = res.text().await?;
    let rewritten = rewrite_multipart_xml(&xml, auth.root_prefix.as_deref().unwrap_or(""));
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::from_u16(status.as_u16())?)
            .header("content-type", "application/xml")
            .body(Body::from(rewritten))?,
        &auth,
    ))
}

pub(crate) async fn fast_list_parts(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let upstream = signed_upstream_request(
        &state,
        Method::GET,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        None,
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    let xml = res.text().await?;
    let rewritten = rewrite_multipart_xml(&xml, auth.root_prefix.as_deref().unwrap_or(""));
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::from_u16(status.as_u16())?)
            .header("content-type", "application/xml")
            .body(Body::from(rewritten))?,
        &auth,
    ))
}

pub(crate) async fn fast_create_multipart_upload(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let lookup_path = auth
        .path_with_query
        .as_deref()
        .unwrap_or("")
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or("");
    let existing_size = if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref())
    {
        cached_existing_size(
            &state,
            bucket,
            key,
            lookup_path,
        )
        .await
        .unwrap_or(0)
    } else {
        head_existing_size(&state, lookup_path)
            .await
            .unwrap_or(0)
    };
    let upstream = signed_upstream_request(
        &state,
        Method::POST,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        Some(0),
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    let xml = res.text().await?;

    if status.is_success() {
        if let (Some(user), Some(bucket), Some(upload_id)) = (
            auth.user.as_ref(),
            auth.bucket.as_ref(),
            extract_first_tag(&xml, "UploadId"),
        ) {
            if !user.is_immortal {
                if let Err(error) = register_multipart_upload(
                    &state,
                    &user.id,
                    &bucket.id,
                    &upload_id,
                    existing_size,
                )
                .await
                {
                    let root = auth.root_prefix.as_deref().unwrap_or("");
                    let key = auth.key.as_deref().unwrap_or("");
                    let abort_path = format!("{root}{key}?uploadId={upload_id}");
                    let _ = signed_upstream_request(
                        &state,
                        Method::DELETE,
                        &abort_path,
                        &HeaderMap::new(),
                        None,
                    )?
                    .send()
                    .await;
                    return Err(anyhow!("failed to register multipart quota: {error}"));
                }
            }
        }
    }

    let rewritten = rewrite_multipart_xml(&xml, auth.root_prefix.as_deref().unwrap_or(""));
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::from_u16(status.as_u16())?)
            .header("content-type", "application/xml")
            .body(Body::from(rewritten))?,
        &auth,
    ))
}

pub(crate) async fn fast_complete_multipart_upload(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response<Body>> {
    let Some(upload_id) = auth.upload_id.as_deref() else {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "Missing uploadId",
            ),
            &auth,
        ));
    };
    let lookup_path = auth
        .path_with_query
        .as_deref()
        .unwrap_or("")
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or("");
    let existing_size = if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref())
    {
        cached_existing_size(
            &state,
            bucket,
            key,
            lookup_path,
        )
        .await
        .unwrap_or(0)
    } else {
        head_existing_size(&state, lookup_path)
            .await
            .unwrap_or(0)
    };
    let content_length = headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    let upstream = signed_upstream_request(
        &state,
        Method::POST,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        content_length,
    )?
    .body(reqwest::Body::wrap_stream(
        body.into_data_stream()
            .map(|r| r.map_err(std::io::Error::other)),
    ));
    let res = upstream.send().await?;
    let status = res.status();
    let xml = res.text().await?;

    if status.is_success() {
        if let (Some(user), Some(bucket), Some(key)) =
            (auth.user.as_ref(), auth.bucket.as_ref(), auth.key.as_ref())
        {
            if let Err(error) =
                clear_multipart_upload(&state, &user.id, &bucket.id, upload_id).await
            {
                warn!(error = %error, "failed to clear multipart quota");
            }
            let path_without_query = auth
                .path_with_query
                .as_deref()
                .unwrap_or("")
                .split_once('?')
                .map(|(path, _)| path)
                .unwrap_or(auth.path_with_query.as_deref().unwrap_or(""));
            let final_size = head_existing_size(&state, path_without_query)
                .await
                .unwrap_or(0);
            if let Err(error) = commit_bucket_delta(&state, bucket, final_size, existing_size).await
            {
                warn!(error = %error, "failed to commit multipart bucket size");
            }
            invalidate_object_caches(&state, bucket, key).await;
            bump_list_cache(&state, bucket).await;
        }
    }

    let rewritten = rewrite_multipart_xml(&xml, auth.root_prefix.as_deref().unwrap_or(""));
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::from_u16(status.as_u16())?)
            .header("content-type", "application/xml")
            .body(Body::from(rewritten))?,
        &auth,
    ))
}

pub(crate) async fn fast_abort_multipart_upload(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let Some(upload_id) = auth.upload_id.as_deref() else {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::BAD_REQUEST,
                "InvalidRequest",
                "Missing uploadId",
            ),
            &auth,
        ));
    };
    let upstream = signed_upstream_request(
        &state,
        Method::DELETE,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        None,
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        if let (Some(user), Some(bucket)) = (auth.user.as_ref(), auth.bucket.as_ref()) {
            if let Err(error) =
                release_multipart_upload(&state, &user.id, &bucket.id, upload_id).await
            {
                warn!(error = %error, "failed to release multipart quota");
            }
        }
    }
    reqwest_to_s3_response(res, &auth).await
}

fn list_multipart_uploads_query(auth: &AuthorizeResponse) -> Result<String> {
    let root_prefix = auth
        .root_prefix
        .as_deref()
        .ok_or_else(|| anyhow!("missing root prefix"))?;
    let raw_query = auth
        .path_with_query
        .as_deref()
        .and_then(|path| path.split_once('?').map(|(_, query)| query))
        .unwrap_or("uploads");
    let mut pairs = url::form_urlencoded::parse(raw_query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    prefix_query_param(&mut pairs, "prefix", root_prefix, true);
    prefix_query_param(&mut pairs, "key-marker", root_prefix, false);

    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in pairs {
        serializer.append_pair(&key, &value);
    }
    Ok(serializer.finish())
}

fn prefix_query_param(
    pairs: &mut Vec<(String, String)>,
    name: &str,
    root_prefix: &str,
    insert_when_missing: bool,
) {
    let mut found = false;
    for (key, value) in pairs.iter_mut() {
        if key == name {
            *value = format!("{root_prefix}{value}");
            found = true;
        }
    }
    if !found && insert_when_missing {
        pairs.push((name.to_string(), root_prefix.to_string()));
    }
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

fn rewrite_multipart_xml(xml: &str, root_prefix: &str) -> String {
    if xml.is_empty() || root_prefix.is_empty() {
        return xml.to_string();
    }
    let mut rewritten = xml.to_string();
    for tag in ["Key", "KeyMarker", "NextKeyMarker", "Prefix"] {
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

fn extract_first_tag(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)?;
    Some(xml[start..start + end].to_string())
}

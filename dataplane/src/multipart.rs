use anyhow::{anyhow, Result};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, Method, Response, StatusCode},
};
use futures_util::StreamExt;
use tracing::warn;

use crate::{
    cache::{invalidate_object_caches, try_redis_object_size},
    quota::{
        clear_multipart_upload, multipart_completed_size, register_multipart_upload,
        release_multipart_upload,
    },
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
    let upstream = signed_upstream_request(
        &state,
        auth_bucket(&auth)?,
        Method::GET,
        &format!("?{query}"),
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

pub(crate) async fn fast_list_parts(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let upstream = signed_upstream_request(
        &state,
        auth_bucket(&auth)?,
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
    writer_generation: i64,
) -> Result<Response<Body>> {
    let bucket = auth_bucket(&auth)?;
    let lookup_path = auth
        .path_with_query
        .as_deref()
        .unwrap_or("")
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or("");
    let existing_size = if let Some(key) = auth.key.as_ref() {
        cached_existing_size(&state, bucket, key, lookup_path)
            .await?
            .unwrap_or(0)
    } else {
        head_existing_size(&state, bucket, lookup_path)
            .await?
            .unwrap_or(0)
    };
    let upstream = signed_upstream_request(
        &state,
        bucket,
        Method::POST,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        Some(0),
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    let xml = res.text().await?;

    if status.is_success() {
        if let (Some(bucket), Some(upload_id)) =
            (auth.bucket.as_ref(), extract_first_tag(&xml, "UploadId"))
        {
            if let Err(error) = crate::writer::register_multipart(
                &state,
                &bucket.id,
                &bucket.resolved_region,
                bucket.active_backend()?,
                &upload_id,
                writer_generation,
            )
            .await
            {
                let root = auth.root_prefix.as_deref().unwrap_or("");
                let key = auth.key.as_deref().unwrap_or("");
                let abort_path = format!("{root}{key}?uploadId={upload_id}");
                let _ = signed_upstream_request(
                    &state,
                    bucket,
                    Method::DELETE,
                    &abort_path,
                    &HeaderMap::new(),
                    None,
                )?
                .send()
                .await;
                return Err(anyhow!("failed to fence multipart upload: {error}"));
            }
            if let Some(user) = auth.user.as_ref() {
                if let Err(error) =
                    register_multipart_upload(&state, &user.id, bucket, &upload_id, existing_size)
                        .await
                {
                    let root = auth.root_prefix.as_deref().unwrap_or("");
                    let key = auth.key.as_deref().unwrap_or("");
                    let abort_path = format!("{root}{key}?uploadId={upload_id}");
                    let _ = signed_upstream_request(
                        &state,
                        bucket,
                        Method::DELETE,
                        &abort_path,
                        &HeaderMap::new(),
                        None,
                    )?
                    .send()
                    .await;
                    let _ = crate::writer::clear_multipart(&state, &upload_id).await;
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
    writer_generation: i64,
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
    let bucket_id = auth
        .bucket
        .as_ref()
        .map(|bucket| bucket.id.as_str())
        .unwrap_or("");
    let bucket = auth_bucket(&auth)?;
    if !crate::writer::multipart_matches(
        &state,
        bucket_id,
        &bucket.resolved_region,
        bucket.active_backend()?,
        upload_id,
        writer_generation,
    )
    .await?
    {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::CONFLICT,
                "InvalidRequest",
                "This multipart upload belongs to an earlier failover generation. Restart the multipart upload.",
            ),
            &auth,
        ));
    }
    let lookup_path = auth
        .path_with_query
        .as_deref()
        .unwrap_or("")
        .split_once('?')
        .map(|(p, _)| p)
        .unwrap_or("");
    let existing_size = if let Some(key) = auth.key.as_ref() {
        cached_existing_size(&state, bucket, key, lookup_path)
            .await?
            .unwrap_or(0)
    } else {
        head_existing_size(&state, bucket, lookup_path)
            .await?
            .unwrap_or(0)
    };
    let completion_body = read_body_limited(body, 2 * 1024 * 1024).await?;
    let part_numbers = completion_part_numbers(&completion_body)?;
    let user = auth
        .user
        .as_ref()
        .ok_or_else(|| anyhow!("multipart completion is missing its user"))?;
    let expected_final_size =
        multipart_completed_size(&state, &user.id, &bucket.id, upload_id, &part_numbers).await?;
    let content_length = Some(completion_body.len() as u64);
    let replication_events = crate::replication::prepare(
        &state,
        bucket,
        &[lookup_path.to_string()],
        crate::replication::Operation::Put,
    )
    .await?;
    let mutation_intent = match crate::accounting::prepare_mutation_intent(
        &state,
        &bucket.resolved_region,
        &bucket.id,
        Some(&user.id),
        lookup_path,
        "put",
        existing_size,
        expected_final_size,
        None,
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
            return Err(error);
        }
    };
    let upstream = signed_upstream_request(
        &state,
        bucket,
        Method::POST,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        content_length,
    )?
    .body(completion_body);
    let res = upstream.send().await?;
    let status = res.status();
    let xml = res.text().await?;

    let embedded_error = xml.contains("<Error>") || xml.contains("<Error ");
    if status.is_success() && !embedded_error {
        if let (Some(user), Some(bucket), Some(key)) =
            (auth.user.as_ref(), auth.bucket.as_ref(), auth.key.as_ref())
        {
            let path_without_query = auth
                .path_with_query
                .as_deref()
                .unwrap_or("")
                .split_once('?')
                .map(|(path, _)| path)
                .unwrap_or(auth.path_with_query.as_deref().unwrap_or(""));
            let final_size = head_existing_size(&state, bucket, path_without_query)
                .await?
                .ok_or_else(|| anyhow!("completed multipart object size could not be verified"))?;
            if final_size != expected_final_size {
                return Err(anyhow!(
                    "completed multipart object size differs from durable part accounting"
                ));
            }
            crate::accounting::commit_mutation_intent(&state, mutation_intent).await?;
            crate::replication::commit(&state, &replication_events).await?;
            if let Err(error) =
                clear_multipart_upload(&state, &user.id, &bucket.id, upload_id).await
            {
                warn!(error = %error, "failed to clear multipart quota");
            }
            invalidate_object_caches(&state, bucket, key).await;
            bump_list_cache(&state, bucket).await;
        }
        if let Err(error) = crate::writer::clear_multipart(&state, upload_id).await {
            warn!(error = %error, "failed to clear multipart writer generation");
        }
    } else {
        crate::accounting::cancel_mutation_intent(
            &state,
            mutation_intent,
            "authoritative multipart completion was rejected",
        )
        .await?;
        crate::replication::cancel(
            &state,
            &replication_events,
            "authoritative multipart completion was rejected",
        )
        .await?;
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
    writer_generation: i64,
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
    let bucket_id = auth
        .bucket
        .as_ref()
        .map(|bucket| bucket.id.as_str())
        .unwrap_or("");
    let bucket = auth_bucket(&auth)?;
    if !crate::writer::multipart_matches(
        &state,
        bucket_id,
        &bucket.resolved_region,
        bucket.active_backend()?,
        upload_id,
        writer_generation,
    )
    .await?
    {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::CONFLICT,
                "InvalidRequest",
                "This multipart upload belongs to an earlier failover generation. Restart the multipart upload.",
            ),
            &auth,
        ));
    }
    let upstream = signed_upstream_request(
        &state,
        bucket,
        Method::DELETE,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        None,
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        if let Err(error) = crate::writer::clear_multipart(&state, upload_id).await {
            warn!(error = %error, "failed to clear multipart writer generation");
        }
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

async fn read_body_limited(body: Body, limit: usize) -> Result<Bytes> {
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if out.len().saturating_add(chunk.len()) > limit {
            return Err(anyhow!("multipart completion body is too large"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(out))
}

fn completion_part_numbers(body: &[u8]) -> Result<Vec<i32>> {
    let xml =
        std::str::from_utf8(body).map_err(|_| anyhow!("multipart completion XML is not UTF-8"))?;
    let mut rest = xml;
    let mut parts = Vec::new();
    while let Some(start) = rest.find("<Part>") {
        let block = &rest[start + "<Part>".len()..];
        let end = block
            .find("</Part>")
            .ok_or_else(|| anyhow!("multipart completion XML is malformed"))?;
        let block = &block[..end];
        let part = extract_first_tag(block, "PartNumber")
            .ok_or_else(|| anyhow!("multipart completion part has no PartNumber"))?
            .parse::<i32>()?;
        parts.push(part);
        rest = &rest[start + "<Part>".len() + end + "</Part>".len()..];
    }
    if parts.is_empty() || parts.len() > 10_000 {
        return Err(anyhow!("multipart completion has no valid parts"));
    }
    Ok(parts)
}

fn auth_bucket(auth: &AuthorizeResponse) -> Result<&AuthBucket> {
    auth.bucket
        .as_ref()
        .ok_or_else(|| anyhow!("authorized multipart request is missing bucket metadata"))
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

#[cfg(test)]
mod tests {
    use super::completion_part_numbers;

    #[test]
    fn parses_exact_multipart_completion_parts() {
        let body = br#"<CompleteMultipartUpload>
          <Part><PartNumber>1</PartNumber><ETag>&quot;a&quot;</ETag></Part>
          <Part><PartNumber>3</PartNumber><ETag>&quot;c&quot;</ETag></Part>
        </CompleteMultipartUpload>"#;
        assert_eq!(completion_part_numbers(body).unwrap(), vec![1, 3]);
        assert!(completion_part_numbers(b"<CompleteMultipartUpload/>").is_err());
    }
}

use anyhow::{anyhow, Context, Result};
use axum::{
    body::{Body, Bytes},
    extract::State,
    http::{header, HeaderMap, Method, Response, StatusCode},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::StreamExt;
use sqlx::Row;
use std::collections::BTreeSet;
use tracing::error;

use crate::{
    internal_auth_ok, is_region_draining, response::s3_error, upstream::signed_upstream_request,
    writer, AppState, AuthBucket,
};

const MAX_INTERNAL_PATH_BYTES: usize = 32 * 1024;

pub(crate) async fn execute(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return empty(StatusCode::UNAUTHORIZED);
    }
    match execute_inner(state, headers, body).await {
        Ok(response) => response,
        Err(error) => {
            error!(error = %error, "protected storage execution failed");
            s3_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "StorageBackendUnavailable",
                "The protected storage operation could not be completed.",
            )
        }
    }
}

async fn execute_inner(state: AppState, headers: HeaderMap, body: Body) -> Result<Response<Body>> {
    let bucket_id = required_header(&headers, "x-silo-bucket-id")?;
    let hinted_region = required_header(&headers, "x-silo-storage-region")?;
    let hinted_root = decode_header(&headers, "x-silo-root-prefix-b64")?;
    let path_with_query = decode_header(&headers, "x-silo-path-with-query-b64")?;
    let method = parse_upstream_method(required_header(&headers, "x-silo-upstream-method")?)?;
    let mutation = matches!(method, Method::PUT | Method::POST | Method::DELETE);

    let row = sqlx::query(
        r#"
        SELECT id::text AS id, name, user_id, is_system, resolved_region
        FROM buckets
        WHERE id = $1::uuid
        LIMIT 1
        "#,
    )
    .bind(bucket_id)
    .fetch_optional(&state.pg)
    .await?
    .ok_or_else(|| anyhow!("internal storage bucket does not exist"))?;
    let resolved_region: String = row.try_get("resolved_region")?;
    if hinted_region != resolved_region {
        return Err(anyhow!(
            "internal storage region hint does not match bucket metadata"
        ));
    }
    state.cfg.regions.ensure_served(&resolved_region)?;
    if mutation && is_region_draining(&state, &resolved_region) {
        return Ok(s3_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ServiceUnavailable",
            "This storage region is draining for a fenced transfer.",
        ));
    }

    let bucket_name: String = row.try_get("name")?;
    let user_id: Option<String> = row.try_get("user_id")?;
    let is_system: bool = row.try_get("is_system")?;
    let live_root = authoritative_root(&bucket_name, user_id.as_deref(), is_system)?;
    let archive_root = deep_freeze_root(
        &state.cfg.deep_freeze_storage_prefix,
        &bucket_name,
        user_id.as_deref(),
    )?;
    let selected_root = if hinted_root == live_root {
        live_root
    } else if path_is_within(&hinted_root, &archive_root) {
        // Deep Freeze callers may narrow the hint to one archive/manifest key,
        // but can never broaden it beyond this bucket's derived archive root.
        hinted_root.clone()
    } else {
        return Err(anyhow!(
            "internal storage root hint does not match bucket metadata"
        ));
    };
    let path_operation = validate_path_operation(&method, &path_with_query, &selected_root)?;
    let mut request_body = Some(body);
    let (buffered_delete, bucket_delete_keys) = if path_operation == PathOperation::BucketDelete {
        let bytes = read_body_limited(
            request_body
                .take()
                .ok_or_else(|| anyhow!("internal storage request body is unavailable"))?,
            10 * 1024 * 1024,
        )
        .await?;
        let keys = delete_body_keys(&bytes, &selected_root)?;
        (Some(bytes), keys)
    } else if path_operation == PathOperation::Object {
        ensure_jailed(&path_with_query, &selected_root)?;
        (None, Vec::new())
    } else {
        // The list prefix was already decoded and checked against the jail by
        // `validate_path_operation`; the request path itself is intentionally
        // empty for an S3 bucket-level ListObjectsV2 request.
        (None, Vec::new())
    };

    let mut bucket = AuthBucket {
        id: row.try_get("id")?,
        name: bucket_name,
        resolved_region: resolved_region.clone(),
        active_backend: None,
        writer_generation: None,
    };
    let (fence, writer_generation) = if mutation {
        if state
            .accounting_unsafe
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            return Ok(s3_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "AccountingUnavailable",
                "Durable accounting is unavailable; mutations are temporarily fenced.",
            ));
        }
        let object_key = (path_operation == PathOperation::Object).then(|| {
            path_with_query
                .split_once('?')
                .map(|(path, _)| path)
                .unwrap_or(path_with_query.as_str())
        });
        match writer::begin_mutation(
            &state,
            &resolved_region,
            &bucket.id,
            true,
            object_key,
            path_operation == PathOperation::BucketDelete,
        )
        .await?
        {
            (fence, Some(context)) => {
                bucket.active_backend = Some(context.backend);
                bucket.writer_generation = Some(context.writer_generation);
                (Some(fence), Some(context.writer_generation))
            }
            (_, None) => {
                return Ok(s3_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "NotActiveWriter",
                    "This dataplane is not the active writer for the bucket region.",
                ));
            }
        }
    } else {
        bucket.active_backend = Some(writer::active_backend(&state, &resolved_region).await?);
        bucket.writer_generation =
            Some(writer::current_generation(&state, &resolved_region).await?);
        (None, None)
    };

    let mut upstream_headers = headers.clone();
    if let Some(encoded_source) = header_value(&headers, "x-silo-copy-source-path-b64") {
        let source = decode_value(encoded_source)?;
        ensure_jailed(&source, &selected_root)?;
        let backend = bucket.active_backend()?;
        let physical = state.cfg.regions.backend(&resolved_region, &backend.id)?;
        upstream_headers.insert(
            "x-amz-copy-source",
            format!("/{}/{}", physical.bucket, source.trim_start_matches('/'))
                .parse()
                .context("copy source header is invalid")?,
        );
    }

    let content_length = header_value(&headers, header::CONTENT_LENGTH.as_str())
        .map(str::parse::<u64>)
        .transpose()
        .context("internal storage Content-Length is invalid")?;
    let content_length = buffered_delete
        .as_ref()
        .map(|body| body.len() as u64)
        .or(content_length);
    let request = signed_upstream_request(
        &state,
        &bucket,
        method.clone(),
        &path_with_query,
        &upstream_headers,
        content_length,
    )?;
    let has_body =
        content_length.unwrap_or(0) > 0 || headers.contains_key(header::TRANSFER_ENCODING);
    let request = if let Some(buffered_delete) = buffered_delete {
        request.body(buffered_delete)
    } else if has_body {
        request.body(reqwest::Body::wrap_stream(
            request_body
                .take()
                .ok_or_else(|| anyhow!("internal storage request body is unavailable"))?
                .into_data_stream()
                .map(|chunk| chunk.map_err(std::io::Error::other)),
        ))
    } else {
        request
    };
    let replication_keys = if mutation {
        match path_operation {
            PathOperation::Object => vec![path_with_query
                .split_once('?')
                .map(|(path, _)| path)
                .unwrap_or(&path_with_query)
                .to_string()],
            PathOperation::BucketDelete => bucket_delete_keys,
            PathOperation::BucketList => Vec::new(),
        }
    } else {
        Vec::new()
    };
    let replication_operation =
        if method == Method::DELETE || path_operation == PathOperation::BucketDelete {
            crate::replication::Operation::Delete
        } else {
            crate::replication::Operation::Put
        };
    let replication_events =
        crate::replication::prepare(&state, &bucket, &replication_keys, replication_operation)
            .await?;
    let upstream = request.send().await?;
    let status = StatusCode::from_u16(upstream.status().as_u16())?;
    let response_headers = upstream.headers().clone();
    let mut streaming_upstream = Some(upstream);
    let buffered_response = if mutation {
        Some(
            streaming_upstream
                .take()
                .expect("mutation response is available")
                .bytes()
                .await?,
        )
    } else {
        None
    };
    let embedded_error = buffered_response.as_ref().is_some_and(|body| {
        let body = String::from_utf8_lossy(body);
        body.contains("<Error>") || body.contains("<Error ")
    });
    if path_operation == PathOperation::BucketDelete && status.is_success() {
        let requested = replication_keys
            .iter()
            .filter_map(|key| key.strip_prefix(&selected_root).map(str::to_string))
            .collect::<Vec<_>>();
        let response_xml = buffered_response
            .as_ref()
            .and_then(|body| std::str::from_utf8(body).ok())
            .ok_or_else(|| anyhow!("authoritative delete result is not UTF-8"))?;
        let deleted =
            crate::delete::successful_delete_keys(response_xml, &selected_root, &requested)
                .into_iter()
                .collect::<BTreeSet<_>>();
        let (committed, cancelled): (Vec<_>, Vec<_>) =
            replication_events.iter().cloned().partition(|event| {
                event
                    .object_key()
                    .strip_prefix(&selected_root)
                    .is_some_and(|key| deleted.contains(key))
            });
        crate::replication::commit(&state, &committed).await?;
        crate::replication::cancel(
            &state,
            &cancelled,
            "authoritative protected bulk delete did not delete this key",
        )
        .await?;
    } else if (status.is_success() || (method == Method::DELETE && status == StatusCode::NOT_FOUND))
        && !embedded_error
    {
        crate::replication::commit(&state, &replication_events).await?;
    } else {
        crate::replication::cancel(
            &state,
            &replication_events,
            "authoritative protected storage mutation was rejected",
        )
        .await?;
    }
    let upstream_content_length = (method == Method::HEAD)
        .then(|| response_headers.get(header::CONTENT_LENGTH).cloned())
        .flatten();
    let mut response = Response::builder().status(status);
    for (name, value) in &response_headers {
        if method == Method::HEAD && name == header::CONTENT_LENGTH {
            continue;
        }
        if !is_hop_by_hop(name.as_str()) {
            response = response.header(name, value);
        }
    }
    if let Some(content_length) = upstream_content_length {
        response = response.header("x-silo-upstream-content-length", content_length);
    }
    if let Some(generation) = writer_generation {
        response = response.header("x-silo-writer-generation", generation.to_string());
    }
    if let Some(backend) = bucket.active_backend.as_ref() {
        response = response.header("x-silo-backend-generation", backend.generation.to_string());
    }
    let response = if method == Method::HEAD {
        // The protected endpoint itself is a POST. Forwarding the upstream
        // object's Content-Length with an empty HEAD body makes HTTP proxies
        // treat this response as truncated and replace it with a 502.
        response.body(Body::empty())?
    } else if let Some(body) = buffered_response {
        response.body(Body::from(body))?
    } else {
        let stream = streaming_upstream
            .expect("non-mutation response is available")
            .bytes_stream()
            .map(|chunk| chunk.map_err(std::io::Error::other));
        response.body(Body::from_stream(stream))?
    };

    if let Some(fence) = fence {
        if let Err(error) = fence.commit().await {
            return Err(error).context("failed to commit protected storage mutation fence");
        }
    }
    Ok(response)
}

pub(crate) fn authoritative_root(
    bucket_name: &str,
    user_id: Option<&str>,
    is_system: bool,
) -> Result<String> {
    if is_system && user_id.is_none() {
        return Ok(format!("system/{bucket_name}/"));
    }
    let user_id = user_id.ok_or_else(|| anyhow!("non-system bucket is missing its owner"))?;
    let user_id = user_id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    Ok(format!("users/{user_id}/{bucket_name}/"))
}

fn deep_freeze_root(prefix: &str, bucket_name: &str, user_id: Option<&str>) -> Result<String> {
    let owner = user_id.unwrap_or("system");
    if owner.contains('/') || owner.contains('\\') || owner == "." || owner == ".." {
        return Err(anyhow!(
            "bucket owner cannot be represented in the archive root"
        ));
    }
    Ok(format!("{prefix}/{owner}/{bucket_name}/"))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum PathOperation {
    Object,
    BucketList,
    BucketDelete,
}

/// Classify the two intentionally supported bucket-level forms. Non-empty
/// object paths are validated by `ensure_jailed` separately.
fn validate_path_operation(
    method: &Method,
    path_with_query: &str,
    root: &str,
) -> Result<PathOperation> {
    let (path, query) = path_with_query
        .split_once('?')
        .unwrap_or((path_with_query, ""));
    if !path.trim_start_matches('/').is_empty() {
        return Ok(PathOperation::Object);
    }
    let pairs = url::form_urlencoded::parse(query.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    if method == Method::GET {
        if !pairs
            .iter()
            .any(|(key, value)| key == "list-type" && value == "2")
        {
            return Err(anyhow!("bucket-level GET must be ListObjectsV2"));
        }
        let prefixes = pairs
            .iter()
            .filter(|(key, _)| key == "prefix")
            .map(|(_, value)| value)
            .collect::<Vec<_>>();
        if prefixes.len() != 1 {
            return Err(anyhow!("bucket-level list must contain one prefix"));
        }
        ensure_jailed(prefixes[0], root)?;
        return Ok(PathOperation::BucketList);
    }
    if method == Method::POST && pairs.len() == 1 && pairs[0].0 == "delete" && pairs[0].1.is_empty()
    {
        return Ok(PathOperation::BucketDelete);
    }
    Err(anyhow!("bucket-level storage operation is not allowed"))
}

fn path_is_within(path: &str, root: &str) -> bool {
    let path = path.trim_start_matches('/');
    let root = root.trim_start_matches('/');
    path == root.trim_end_matches('/') || path.starts_with(root)
}

fn ensure_jailed(path_with_query: &str, root_prefix: &str) -> Result<()> {
    if path_with_query.len() > MAX_INTERNAL_PATH_BYTES
        || path_with_query.contains('\0')
        || path_with_query.contains('\\')
        || path_with_query.contains('#')
        || path_with_query.contains("://")
    {
        return Err(anyhow!("internal storage path is invalid"));
    }
    let path = path_with_query
        .split_once('?')
        .map(|(path, _)| path)
        .unwrap_or(path_with_query)
        .trim_start_matches('/');
    let root = root_prefix.trim_start_matches('/');
    if root.is_empty() || !(path == root.trim_end_matches('/') || path.starts_with(root)) {
        return Err(anyhow!("internal storage path is outside the bucket jail"));
    }
    let lower = path.to_ascii_lowercase();
    if lower.contains("%2e%2e")
        || lower.contains("%252e%252e")
        || path.split('/').any(|segment| segment == "..")
    {
        return Err(anyhow!("internal storage path traversal denied"));
    }
    Ok(())
}

async fn read_body_limited(body: Body, limit: usize) -> Result<Bytes> {
    let mut stream = body.into_data_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        if out.len().saturating_add(chunk.len()) > limit {
            return Err(anyhow!("internal storage delete body is too large"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(Bytes::from(out))
}

fn delete_body_keys(body: &[u8], root: &str) -> Result<Vec<String>> {
    let xml = std::str::from_utf8(body).context("internal storage delete body is not UTF-8")?;
    let mut rest = xml;
    let mut keys = Vec::new();
    while let Some(start) = rest.find("<Key>") {
        let value_start = start + "<Key>".len();
        let after = &rest[value_start..];
        let end = after
            .find("</Key>")
            .ok_or_else(|| anyhow!("internal storage delete XML is malformed"))?;
        let key = xml_unescape(&after[..end]);
        ensure_jailed(&key, root)?;
        keys.push(key);
        if keys.len() > 1_000 {
            return Err(anyhow!("internal storage delete contains too many keys"));
        }
        rest = &after[end + "</Key>".len()..];
    }
    if keys.is_empty() {
        return Err(anyhow!("internal storage delete contains no keys"));
    }
    Ok(keys)
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn decode_header(headers: &HeaderMap, name: &str) -> Result<String> {
    decode_value(required_header(headers, name)?)
}

fn decode_value(value: &str) -> Result<String> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .context("internal storage base64url header is invalid")?;
    if decoded.len() > MAX_INTERNAL_PATH_BYTES {
        return Err(anyhow!("internal storage encoded path is too large"));
    }
    String::from_utf8(decoded).context("internal storage encoded path is not UTF-8")
}

fn parse_upstream_method(value: &str) -> Result<Method> {
    match value {
        "GET" => Ok(Method::GET),
        "HEAD" => Ok(Method::HEAD),
        "PUT" => Ok(Method::PUT),
        "POST" => Ok(Method::POST),
        "DELETE" => Ok(Method::DELETE),
        _ => Err(anyhow!("internal storage method is not allowed")),
    }
}

fn required_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str> {
    header_value(headers, name)
        .ok_or_else(|| anyhow!("required internal storage header is missing"))
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.to_str().ok())
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn empty(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn internal_paths_must_stay_inside_authoritative_root() {
        let root = "users/u1/photos/";
        assert!(ensure_jailed("users/u1/photos/a.jpg?x=1", root).is_ok());
        assert!(ensure_jailed("users/u1/photos2/a.jpg", root).is_err());
        assert!(ensure_jailed("users/u1/photos/%2e%2e/secret", root).is_err());
        assert!(ensure_jailed("https://attacker.invalid/", root).is_err());
    }

    #[test]
    fn computes_system_and_user_roots() {
        assert_eq!(
            authoritative_root("docs", None, true).unwrap(),
            "system/docs/"
        );
        assert_eq!(
            authoritative_root("photos", Some("user/1"), false).unwrap(),
            "users/user_1/photos/"
        );
    }

    #[test]
    fn allows_only_jailed_bucket_level_list_and_delete() {
        let root = "users/u1/photos/";
        assert_eq!(
            validate_path_operation(
                &Method::GET,
                "?list-type=2&prefix=users%2Fu1%2Fphotos%2F",
                root,
            )
            .unwrap(),
            PathOperation::BucketList
        );
        assert_eq!(
            validate_path_operation(&Method::POST, "?delete", root).unwrap(),
            PathOperation::BucketDelete
        );
        assert!(
            validate_path_operation(&Method::GET, "?list-type=2&prefix=users%2Fu2%2F", root,)
                .is_err()
        );
        assert!(validate_path_operation(&Method::PUT, "?acl", root).is_err());
    }
}

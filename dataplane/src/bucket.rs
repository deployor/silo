use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, Response, StatusCode},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::{response::with_s3_headers, AppState, AuthorizeResponse};

pub(crate) async fn fast_list_buckets(
    state: AppState,
    auth: AuthorizeResponse,
) -> Result<Response<Body>> {
    let Some(user) = auth.user.as_ref() else {
        return Ok(access_denied());
    };
    let rows = sqlx::query(
        "SELECT name, created_at FROM buckets WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(&user.id)
    .fetch_all(&state.pg)
    .await?;
    let mut buckets_xml = String::new();
    for row in rows {
        let name: String = row.try_get("name")?;
        let created_at: Option<chrono::NaiveDateTime> = row.try_get("created_at")?;
        let created_at = created_at
            .map(|value| value.and_utc().to_rfc3339())
            .unwrap_or_else(|| chrono::Utc::now().to_rfc3339());
        buckets_xml.push_str("<Bucket><Name>");
        buckets_xml.push_str(&xml_escape(&name));
        buckets_xml.push_str("</Name><CreationDate>");
        buckets_xml.push_str(&created_at);
        buckets_xml.push_str("</CreationDate></Bucket>");
    }

    let body = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<ListAllMyBucketsResult><Owner><ID>{}</ID><DisplayName>{}</DisplayName></Owner><Buckets>{}</Buckets></ListAllMyBucketsResult>",
        xml_escape(&user.id),
        xml_escape(&user.id),
        buckets_xml
    );
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/xml")
            .body(Body::from(body))?,
        &auth,
    ))
}

pub(crate) async fn fast_get_bucket_cors(
    state: AppState,
    auth: AuthorizeResponse,
) -> Result<Response<Body>> {
    let Some(bucket) = auth.bucket.as_ref() else {
        return Ok(access_denied());
    };
    let cors_config = sqlx::query_scalar::<_, Option<String>>(
        "SELECT cors_config FROM buckets WHERE id = $1::uuid LIMIT 1",
    )
    .bind(&bucket.id)
    .fetch_optional(&state.pg)
    .await?
    .flatten();
    let config = parse_stored_cors(cors_config.as_deref());
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", "application/xml")
            .body(Body::from(cors_config_to_xml(&config)))?,
        &auth,
    ))
}

pub(crate) async fn fast_put_bucket_cors(
    state: AppState,
    auth: AuthorizeResponse,
    body: Body,
) -> Result<Response<Body>> {
    let Some(bucket) = auth.bucket.as_ref() else {
        return Ok(access_denied());
    };
    let bytes = read_body_limited(body, 1024 * 1024).await?;
    let xml = std::str::from_utf8(&bytes).map_err(|_| anyhow!("cors xml is not utf-8"))?;
    let config = match parse_cors_xml(xml) {
        Ok(config) => config,
        Err(_) => {
            return Ok(with_s3_headers(
                s3_error_response(StatusCode::BAD_REQUEST, "MalformedXML", "The XML you provided was not well-formed or did not validate against our published schema."),
                &auth,
            ));
        }
    };
    sqlx::query("UPDATE buckets SET cors_config = $1 WHERE id = $2::uuid")
        .bind(serde_json::to_string(&config)?)
        .bind(&bucket.id)
        .execute(&state.pg)
        .await?;
    invalidate_bucket_auth_cache(&state, &bucket.id, &bucket.name).await;
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::OK)
            .body(Body::empty())?,
        &auth,
    ))
}

pub(crate) async fn fast_delete_bucket_cors(
    state: AppState,
    auth: AuthorizeResponse,
) -> Result<Response<Body>> {
    let Some(bucket) = auth.bucket.as_ref() else {
        return Ok(access_denied());
    };
    sqlx::query("UPDATE buckets SET cors_config = NULL WHERE id = $1::uuid")
        .bind(&bucket.id)
        .execute(&state.pg)
        .await?;
    invalidate_bucket_auth_cache(&state, &bucket.id, &bucket.name).await;
    Ok(with_s3_headers(
        Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())?,
        &auth,
    ))
}

pub(crate) async fn fast_options(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let Some(bucket) = auth.bucket.as_ref() else {
        return Ok(access_denied());
    };
    let origin = header_value(headers, "origin");
    let request_method = header_value(headers, "access-control-request-method");
    let request_headers = header_value(headers, "access-control-request-headers");
    let fallback = preflight_fallback_headers(origin);

    let (Some(origin), Some(request_method)) = (origin, request_method) else {
        return Ok(Response::builder()
            .status(StatusCode::FORBIDDEN)
            .body(Body::empty())?);
    };

    let cors_config = sqlx::query_scalar::<_, Option<String>>(
        "SELECT cors_config FROM buckets WHERE id = $1::uuid LIMIT 1",
    )
    .bind(&bucket.id)
    .fetch_optional(&state.pg)
    .await?
    .flatten();
    let config = parse_stored_cors(cors_config.as_deref());
    let Some(rule) = config.cors_rules.iter().find(|rule| {
        matches_exact_or_wildcard(origin, &rule.allowed_origins)
            && matches_exact_or_wildcard(request_method, &rule.allowed_methods)
            && headers_allowed(request_headers, rule.allowed_headers.as_deref())
    }) else {
        return response_with_headers(StatusCode::FORBIDDEN, fallback);
    };

    let mut out = BTreeMap::new();
    if rule.allowed_origins.len() == 1 && rule.allowed_origins[0] == "*" {
        out.insert("access-control-allow-origin".to_string(), "*".to_string());
    } else {
        out.insert(
            "access-control-allow-origin".to_string(),
            origin.to_string(),
        );
    }
    out.insert(
        "access-control-allow-methods".to_string(),
        rule.allowed_methods.join(", "),
    );
    if let Some(allowed_headers) = rule.allowed_headers.as_ref() {
        if allowed_headers.iter().any(|h| h == "*") {
            if let Some(request_headers) = request_headers {
                out.insert(
                    "access-control-allow-headers".to_string(),
                    request_headers.to_string(),
                );
            }
        } else {
            out.insert(
                "access-control-allow-headers".to_string(),
                allowed_headers.join(", "),
            );
        }
    }
    if let Some(expose_headers) = rule.expose_headers.as_ref() {
        if !expose_headers.is_empty() {
            out.insert(
                "access-control-expose-headers".to_string(),
                expose_headers.join(", "),
            );
        }
    }
    if let Some(max_age) = rule.max_age_seconds {
        out.insert("access-control-max-age".to_string(), max_age.to_string());
    }
    out.insert(
        "vary".to_string(),
        "Origin, Access-Control-Request-Headers, Access-Control-Request-Method".to_string(),
    );
    response_with_headers(StatusCode::OK, out)
}

async fn invalidate_bucket_auth_cache(state: &AppState, bucket_id: &str, bucket_name: &str) {
    let mut conn = state.redis.clone();
    let access_keys = sqlx::query_scalar::<_, String>(
        "SELECT access_key FROM bucket_keys WHERE bucket_id = $1::uuid",
    )
    .bind(bucket_id)
    .fetch_all(&state.pg)
    .await
    .unwrap_or_default();
    let mut pipe = redis::pipe();
    pipe.del(format!("auth:rust:pub:{bucket_name}"));
    for access_key in access_keys {
        pipe.del(format!("auth:rust:key:{access_key}"));
    }
    let _: redis::RedisResult<()> = pipe.query_async(&mut conn).await;
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

fn parse_stored_cors(raw: Option<&str>) -> CorsConfiguration {
    raw.and_then(|raw| serde_json::from_str::<CorsConfiguration>(raw).ok())
        .filter(|config| !config.cors_rules.is_empty())
        .unwrap_or_else(|| CorsConfiguration {
            cors_rules: Vec::new(),
        })
}

fn parse_cors_xml(xml: &str) -> Result<CorsConfiguration> {
    let rules = extract_blocks(xml, "CORSRule")
        .into_iter()
        .map(|block| {
            let allowed_origins = extract_tags(block, "AllowedOrigin");
            let allowed_methods = extract_tags(block, "AllowedMethod");
            if allowed_origins.is_empty() || allowed_methods.is_empty() {
                return Err(anyhow!("missing required CORS tags"));
            }
            Ok(CorsRule {
                id: extract_first_tag(block, "ID"),
                allowed_origins,
                allowed_methods,
                allowed_headers: nonempty(extract_tags(block, "AllowedHeader")),
                expose_headers: nonempty(extract_tags(block, "ExposeHeader")),
                max_age_seconds: extract_first_tag(block, "MaxAgeSeconds")
                    .and_then(|v| v.parse::<u32>().ok()),
            })
        })
        .collect::<Result<Vec<_>>>()?;
    if rules.is_empty() {
        return Err(anyhow!("missing CORSRule"));
    }
    Ok(CorsConfiguration { cors_rules: rules })
}

fn cors_config_to_xml(config: &CorsConfiguration) -> String {
    let mut out = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CORSConfiguration xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">".to_string();
    for rule in &config.cors_rules {
        out.push_str("<CORSRule>");
        if let Some(id) = rule.id.as_ref() {
            out.push_str("<ID>");
            out.push_str(&xml_escape(id));
            out.push_str("</ID>");
        }
        for origin in &rule.allowed_origins {
            out.push_str("<AllowedOrigin>");
            out.push_str(&xml_escape(origin));
            out.push_str("</AllowedOrigin>");
        }
        for method in &rule.allowed_methods {
            out.push_str("<AllowedMethod>");
            out.push_str(&xml_escape(method));
            out.push_str("</AllowedMethod>");
        }
        if let Some(headers) = rule.allowed_headers.as_ref() {
            for header in headers {
                out.push_str("<AllowedHeader>");
                out.push_str(&xml_escape(header));
                out.push_str("</AllowedHeader>");
            }
        }
        if let Some(headers) = rule.expose_headers.as_ref() {
            for header in headers {
                out.push_str("<ExposeHeader>");
                out.push_str(&xml_escape(header));
                out.push_str("</ExposeHeader>");
            }
        }
        if let Some(max_age) = rule.max_age_seconds {
            out.push_str("<MaxAgeSeconds>");
            out.push_str(&max_age.to_string());
            out.push_str("</MaxAgeSeconds>");
        }
        out.push_str("</CORSRule>");
    }
    out.push_str("</CORSConfiguration>");
    out
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

fn extract_tags(block: &str, tag: &str) -> Vec<String> {
    extract_blocks(block, tag)
        .into_iter()
        .map(xml_unescape)
        .collect()
}

fn extract_first_tag(block: &str, tag: &str) -> Option<String> {
    extract_tags(block, tag).into_iter().next()
}

fn nonempty(values: Vec<String>) -> Option<Vec<String>> {
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.to_str().ok())
}

fn preflight_fallback_headers(origin: Option<&str>) -> BTreeMap<String, String> {
    let mut headers = BTreeMap::new();
    if origin.is_some() {
        headers.insert("access-control-allow-origin".to_string(), "*".to_string());
    }
    headers.insert(
        "vary".to_string(),
        "Origin, Access-Control-Request-Headers, Access-Control-Request-Method".to_string(),
    );
    headers
}

fn response_with_headers(
    status: StatusCode,
    headers: BTreeMap<String, String>,
) -> Result<Response<Body>> {
    let mut builder = Response::builder().status(status);
    for (key, value) in headers {
        builder = builder.header(key, value);
    }
    Ok(builder.body(Body::empty())?)
}

fn headers_allowed(request_headers: Option<&str>, allowed_headers: Option<&[String]>) -> bool {
    let Some(request_headers) = request_headers else {
        return true;
    };
    let Some(allowed_headers) = allowed_headers else {
        return false;
    };
    request_headers
        .split(',')
        .map(str::trim)
        .filter(|header| !header.is_empty())
        .all(|header| matches_exact_or_wildcard_case_insensitive(header, allowed_headers))
}

fn matches_exact_or_wildcard(value: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|item| item == "*" || item == value)
}

fn matches_exact_or_wildcard_case_insensitive(value: &str, allowed: &[String]) -> bool {
    allowed
        .iter()
        .any(|item| item == "*" || item.eq_ignore_ascii_case(value))
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

fn access_denied() -> Response<Body> {
    s3_error_response(StatusCode::FORBIDDEN, "AccessDenied", "Access Denied")
}

fn s3_error_response(status: StatusCode, code: &str, message: &str) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/xml")
        .body(Body::from(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{code}</Code><Message>{message}</Message></Error>"
        )))
        .unwrap()
}

#[derive(Debug, Deserialize, Serialize)]
struct CorsConfiguration {
    #[serde(rename = "CORSRules")]
    cors_rules: Vec<CorsRule>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CorsRule {
    #[serde(rename = "ID", skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    #[serde(rename = "AllowedOrigins")]
    allowed_origins: Vec<String>,
    #[serde(rename = "AllowedMethods")]
    allowed_methods: Vec<String>,
    #[serde(
        rename = "AllowedHeaders",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    allowed_headers: Option<Vec<String>>,
    #[serde(
        rename = "ExposeHeaders",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    expose_headers: Option<Vec<String>>,
    #[serde(
        rename = "MaxAgeSeconds",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    max_age_seconds: Option<u32>,
}

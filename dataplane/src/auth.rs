use std::collections::BTreeMap;

use anyhow::{anyhow, Result};
use axum::http::{header, HeaderMap, Method, StatusCode};
use chrono::{DateTime, NaiveDateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tracing::warn;
use url::Url;

use crate::{AppState, AuthBucket, AuthUser, AuthorizeResponse};

type HmacSha256 = Hmac<Sha256>;

const AWS_ALGORITHM: &str = "AWS4-HMAC-SHA256";
const AUTH_CACHE_TTL_SECONDS: u64 = 15;
const HEADER_AUTH_MAX_SKEW_SECONDS: i64 = 15 * 60;
const PRESIGNED_MAX_EXPIRES_SECONDS: i64 = 7 * 24 * 60 * 60;
const AUTH_QUERY_PARAMS: &[&str] = &[
    "X-Amz-Signature",
    "X-Amz-Credential",
    "X-Amz-Date",
    "X-Amz-Algorithm",
    "X-Amz-SignedHeaders",
    "X-Amz-Security-Token",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-date",
    "x-amz-algorithm",
    "x-amz-signedheaders",
    "x-amz-security-token",
    "X-Amz-Expires",
    "x-amz-expires",
];

/// Evict all locally cached authorization contexts named by the global
/// control plane. This intentionally returns no existence information to its
/// caller; revocation fanout is safe to repeat on every regional Dragonfly.
pub(crate) async fn invalidate_cached_contexts(
    state: &AppState,
    bucket_id: Option<&str>,
    bucket_name: Option<&str>,
    access_keys: &[String],
) -> Result<()> {
    let mut names = bucket_name
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut keys = access_keys.to_vec();

    if let Some(bucket_id) = bucket_id {
        let row =
            sqlx::query_scalar::<_, String>("SELECT name FROM buckets WHERE id = $1::uuid LIMIT 1")
                .bind(bucket_id)
                .fetch_optional(&state.pg)
                .await?;
        if let Some(name) = row {
            names.push(name);
        }
        keys.extend(
            sqlx::query_scalar::<_, String>(
                "SELECT access_key FROM bucket_keys WHERE bucket_id = $1::uuid",
            )
            .bind(bucket_id)
            .fetch_all(&state.pg)
            .await?,
        );
    }

    if let Some(bucket_name) = bucket_name {
        keys.extend(
            sqlx::query_scalar::<_, String>(
                r#"
                SELECT k.access_key
                FROM bucket_keys k
                JOIN buckets b ON b.id = k.bucket_id
                WHERE b.name = $1
                "#,
            )
            .bind(bucket_name)
            .fetch_all(&state.pg)
            .await?,
        );
    }

    names.sort_unstable();
    names.dedup();
    keys.sort_unstable();
    keys.dedup();
    let cache_region = state.cfg.regions.local_region();
    let mut pipe = redis::pipe();
    for name in names {
        pipe.del(format!("auth:rust:{cache_region}:pub:{name}"));
        // Rollout compatibility with the pre-regional namespace.
        pipe.del(format!("auth:rust:pub:{name}"));
    }
    for access_key in keys {
        pipe.del(format!("auth:rust:{cache_region}:key:{access_key}"));
        pipe.del(format!("auth:rust:key:{access_key}"));
    }
    let Some(mut conn) = state.redis.connection().await else {
        return Ok(());
    };
    if let Err(error) = pipe.query_async::<()>(&mut conn).await {
        warn!(error = %error, "auth cache invalidation failed");
    }
    Ok(())
}

pub(crate) async fn authorize_direct(
    state: &AppState,
    method: &Method,
    url: &str,
    headers: &HeaderMap,
) -> Result<Option<AuthorizeResponse>> {
    let url = Url::parse(url)?;
    let requested_bucket = bucket_from_request(state, &url);

    let credential = credential_from_request(&url, headers);
    if credential.is_none() && requested_bucket.is_none() {
        if state.cfg.custom_domains_enabled {
            return Ok(None);
        }
        return Ok(Some(deny(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    }

    let context = if let Some(credential) = credential {
        signed_context(
            state,
            method,
            &url,
            headers,
            requested_bucket.as_deref(),
            &credential,
        )
        .await?
    } else {
        let Some(requested_bucket) = requested_bucket.as_deref() else {
            return Ok(Some(deny(
                StatusCode::FORBIDDEN,
                "AccessDenied",
                "Access Denied",
            )));
        };
        public_context(state, method, &url, requested_bucket).await?
    };

    let Some(context) = context else {
        return Ok(None);
    };
    if let Some(denied) = context.denied {
        return Ok(Some(denied));
    }

    let key = if requested_bucket.is_some() {
        match key_from_request(state, &url, &context.bucket.name) {
            Ok(key) => key,
            Err(_) => {
                return Ok(Some(deny(
                    StatusCode::FORBIDDEN,
                    "AccessDenied",
                    "Access Denied",
                )))
            }
        }
    } else {
        String::new()
    };
    let action = if requested_bucket.is_none()
        && method == Method::GET
        && url.path() == "/"
        && url.query().is_none()
    {
        "ListBuckets"
    } else {
        determine_action(method, &key, &url, headers)
    };
    if action == "Unknown" {
        return Ok(Some(deny(
            StatusCode::METHOD_NOT_ALLOWED,
            "MethodNotAllowed",
            "The specified method is not allowed against this resource.",
        )));
    }
    if !fast_action(action) {
        return Ok(Some(AuthorizeResponse {
            allowed: true,
            status: None,
            body: None,
            fast_path: Some(false),
            action: Some(action.to_string()),
            key: Some(key),
            path_with_query: None,
            root_prefix: None,
            part_number: None,
            upload_id: None,
            cors_headers: None,
            bucket: None,
            user: None,
        }));
    }
    if context.mode == AuthMode::Public
        && !matches!(
            action,
            "GetObject" | "HeadObject" | "ListObjectsV2" | "Options"
        )
    {
        return Ok(Some(deny(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    }
    if context.mode == AuthMode::OffboardingExport
        && !matches!(
            action,
            "GetBucketLocation"
                | "GetObject"
                | "HeadBucket"
                | "HeadObject"
                | "ListBuckets"
                | "ListObjectsV2"
        )
    {
        return Ok(Some(deny(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Offboarding export credentials are read-only.",
        )));
    }
    if let Some(user) = context.user.as_ref() {
        if (user.data_exported || user.files_deleted)
            && method != Method::GET
            && method != Method::HEAD
        {
            return Ok(Some(deny(
                StatusCode::FORBIDDEN,
                "AccessDenied",
                "Account is frozen. Modifications are disabled.",
            )));
        }
    }
    if requires_authenticated_user(action) && context.user.is_none() {
        return Ok(Some(deny(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    }
    if let Some(user) = context.user.as_ref() {
        if user.marked_as_over_age
            && !user.is_immortal
            && !matches!(
                action,
                "GetBucketLocation"
                    | "GetObject"
                    | "HeadBucket"
                    | "HeadObject"
                    | "ListObjectsV2"
                    | "ListBuckets"
            )
        {
            return Ok(Some(deny(
                StatusCode::FORBIDDEN,
                "AccessDenied",
                "Account is in migration grace period. New uploads are disabled.",
            )));
        }
    }

    let auth_user = context.user.as_ref().map(|u| AuthUser {
        id: u.id.clone(),
        is_immortal: u.is_immortal,
    });
    let root_prefix = internal_path("", auth_user.as_ref(), &context.bucket)?;
    let internal_path = if action == "ListBuckets" {
        root_prefix.clone()
    } else {
        internal_path(&key, auth_user.as_ref(), &context.bucket)?
    };
    if let Some(allowed_prefix) = context.allowed_prefix.as_deref() {
        if !root_prefix.starts_with(allowed_prefix) || !internal_path.starts_with(allowed_prefix) {
            return Ok(Some(deny(
                StatusCode::FORBIDDEN,
                "AccessDenied",
                "The export credential cannot access this prefix.",
            )));
        }
    }
    let query = stripped_query(&url);
    let path_with_query = if query.is_empty() {
        internal_path
    } else {
        format!("{internal_path}?{query}")
    };

    Ok(Some(AuthorizeResponse {
        allowed: true,
        status: None,
        body: None,
        fast_path: Some(true),
        action: Some(action.to_string()),
        key: Some(key),
        path_with_query: Some(path_with_query),
        root_prefix: Some(root_prefix),
        part_number: query_param(&url, "partNumber"),
        upload_id: query_param(&url, "uploadId"),
        cors_headers: Some(cors_headers(
            headers,
            method,
            context.bucket.cors_config.as_deref(),
        )),
        bucket: Some(AuthBucket {
            id: context.bucket.id,
            name: context.bucket.name,
            resolved_region: context.bucket.resolved_region,
            active_backend: None,
            writer_generation: None,
        }),
        user: auth_user,
    }))
}

async fn signed_context(
    state: &AppState,
    method: &Method,
    url: &Url,
    headers: &HeaderMap,
    requested_bucket: Option<&str>,
    credential: &str,
) -> Result<Option<AuthContext>> {
    let parts = credential.split('/').collect::<Vec<_>>();
    let Some(access_key) = parts.first().copied() else {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    };
    if parts.get(3).copied() != Some("s3") {
        return Ok(Some(deny_context(
            StatusCode::BAD_REQUEST,
            "InvalidRequest",
            "Invalid Service",
        )));
    }

    let context = match get_signed_auth_context(state, access_key).await? {
        Some(context) => context,
        None if access_key.starts_with("ox_") => {
            let Some(context) =
                get_offboarding_export_auth_context(state, access_key, requested_bucket).await?
            else {
                return Ok(None);
            };
            context
        }
        None => return Ok(None),
    };
    if requested_bucket.is_some_and(|requested_bucket| requested_bucket != context.bucket.name) {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    }
    let Some(key) = context.key.as_ref() else {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "InvalidAccessKeyId",
            "The AWS Access Key Id you provided does not exist in our records.",
        )));
    };
    if !verify_aws_v4_signature(method, url, headers, &key.secret_key)? {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "SignatureDoesNotMatch",
            "The request signature we calculated does not match the signature you provided.",
        )));
    }
    if context.mode == AuthMode::OffboardingExport {
        return Ok(Some(context));
    }
    apply_policy(state, context, true)
}

async fn public_context(
    state: &AppState,
    method: &Method,
    url: &Url,
    requested_bucket: &str,
) -> Result<Option<AuthContext>> {
    if method != Method::GET && method != Method::HEAD && method != Method::OPTIONS {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    }

    let Some(context) = get_public_auth_context(state, requested_bucket).await? else {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    };
    if !context.bucket.is_public && has_dashboard_signed_preview(url) {
        return Ok(None);
    }
    if !context.bucket.is_public {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    }
    apply_policy(state, context, false)
}

fn apply_policy(
    state: &AppState,
    context: AuthContext,
    signed: bool,
) -> Result<Option<AuthContext>> {
    if let Some(user) = context.user.as_ref() {
        if user.is_locked {
            return Ok(Some(deny_context(
                StatusCode::FORBIDDEN,
                "AccessDenied",
                "Account is temporarily locked.",
            )));
        }
    } else if !context.bucket.is_system {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        )));
    }

    if context.bucket.is_paused {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            &paused_message("Bucket", context.bucket.pause_reason.as_deref()),
        )));
    }
    if let Some(message) = deep_freeze_message(state, &context.bucket) {
        return Ok(Some(deny_context(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            &message,
        )));
    }
    if signed {
        if let Some(key) = context.key.as_ref() {
            if key.is_paused {
                return Ok(Some(deny_context(
                    StatusCode::FORBIDDEN,
                    "AccessDenied",
                    &paused_message("Access Key", key.pause_reason.as_deref()),
                )));
            }
        }
    }
    Ok(Some(context))
}

fn deny_context(status: StatusCode, code: &str, message: &str) -> AuthContext {
    AuthContext {
        mode: AuthMode::Denied,
        bucket: BucketAuth {
            id: String::new(),
            name: String::new(),
            resolved_region: crate::default_storage_region(),
            user_id: None,
            is_public: false,
            is_system: false,
            is_paused: false,
            pause_reason: None,
            deep_freeze_state: "active".to_string(),
            deep_freeze_reason: None,
            cors_config: None,
        },
        user: None,
        key: None,
        allowed_prefix: None,
        denied: Some(deny(status, code, message)),
    }
}

async fn get_signed_auth_context(
    state: &AppState,
    access_key: &str,
) -> Result<Option<AuthContext>> {
    let cache_key = format!(
        "auth:rust:{}:key:{access_key}",
        state.cfg.regions.local_region()
    );
    if let Some(context) = get_cached_context(state, &cache_key).await {
        return Ok(Some(context));
    }

    let row = sqlx::query(
        r#"
        SELECT
          b.id::text AS bucket_id, b.name AS bucket_name, b.resolved_region,
          b.user_id, b.is_public, b.is_system,
          b.is_paused AS bucket_is_paused, b.pause_reason AS bucket_pause_reason,
          b.deep_freeze_state, b.deep_freeze_reason, b.cors_config,
          u.id AS user_id,
          COALESCE(NULLIF(u.storage_limit_bytes, 0), (SELECT default_storage_limit_bytes FROM app_settings LIMIT 1), 1073741824) AS storage_limit_bytes,
          COALESCE((SELECT SUM(owned.total_bytes) FROM buckets owned WHERE owned.user_id = u.id), 0) AS storage_usage_bytes,
          u.egress_limit_bytes,
          u.egress_bytes, u.egress_period, u.is_immortal, u.is_locked, u.marked_as_over_age,
          u.data_exported, u.files_deleted,
          k.secret_key, k.is_paused AS key_is_paused, k.pause_reason AS key_pause_reason
        FROM bucket_keys k
        JOIN buckets b ON k.bucket_id = b.id
        JOIN users u ON b.user_id = u.id
        WHERE k.access_key = $1
        LIMIT 1
        "#,
    )
    .bind(access_key)
    .fetch_optional(&state.pg)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let context = AuthContext {
        mode: AuthMode::Authenticated,
        bucket: bucket_from_row(&row),
        user: Some(user_from_row(&row)),
        key: Some(KeyAuth {
            secret_key: row.try_get("secret_key")?,
            is_paused: row.try_get("key_is_paused")?,
            pause_reason: row.try_get("key_pause_reason")?,
        }),
        allowed_prefix: None,
        denied: None,
    };
    set_cached_context(state, &cache_key, &context).await;
    Ok(Some(context))
}

async fn get_offboarding_export_auth_context(
    state: &AppState,
    access_key: &str,
    requested_bucket: Option<&str>,
) -> Result<Option<AuthContext>> {
    let Some(derivation_secret) = state.cfg.offboarding_export_derivation_secret.as_deref() else {
        // A regional deployment without this secret safely falls back to the
        // Bun control-plane authorizer instead of accepting an unverifiable
        // export credential.
        return Ok(None);
    };
    let row = sqlx::query(
        r#"
        SELECT
          s.id::text AS export_session_id, s.secret_key_hash, s.allowed_prefix,
          b.id::text AS bucket_id, b.name AS bucket_name, b.resolved_region,
          b.user_id, b.is_public, b.is_system,
          b.is_paused AS bucket_is_paused, b.pause_reason AS bucket_pause_reason,
          b.deep_freeze_state, b.deep_freeze_reason, b.cors_config,
          u.id AS user_id,
          COALESCE(NULLIF(u.storage_limit_bytes, 0),
            (SELECT default_storage_limit_bytes FROM app_settings LIMIT 1),
            1073741824) AS storage_limit_bytes,
          COALESCE((SELECT SUM(owned.total_bytes) FROM buckets owned WHERE owned.user_id = u.id), 0) AS storage_usage_bytes,
          u.egress_limit_bytes, u.egress_bytes, u.egress_period,
          u.is_immortal, u.is_locked, u.marked_as_over_age,
          u.data_exported, u.files_deleted
        FROM offboarding_export_sessions s
        JOIN users u ON u.id = s.user_id
        JOIN buckets b ON b.user_id = u.id
        WHERE s.access_key = $1
          AND s.revoked_at IS NULL
          AND s.download_completed_at IS NULL
          AND s.expires_at > now()
          AND ($2::text IS NULL OR b.name = $2)
        ORDER BY b.created_at ASC
        LIMIT 1
        "#,
    )
    .bind(access_key)
    .bind(requested_bucket)
    .fetch_optional(&state.pg)
    .await?;
    let Some(row) = row else {
        return Ok(None);
    };

    let derived_secret = derive_offboarding_secret(derivation_secret, access_key)?;
    let derived_hash = hex::encode(Sha256::digest(derived_secret.as_bytes()));
    let stored_hash: String = row.try_get("secret_key_hash")?;
    if !constant_time_hex_eq(&derived_hash, &stored_hash) {
        warn!("offboarding export secret derivation does not match its stored hash");
        return Ok(None);
    }

    let user_id: String = row.try_get("user_id")?;
    let expected_prefix = format!("users/{}/", sanitize_user_id(&user_id));
    let stored_prefix: String = row.try_get("allowed_prefix")?;
    let allowed_prefix = format!("{}/", stored_prefix.trim_end_matches('/'));
    if allowed_prefix != expected_prefix {
        warn!("offboarding export session has an invalid allowed prefix");
        return Ok(None);
    }

    let session_id: String = row.try_get("export_session_id")?;
    sqlx::query(
        r#"
        UPDATE offboarding_export_sessions
        SET used_at = COALESCE(used_at, now()), last_accessed_at = now(), updated_at = now()
        WHERE id = $1::uuid
          AND (last_accessed_at IS NULL OR last_accessed_at < now() - interval '1 minute')
        "#,
    )
    .bind(&session_id)
    .execute(&state.pg)
    .await?;

    Ok(Some(AuthContext {
        mode: AuthMode::OffboardingExport,
        bucket: bucket_from_row(&row),
        user: Some(user_from_row(&row)),
        key: Some(KeyAuth {
            secret_key: derived_secret,
            is_paused: false,
            pause_reason: None,
        }),
        allowed_prefix: Some(allowed_prefix),
        denied: None,
    }))
}

fn derive_offboarding_secret(derivation_secret: &str, access_key: &str) -> Result<String> {
    let mut mac = HmacSha256::new_from_slice(derivation_secret.as_bytes())?;
    mac.update(format!("offboarding-export:{access_key}").as_bytes());
    Ok(hex::encode(mac.finalize().into_bytes()))
}

async fn get_public_auth_context(
    state: &AppState,
    bucket_name: &str,
) -> Result<Option<AuthContext>> {
    let cache_key = format!(
        "auth:rust:{}:pub:{bucket_name}",
        state.cfg.regions.local_region()
    );
    if let Some(context) = get_cached_context(state, &cache_key).await {
        return Ok(Some(context));
    }

    let row = sqlx::query(
        r#"
        SELECT
          b.id::text AS bucket_id, b.name AS bucket_name, b.resolved_region,
          b.user_id, b.is_public, b.is_system,
          b.is_paused AS bucket_is_paused, b.pause_reason AS bucket_pause_reason,
          b.deep_freeze_state, b.deep_freeze_reason, b.cors_config,
          u.id AS user_id,
          COALESCE(NULLIF(u.storage_limit_bytes, 0), (SELECT default_storage_limit_bytes FROM app_settings LIMIT 1), 1073741824) AS storage_limit_bytes,
          COALESCE((SELECT SUM(owned.total_bytes) FROM buckets owned WHERE owned.user_id = u.id), 0) AS storage_usage_bytes,
          u.egress_limit_bytes,
          u.egress_bytes, u.egress_period, u.is_immortal, u.is_locked, u.marked_as_over_age,
          u.data_exported, u.files_deleted
        FROM buckets b
        LEFT JOIN users u ON b.user_id = u.id
        WHERE b.name = $1
        LIMIT 1
        "#,
    )
    .bind(bucket_name)
    .fetch_optional(&state.pg)
    .await?;

    let Some(row) = row else {
        return Ok(None);
    };
    let context = AuthContext {
        mode: AuthMode::Public,
        bucket: bucket_from_row(&row),
        user: row
            .try_get::<Option<String>, _>("user_id")?
            .map(|_| user_from_row(&row)),
        key: None,
        allowed_prefix: None,
        denied: None,
    };
    set_cached_context(state, &cache_key, &context).await;
    Ok(Some(context))
}

async fn get_cached_context(state: &AppState, cache_key: &str) -> Option<AuthContext> {
    let mut conn = state.redis.connection().await?;
    let cached: redis::RedisResult<Option<String>> = redis::cmd("GET")
        .arg(cache_key)
        .query_async(&mut conn)
        .await;
    match cached {
        Ok(Some(value)) => serde_json::from_str(&value).ok(),
        Ok(None) => None,
        Err(error) => {
            warn!(error = %error, "auth cache read failed");
            None
        }
    }
}

async fn set_cached_context(state: &AppState, cache_key: &str, context: &AuthContext) {
    let Ok(value) = serde_json::to_string(context) else {
        return;
    };
    let Some(mut conn) = state.redis.connection().await else {
        return;
    };
    let result: redis::RedisResult<()> = redis::cmd("SETEX")
        .arg(cache_key)
        .arg(AUTH_CACHE_TTL_SECONDS)
        .arg(value)
        .query_async(&mut conn)
        .await;
    if let Err(error) = result {
        warn!(error = %error, "auth cache write failed");
    }
}

fn bucket_from_row(row: &sqlx::postgres::PgRow) -> BucketAuth {
    BucketAuth {
        id: row.try_get("bucket_id").unwrap_or_default(),
        name: row.try_get("bucket_name").unwrap_or_default(),
        resolved_region: row
            .try_get("resolved_region")
            .unwrap_or_else(|_| crate::default_storage_region()),
        user_id: row.try_get("user_id").unwrap_or(None),
        is_public: row.try_get("is_public").unwrap_or(false),
        is_system: row.try_get("is_system").unwrap_or(false),
        is_paused: row.try_get("bucket_is_paused").unwrap_or(false),
        pause_reason: row.try_get("bucket_pause_reason").unwrap_or(None),
        deep_freeze_state: row
            .try_get("deep_freeze_state")
            .unwrap_or_else(|_| "active".into()),
        deep_freeze_reason: row.try_get("deep_freeze_reason").unwrap_or(None),
        cors_config: row.try_get("cors_config").unwrap_or(None),
    }
}

fn user_from_row(row: &sqlx::postgres::PgRow) -> UserAuth {
    UserAuth {
        id: row.try_get("user_id").unwrap_or_default(),
        storage_limit_bytes: row.try_get("storage_limit_bytes").unwrap_or(None),
        storage_usage_bytes: row.try_get("storage_usage_bytes").unwrap_or(0),
        egress_limit_bytes: row.try_get("egress_limit_bytes").unwrap_or(None),
        egress_bytes: row.try_get("egress_bytes").unwrap_or(0),
        egress_period: row.try_get("egress_period").unwrap_or(None),
        is_immortal: row.try_get("is_immortal").unwrap_or(false),
        is_locked: row.try_get("is_locked").unwrap_or(false),
        marked_as_over_age: row.try_get("marked_as_over_age").unwrap_or(false),
        data_exported: row.try_get("data_exported").unwrap_or(false),
        files_deleted: row.try_get("files_deleted").unwrap_or(false),
    }
}

fn bucket_from_request(state: &AppState, url: &Url) -> Option<String> {
    bucket_from_request_for_domains(&state.cfg.s3_domain, &state.cfg.origin_domains, url)
}

fn bucket_from_request_for_domains(
    s3_domain: &str,
    origin_domains: &[String],
    url: &Url,
) -> Option<String> {
    let host = url_host(url);
    if is_path_style_host(s3_domain, origin_domains, &host)
        || (s3_domain == "localhost:3000" && host.starts_with("localhost"))
    {
        return url
            .path_segments()
            .and_then(|mut segments| segments.next())
            .filter(|bucket| !bucket.is_empty())
            .map(str::to_string);
    }
    None
}

fn key_from_request(_state: &AppState, url: &Url, bucket_name: &str) -> Result<String> {
    key_from_path_request(url, bucket_name)
}

fn key_from_path_request(url: &Url, bucket_name: &str) -> Result<String> {
    let path = url.path();
    let prefix = format!("/{bucket_name}/");
    let key = if path.starts_with(&prefix) {
        path[prefix.len()..].to_string()
    } else if path == "/" || path == format!("/{bucket_name}") {
        String::new()
    } else {
        path.trim_start_matches('/').to_string()
    };
    ensure_no_traversal(&key)?;
    Ok(key)
}

fn is_path_style_host(s3_domain: &str, origin_domains: &[String], host: &str) -> bool {
    host == s3_domain || origin_domains.iter().any(|domain| domain == host)
}

fn internal_path(key: &str, user: Option<&AuthUser>, bucket: &BucketAuth) -> Result<String> {
    ensure_no_traversal(key)?;
    let clean_key = key
        .trim_start_matches('/')
        .replace('?', "%3F")
        .replace('#', "%23")
        .replace('&', "%26");
    if bucket.is_system && bucket.user_id.is_none() {
        return Ok(format!("system/{}/{}", bucket.name, clean_key));
    }
    let Some(user) = user else {
        return Err(anyhow!("user required for non-system bucket"));
    };
    Ok(format!(
        "users/{}/{}/{}",
        sanitize_user_id(&user.id),
        bucket.name,
        clean_key
    ))
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

fn determine_action(method: &Method, key: &str, url: &Url, headers: &HeaderMap) -> &'static str {
    if method == Method::OPTIONS {
        return "Options";
    }
    if key.is_empty() {
        if method == Method::GET {
            if query_has(url, "location") {
                return "GetBucketLocation";
            }
            if query_has(url, "cors") {
                return "GetBucketCors";
            }
            if query_has(url, "uploads") {
                return "ListMultipartUploads";
            }
            return "ListObjectsV2";
        }
        if method == Method::HEAD {
            return "HeadBucket";
        }
        if method == Method::PUT && query_has(url, "cors") {
            return "PutBucketCors";
        }
        if method == Method::DELETE && query_has(url, "cors") {
            return "DeleteBucketCors";
        }
        if method == Method::POST && query_has(url, "delete") {
            return "DeleteObjects";
        }
    } else {
        if method == Method::GET {
            if query_has(url, "uploadId") {
                return "ListParts";
            }
            return "GetObject";
        }
        if method == Method::HEAD {
            return "HeadObject";
        }
        if method == Method::PUT {
            if query_has(url, "partNumber") && query_has(url, "uploadId") {
                return "UploadPart";
            }
            if headers.contains_key("x-amz-copy-source") {
                return "CopyObject";
            }
            return "PutObject";
        }
        if method == Method::DELETE {
            if query_has(url, "uploadId") {
                return "AbortMultipartUpload";
            }
            return "DeleteObject";
        }
        if method == Method::POST {
            if query_has(url, "uploads") {
                return "CreateMultipartUpload";
            }
            if query_has(url, "uploadId") {
                return "CompleteMultipartUpload";
            }
        }
    }
    "Unknown"
}

fn fast_action(action: &str) -> bool {
    matches!(
        action,
        "AbortMultipartUpload"
            | "CompleteMultipartUpload"
            | "CopyObject"
            | "CreateMultipartUpload"
            | "DeleteBucketCors"
            | "DeleteObject"
            | "DeleteObjects"
            | "GetBucketCors"
            | "GetBucketLocation"
            | "GetObject"
            | "HeadBucket"
            | "HeadObject"
            | "ListBuckets"
            | "ListMultipartUploads"
            | "ListObjectsV2"
            | "ListParts"
            | "Options"
            | "PutBucketCors"
            | "PutObject"
            | "UploadPart"
    )
}

fn requires_authenticated_user(action: &str) -> bool {
    matches!(
        action,
        "AbortMultipartUpload"
            | "CompleteMultipartUpload"
            | "CopyObject"
            | "CreateMultipartUpload"
            | "DeleteBucketCors"
            | "DeleteObject"
            | "DeleteObjects"
            | "PutBucketCors"
            | "PutObject"
            | "UploadPart"
    )
}

fn verify_aws_v4_signature(
    method: &Method,
    url: &Url,
    headers: &HeaderMap,
    secret_key: &str,
) -> Result<bool> {
    let Some(sig) = signature_parts(method, url, headers) else {
        return Ok(false);
    };
    if sig.algorithm != AWS_ALGORITHM || sig.signature.len() != 64 {
        return Ok(false);
    }
    if !signature_time_is_valid(&sig) {
        return Ok(false);
    }
    if !signed_headers_are_valid(headers, &sig.signed_headers) {
        return Ok(false);
    }

    let canonical_request = [
        sig.method.as_str(),
        &canonical_uri(url.path()),
        &canonical_query(url),
        &canonical_headers(url, headers, &sig.signed_headers),
        &sig.signed_headers.join(";"),
        &hashed_payload(url, headers),
    ]
    .join("\n");
    let hashed_canonical_request = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    let credential_parts = sig.credential.split('/').collect::<Vec<_>>();
    if credential_parts.len() != 5 || credential_parts[4] != "aws4_request" {
        return Ok(false);
    }
    let Some(signed_at) = parse_sigv4_time(&sig.date) else {
        return Ok(false);
    };
    if credential_parts[1] != signed_at.format("%Y%m%d").to_string() {
        return Ok(false);
    }
    let credential_scope = credential_parts[1..].join("/");
    let string_to_sign = [
        sig.algorithm.as_str(),
        sig.date.as_str(),
        credential_scope.as_str(),
        hashed_canonical_request.as_str(),
    ]
    .join("\n");
    let signing_key = signing_key(
        secret_key,
        credential_parts[1],
        credential_parts[2],
        credential_parts[3],
    )?;
    let mut mac = HmacSha256::new_from_slice(&signing_key)?;
    mac.update(string_to_sign.as_bytes());
    let calculated = hex::encode(mac.finalize().into_bytes());
    Ok(constant_time_hex_eq(&calculated, &sig.signature))
}

fn signature_parts(method: &Method, url: &Url, headers: &HeaderMap) -> Option<SignatureParts> {
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(params) = auth.strip_prefix(AWS_ALGORITHM) {
            let params = params.trim();
            let mut credential = String::new();
            let mut signed_headers = String::new();
            let mut signature = String::new();
            for pair in params.split(',').map(str::trim) {
                let (key, value) = pair.split_once('=')?;
                match key {
                    "Credential" => credential = value.to_string(),
                    "SignedHeaders" => signed_headers = value.to_string(),
                    "Signature" => signature = value.to_string(),
                    _ => {}
                }
            }
            let date = header_value_case_insensitive(headers, "x-amz-date")
                .or_else(|| {
                    headers
                        .get(header::DATE)
                        .and_then(|value| value.to_str().ok())
                })?
                .to_string();
            return Some(SignatureParts {
                method: method.as_str().to_string(),
                algorithm: AWS_ALGORITHM.to_string(),
                credential,
                signed_headers: signed_headers.split(';').map(str::to_string).collect(),
                signature,
                date,
                is_presigned: false,
                presigned_expires_seconds: None,
            });
        }
    }
    let signature = query_param(url, "X-Amz-Signature")?;
    Some(SignatureParts {
        method: method.as_str().to_string(),
        algorithm: query_param(url, "X-Amz-Algorithm").unwrap_or_else(|| AWS_ALGORITHM.to_string()),
        credential: query_param(url, "X-Amz-Credential")?,
        signed_headers: query_param(url, "X-Amz-SignedHeaders")?
            .split(';')
            .map(str::to_string)
            .collect(),
        signature,
        date: query_param(url, "X-Amz-Date")?,
        is_presigned: true,
        presigned_expires_seconds: query_param(url, "X-Amz-Expires").and_then(|v| v.parse().ok()),
    })
}

fn signature_time_is_valid(sig: &SignatureParts) -> bool {
    signature_time_is_valid_at(sig, Utc::now())
}

fn signature_time_is_valid_at(sig: &SignatureParts, now: DateTime<Utc>) -> bool {
    let Some(signed_at) = parse_sigv4_time(&sig.date) else {
        return false;
    };
    if sig.is_presigned {
        let Some(expires) = sig.presigned_expires_seconds else {
            return false;
        };
        if !(0..=PRESIGNED_MAX_EXPIRES_SECONDS).contains(&expires) {
            return false;
        }
        signed_at <= now + chrono::Duration::seconds(HEADER_AUTH_MAX_SKEW_SECONDS)
            && now <= signed_at + chrono::Duration::seconds(expires + HEADER_AUTH_MAX_SKEW_SECONDS)
    } else {
        let delta = now.signed_duration_since(signed_at).num_seconds().abs();
        delta <= HEADER_AUTH_MAX_SKEW_SECONDS
    }
}

fn signed_headers_are_valid(headers: &HeaderMap, signed_headers: &[String]) -> bool {
    if signed_headers.is_empty() || !signed_headers.iter().any(|h| h == "host") {
        return false;
    }
    let mut previous = "";
    for name in signed_headers {
        if name.is_empty()
            || !name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        {
            return false;
        }
        if !previous.is_empty() && previous >= name.as_str() {
            return false;
        }
        previous = name;
        if name != "host" && header_value_case_insensitive(headers, name).is_none() {
            return false;
        }
    }
    true
}

fn parse_sigv4_time(value: &str) -> Option<DateTime<Utc>> {
    if let Ok(value) = DateTime::parse_from_rfc2822(value) {
        return Some(value.with_timezone(&Utc));
    }
    NaiveDateTime::parse_from_str(value, "%Y%m%dT%H%M%SZ")
        .ok()
        .map(|value| value.and_utc())
}

fn credential_from_request(url: &Url, headers: &HeaderMap) -> Option<String> {
    if let Some(auth) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(params) = auth.strip_prefix(AWS_ALGORITHM) {
            let params = params.trim();
            for pair in params.split(',').map(str::trim) {
                if let Some(value) = pair.strip_prefix("Credential=") {
                    return Some(value.to_string());
                }
            }
        }
    }
    query_param(url, "X-Amz-Credential").or_else(|| query_param(url, "x-amz-credential"))
}

fn url_host(url: &Url) -> String {
    let mut host = url.host_str().unwrap_or("").to_string();
    if let Some(port) = url.port() {
        host.push(':');
        host.push_str(&port.to_string());
    }
    host
}

fn canonical_uri(path: &str) -> String {
    let path = if path.is_empty() { "/" } else { path };
    path.split('/')
        .map(preserve_pct_encoded_segment)
        .collect::<Vec<_>>()
        .join("/")
}

fn canonical_query(url: &Url) -> String {
    let Some(query) = url.query() else {
        return String::new();
    };
    let mut pairs = query
        .split('&')
        .filter_map(|kv| {
            let (key, value) = kv.split_once('=').unwrap_or((kv, ""));
            let key = percent_decode_query(key)?;
            if key == "X-Amz-Signature" {
                return None;
            }
            let value = percent_decode_query(value)?;
            Some((uri_encode(&key), uri_encode(&value)))
        })
        .collect::<Vec<_>>();
    pairs.sort();
    pairs
        .into_iter()
        .map(|(key, value)| format!("{key}={value}"))
        .collect::<Vec<_>>()
        .join("&")
}

fn canonical_headers(url: &Url, headers: &HeaderMap, signed_headers: &[String]) -> String {
    let mut out = String::new();
    for name in signed_headers {
        let value = header_value_case_insensitive(headers, name)
            .map(str::to_string)
            .or_else(|| {
                if name.eq_ignore_ascii_case("host") {
                    Some(url_host(url))
                } else {
                    None
                }
            })
            .unwrap_or_default();
        out.push_str(&format!(
            "{}:{}\n",
            name.to_ascii_lowercase(),
            value.split_whitespace().collect::<Vec<_>>().join(" ")
        ));
    }
    out
}

fn hashed_payload(url: &Url, headers: &HeaderMap) -> String {
    header_value_case_insensitive(headers, "x-amz-content-sha256")
        .map(str::to_string)
        .or_else(|| query_param(url, "X-Amz-Content-Sha256"))
        .or_else(|| query_param(url, "x-amz-content-sha256"))
        .unwrap_or_else(|| "UNSIGNED-PAYLOAD".to_string())
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> Result<Vec<u8>> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, service.as_bytes())?;
    hmac_sha256(&k_service, b"aws4_request")
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key)?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn constant_time_hex_eq(expected: &str, actual: &str) -> bool {
    if expected.len() != actual.len() || !actual.bytes().all(|b| b.is_ascii_hexdigit()) {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in expected.as_bytes().iter().zip(actual.as_bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn stripped_query(url: &Url) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in url.query_pairs() {
        if !AUTH_QUERY_PARAMS.iter().any(|p| p == &key.as_ref()) {
            serializer.append_pair(&key, &value);
        }
    }
    serializer.finish()
}

fn cors_headers(
    headers: &HeaderMap,
    method: &Method,
    cors_config: Option<&str>,
) -> BTreeMap<String, String> {
    let Some(origin) = header_value_case_insensitive(headers, "origin") else {
        return BTreeMap::new();
    };
    let rules = parse_cors_rules(cors_config);
    for rule in rules {
        if matches_rule(origin, &rule.allowed_origins)
            && matches_rule(method.as_str(), &rule.allowed_methods)
        {
            let mut out = BTreeMap::new();
            if rule.allowed_origins.len() == 1 && rule.allowed_origins[0] == "*" {
                out.insert("Access-Control-Allow-Origin".into(), "*".into());
            } else {
                out.insert("Access-Control-Allow-Origin".into(), origin.to_string());
            }
            if !rule.expose_headers.is_empty() {
                out.insert(
                    "Access-Control-Expose-Headers".into(),
                    rule.expose_headers.join(", "),
                );
            }
            out.insert("Vary".into(), "Origin".into());
            return out;
        }
    }
    BTreeMap::new()
}

fn parse_cors_rules(cors_config: Option<&str>) -> Vec<CorsRule> {
    let Some(raw) = cors_config else {
        return default_cors_rules();
    };
    let Ok(parsed) = serde_json::from_str::<CorsConfiguration>(raw) else {
        return default_cors_rules();
    };
    if parsed.cors_rules.is_empty() {
        default_cors_rules()
    } else {
        parsed.cors_rules
    }
}

fn default_cors_rules() -> Vec<CorsRule> {
    vec![CorsRule {
        allowed_origins: vec!["*".into()],
        allowed_methods: vec![
            "GET".into(),
            "HEAD".into(),
            "PUT".into(),
            "POST".into(),
            "DELETE".into(),
        ],
        expose_headers: vec!["*".into()],
    }]
}

fn matches_rule(value: &str, allowed: &[String]) -> bool {
    allowed.iter().any(|item| item == "*" || item == value)
}

fn query_has(url: &Url, name: &str) -> bool {
    url.query_pairs().any(|(key, _)| key == name)
}

fn query_param(url: &Url, name: &str) -> Option<String> {
    url.query_pairs().find_map(|(key, value)| {
        if key == name {
            Some(value.into_owned())
        } else {
            None
        }
    })
}

fn header_value_case_insensitive<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.to_str().ok())
}

fn preserve_pct_encoded_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    let bytes = segment.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && bytes[i + 1].is_ascii_hexdigit()
            && bytes[i + 2].is_ascii_hexdigit()
        {
            out.push('%');
            out.push((bytes[i + 1] as char).to_ascii_uppercase());
            out.push((bytes[i + 2] as char).to_ascii_uppercase());
            i += 3;
            continue;
        }
        let ch = segment[i..].chars().next().expect("valid char boundary");
        out.push_str(&uri_encode(&ch.to_string()));
        i += ch.len_utf8();
    }
    out
}

fn uri_encode(input: &str) -> String {
    url::form_urlencoded::byte_serialize(input.as_bytes())
        .collect::<String>()
        .replace("+", "%20")
        .replace("%7E", "~")
}

fn percent_decode_query(input: &str) -> Option<String> {
    let replaced = input.replace('+', "%20");
    let decoded = url::form_urlencoded::parse(replaced.as_bytes())
        .next()
        .map(|(key, _)| key.into_owned());
    decoded.or_else(|| Some(String::new()))
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

fn deep_freeze_message(state: &AppState, bucket: &BucketAuth) -> Option<String> {
    if !state.cfg.deep_freeze_enabled {
        return None;
    }
    match bucket.deep_freeze_state.as_str() {
        "freezing" => Some(
            "Bucket is entering Deep Freeze. All access is blocked until packaging completes."
                .into(),
        ),
        "unfreezing" => Some(
            "Bucket is leaving Deep Freeze. All access is blocked until restoration completes."
                .into(),
        ),
        "frozen" => Some(
            "Bucket is in Deep Freeze. Unfreeze it before accessing files, reads, or writes."
                .into(),
        ),
        _ => None,
    }
}

fn paused_message(kind: &str, reason: Option<&str>) -> String {
    match reason {
        Some(reason) if !reason.is_empty() => {
            format!("{kind} is temporarily paused. Reason: {reason}")
        }
        _ => format!("{kind} is temporarily paused."),
    }
}

fn has_dashboard_signed_preview(url: &Url) -> bool {
    query_has(url, "signature") && query_has(url, "expires")
}

fn deny(status: StatusCode, code: &str, message: &str) -> AuthorizeResponse {
    AuthorizeResponse {
        allowed: false,
        status: Some(status.as_u16()),
        body: Some(format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{code}</Code><Message>{message}</Message></Error>"
            ,
            code = xml_escape(code),
            message = xml_escape(message)
        )),
        fast_path: None,
        action: None,
        key: None,
        path_with_query: None,
        root_prefix: None,
        part_number: None,
        upload_id: None,
        cors_headers: None,
        bucket: None,
        user: None,
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[derive(Debug, Deserialize, Serialize)]
struct AuthContext {
    mode: AuthMode,
    bucket: BucketAuth,
    user: Option<UserAuth>,
    key: Option<KeyAuth>,
    #[serde(default)]
    allowed_prefix: Option<String>,
    #[serde(skip)]
    denied: Option<AuthorizeResponse>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
enum AuthMode {
    Authenticated,
    OffboardingExport,
    Public,
    Denied,
}

#[derive(Debug, Deserialize, Serialize)]
struct BucketAuth {
    id: String,
    name: String,
    #[serde(default = "crate::default_storage_region")]
    resolved_region: String,
    user_id: Option<String>,
    is_public: bool,
    is_system: bool,
    is_paused: bool,
    pause_reason: Option<String>,
    deep_freeze_state: String,
    deep_freeze_reason: Option<String>,
    cors_config: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct UserAuth {
    id: String,
    storage_limit_bytes: Option<i64>,
    storage_usage_bytes: i64,
    egress_limit_bytes: Option<i64>,
    egress_bytes: i64,
    egress_period: Option<String>,
    is_immortal: bool,
    is_locked: bool,
    marked_as_over_age: bool,
    data_exported: bool,
    files_deleted: bool,
}

#[derive(Debug, Deserialize, Serialize)]
struct KeyAuth {
    secret_key: String,
    is_paused: bool,
    pause_reason: Option<String>,
}

#[derive(Deserialize)]
struct CorsConfiguration {
    #[serde(rename = "CORSRules")]
    cors_rules: Vec<CorsRule>,
}

#[derive(Deserialize)]
struct CorsRule {
    #[serde(rename = "AllowedMethods")]
    allowed_methods: Vec<String>,
    #[serde(rename = "AllowedOrigins")]
    allowed_origins: Vec<String>,
    #[serde(default, rename = "ExposeHeaders")]
    expose_headers: Vec<String>,
}

struct SignatureParts {
    method: String,
    algorithm: String,
    credential: String,
    signed_headers: Vec<String>,
    signature: String,
    date: String,
    is_presigned: bool,
    presigned_expires_seconds: Option<i64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sig(date: DateTime<Utc>, is_presigned: bool, expires: Option<i64>) -> SignatureParts {
        SignatureParts {
            method: "GET".to_string(),
            algorithm: AWS_ALGORITHM.to_string(),
            credential: "AKIA/20260701/auto/s3/aws4_request".to_string(),
            signed_headers: vec!["host".to_string()],
            signature: "0".repeat(64),
            date: date.format("%Y%m%dT%H%M%SZ").to_string(),
            is_presigned,
            presigned_expires_seconds: expires,
        }
    }

    #[test]
    fn rejects_stale_header_auth_dates() {
        let now = Utc::now();
        assert!(signature_time_is_valid_at(
            &sig(now - chrono::Duration::minutes(10), false, None),
            now
        ));
        assert!(!signature_time_is_valid_at(
            &sig(now - chrono::Duration::minutes(16), false, None),
            now
        ));
        assert!(!signature_time_is_valid_at(
            &sig(now + chrono::Duration::minutes(16), false, None),
            now
        ));
    }

    #[test]
    fn enforces_presigned_expiry_and_max_lifetime() {
        let now = Utc::now();
        assert!(signature_time_is_valid_at(
            &sig(now - chrono::Duration::seconds(30), true, Some(60)),
            now
        ));
        assert!(!signature_time_is_valid_at(
            &sig(now - chrono::Duration::minutes(30), true, Some(60)),
            now
        ));
        assert!(!signature_time_is_valid_at(
            &sig(now, true, Some(PRESIGNED_MAX_EXPIRES_SECONDS + 1)),
            now
        ));
        assert!(!signature_time_is_valid_at(&sig(now, true, None), now));
    }

    #[test]
    fn validates_signed_headers_are_lowercase_sorted_and_present() {
        let mut headers = HeaderMap::new();
        headers.insert("x-amz-date", "20260701T000000Z".parse().unwrap());
        assert!(signed_headers_are_valid(
            &headers,
            &["host".to_string(), "x-amz-date".to_string()]
        ));
        assert!(!signed_headers_are_valid(
            &headers,
            &["x-amz-date".to_string()]
        ));
        assert!(!signed_headers_are_valid(
            &headers,
            &["host".to_string(), "missing-header".to_string()]
        ));
        assert!(!signed_headers_are_valid(
            &headers,
            &["x-amz-date".to_string(), "host".to_string()]
        ));
        assert!(!signed_headers_are_valid(
            &headers,
            &["host".to_string(), "X-Amz-Date".to_string()]
        ));
    }

    #[test]
    fn treats_configured_subdomain_origin_as_path_style() {
        let origins = vec!["primary-origin.onsilo.dev".to_string()];
        let url =
            Url::parse("https://primary-origin.onsilo.dev/silo-canary/__silo_healthcheck/test")
                .unwrap();

        assert_eq!(
            bucket_from_request_for_domains("onsilo.dev", &origins, &url).as_deref(),
            Some("silo-canary")
        );
        assert_eq!(
            key_from_path_request(&url, "silo-canary").unwrap(),
            "__silo_healthcheck/test"
        );
    }

    #[test]
    fn rejects_virtual_hosted_bucket_routing() {
        let url = Url::parse("https://photos.onsilo.dev/2026/image.png").unwrap();

        assert_eq!(
            bucket_from_request_for_domains("onsilo.dev", &[], &url),
            None
        );
    }

    #[test]
    fn offboarding_secret_derivation_matches_control_plane_vector() {
        assert_eq!(
            derive_offboarding_secret(
                "silo-offboarding-parity-secret-2026",
                "ox_0123456789abcdef0123456789abcdef",
            )
            .unwrap(),
            "1ba9c08e16f5e4e28fdd015ca2868327feebc31ba587b10ae8132736bd3c7038"
        );
    }
}

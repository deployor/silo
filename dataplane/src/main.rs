use std::{
    collections::BTreeMap,
    env,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, RwLock,
    },
    time::Duration,
};

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    extract::{Json, State},
    http::{header, HeaderMap, Method, Request, Response, StatusCode, Uri},
    routing::{any, get, post},
    Router,
};
use futures_util::StreamExt;
use reqwest::header::HOST;
use serde::{Deserialize, Serialize};
use tower_http::trace::TraceLayer;
use tracing::{error, info, warn};

mod accounting;
mod auth;
mod aws_chunked;
mod bucket;
mod cache;
mod copy;
mod delete;
mod disk_cache;
mod list;
mod multipart;
mod quota;
mod rate_limit;
mod response;
mod security;
mod stats;
mod upstream;
mod usage;
mod writer;

use auth::authorize_direct;
use aws_chunked::{decoded_content_length, is_aws_chunked, AwsChunkedDecoder};
use bucket::{
    fast_delete_bucket_cors, fast_get_bucket_cors, fast_list_buckets, fast_options,
    fast_put_bucket_cors,
};
use cache::{
    buffer_small_get_and_cache, cache_object_meta, has_conditional_headers,
    invalidate_object_caches, try_redis_object_cache, try_redis_object_meta, try_redis_object_size,
};
use copy::fast_copy_object;
use delete::fast_delete_objects;
use disk_cache::DiskCache;
use list::{
    fast_bucket_location, fast_internal_list_objects, fast_list_objects, invalidate_list_cache,
    InternalListInvalidateRequest, InternalListRequest,
};
use multipart::{
    fast_abort_multipart_upload, fast_complete_multipart_upload, fast_create_multipart_upload,
    fast_list_multipart_uploads, fast_list_parts,
};
use quota::{
    release_multipart_part, release_storage, reserve_multipart_part, reserve_served_egress,
    reserve_storage,
};
use rate_limit::{check_client_request_rate, check_ingress_bytes, check_request_rate};
use response::{reqwest_to_s3_response, s3_error, s3_passthrough_error, with_s3_headers};
use security::authorized_path_is_jailed;
use stats::{record_ingress, record_request};
use upstream::signed_upstream_request;

#[derive(Clone)]
struct AppState {
    cfg: Arc<Config>,
    http: reqwest::Client,
    redis: redis::aio::MultiplexedConnection,
    pg: sqlx::PgPool,
    writer_pg: sqlx::PgPool,
    signing_keys: Arc<RwLock<BTreeMap<String, Vec<u8>>>>,
    disk_cache: DiskCache,
    maintenance_active: Arc<AtomicBool>,
    accounting_unsafe: Arc<AtomicBool>,
    accounting_flush_lock: Arc<tokio::sync::Mutex<()>>,
    draining: Arc<AtomicBool>,
}

#[derive(Clone)]
struct Config {
    bind: String,
    control_plane_url: String,
    internal_secret: String,
    public_scheme: String,
    s3_domain: String,
    dashboard_domain: String,
    origin_domains: Vec<String>,
    custom_domains_enabled: bool,
    deep_freeze_enabled: bool,
    s3_access_key: String,
    s3_secret_key: String,
    s3_region: String,
    s3_endpoint_scheme: String,
    s3_endpoint: String,
    s3_bucket: String,
    emergency_mode: bool,
    redis_object_cache_enabled: bool,
    writer_instance_id: String,
    writer_auto_claim: bool,
    writer_lease_seconds: i32,
    accounting_unsafe_marker: Option<std::path::PathBuf>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizeResponse {
    allowed: bool,
    status: Option<u16>,
    body: Option<String>,
    fast_path: Option<bool>,
    action: Option<String>,
    key: Option<String>,
    path_with_query: Option<String>,
    root_prefix: Option<String>,
    part_number: Option<String>,
    upload_id: Option<String>,
    cors_headers: Option<BTreeMap<String, String>>,
    bucket: Option<AuthBucket>,
    user: Option<AuthUser>,
}

#[derive(Clone, Debug, Deserialize)]
struct AuthBucket {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthUser {
    id: String,
    is_immortal: bool,
    storage_limit_bytes: Option<i64>,
    storage_usage_bytes: i64,
    egress_limit_bytes: Option<i64>,
    egress_bytes: i64,
    egress_period: Option<String>,
}

#[derive(Serialize)]
struct AuthorizeRequest {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(env::var("RUST_LOG").unwrap_or_else(|_| "info,tower_http=warn".into()))
        .init();

    let cfg = Arc::new(Config::from_env()?);
    let emergency_mode = cfg.emergency_mode;
    let http = reqwest::Client::builder()
        .tcp_nodelay(true)
        .pool_idle_timeout(Duration::from_secs(90))
        .pool_max_idle_per_host(
            env::var("DATAPLANE_HTTP_POOL_MAX_IDLE_PER_HOST")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(if emergency_mode { 8 } else { 128 }),
        )
        .tcp_keepalive(Duration::from_secs(60))
        .http2_adaptive_window(true)
        .http2_keep_alive_interval(Duration::from_secs(30))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .build()?;
    let redis_client = redis::Client::open(
        env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".into()),
    )?;
    let redis = redis_client
        .get_multiplexed_async_connection()
        .await
        .context("failed to connect to Redis")?;
    let database_url = env::var("DATABASE_URL").context("DATABASE_URL is required")?;
    let pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(
            env::var("DATAPLANE_DATABASE_MAX_CONNECTIONS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(if emergency_mode { 4 } else { 16 }),
        )
        .connect(&database_url)
        .await
        .context("failed to connect to Postgres")?;
    // Mutation fences hold a PostgreSQL advisory transaction lock for the
    // duration of upstream writes. Keep them on a small separate lazy pool so
    // accounting and multipart metadata cannot deadlock behind fence holders.
    let writer_pg = sqlx::postgres::PgPoolOptions::new()
        .max_connections(
            env::var("DATAPLANE_WRITER_MAX_CONNECTIONS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(if emergency_mode { 4 } else { 8 }),
        )
        .connect(&database_url)
        .await
        .context("failed to connect writer fence pool to Postgres")?;
    let disk_cache = DiskCache::from_env(emergency_mode)?;
    disk_cache.start_background_tasks();
    let maintenance_active = Arc::new(AtomicBool::new(true));
    refresh_maintenance_state(&pg, &maintenance_active).await;
    start_maintenance_refresh(pg.clone(), maintenance_active.clone());

    let accounting_unsafe = cfg
        .accounting_unsafe_marker
        .as_ref()
        .is_some_and(|path| path.exists());
    if accounting_unsafe {
        warn!("persistent emergency accounting unsafe marker is present; teardown will remain blocked");
    }
    let state = AppState {
        cfg: cfg.clone(),
        http,
        redis,
        pg,
        writer_pg,
        signing_keys: Arc::new(RwLock::new(BTreeMap::new())),
        disk_cache,
        maintenance_active,
        accounting_unsafe: Arc::new(AtomicBool::new(accounting_unsafe)),
        accounting_flush_lock: Arc::new(tokio::sync::Mutex::new(())),
        draining: Arc::new(AtomicBool::new(false)),
    };
    if state.cfg.writer_auto_claim {
        match writer::claim_initial(&state).await {
            Ok(Some(generation)) => info!(generation, "dataplane writer lease initialized"),
            Ok(None) => {
                warn!("another dataplane owns the writer lease; mutations will remain fenced")
            }
            Err(error) => {
                warn!(error = %error, "failed to initialize writer lease; mutations will remain fenced")
            }
        }
    }
    start_writer_renewal(state.clone());
    accounting::start_background_flush(state.clone());
    let app = Router::new()
        .route("/health", get(health))
        .route("/ready", get(readiness))
        .route("/api/internal/writer/claim", post(internal_writer_claim))
        .route("/api/internal/drain", post(internal_drain))
        .route(
            "/api/internal/accounting/flush",
            post(internal_accounting_flush),
        )
        .route(
            "/api/internal/dashboard/list",
            post(internal_dashboard_list),
        )
        .route(
            "/api/internal/dashboard/list-cache/invalidate",
            post(internal_dashboard_list_cache_invalidate),
        )
        .fallback(any(handle_request))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let addr: SocketAddr = cfg.bind.parse().context("invalid DATAPLANE_BIND")?;
    info!("silo rust dataplane listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Response<Body> {
    // Keep the public liveness endpoint intentionally boring. Dependency
    // names and statuses belong on the authenticated readiness endpoint.
    let body = r#"{"status":"ok"}"#;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()));
    with_failover_header(response, state.cfg.emergency_mode)
}

/// Readiness deliberately checks every dependency required to serve an S3
/// request. Unlike /health, this is suitable for the failover controller.
async fn readiness(State(state): State<AppState>, headers: HeaderMap) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        let response = Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
        return with_failover_header(response, state.cfg.emergency_mode);
    }
    let postgres_ok = sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.pg)
        .await
        .is_ok();
    let redis_ok = {
        let mut conn = state.redis.clone();
        let result: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut conn).await;
        result.is_ok_and(|value| value == "PONG")
    };
    // A signed HEAD exercises DNS, TLS, credentials, and the backing object
    // store without creating or changing an object.
    let storage_ok =
        match signed_upstream_request(&state, Method::HEAD, "", &HeaderMap::new(), None) {
            Ok(request) => request
                .send()
                .await
                .map(|response| response.status().is_success())
                .unwrap_or(false),
            Err(error) => {
                warn!(error = %error, "failed to create backing storage readiness request");
                false
            }
        };
    let ok = postgres_ok && redis_ok && storage_ok;
    let active_writer = if postgres_ok {
        writer::active_generation(&state).await.ok().flatten()
    } else {
        None
    };
    let body = serde_json::json!({
        "status": if ok { "ok" } else { "degraded" },
        "postgres": postgres_ok,
        "redis": redis_ok,
        "storage": storage_ok,
        "dataplane": true,
        "activeWriter": active_writer.is_some(),
        "writerGeneration": active_writer,
    })
    .to_string();
    let response = Response::builder()
        .status(if ok {
            StatusCode::OK
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        })
        .header("content-type", "application/json")
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()));
    with_failover_header(response, state.cfg.emergency_mode)
}

async fn internal_writer_claim(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    match writer::claim(&state).await {
        Ok(generation) => json_response(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "generation": generation }),
        ),
        Err(error) => {
            error!(error = %error, "writer lease claim failed");
            json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "ok": false, "error": "writer lease claim failed" }),
            )
        }
    }
}

async fn internal_accounting_flush(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    match accounting::flush(&state).await {
        Ok(result) => json_response(
            if result.ok {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            serde_json::to_value(result).unwrap_or_else(|_| serde_json::json!({ "ok": false })),
        ),
        Err(error) => {
            error!(error = %error, "accounting flush failed");
            json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "ok": false, "error": "accounting flush failed" }),
            )
        }
    }
}

#[derive(Deserialize)]
struct DrainRequest {
    enabled: bool,
}

async fn internal_drain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<DrainRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    state.draining.store(request.enabled, Ordering::SeqCst);
    json_response(
        StatusCode::OK,
        serde_json::json!({ "ok": true, "draining": request.enabled }),
    )
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

async fn internal_dashboard_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<InternalListRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from("Unauthorized"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }

    if s3_maintenance_active(&state).await {
        return maintenance_s3_response();
    }

    match fast_internal_list_objects(state, request).await {
        Ok(response) => response,
        Err(error) => {
            error!(error = %error, "internal dashboard list failed");
            s3_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalError",
                "Internal Server Error",
            )
        }
    }
}

async fn internal_dashboard_list_cache_invalidate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<InternalListInvalidateRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::from("Unauthorized"))
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }

    if s3_maintenance_active(&state).await {
        return maintenance_s3_response();
    }

    match invalidate_list_cache(&state, &request.bucket_id).await {
        Ok(()) => Response::builder()
            .status(StatusCode::NO_CONTENT)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty())),
        Err(error) => {
            error!(error = %error, "internal dashboard list cache invalidation failed");
            s3_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalError",
                "Internal Server Error",
            )
        }
    }
}

fn internal_auth_ok(cfg: &Config, headers: &HeaderMap) -> bool {
    headers
        .get("x-dataplane-secret")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|provided| provided == cfg.internal_secret)
}

impl Config {
    fn from_env() -> Result<Self> {
        let emergency_mode = match env::var("DATAPLANE_MODE")
            .unwrap_or_else(|_| "production".to_string())
            .as_str()
        {
            "production" => false,
            "emergency" => true,
            value => {
                return Err(anyhow!(
                    "DATAPLANE_MODE must be production or emergency, got {value}"
                ))
            }
        };
        let internal_secret = env::var("DATAPLANE_INTERNAL_SECRET")
            .context("DATAPLANE_INTERNAL_SECRET is required")?;
        if internal_secret.len() < 24 {
            return Err(anyhow!(
                "DATAPLANE_INTERNAL_SECRET must be at least 24 chars"
            ));
        }

        let control_plane_url = env::var("CONTROL_PLANE_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:3000".into())
            .trim_end_matches('/')
            .to_string();

        let s3_domain = env::var("S3_DOMAIN").context("S3_DOMAIN is required")?;
        let dashboard_domain = env::var("DASHBOARD_DOMAIN").unwrap_or_else(|_| {
            if s3_domain == "localhost:3000" {
                s3_domain.clone()
            } else {
                format!("dash.{s3_domain}")
            }
        });

        Ok(Self {
            bind: env::var("DATAPLANE_BIND").unwrap_or_else(|_| "0.0.0.0:3001".into()),
            control_plane_url,
            internal_secret,
            public_scheme: env::var("DATAPLANE_PUBLIC_SCHEME").unwrap_or_else(|_| "https".into()),
            s3_domain,
            dashboard_domain,
            origin_domains: env::var("DATAPLANE_ORIGIN_DOMAINS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_ascii_lowercase)
                .collect(),
            custom_domains_enabled: env_bool("DOMAINS"),
            deep_freeze_enabled: env_bool("DEEP_FREEZE"),
            s3_access_key: env::var("S3_ACCESS_KEY_ID").context("S3_ACCESS_KEY_ID is required")?,
            s3_secret_key: env::var("S3_SECRET_ACCESS_KEY")
                .context("S3_SECRET_ACCESS_KEY is required")?,
            s3_region: env::var("S3_REGION").unwrap_or_else(|_| "auto".into()),
            s3_endpoint_scheme: env::var("S3_ENDPOINT_SCHEME").unwrap_or_else(|_| "https".into()),
            s3_endpoint: env::var("S3_ENDPOINT")
                .context("S3_ENDPOINT is required")?
                .trim_end_matches('/')
                .trim_start_matches("https://")
                .trim_start_matches("http://")
                .to_string(),
            s3_bucket: env::var("S3_BUCKET_NAME").context("S3_BUCKET_NAME is required")?,
            emergency_mode,
            redis_object_cache_enabled: !emergency_mode
                && env::var("DATAPLANE_REDIS_OBJECT_CACHE_ENABLED")
                    .map(|value| {
                        !matches!(
                            value.as_str(),
                            "0" | "false" | "FALSE" | "no" | "NO" | "off" | "OFF"
                        )
                    })
                    .unwrap_or(true),
            writer_instance_id: env::var("DATAPLANE_WRITER_INSTANCE_ID").unwrap_or_else(|_| {
                if emergency_mode {
                    "emergency-unconfigured"
                } else {
                    "primary"
                }
                .into()
            }),
            writer_auto_claim: env::var("DATAPLANE_WRITER_AUTO_CLAIM")
                .map(|value| {
                    matches!(
                        value.as_str(),
                        "1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON"
                    )
                })
                .unwrap_or(!emergency_mode),
            writer_lease_seconds: env::var("DATAPLANE_WRITER_LEASE_SECONDS")
                .ok()
                .and_then(|value| value.parse::<i32>().ok())
                .filter(|value| (15..=300).contains(value))
                .unwrap_or(30),
            accounting_unsafe_marker: env::var_os("DATAPLANE_ACCOUNTING_UNSAFE_MARKER")
                .map(std::path::PathBuf::from),
        })
    }
}

fn env_bool(name: &str) -> bool {
    matches!(
        env::var(name).ok().as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

async fn handle_request(State(state): State<AppState>, req: Request<Body>) -> Response<Body> {
    let emergency_mode = state.cfg.emergency_mode;
    let response = match handle_request_inner(state, req).await {
        Ok(res) => res,
        Err(err) => {
            error!(error = %err, "dataplane request failed");
            s3_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "InternalError",
                "Internal Server Error",
            )
        }
    };
    with_failover_header(response, emergency_mode)
}

async fn handle_request_inner(state: AppState, req: Request<Body>) -> Result<Response<Body>> {
    let (parts, body) = req.into_parts();
    let method = parts.method.clone();
    let headers = parts.headers.clone();
    let url = reconstruct_url(&state.cfg, &parts.uri, &headers)?;

    if state.draining.load(Ordering::SeqCst) {
        return Ok(s3_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "ServiceUnavailable",
            "This Silo dataplane is draining for safe failover teardown. Retry against onsilo.dev.",
        ));
    }

    if is_dashboard_host(&state.cfg, &headers) {
        if state.cfg.emergency_mode {
            return Ok(s3_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "ServiceUnavailable",
                "The Silo dashboard is unavailable while emergency failover is active.",
            ));
        }
        return proxy_control_plane(state, method, parts.uri, headers, body).await;
    }

    // This is the outermost S3 trust boundary: it covers signed, public,
    // custom-domain, and cached requests before authorization or upstream I/O.
    if s3_maintenance_active(&state).await {
        return Ok(maintenance_s3_response());
    }

    if parts.uri.path() == "/" {
        let accept = headers
            .get(header::ACCEPT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if accept.contains("text/html") {
            let location = format!(
                "{}://{}/",
                state.cfg.public_scheme, state.cfg.dashboard_domain
            );
            return Ok(Response::builder()
                .status(StatusCode::FOUND)
                .header(axum::http::header::LOCATION, location)
                .body(Body::empty())?);
        }
    }

    let client_id = rate_limit::client_identity(&headers);
    if let Some(res) = check_client_request_rate(&state, &client_id).await? {
        return Ok(res);
    }

    let auth = authorize(&state, &method, &url, &headers).await?;
    if !auth.allowed {
        return Ok(s3_passthrough_error(auth));
    }
    if auth.fast_path != Some(true) {
        return Ok(s3_error(
            StatusCode::NOT_IMPLEMENTED,
            "NotImplemented",
            "A header or query you requested is not implemented.",
        ));
    }
    let action = auth.action.as_deref().unwrap_or("");
    if action != "ListBuckets" && !authorized_path_is_jailed(&auth) {
        warn!(
            path = ?auth.path_with_query,
            root_prefix = ?auth.root_prefix,
            "dataplane authorization returned path outside bucket jail"
        );
        return Ok(s3_error(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            "Access Denied",
        ));
    }

    if let Some(res) = check_request_rate(&state, &auth).await? {
        return Ok(with_s3_headers(res, &auth));
    }

    let (mutation_fence, writer_generation) = if writer::is_mutation(action) {
        match writer::begin_mutation(&state).await {
            Ok((fence, Some(generation))) => (Some(fence), Some(generation)),
            Ok((_, None)) | Err(_) => {
                return Ok(with_s3_headers(
                    s3_error(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "NotActiveWriter",
                        "This Silo dataplane is not the active writer. Retry against onsilo.dev.",
                    ),
                    &auth,
                ));
            }
        }
    } else {
        (None, None)
    };

    record_request(&state, &auth).await;
    let response = match (method.as_str(), action) {
        ("GET", "ListBuckets") => fast_list_buckets(state, auth).await,
        ("GET", "GetBucketLocation") => fast_bucket_location(state, auth).await,
        ("GET", "GetBucketCors") => fast_get_bucket_cors(state, auth).await,
        ("GET", "GetObject") => fast_get(state, auth, &headers).await,
        ("GET", "ListMultipartUploads") => fast_list_multipart_uploads(state, auth, &headers).await,
        ("GET", "ListObjectsV2") => fast_list_objects(state, auth, &headers).await,
        ("GET", "ListParts") => fast_list_parts(state, auth, &headers).await,
        ("HEAD", "HeadBucket") => Ok(with_s3_headers(
            Response::builder()
                .status(StatusCode::OK)
                .body(Body::empty())?,
            &auth,
        )),
        ("HEAD", "HeadObject") => fast_head(state, auth, &headers).await,
        ("OPTIONS", "Options") => fast_options(state, auth, &headers).await,
        ("POST", "CreateMultipartUpload") => {
            fast_create_multipart_upload(state, auth, &headers, writer_generation.unwrap()).await
        }
        ("POST", "CompleteMultipartUpload") => {
            fast_complete_multipart_upload(state, auth, &headers, body, writer_generation.unwrap())
                .await
        }
        ("POST", "DeleteObjects") => fast_delete_objects(state, auth, &headers, body).await,
        ("DELETE", "AbortMultipartUpload") => {
            fast_abort_multipart_upload(state, auth, &headers, writer_generation.unwrap()).await
        }
        ("DELETE", "DeleteBucketCors") => fast_delete_bucket_cors(state, auth).await,
        ("DELETE", "DeleteObject") => fast_delete_object(state, auth, &headers).await,
        ("PUT", "CopyObject") => fast_copy_object(state, auth, &headers).await,
        ("PUT", "PutBucketCors") => fast_put_bucket_cors(state, auth, body).await,
        ("PUT", "PutObject") => fast_put_object(state, auth, &headers, body).await,
        ("PUT", "UploadPart") => {
            fast_upload_part(state, auth, &headers, body, writer_generation.unwrap()).await
        }
        _ => Ok(s3_error(
            StatusCode::NOT_IMPLEMENTED,
            "NotImplemented",
            "A header or query you requested is not implemented.",
        )),
    };
    if let Some(fence) = mutation_fence {
        if let Err(error) = fence.rollback().await {
            warn!(error = %error, "failed to release mutation fence cleanly");
        }
    }
    response
}

fn start_writer_renewal(state: AppState) {
    tokio::spawn(async move {
        let renew_every = u64::try_from((state.cfg.writer_lease_seconds / 3).max(5)).unwrap_or(10);
        let mut interval = tokio::time::interval(Duration::from_secs(renew_every));
        interval.tick().await;
        loop {
            interval.tick().await;
            match writer::renew(&state).await {
                Ok(true) => {}
                Ok(false) => warn!("writer lease is owned by another dataplane"),
                Err(error) => {
                    warn!(error = %error, "writer lease renewal failed; mutations will fail closed when it expires")
                }
            }
        }
    });
}

async fn s3_maintenance_active(state: &AppState) -> bool {
    state.maintenance_active.load(Ordering::Relaxed)
}

async fn refresh_maintenance_state(pg: &sqlx::PgPool, current: &AtomicBool) {
    match sqlx::query_scalar::<_, bool>(
        "SELECT COALESCE(s3_maintenance_mode OR full_maintenance_mode, false) FROM app_settings WHERE id = 'global'",
    )
    .fetch_optional(pg)
    .await
    {
        Ok(value) => current.store(value.unwrap_or(false), Ordering::Relaxed),
        Err(error) => {
            // Keep the last known state. Startup begins fail-closed, so an
            // unavailable database can never silently bypass maintenance.
            error!(error = %error, "failed to refresh maintenance status");
        }
    }
}

fn start_maintenance_refresh(pg: sqlx::PgPool, current: Arc<AtomicBool>) {
    let seconds = env::var("DATAPLANE_MAINTENANCE_REFRESH_SECONDS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| (2..=5).contains(value))
        .unwrap_or(3);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(seconds));
        interval.tick().await;
        loop {
            refresh_maintenance_state(&pg, &current).await;
            interval.tick().await;
        }
    });
}

fn with_failover_header(mut response: Response<Body>, emergency_mode: bool) -> Response<Body> {
    if emergency_mode {
        response.headers_mut().insert(
            axum::http::header::HeaderName::from_static("x-silo-failover"),
            axum::http::HeaderValue::from_static("active"),
        );
    }
    response
}

fn maintenance_s3_response() -> Response<Body> {
    s3_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "ServiceUnavailable",
        "Storage service is temporarily unavailable due to planned maintenance.",
    )
}

fn is_dashboard_host(cfg: &Config, headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    let host = host
        .split_once(':')
        .map(|(host, _)| host)
        .unwrap_or(host)
        .to_ascii_lowercase();
    host == cfg.dashboard_domain.to_ascii_lowercase()
}

async fn proxy_control_plane(
    state: AppState,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Result<Response<Body>> {
    let path_and_query = uri
        .path_and_query()
        .map(|v| v.as_str())
        .unwrap_or_else(|| uri.path());
    let url = format!("{}{}", state.cfg.control_plane_url, path_and_query);
    let mut builder = state.http.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes())?,
        url,
    );

    for (name, value) in headers.iter() {
        if should_forward_control_plane_header(name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    if let Some(host) = headers.get(HOST).and_then(|value| value.to_str().ok()) {
        builder = builder
            .header("x-forwarded-host", host)
            .header("x-forwarded-proto", &state.cfg.public_scheme);
    }

    let has_request_body = method != Method::GET && method != Method::HEAD
        || headers.contains_key(header::CONTENT_LENGTH)
        || headers.contains_key(header::TRANSFER_ENCODING);
    let upstream = if has_request_body {
        let request_body = body
            .into_data_stream()
            .map(|chunk| chunk.map_err(std::io::Error::other));
        builder
            .body(reqwest::Body::wrap_stream(request_body))
            .send()
            .await?
    } else {
        builder.send().await?
    };
    let status = StatusCode::from_u16(upstream.status().as_u16())?;
    let mut response = Response::builder().status(status);

    for (name, value) in upstream.headers().iter() {
        if should_forward_control_plane_header(name.as_str()) {
            response = response.header(name, value);
        }
    }

    let body = upstream
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    Ok(response.body(Body::from_stream(body))?)
}

fn should_forward_control_plane_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    !matches!(
        name.as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "host"
            | "x-forwarded-host"
            | "x-forwarded-proto"
            | "x-dataplane-secret"
    )
}

fn reconstruct_url(cfg: &Config, uri: &Uri, headers: &HeaderMap) -> Result<String> {
    if uri.scheme().is_some() && uri.authority().is_some() {
        return Ok(uri.to_string());
    }
    let host = headers
        .get(HOST)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| anyhow!("missing Host header"))?;
    Ok(format!("{}://{}{}", cfg.public_scheme, host, uri))
}

async fn authorize(
    state: &AppState,
    method: &Method,
    url: &str,
    headers: &HeaderMap,
) -> Result<AuthorizeResponse> {
    if let Some(auth) = authorize_direct(state, method, url, headers).await? {
        return Ok(auth);
    }

    if state.cfg.emergency_mode {
        // The temporary VM intentionally has no Bun control plane. A request
        // that cannot be resolved from Aiven metadata is denied instead of
        // turning an outage into a cross-origin authorization dependency.
        return Ok(emergency_authorization_denied());
    }

    let req = AuthorizeRequest {
        method: method.as_str().to_string(),
        url: url.to_string(),
        headers: headers_to_vec(headers),
    };

    let res = state
        .http
        .post(format!(
            "{}/api/internal/dataplane/authorize",
            state.cfg.control_plane_url
        ))
        .header("x-dataplane-secret", &state.cfg.internal_secret)
        .json(&req)
        .send()
        .await
        .context("control-plane authorization request failed")?;

    if !res.status().is_success() {
        return Err(anyhow!(
            "control-plane authorization returned {}",
            res.status()
        ));
    }
    Ok(res.json::<AuthorizeResponse>().await?)
}

fn emergency_authorization_denied() -> AuthorizeResponse {
    AuthorizeResponse {
        allowed: false,
        status: Some(StatusCode::FORBIDDEN.as_u16()),
        body: Some(
            r#"<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>"#.to_string(),
        ),
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

fn headers_to_vec(headers: &HeaderMap) -> Vec<(String, String)> {
    headers
        .iter()
        .filter_map(|(k, v)| {
            v.to_str()
                .ok()
                .map(|value| (k.as_str().to_string(), value.to_string()))
        })
        .collect()
}

async fn fast_head(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    if !has_conditional_headers(headers) {
        if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
            if let Some(res) = try_redis_object_meta(&state, bucket, key).await? {
                return Ok(with_s3_headers(res, &auth));
            }
            if let Some(res) = state.disk_cache.get_meta_response(bucket, key).await? {
                return Ok(with_s3_headers(res, &auth));
            }
        }
    }

    let upstream = signed_upstream_request(
        &state,
        Method::HEAD,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        None,
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    let response = reqwest_to_s3_response(res, &auth).await?;
    if status == reqwest::StatusCode::OK {
        if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
            cache_object_meta(&state, bucket, key, response.headers(), 21_600).await?;
        }
    }
    Ok(response)
}

async fn fast_get(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
        state.disk_cache.record_demand(&bucket.id, key, 0).await;
        if let Some(res) = try_redis_object_cache(&state, &auth, headers, bucket, key).await? {
            return Ok(with_s3_headers(res, &auth));
        }
        if let Some(res) = state
            .disk_cache
            .get_response(&state, &auth, headers, bucket, key)
            .await?
        {
            return Ok(with_s3_headers(res, &auth));
        }
    }

    let has_range = headers.contains_key(axum::http::header::RANGE);

    let upstream = signed_upstream_request(
        &state,
        Method::GET,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        None,
    )?;
    let res = upstream.send().await?;
    let status = res.status();
    let content_length_header = res.headers().get(reqwest::header::CONTENT_LENGTH);
    let content_length = content_length_header
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
        state
            .disk_cache
            .record_demand(&bucket.id, key, content_length)
            .await;
    }

    if status.is_success()
        && status != reqwest::StatusCode::NO_CONTENT
        && status != reqwest::StatusCode::NOT_MODIFIED
    {
        if let Some(user) = &auth.user {
            if content_length_header.is_none() && !user.is_immortal {
                return Ok(with_s3_headers(
                    s3_error(
                        StatusCode::BAD_REQUEST,
                        "InvalidRequest",
                        "Upstream response is missing Content-Length for quota enforcement.",
                    ),
                    &auth,
                ));
            }
        }
        if let Some(res) = reserve_served_egress(&state, &auth, content_length).await? {
            return Ok(with_s3_headers(res, &auth));
        }
    }

    if state.cfg.redis_object_cache_enabled
        && !has_range
        && status.is_success()
        && content_length > 0
        && content_length < 10 * 1024 * 1024
    {
        if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
            return Ok(with_s3_headers(
                buffer_small_get_and_cache(&state, res, bucket, key).await?,
                &auth,
            ));
        }
    }

    if !has_range && status.is_success() && content_length >= state.disk_cache.min_size() {
        if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
            if state
                .disk_cache
                .should_admit(&bucket.id, key, content_length)
                .await
            {
                return Ok(with_s3_headers(
                    state
                        .disk_cache
                        .stream_and_cache_response(res, bucket, key, content_length)
                        .await?,
                    &auth,
                ));
            }
        }
    }

    reqwest_to_s3_response(res, &auth).await
}

async fn fast_put_object(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
    body: Body,
) -> Result<Response<Body>> {
    let content_length = match upload_content_length(headers) {
        Ok(content_length) => content_length,
        Err(_) => {
            return Ok(with_s3_headers(
                s3_error(
                    StatusCode::BAD_REQUEST,
                    "InvalidRequest",
                    "Missing or invalid Content-Length header",
                ),
                &auth,
            ));
        }
    };
    let existing_size = if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref())
    {
        cached_existing_size(
            &state,
            bucket,
            key,
            auth.path_with_query.as_deref().unwrap_or(""),
        )
        .await
        .unwrap_or(0)
    } else {
        head_existing_size(&state, auth.path_with_query.as_deref().unwrap_or(""))
            .await
            .unwrap_or(0)
    };
    let mut reserved_delta = 0;

    if let Some(res) = check_ingress_bytes(&state, &auth, content_length).await? {
        return Ok(with_s3_headers(res, &auth));
    }

    if let Some(user) = &auth.user {
        let delta = content_length.saturating_sub(existing_size);
        if delta > 0 {
            if reserve_storage(&state, user, delta).await.is_err() {
                return Ok(with_s3_headers(
                    s3_error(
                        StatusCode::FORBIDDEN,
                        "QuotaExceeded",
                        "You have exceeded your storage quota.",
                    ),
                    &auth,
                ));
            }
            reserved_delta = delta;
        }
    }

    let upstream = signed_upstream_request(
        &state,
        Method::PUT,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        Some(content_length),
    )?
    .body(upload_body(headers, body));

    let res = match upstream.send().await {
        Ok(res) => res,
        Err(error) => {
            if reserved_delta > 0 {
                if let Some(user) = &auth.user {
                    let _ = release_storage(&state, &user.id, reserved_delta).await;
                }
            }
            return Err(error.into());
        }
    };
    let status = res.status();
    let status_u16 = status.as_u16();

    if !status.is_success() {
        if let Some(user) = &auth.user {
            let delta = content_length.saturating_sub(existing_size);
            if delta > 0 {
                let _ = release_storage(&state, &user.id, delta).await;
            }
        }
    } else if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
        record_ingress(&state, &auth, content_length).await;
        invalidate_object_caches(&state, bucket, key).await;
        if let Some(user) = &auth.user {
            let shrink = existing_size.saturating_sub(content_length);
            if shrink > 0 {
                let _ = release_storage(&state, &user.id, shrink).await;
            }
        }
        if let Err(error) = commit_object_change(
            &state,
            bucket,
            "PUT",
            status_u16,
            content_length,
            existing_size,
        )
        .await
        {
            warn!(error = %error, "dataplane bucket byte commit failed after successful PUT");
        }
    }

    reqwest_to_s3_response(res, &auth).await
}

async fn fast_delete_object(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let existing_size = if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref())
    {
        cached_existing_size(
            &state,
            bucket,
            key,
            auth.path_with_query.as_deref().unwrap_or(""),
        )
        .await
        .unwrap_or(0)
    } else {
        head_existing_size(&state, auth.path_with_query.as_deref().unwrap_or(""))
            .await
            .unwrap_or(0)
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
    let status_u16 = status.as_u16();
    let should_invalidate = status.is_success() || status == reqwest::StatusCode::NOT_FOUND;

    if should_invalidate {
        if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
            invalidate_object_caches(&state, bucket, key).await;
            if status.is_success() && existing_size > 0 {
                if let Some(user) = &auth.user {
                    let _ = release_storage(&state, &user.id, existing_size).await;
                }
                if let Err(error) =
                    commit_object_change(&state, bucket, "DELETE", status_u16, 0, existing_size)
                        .await
                {
                    warn!(error = %error, "dataplane bucket byte commit failed after successful DELETE");
                }
            }
        }
    }

    reqwest_to_s3_response(res, &auth).await
}

async fn fast_upload_part(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
    body: Body,
    writer_generation: i64,
) -> Result<Response<Body>> {
    let bucket_id = auth
        .bucket
        .as_ref()
        .map(|bucket| bucket.id.as_str())
        .unwrap_or("");
    let upload_id = auth.upload_id.as_deref().unwrap_or("");
    if !writer::multipart_matches(&state, bucket_id, upload_id, writer_generation).await? {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::CONFLICT,
                "InvalidRequest",
                "This multipart upload belongs to an earlier failover generation. Restart the multipart upload.",
            ),
            &auth,
        ));
    }
    let content_length = match upload_content_length(headers) {
        Ok(content_length) => content_length,
        Err(_) => {
            return Ok(with_s3_headers(
                s3_error(
                    StatusCode::BAD_REQUEST,
                    "InvalidRequest",
                    "Missing or invalid Content-Length header",
                ),
                &auth,
            ));
        }
    };
    let mut reserved_part: Option<(String, String, String, String)> = None;

    if let Some(res) = check_ingress_bytes(&state, &auth, content_length).await? {
        return Ok(with_s3_headers(res, &auth));
    }

    if let Some(user) = &auth.user {
        let bucket_id = auth.bucket.as_ref().map(|b| b.id.as_str()).unwrap_or("");
        let upload_id = auth.upload_id.as_deref().unwrap_or("");
        let part_number = auth.part_number.as_deref().unwrap_or("");
        if reserve_multipart_part(
            &state,
            user,
            bucket_id,
            upload_id,
            part_number,
            content_length,
        )
        .await
        .is_err()
        {
            return Ok(with_s3_headers(
                s3_error(
                    StatusCode::FORBIDDEN,
                    "QuotaExceeded",
                    "You have exceeded your storage quota.",
                ),
                &auth,
            ));
        }
        if !user.is_immortal {
            reserved_part = Some((
                user.id.clone(),
                bucket_id.to_string(),
                upload_id.to_string(),
                part_number.to_string(),
            ));
        }
    }

    let upstream = signed_upstream_request(
        &state,
        Method::PUT,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        Some(content_length),
    )?
    .body(upload_body(headers, body));

    let res = match upstream.send().await {
        Ok(res) => res,
        Err(error) => {
            if let Some((user_id, bucket_id, upload_id, part_number)) = reserved_part.as_ref() {
                let _ = release_multipart_part(&state, user_id, bucket_id, upload_id, part_number)
                    .await;
            }
            return Err(error.into());
        }
    };
    if !res.status().is_success() {
        if let Some((user_id, bucket_id, upload_id, part_number)) = reserved_part.as_ref() {
            let _ =
                release_multipart_part(&state, user_id, bucket_id, upload_id, part_number).await;
        }
    } else {
        record_ingress(&state, &auth, content_length).await;
    }
    reqwest_to_s3_response(res, &auth).await
}

fn required_content_length(headers: &HeaderMap) -> Result<u64> {
    headers
        .get(axum::http::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| anyhow!("missing valid Content-Length"))
}

fn upload_content_length(headers: &HeaderMap) -> Result<u64> {
    if is_aws_chunked(headers) {
        return decoded_content_length(headers)
            .ok_or_else(|| anyhow!("missing x-amz-decoded-content-length"));
    }
    required_content_length(headers)
}

fn upload_body(headers: &HeaderMap, body: Body) -> reqwest::Body {
    let stream = body
        .into_data_stream()
        .map(|r| r.map_err(std::io::Error::other));
    if is_aws_chunked(headers) {
        return reqwest::Body::wrap_stream(AwsChunkedDecoder::new(stream));
    }
    reqwest::Body::wrap_stream(stream)
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

async fn commit_object_change(
    state: &AppState,
    bucket: &AuthBucket,
    method: &str,
    status: u16,
    actual_size: u64,
    existing_size: u64,
) -> Result<()> {
    if !(200..300).contains(&status) {
        return Ok(());
    }

    let delta = match method {
        "PUT" => i128::from(actual_size) - i128::from(existing_size),
        "DELETE" => -i128::from(existing_size),
        _ => 0,
    };
    if delta == 0 {
        return Ok(());
    }

    let delta = i64::try_from(delta).context("bucket byte delta exceeds bigint")?;
    usage::commit_bucket_usage_delta(state, bucket, delta).await
}

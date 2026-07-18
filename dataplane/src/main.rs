use std::{
    collections::{BTreeMap, BTreeSet},
    env,
    future::IntoFuture,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, RwLock,
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
use futures_util::{stream, StreamExt};
use hmac::{Hmac, Mac};
use reqwest::header::HOST;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use sqlx::Row;
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
mod internal_storage;
mod list;
mod multipart;
mod quota;
mod rate_limit;
mod regions;
mod replication;
mod response;
mod security;
mod stats;
mod upstream;
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
    release_multipart_part, release_storage_reservation, reserve_multipart_part,
    reserve_served_egress, reserve_storage,
};
use rate_limit::{check_client_request_rate, check_ingress_bytes, check_request_rate};
use regions::{RegionRegistry, DEFAULT_STORAGE_REGION};
use response::{reqwest_to_s3_response, s3_error, s3_passthrough_error, with_s3_headers};
use security::authorized_path_is_jailed;
use stats::{record_ingress, record_request};
use upstream::{signed_backend_request, signed_upstream_request};

#[derive(Clone)]
struct AppState {
    cfg: Arc<Config>,
    http: reqwest::Client,
    redis: RedisHandle,
    pg: sqlx::PgPool,
    writer_pg: sqlx::PgPool,
    signing_keys: Arc<RwLock<BTreeMap<String, Vec<u8>>>>,
    disk_cache: DiskCache,
    maintenance_active: Arc<AtomicBool>,
    accounting_unsafe: Arc<AtomicBool>,
    shutting_down: Arc<AtomicBool>,
    accounting_flush_lock: Arc<tokio::sync::Mutex<()>>,
    draining: Arc<AtomicBool>,
    draining_regions: Arc<RwLock<BTreeSet<String>>>,
    active_backend_cache:
        Arc<tokio::sync::RwLock<BTreeMap<String, (writer::ActiveBackend, std::time::Instant)>>>,
    bucket_teardowns: Arc<tokio::sync::Mutex<BTreeMap<String, BucketTeardownGuard>>>,
}

#[derive(Clone)]
struct RedisHandle {
    client: redis::Client,
    connection: Arc<tokio::sync::Mutex<Option<redis::aio::MultiplexedConnection>>>,
}

impl RedisHandle {
    fn new(url: &str) -> Result<Self> {
        Ok(Self {
            client: redis::Client::open(url)?,
            connection: Arc::new(tokio::sync::Mutex::new(None)),
        })
    }

    async fn connection(&self) -> Option<redis::aio::MultiplexedConnection> {
        let mut connection = self.connection.lock().await;
        if let Some(connection) = connection.as_ref() {
            return Some(connection.clone());
        }
        match self.client.get_multiplexed_async_connection().await {
            Ok(created) => {
                *connection = Some(created.clone());
                Some(created)
            }
            Err(error) => {
                warn!(error = %error, "Dragonfly cache is unavailable; serving without it");
                None
            }
        }
    }

    async fn ping(&self) -> bool {
        let Some(mut connection) = self.connection().await else {
            return false;
        };
        let result: redis::RedisResult<String> =
            redis::cmd("PING").query_async(&mut connection).await;
        if result.as_deref() == Ok("PONG") {
            return true;
        }
        *self.connection.lock().await = None;
        false
    }
}

fn start_redis_reconnect(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(2));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let _ = state.redis.ping().await;
        }
    });
}

struct BucketTeardownGuard {
    bucket_id: String,
    expires_at: std::time::Instant,
    transaction: sqlx::Transaction<'static, sqlx::Postgres>,
}

#[derive(Clone)]
struct Config {
    bind: String,
    control_plane_url: String,
    internal_secret: String,
    offboarding_export_derivation_secret: Option<String>,
    public_scheme: String,
    s3_domain: String,
    dashboard_domain: String,
    origin_domains: Vec<String>,
    custom_domains_enabled: bool,
    deep_freeze_enabled: bool,
    deep_freeze_storage_prefix: String,
    regions: RegionRegistry,
    emergency_mode: bool,
    redis_object_cache_enabled: bool,
    writer_instance_id: String,
    writer_auto_claim: bool,
    writer_lease_seconds: i32,
    backend_verification_max_age_seconds: i64,
    active_backend_cache_ttl: Duration,
    replication_excluded_prefixes: Vec<String>,
    bootstrap_copy_concurrency: usize,
    accounting_spool_dir: std::path::PathBuf,
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
#[serde(rename_all = "camelCase")]
struct AuthBucket {
    id: String,
    name: String,
    #[serde(default = "default_storage_region")]
    resolved_region: String,
    #[serde(skip)]
    active_backend: Option<writer::ActiveBackend>,
    #[serde(skip)]
    writer_generation: Option<i64>,
}

impl AuthBucket {
    fn active_backend(&self) -> Result<&writer::ActiveBackend> {
        self.active_backend.as_ref().ok_or_else(|| {
            anyhow!(
                "active storage backend was not resolved for region {}",
                self.resolved_region
            )
        })
    }

    fn cache_namespace(&self, cfg: &Config) -> Result<String> {
        let backend = self.active_backend()?;
        Ok(format!(
            "{}:{}:{}:{}:{}",
            cfg.regions.local_region(),
            self.resolved_region,
            backend.id,
            backend.generation,
            self.writer_generation
                .ok_or_else(|| anyhow!("writer generation is unresolved"))?
        ))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthUser {
    id: String,
    is_immortal: bool,
}

#[derive(Clone, Debug)]
struct RequestLogContext {
    request_id: String,
    bucket_id: String,
    bucket_name: String,
    owner_id: String,
    requester_id: String,
    storage_region: String,
    action: String,
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
        .json()
        .with_env_filter(env::var("RUST_LOG").unwrap_or_else(|_| "info,tower_http=warn".into()))
        .init();

    let cfg = Arc::new(Config::from_env()?);
    accounting::initialize_spool(&cfg.accounting_spool_dir)?;
    let emergency_mode = cfg.emergency_mode;
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
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
    let redis = RedisHandle::new(
        &env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".into()),
    )?;
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
    let disk_cache = DiskCache::from_env(emergency_mode, cfg.regions.local_region())?;
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
        shutting_down: Arc::new(AtomicBool::new(false)),
        accounting_flush_lock: Arc::new(tokio::sync::Mutex::new(())),
        draining: Arc::new(AtomicBool::new(false)),
        draining_regions: Arc::new(RwLock::new(BTreeSet::new())),
        active_backend_cache: Arc::new(tokio::sync::RwLock::new(BTreeMap::new())),
        bucket_teardowns: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
    };
    if state.cfg.writer_auto_claim {
        match writer::claim_initial(&state, state.cfg.regions.local_region()).await {
            Ok(Some(generation)) => info!(
                storage_region = state.cfg.regions.local_region(),
                generation, "dataplane writer lease initialized"
            ),
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
    replication::start_workers(state.clone());
    start_redis_reconnect(state.clone());
    start_bucket_teardown_cleanup(state.clone());
    let app = Router::new()
        .route("/health", get(health))
        .route("/ready", get(readiness))
        .route("/api/internal/writer/claim", post(internal_writer_claim))
        .route(
            "/api/internal/storage/execute",
            post(internal_storage::execute),
        )
        .route(
            "/api/internal/storage/promote",
            post(internal_storage_promote),
        )
        .route(
            "/api/internal/storage/replication/reconcile",
            post(internal_replication_reconcile),
        )
        .route(
            "/api/internal/storage/bootstrap/start",
            post(internal_storage_bootstrap_start),
        )
        .route(
            "/api/internal/storage/bootstrap/retry",
            post(internal_storage_bootstrap_retry),
        )
        .route(
            "/api/internal/bucket/teardown/verify",
            post(internal_bucket_teardown_verify),
        )
        .route(
            "/api/internal/bucket/teardown/release",
            post(internal_bucket_teardown_release),
        )
        .route(
            "/api/internal/auth-cache/invalidate",
            post(internal_auth_cache_invalidate),
        )
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
        .with_state(state.clone());

    let addr: SocketAddr = cfg.bind.parse().context("invalid DATAPLANE_BIND")?;
    info!("silo rust dataplane listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .into_future();
    tokio::pin!(server);
    tokio::select! {
        result = &mut server => result?,
        () = wait_for_shutdown_signal() => {
            info!("shutdown signal received; draining dataplane mutations");
            state.draining.store(true, Ordering::SeqCst);
            state.shutting_down.store(true, Ordering::SeqCst);
            let _ = shutdown_tx.send(());
            if tokio::time::timeout(Duration::from_secs(30), &mut server).await.is_err() {
                accounting::mark_unsafe(&state, "HTTP graceful shutdown timed out").await;
                warn!("HTTP graceful shutdown timed out; closing remaining connections");
            }
        }
    }
    if tokio::time::timeout(Duration::from_secs(30), shutdown_cleanup(&state))
        .await
        .is_err()
    {
        accounting::mark_unsafe(&state, "dataplane shutdown cleanup timed out").await;
        warn!("dataplane shutdown cleanup timed out");
    }
    Ok(())
}

async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler must install");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn shutdown_cleanup(state: &AppState) {
    match accounting::flush(state).await {
        Ok(result) if result.ok => {}
        Ok(result) => {
            accounting::mark_unsafe(
                state,
                &format!(
                    "shutdown accounting flush incomplete: pending={}, unsafe={}",
                    result.pending, result.unsafe_state
                ),
            )
            .await;
        }
        Err(error) => {
            accounting::mark_unsafe(state, &format!("shutdown accounting flush failed: {error}"))
                .await;
        }
    }
    for region in state
        .cfg
        .regions
        .served_regions()
        .map(str::to_string)
        .collect::<Vec<_>>()
    {
        match writer::relinquish(state, &region).await {
            Ok(true) => info!(
                storage_region = region,
                "writer lease relinquished on shutdown"
            ),
            Ok(false) => {}
            Err(error) => {
                accounting::mark_unsafe(
                    state,
                    &format!("failed to relinquish writer lease for {region}: {error}"),
                )
                .await;
            }
        }
    }
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
    let regional_schema_ok = if postgres_ok {
        sqlx::query(
            r#"
            SELECT b.resolved_region, m.storage_region, m.backend_id, m.backend_generation
            FROM buckets b
            CROSS JOIN multipart_upload_generations m
            LIMIT 0
            "#,
        )
        .execute(&state.pg)
        .await
        .is_ok()
            && sqlx::query_scalar::<_, bool>(
                r#"
                SELECT to_regclass('storage_region_state') IS NOT NULL
                   AND to_regclass('storage_region_backends') IS NOT NULL
                "#,
            )
            .fetch_one(&state.pg)
            .await
            .unwrap_or(false)
    } else {
        false
    };
    let redis_ok = state.redis.ping().await;
    let disk_cache_status = state.disk_cache.readiness_status().await;
    let accounting_status = accounting::status(&state).await.unwrap_or_else(|_| {
        serde_json::json!({
            "durable": false,
            "pending": 0,
            "unsafe": true,
            "region": state.cfg.regions.local_region(),
        })
    });
    let accounting_ok = accounting_status
        .get("unsafe")
        .and_then(serde_json::Value::as_bool)
        == Some(false)
        && accounting_status
            .get("mutationReconciliationNeeded")
            .and_then(serde_json::Value::as_i64)
            == Some(0)
        && accounting_status
            .get("committedMutationsPending")
            .and_then(serde_json::Value::as_i64)
            == Some(0);
    let backend_probe_targets = state
        .cfg
        .regions
        .configured_regions()
        .flat_map(|region| {
            state
                .cfg
                .regions
                .configured_backends(region)
                .map(move |(backend, _)| (region.to_string(), backend.to_string()))
        })
        .collect::<Vec<_>>();
    let backend_probe_results = stream::iter(backend_probe_targets)
        .map(|(region, backend)| {
            let state = state.clone();
            async move {
                let healthy = match signed_backend_request(
                    &state,
                    &region,
                    &backend,
                    Method::HEAD,
                    "",
                    &HeaderMap::new(),
                    None,
                ) {
                    Ok(request) => tokio::time::timeout(Duration::from_secs(5), request.send())
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .is_some_and(|response| response.status().is_success()),
                    Err(error) => {
                        warn!(
                            error = %error,
                            storage_region = region,
                            storage_backend = backend,
                            "failed to create storage backend readiness request"
                        );
                        false
                    }
                };
                (region, backend, healthy)
            }
        })
        .buffer_unordered(8)
        .collect::<Vec<_>>()
        .await;
    let mut grouped_backends = BTreeMap::<String, BTreeMap<String, bool>>::new();
    for (region, backend, healthy) in backend_probe_results {
        if let Err(error) =
            replication::record_backend_probe(&state, &region, &backend, healthy).await
        {
            warn!(error = %error, storage_region = region, storage_backend = backend, "failed to persist backend verification evidence");
        }
        grouped_backends
            .entry(region)
            .or_default()
            .insert(backend, healthy);
    }
    let storage_backends = grouped_backends
        .into_iter()
        .map(|(region, backends)| {
            let backends = backends
                .into_iter()
                .map(|(backend, healthy)| (backend, serde_json::Value::Bool(healthy)))
                .collect::<serde_json::Map<_, _>>();
            (region, serde_json::Value::Object(backends))
        })
        .collect::<serde_json::Map<_, _>>();

    let mut storage_regions = serde_json::Map::new();
    let mut active_backends = serde_json::Map::new();
    let mut active_storage_backends = serde_json::Map::new();
    let mut backend_generations = serde_json::Map::new();
    let served_regions = state
        .cfg
        .regions
        .served_regions()
        .map(str::to_string)
        .collect::<Vec<_>>();
    for region in &served_regions {
        let active = if regional_schema_ok {
            writer::active_backend(&state, region).await.ok()
        } else {
            None
        };
        let healthy = active.as_ref().is_some_and(|active| {
            storage_backends
                .get(region)
                .and_then(serde_json::Value::as_object)
                .and_then(|backends| backends.get(&active.id))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false)
        });
        storage_regions.insert(region.clone(), serde_json::Value::Bool(healthy));

        if let Some(active) = active {
            active_storage_backends
                .insert(region.clone(), serde_json::Value::String(active.id.clone()));
            backend_generations.insert(
                region.clone(),
                serde_json::Value::Number(active.generation.into()),
            );
            let metadata = sqlx::query(
                r#"
                SELECT b.provider, b.role, b.status, b.replication_checkpoint,
                       b.replication_caught_up_at, b.last_verified_at,
                       b.bootstrap_state, b.bootstrap_barrier_sequence,
                       b.bootstrap_cursor, b.bootstrap_objects_copied,
                       b.bootstrap_bytes_copied, b.bootstrap_started_at,
                       b.bootstrap_completed_at, b.bootstrap_verified_at,
                       b.bootstrap_last_error,
                       s.required_replication_checkpoint
                FROM storage_region_state s
                JOIN storage_region_backends b
                  ON b.region_id = s.region_id
                 AND b.backend_id = s.active_backend_id
                WHERE s.region_id = $1
                "#,
            )
            .bind(region)
            .fetch_optional(&state.pg)
            .await
            .ok()
            .flatten();
            let value = if let Some(row) = metadata {
                serde_json::json!({
                    "backendId": active.id,
                    "backendGeneration": active.generation,
                    "provider": row.try_get::<String, _>("provider").ok(),
                    "role": row.try_get::<String, _>("role").ok(),
                    "status": row.try_get::<String, _>("status").ok(),
                    "replicationCheckpoint": row.try_get::<i64, _>("replication_checkpoint").ok(),
                    "requiredReplicationCheckpoint": row.try_get::<i64, _>("required_replication_checkpoint").ok(),
                    "replicationCaughtUpAt": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("replication_caught_up_at").ok().flatten().map(|value| value.to_rfc3339()),
                    "lastVerifiedAt": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_verified_at").ok().flatten().map(|value| value.to_rfc3339()),
                    "bootstrapState": row.try_get::<String, _>("bootstrap_state").ok(),
                    "bootstrapBarrierSequence": row.try_get::<Option<i64>, _>("bootstrap_barrier_sequence").ok().flatten().map(|value| value.to_string()),
                    "bootstrapCursor": row.try_get::<Option<String>, _>("bootstrap_cursor").ok().flatten(),
                    "bootstrapObjectsCopied": row.try_get::<i64, _>("bootstrap_objects_copied").unwrap_or(0).to_string(),
                    "bootstrapBytesCopied": row.try_get::<i64, _>("bootstrap_bytes_copied").unwrap_or(0).to_string(),
                    "bootstrapStartedAt": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("bootstrap_started_at").ok().flatten().map(|value| value.to_rfc3339()),
                    "bootstrapCompletedAt": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("bootstrap_completed_at").ok().flatten().map(|value| value.to_rfc3339()),
                    "bootstrapVerifiedAt": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("bootstrap_verified_at").ok().flatten().map(|value| value.to_rfc3339()),
                    "bootstrapLastError": row.try_get::<Option<String>, _>("bootstrap_last_error").ok().flatten(),
                    "healthy": healthy,
                })
            } else {
                serde_json::json!({
                    "backendId": active.id,
                    "backendGeneration": active.generation,
                    "healthy": healthy,
                })
            };
            active_backends.insert(region.clone(), value);
        }
    }

    let mut replication = serde_json::Map::new();
    if regional_schema_ok {
        if let Ok(rows) = sqlx::query(
            r#"
            SELECT b.region_id, b.backend_id, b.status, b.promotion_authorized,
                   b.replication_checkpoint, b.replication_caught_up_at,
                   b.last_verified_at, b.bootstrap_state,
                   b.bootstrap_barrier_sequence, b.bootstrap_cursor,
                   b.bootstrap_objects_copied, b.bootstrap_bytes_copied,
                   b.bootstrap_started_at, b.bootstrap_completed_at,
                   b.bootstrap_verified_at, b.bootstrap_last_error,
                   s.required_replication_checkpoint
            FROM storage_region_backends b
            JOIN storage_region_state s ON s.region_id = b.region_id
            ORDER BY b.region_id, b.backend_id
            "#,
        )
        .fetch_all(&state.pg)
        .await
        {
            let now = chrono::Utc::now();
            for row in rows {
                let Ok(region) = row.try_get::<String, _>("region_id") else {
                    continue;
                };
                let Ok(backend) = row.try_get::<String, _>("backend_id") else {
                    continue;
                };
                if state
                    .cfg
                    .regions
                    .configured_backend(&region, &backend)
                    .is_none()
                {
                    continue;
                }
                let checkpoint = row.try_get::<i64, _>("replication_checkpoint").unwrap_or(0);
                let required = row
                    .try_get::<i64, _>("required_replication_checkpoint")
                    .unwrap_or(i64::MAX);
                let caught_up_at = row
                    .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("replication_caught_up_at")
                    .ok()
                    .flatten();
                let verified_at = row
                    .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("last_verified_at")
                    .ok()
                    .flatten();
                let checkpoint_age =
                    caught_up_at.map(|value| now.signed_duration_since(value).num_seconds().max(0));
                let verification_age =
                    verified_at.map(|value| now.signed_duration_since(value).num_seconds().max(0));
                let fresh = checkpoint_age
                    .is_some_and(|age| age <= state.cfg.backend_verification_max_age_seconds)
                    && verification_age
                        .is_some_and(|age| age <= state.cfg.backend_verification_max_age_seconds);
                let bootstrap_state = row
                    .try_get::<String, _>("bootstrap_state")
                    .unwrap_or_else(|_| "pending".to_string());
                let bootstrap_verified_at = row
                    .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("bootstrap_verified_at")
                    .ok()
                    .flatten();
                let bootstrap_verification_age = bootstrap_verified_at
                    .map(|value| now.signed_duration_since(value).num_seconds().max(0));
                let bootstrap_complete = bootstrap_state == "complete"
                    && bootstrap_verification_age
                        .is_some_and(|age| age <= state.cfg.backend_verification_max_age_seconds);
                let gate = serde_json::json!({
                    "caughtUp": checkpoint >= required,
                    "fresh": fresh,
                    "bootstrapComplete": bootstrap_complete,
                    "bootstrapState": bootstrap_state,
                    "bootstrapBarrierSequence": row.try_get::<Option<i64>, _>("bootstrap_barrier_sequence").ok().flatten().map(|value| value.to_string()),
                    "bootstrapCursor": row.try_get::<Option<String>, _>("bootstrap_cursor").ok().flatten(),
                    "bootstrapObjectsCopied": row.try_get::<i64, _>("bootstrap_objects_copied").unwrap_or(0).to_string(),
                    "bootstrapBytesCopied": row.try_get::<i64, _>("bootstrap_bytes_copied").unwrap_or(0).to_string(),
                    "bootstrapStartedAt": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("bootstrap_started_at").ok().flatten().map(|value| value.to_rfc3339()),
                    "bootstrapCompletedAt": row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("bootstrap_completed_at").ok().flatten().map(|value| value.to_rfc3339()),
                    "bootstrapVerifiedAt": bootstrap_verified_at.map(|value| value.to_rfc3339()),
                    "bootstrapVerificationAgeSeconds": bootstrap_verification_age,
                    "bootstrapLastError": row.try_get::<Option<String>, _>("bootstrap_last_error").ok().flatten(),
                    "authorized": row.try_get::<bool, _>("promotion_authorized").unwrap_or(false),
                    "checkpoint": checkpoint.to_string(),
                    "checkpointAgeSeconds": checkpoint_age,
                    "lagObjects": required.saturating_sub(checkpoint).max(0),
                    "status": row.try_get::<String, _>("status").ok(),
                });
                replication
                    .entry(region)
                    .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
                    .as_object_mut()
                    .expect("replication region is an object")
                    .insert(backend, gate);
            }
        }
    }

    let storage_ok = storage_regions
        .get(state.cfg.regions.local_region())
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let all_served_storage_ok = storage_regions
        .values()
        .all(|value| value.as_bool().unwrap_or(false));
    // Dragonfly is an optional acceleration layer. Its state is exposed so
    // operators can repair it, but an outage must not take durable S3 serving
    // offline.
    let ok = postgres_ok && regional_schema_ok && accounting_ok && all_served_storage_ok;
    let active_writers = if regional_schema_ok {
        writer::active_generations(&state).await.unwrap_or_default()
    } else {
        BTreeMap::new()
    };
    let active_writer = active_writers
        .get(state.cfg.regions.local_region())
        .copied();
    let failover_regions = served_regions
        .iter()
        .filter(|region| state.cfg.regions.is_failover(region))
        .cloned()
        .collect::<Vec<_>>();
    let body = serde_json::json!({
        "status": if ok { "ok" } else { "degraded" },
        "postgres": postgres_ok,
        "regionalSchema": regional_schema_ok,
        "redis": redis_ok,
        "diskCache": disk_cache_status,
        "accounting": accounting_status,
        "storage": storage_ok,
        "region": state.cfg.regions.local_region(),
        "storageRegions": storage_regions,
        "storageBackends": storage_backends,
        "activeBackends": active_backends,
        "activeStorageBackends": active_storage_backends,
        "backendGenerations": backend_generations,
        "replication": replication,
        "activeWriterRegions": active_writers,
        "failoverRegions": failover_regions,
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
    payload: Option<Json<RegionRequest>>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    let region = payload
        .as_ref()
        .map(|Json(payload)| payload.region.as_str())
        .unwrap_or_else(|| state.cfg.regions.local_region());
    match writer::claim(&state, region).await {
        Ok(generation) => json_response(
            StatusCode::OK,
            serde_json::json!({ "ok": true, "region": region, "generation": generation }),
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
    payload: Option<Json<RegionRequest>>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    let region = payload
        .as_ref()
        .map(|Json(payload)| payload.region.as_str())
        .unwrap_or_else(|| state.cfg.regions.local_region());
    if state.cfg.regions.ensure_served(region).is_err() {
        return json_response(
            StatusCode::BAD_REQUEST,
            serde_json::json!({ "ok": false, "error": "invalid storage region" }),
        );
    }
    match accounting::flush(&state).await {
        Ok(result) => json_response(
            if result.ok {
                StatusCode::OK
            } else {
                StatusCode::SERVICE_UNAVAILABLE
            },
            serde_json::to_value(result)
                .map(|mut value| {
                    value["region"] = serde_json::Value::String(region.to_string());
                    value
                })
                .unwrap_or_else(|_| serde_json::json!({ "ok": false, "region": region })),
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
    #[serde(default)]
    region: Option<String>,
}

#[derive(Deserialize)]
struct RegionRequest {
    region: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoragePromotionRequest {
    #[serde(alias = "regionId")]
    region: String,
    #[serde(alias = "backendId")]
    target_backend_id: String,
    #[serde(deserialize_with = "deserialize_i64_string_or_number")]
    expected_backend_generation: i64,
    #[serde(default = "default_promotion_actor")]
    actor: String,
    #[serde(default = "default_promotion_reason")]
    reason: String,
}

fn default_promotion_actor() -> String {
    "status-controller".to_string()
}

fn default_promotion_reason() -> String {
    "automated provider failover".to_string()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BucketTeardownVerifyRequest {
    bucket_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BucketTeardownReleaseRequest {
    bucket_id: String,
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum ReplicationReconcileResolutionRequest {
    Committed,
    Cancelled,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReplicationReconcileRequest {
    #[serde(deserialize_with = "deserialize_i64_string_or_number")]
    sequence: i64,
    event_id: String,
    resolution: ReplicationReconcileResolutionRequest,
    actor: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StorageBootstrapRequest {
    #[serde(alias = "regionId")]
    region: String,
    backend_id: String,
    actor: String,
    reason: String,
}

fn deserialize_i64_string_or_number<'de, D>(deserializer: D) -> std::result::Result<i64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum ExactI64 {
        String(String),
        Number(i64),
    }
    match ExactI64::deserialize(deserializer)? {
        ExactI64::String(value) => value.parse::<i64>().map_err(serde::de::Error::custom),
        ExactI64::Number(value) => Ok(value),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AuthCacheInvalidateRequest {
    #[serde(default)]
    bucket_id: Option<String>,
    #[serde(default)]
    bucket_name: Option<String>,
    #[serde(default, alias = "accessKey")]
    access_key_id: Option<String>,
    #[serde(default, alias = "accessKeys")]
    access_key_ids: Vec<String>,
}

async fn internal_auth_cache_invalidate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut request): Json<AuthCacheInvalidateRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return empty_response(StatusCode::UNAUTHORIZED);
    }
    if let Some(access_key) = request.access_key_id.take() {
        request.access_key_ids.push(access_key);
    }
    let bounded = request
        .bucket_id
        .as_deref()
        .is_none_or(|value| value.len() <= 64 && uuid::Uuid::parse_str(value).is_ok())
        && request.bucket_name.as_deref().is_none_or(|value| {
            !value.is_empty()
                && value.len() <= 255
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b".-_".contains(&byte))
        })
        && request.access_key_ids.len() <= 100
        && request.access_key_ids.iter().all(|value| {
            !value.is_empty()
                && value.len() <= 256
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        });
    if !bounded
        || (request.bucket_id.is_none()
            && request.bucket_name.is_none()
            && request.access_key_ids.is_empty())
    {
        return empty_response(StatusCode::BAD_REQUEST);
    }
    match auth::invalidate_cached_contexts(
        &state,
        request.bucket_id.as_deref(),
        request.bucket_name.as_deref(),
        &request.access_key_ids,
    )
    .await
    {
        Ok(()) => empty_response(StatusCode::NO_CONTENT),
        Err(error) => {
            warn!(error = %error, "protected authorization cache invalidation failed");
            // Never reveal which requested cache key or database row existed.
            empty_response(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

async fn internal_storage_promote(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<StoragePromotionRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return Response::builder()
            .status(StatusCode::UNAUTHORIZED)
            .body(Body::empty())
            .unwrap_or_else(|_| Response::new(Body::empty()));
    }
    match writer::promote_backend(
        &state,
        &request.region,
        &request.target_backend_id,
        request.expected_backend_generation,
        &request.actor,
        &request.reason,
    )
    .await
    {
        Ok(result) => json_response(
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "region": &result.region,
                "fromBackendId": &result.from_backend_id,
                "toBackendId": &result.to_backend_id,
                "oldBackendGeneration": result.old_backend_generation,
                "newBackendGeneration": result.new_backend_generation,
                "backendId": &result.to_backend_id,
                "generation": result.new_backend_generation,
            }),
        ),
        Err(error) => {
            warn!(
                error = %error,
                storage_region = request.region,
                target_backend = request.target_backend_id,
                "storage backend promotion rejected"
            );
            json_response(
                StatusCode::CONFLICT,
                serde_json::json!({
                    "ok": false,
                    "error": "storage backend promotion preconditions were not met"
                }),
            )
        }
    }
}

async fn internal_replication_reconcile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<ReplicationReconcileRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return empty_response(StatusCode::UNAUTHORIZED);
    }
    let resolution = match request.resolution {
        ReplicationReconcileResolutionRequest::Committed => {
            replication::ReconcileResolution::Committed
        }
        ReplicationReconcileResolutionRequest::Cancelled => {
            replication::ReconcileResolution::Cancelled
        }
    };
    match replication::reconcile(
        &state,
        request.sequence,
        &request.event_id,
        resolution,
        &request.actor,
        &request.reason,
    )
    .await
    {
        Ok(result) => json_response(
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "sequence": result.sequence.to_string(),
                "region": result.region,
                "resolution": result.resolution,
            }),
        ),
        Err(error) => {
            warn!(error = %error, sequence = request.sequence, "replication reconciliation rejected");
            json_response(
                StatusCode::CONFLICT,
                serde_json::json!({
                    "ok": false,
                    "error": "replication event reconciliation preconditions were not met"
                }),
            )
        }
    }
}

async fn internal_storage_bootstrap_start(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<StorageBootstrapRequest>,
) -> Response<Body> {
    internal_storage_bootstrap(state, headers, request, false).await
}

async fn internal_storage_bootstrap_retry(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<StorageBootstrapRequest>,
) -> Response<Body> {
    internal_storage_bootstrap(state, headers, request, true).await
}

async fn internal_storage_bootstrap(
    state: AppState,
    headers: HeaderMap,
    request: StorageBootstrapRequest,
    retry: bool,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return empty_response(StatusCode::UNAUTHORIZED);
    }
    match replication::start_bootstrap(
        &state,
        &request.region,
        &request.backend_id,
        &request.actor,
        &request.reason,
        retry,
    )
    .await
    {
        Ok(result) => json_response(
            StatusCode::ACCEPTED,
            serde_json::json!({
                "ok": true,
                "region": result.region,
                "backendId": result.backend_id,
                "bootstrapState": result.state,
                "bootstrapBarrierSequence": result.barrier_sequence.to_string(),
            }),
        ),
        Err(error) => {
            warn!(
                error = %error,
                region = request.region,
                backend_id = request.backend_id,
                retry,
                "provider bootstrap request rejected"
            );
            json_response(
                StatusCode::CONFLICT,
                serde_json::json!({
                    "ok": false,
                    "error": "provider bootstrap preconditions were not met"
                }),
            )
        }
    }
}

async fn internal_bucket_teardown_verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<BucketTeardownVerifyRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return empty_response(StatusCode::UNAUTHORIZED);
    }
    if uuid::Uuid::parse_str(&request.bucket_id).is_err() {
        return empty_response(StatusCode::BAD_REQUEST);
    }
    match begin_verified_bucket_teardown(&state, &request.bucket_id).await {
        Ok(token) => json_response(
            StatusCode::OK,
            serde_json::json!({
                "ok": true,
                "bucketId": request.bucket_id,
                "token": token,
                "expiresInSeconds": 600,
            }),
        ),
        Err(error) => {
            warn!(error = %error, bucket_id = request.bucket_id, "bucket teardown verification rejected");
            json_response(
                StatusCode::CONFLICT,
                serde_json::json!({ "ok": false, "error": "bucket teardown preconditions were not met" }),
            )
        }
    }
}

async fn begin_verified_bucket_teardown(state: &AppState, bucket_id: &str) -> Result<String> {
    let transaction = writer::begin_bucket_teardown(state, bucket_id).await?;
    let accounting = accounting::flush(state).await?;
    if !accounting.ok || accounting.pending != 0 || accounting.unsafe_state {
        return Err(anyhow!("accounting is not durably flushed"));
    }
    let row = sqlx::query(
        r#"
        SELECT id::text AS id, name, user_id, is_system, resolved_region
        FROM buckets WHERE id = $1::uuid
        "#,
    )
    .bind(bucket_id)
    .fetch_optional(&state.pg)
    .await?
    .ok_or_else(|| anyhow!("bucket does not exist"))?;
    let bucket_name: String = row.try_get("name")?;
    let user_id: Option<String> = row.try_get("user_id")?;
    let root = internal_storage::authoritative_root(
        &bucket_name,
        user_id.as_deref(),
        row.try_get("is_system")?,
    )?;
    let resolved_region: String = row.try_get("resolved_region")?;
    state.cfg.regions.ensure_served(&resolved_region)?;
    let mut bucket = AuthBucket {
        id: row.try_get("id")?,
        name: bucket_name,
        resolved_region: resolved_region.clone(),
        active_backend: None,
        writer_generation: None,
    };
    bucket.active_backend = Some(writer::active_backend(state, &resolved_region).await?);
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("list-type", "2")
        .append_pair("max-keys", "1")
        .append_pair("prefix", &root)
        .finish();
    let response = tokio::time::timeout(
        Duration::from_secs(15),
        signed_upstream_request(
            state,
            &bucket,
            Method::GET,
            &format!("?{query}"),
            &HeaderMap::new(),
            None,
        )?
        .send(),
    )
    .await
    .context("bucket teardown emptiness proof timed out")??;
    if !response.status().is_success() {
        return Err(anyhow!("bucket teardown emptiness proof failed"));
    }
    let body = response.text().await?;
    if body.contains("<Contents>") || body.contains("<Contents ") {
        return Err(anyhow!("bucket is not empty"));
    }

    let token = uuid::Uuid::new_v4().to_string();
    let mut guards = state.bucket_teardowns.lock().await;
    guards.insert(
        token.clone(),
        BucketTeardownGuard {
            bucket_id: bucket_id.to_string(),
            expires_at: std::time::Instant::now() + Duration::from_secs(600),
            transaction,
        },
    );
    Ok(token)
}

async fn internal_bucket_teardown_release(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(request): Json<BucketTeardownReleaseRequest>,
) -> Response<Body> {
    if !internal_auth_ok(&state.cfg, &headers) {
        return empty_response(StatusCode::UNAUTHORIZED);
    }
    if uuid::Uuid::parse_str(&request.bucket_id).is_err()
        || uuid::Uuid::parse_str(&request.token).is_err()
    {
        return empty_response(StatusCode::BAD_REQUEST);
    }
    let guard = state.bucket_teardowns.lock().await.remove(&request.token);
    let Some(guard) = guard else {
        return empty_response(StatusCode::NOT_FOUND);
    };
    if guard.bucket_id != request.bucket_id {
        // Dropping the transaction releases the exclusive advisory lock. A
        // token can never be used to finalize a different bucket.
        return empty_response(StatusCode::CONFLICT);
    }
    match guard.transaction.commit().await {
        Ok(()) => empty_response(StatusCode::NO_CONTENT),
        Err(error) => {
            warn!(error = %error, bucket_id = request.bucket_id, "failed to release bucket teardown fence");
            empty_response(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

fn start_bucket_teardown_cleanup(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        interval.tick().await;
        loop {
            interval.tick().await;
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let now = std::time::Instant::now();
            let mut guards = state.bucket_teardowns.lock().await;
            let expired = guards
                .iter()
                .filter_map(|(token, guard)| (guard.expires_at <= now).then_some(token.clone()))
                .collect::<Vec<_>>();
            for token in expired {
                if let Some(guard) = guards.remove(&token) {
                    warn!(
                        bucket_id = guard.bucket_id,
                        "expired bucket teardown fence released"
                    );
                    drop(guard);
                }
            }
        }
    });
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
    if let Some(region) = request.region.as_deref() {
        if state.cfg.regions.ensure_served(region).is_err() {
            return json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "ok": false, "error": "invalid storage region" }),
            );
        }
        let Ok(mut draining_regions) = state.draining_regions.write() else {
            return json_response(
                StatusCode::SERVICE_UNAVAILABLE,
                serde_json::json!({ "ok": false, "error": "drain state unavailable" }),
            );
        };
        if request.enabled {
            draining_regions.insert(region.to_string());
        } else {
            draining_regions.remove(region);
        }
    } else {
        state.draining.store(request.enabled, Ordering::SeqCst);
    }
    json_response(
        StatusCode::OK,
        serde_json::json!({
            "ok": true,
            "region": request.region,
            "draining": request.enabled
        }),
    )
}

fn json_response(status: StatusCode, value: serde_json::Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(value.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn empty_response(status: StatusCode) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Body::empty())
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

    match invalidate_list_cache(&state, &request.bucket_id, &request.resolved_region).await {
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
    let Some(provided) = headers
        .get("x-dataplane-secret")
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Ok(mut provided_mac) = Hmac::<Sha256>::new_from_slice(cfg.internal_secret.as_bytes())
    else {
        return false;
    };
    provided_mac.update(provided.as_bytes());
    let Ok(mut expected_mac) = Hmac::<Sha256>::new_from_slice(cfg.internal_secret.as_bytes())
    else {
        return false;
    };
    expected_mac.update(cfg.internal_secret.as_bytes());
    provided_mac
        .verify_slice(&expected_mac.finalize().into_bytes())
        .is_ok()
}

impl Config {
    fn from_env() -> Result<Self> {
        let emergency_mode = match env::var("DATAPLANE_MODE")
            .unwrap_or_else(|_| "production".to_string())
            .as_str()
        {
            "production" | "regional" => false,
            "emergency" => true,
            value => {
                return Err(anyhow!(
                    "DATAPLANE_MODE must be regional, production, or emergency, got {value}"
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
        let regions = RegionRegistry::from_env(&s3_domain)?;
        let local_region = regions.local_region().to_string();
        let mut origin_domains = env::var("DATAPLANE_ORIGIN_DOMAINS")
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_ascii_lowercase)
            .collect::<Vec<_>>();
        origin_domains.extend(regions.ingress_domains().map(str::to_ascii_lowercase));
        origin_domains.sort_unstable();
        origin_domains.dedup();
        let deep_freeze_storage_prefix = env::var("DEEP_FREEZE_STORAGE_PREFIX")
            .unwrap_or_else(|_| "deep-freeze".into())
            .trim_matches('/')
            .to_string();
        if deep_freeze_storage_prefix.is_empty()
            || deep_freeze_storage_prefix.contains('\\')
            || deep_freeze_storage_prefix
                .split('/')
                .any(|segment| segment.is_empty() || segment == "." || segment == "..")
        {
            return Err(anyhow!("DEEP_FREEZE_STORAGE_PREFIX is invalid"));
        }
        let accounting_spool_dir = env::var_os("DATAPLANE_ACCOUNTING_SPOOL_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                let base = env::var_os("DISK_CACHE_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or_else(|| std::path::PathBuf::from("/var/lib/silo-dataplane"));
                base.join("accounting-spool")
            });
        let mut replication_excluded_prefixes = env::var("DATAPLANE_REPLICATION_EXCLUDED_PREFIXES")
            .unwrap_or_else(|_| "__silo_healthcheck/".to_string())
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if replication_excluded_prefixes.iter().any(|prefix| {
            prefix.starts_with('/')
                || prefix.contains('\0')
                || prefix.split('/').any(|part| part == "." || part == "..")
        }) {
            return Err(anyhow!(
                "DATAPLANE_REPLICATION_EXCLUDED_PREFIXES contains an invalid prefix"
            ));
        }
        replication_excluded_prefixes.sort();
        replication_excluded_prefixes.dedup();

        Ok(Self {
            bind: env::var("DATAPLANE_BIND").unwrap_or_else(|_| "0.0.0.0:3001".into()),
            control_plane_url,
            internal_secret,
            offboarding_export_derivation_secret: env::var("OFFBOARDING_EXPORT_DERIVATION_SECRET")
                .or_else(|_| env::var("HC_AUTH_CLIENT_SECRET"))
                .ok()
                .filter(|value| value.len() >= 24),
            public_scheme: env::var("DATAPLANE_PUBLIC_SCHEME").unwrap_or_else(|_| "https".into()),
            s3_domain,
            dashboard_domain,
            origin_domains,
            custom_domains_enabled: env_bool("DOMAINS"),
            deep_freeze_enabled: env_bool("DEEP_FREEZE"),
            deep_freeze_storage_prefix,
            regions,
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
                    format!("emergency-{local_region}")
                } else {
                    format!("dataplane-{local_region}")
                }
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
            backend_verification_max_age_seconds: env::var(
                "DATAPLANE_BACKEND_VERIFICATION_MAX_AGE_SECONDS",
            )
            .ok()
            .and_then(|value| value.parse::<i64>().ok())
            .filter(|value| (30..=3600).contains(value))
            .unwrap_or(300),
            active_backend_cache_ttl: Duration::from_millis(
                env::var("DATAPLANE_ACTIVE_BACKEND_CACHE_TTL_MS")
                    .ok()
                    .and_then(|value| value.parse::<u64>().ok())
                    .filter(|value| (100..=5_000).contains(value))
                    .unwrap_or(1_000),
            ),
            replication_excluded_prefixes,
            bootstrap_copy_concurrency: env::var("DATAPLANE_BOOTSTRAP_COPY_CONCURRENCY")
                .ok()
                .and_then(|value| value.parse::<usize>().ok())
                .filter(|value| (1..=32).contains(value))
                .unwrap_or(8),
            accounting_spool_dir: accounting_spool_dir.clone(),
            accounting_unsafe_marker: env::var_os("DATAPLANE_ACCOUNTING_UNSAFE_MARKER")
                .map(std::path::PathBuf::from)
                .or_else(|| Some(accounting_spool_dir.join("unsafe"))),
        })
    }
}

fn default_storage_region() -> String {
    DEFAULT_STORAGE_REGION.to_string()
}

fn env_bool(name: &str) -> bool {
    matches!(
        env::var(name).ok().as_deref(),
        Some("1" | "true" | "TRUE" | "yes" | "YES" | "on" | "ON")
    )
}

async fn handle_request(State(state): State<AppState>, mut req: Request<Body>) -> Response<Body> {
    let emergency_mode = state.cfg.emergency_mode;
    let started = std::time::Instant::now();
    let method = req.method().to_string();
    let path = req
        .uri()
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or("/")
        .to_string();
    let ingress_bytes = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let ip_address = rate_limit::client_identity(req.headers());
    let user_agent = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .chars()
        .take(512)
        .collect::<String>();
    let log_context = Arc::new(Mutex::new(RequestLogContext {
        request_id: uuid::Uuid::new_v4().to_string(),
        bucket_id: String::new(),
        bucket_name: String::new(),
        owner_id: String::new(),
        requester_id: String::new(),
        storage_region: String::new(),
        action: String::new(),
    }));
    req.extensions_mut().insert(log_context.clone());
    let response = match handle_request_inner(state.clone(), req).await {
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
    let response = with_failover_header(response, emergency_mode);
    let egress_bytes = response
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let context = log_context
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    tracing::info!(
        event = "silo.request",
        event_time = %chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        request_id = %context.request_id,
        region = %state.cfg.regions.local_region(),
        service = "silo-dataplane",
        instance = %state.cfg.writer_instance_id,
        storage_region = %context.storage_region,
        action = %context.action,
        bucket_id = %context.bucket_id,
        bucket_name = %context.bucket_name,
        owner_id = %context.owner_id,
        requester_id = %context.requester_id,
        method = %method,
        path = %path,
        status_code = response.status().as_u16(),
        ingress_bytes,
        egress_bytes,
        latency_ms = started.elapsed().as_millis() as u64,
        ip_address = %ip_address,
        user_agent = %user_agent,
        "silo request completed"
    );
    response
}

async fn handle_request_inner(state: AppState, req: Request<Body>) -> Result<Response<Body>> {
    let (parts, body) = req.into_parts();
    let request_log = parts
        .extensions
        .get::<Arc<Mutex<RequestLogContext>>>()
        .cloned();
    let method = parts.method.clone();
    let headers = parts.headers.clone();
    let url = reconstruct_url(&state.cfg, &parts.uri, &headers)?;

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

    let mut auth = authorize(&state, &method, &url, &headers).await?;
    if let Some(request_log) = request_log.as_ref() {
        let mut context = request_log
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        context.action = auth.action.clone().unwrap_or_default();
        if let Some(bucket) = auth.bucket.as_ref() {
            context.bucket_id = bucket.id.clone();
            context.bucket_name = bucket.name.clone();
            context.storage_region = bucket.resolved_region.clone();
        }
        if let Some(user) = auth.user.as_ref() {
            context.owner_id = user.id.clone();
            context.requester_id = user.id.clone();
        }
    }
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
    let action_name = auth.action.clone().unwrap_or_default();
    let action = action_name.as_str();
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

    let storage_region = auth
        .bucket
        .as_ref()
        .map(|bucket| bucket.resolved_region.clone());
    if action_uses_backing_storage(action) || writer::is_mutation(action) {
        let Some(storage_region) = storage_region.as_deref() else {
            return Ok(with_s3_headers(
                s3_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "StorageRegionUnavailable",
                    "The bucket storage region could not be resolved.",
                ),
                &auth,
            ));
        };
        if let Err(error) = state.cfg.regions.ensure_served(storage_region) {
            if headers.get("x-silo-peer-hop").is_none() {
                if let Some(peer) = state.cfg.regions.peer(storage_region).cloned() {
                    match proxy_region_peer(
                        state.clone(),
                        &peer,
                        method.clone(),
                        parts.uri.clone(),
                        headers.clone(),
                        body,
                    )
                    .await
                    {
                        Ok(response) => return Ok(response),
                        Err(proxy_error) => {
                            warn!(
                                error = %proxy_error,
                                peer = %peer,
                                bucket_storage_region = storage_region,
                                "regional peer proxy failed"
                            );
                            return Ok(with_s3_headers(
                                s3_error(
                                    StatusCode::SERVICE_UNAVAILABLE,
                                    "ServiceUnavailable",
                                    "The bucket's regional dataplane is temporarily unavailable.",
                                ),
                                &auth,
                            ));
                        }
                    }
                }
            }
            warn!(
                error = %error,
                active_dataplane_region = state.cfg.regions.local_region(),
                bucket_storage_region = storage_region,
                "request reached a dataplane that is not authorized to serve the bucket region"
            );
            return Ok(with_s3_headers(
                wrong_region_response(&state.cfg, storage_region),
                &auth,
            ));
        }
        if writer::is_mutation(action)
            && (state.draining.load(Ordering::SeqCst) || is_region_draining(&state, storage_region))
        {
            return Ok(with_s3_headers(
                s3_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "ServiceUnavailable",
                    "This storage region is draining for a fenced transfer. Retry shortly.",
                ),
                &auth,
            ));
        }
    }

    let (mutation_fence, writer_generation) = if writer::is_mutation(action) {
        let storage_region = storage_region
            .as_deref()
            .ok_or_else(|| anyhow!("mutation is missing bucket storage region"))?;
        let bucket_id = auth
            .bucket
            .as_ref()
            .map(|bucket| bucket.id.as_str())
            .ok_or_else(|| anyhow!("mutation is missing bucket identity"))?;
        if state.accounting_unsafe.load(Ordering::SeqCst) {
            return Ok(with_s3_headers(
                s3_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "AccountingUnavailable",
                    "Durable accounting is unavailable; mutations are temporarily fenced.",
                ),
                &auth,
            ));
        }
        let object_key = matches!(
            action,
            "PutObject" | "DeleteObject" | "CopyObject" | "CompleteMultipartUpload"
        )
        .then(|| {
            auth.path_with_query
                .as_deref()
                .unwrap_or("")
                .split_once('?')
                .map(|(path, _)| path)
                .unwrap_or(auth.path_with_query.as_deref().unwrap_or(""))
        });
        match writer::begin_mutation(
            &state,
            storage_region,
            bucket_id,
            false,
            object_key,
            action == "DeleteObjects",
        )
        .await
        {
            Ok((fence, Some(context))) => {
                if let Some(bucket) = auth.bucket.as_mut() {
                    bucket.active_backend = Some(context.backend);
                    bucket.writer_generation = Some(context.writer_generation);
                }
                (Some(fence), Some(context.writer_generation))
            }
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
        if action_uses_backing_storage(action) {
            let storage_region = storage_region
                .as_deref()
                .ok_or_else(|| anyhow!("request is missing bucket storage region"))?;
            let backend = match writer::active_backend(&state, storage_region).await {
                Ok(backend) => backend,
                Err(error) => {
                    error!(
                        error = %error,
                        bucket_storage_region = storage_region,
                        "failed to resolve authoritative storage backend"
                    );
                    return Ok(with_s3_headers(
                        s3_error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "StorageBackendUnavailable",
                            "The authoritative storage backend is unavailable.",
                        ),
                        &auth,
                    ));
                }
            };
            if let Some(bucket) = auth.bucket.as_mut() {
                bucket.active_backend = Some(backend);
                bucket.writer_generation = writer::current_generation(&state, storage_region)
                    .await
                    .ok();
            }
        }
        (None, None)
    };

    let ingress_region = state
        .cfg
        .regions
        .ingress_region(headers.get(HOST).and_then(|value| value.to_str().ok()));
    let active_dataplane_region = state.cfg.regions.local_region().to_string();
    let bucket_storage_region = storage_region.as_deref().unwrap_or("none");
    let failover_mode = storage_region
        .as_deref()
        .is_some_and(|region| state.cfg.regions.is_failover(region));
    let (backend_id, backend_generation) = auth
        .bucket
        .as_ref()
        .and_then(|bucket| bucket.active_backend.as_ref())
        .map(|backend| (backend.id.clone(), Some(backend.generation)))
        .unwrap_or_else(|| ("none".to_string(), None));
    info!(
        operation = action,
        request_ingress_region = ingress_region,
        active_dataplane_region = active_dataplane_region.as_str(),
        bucket_storage_region,
        failover_mode,
        storage_backend = backend_id.as_str(),
        backend_generation,
        writer_generation,
        "authorized S3 request"
    );

    record_request(&state, &auth).await;
    if writer::is_mutation(action) && state.accounting_unsafe.load(Ordering::SeqCst) {
        return Ok(with_s3_headers(
            s3_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "AccountingUnavailable",
                "Durable accounting is unavailable; mutations are temporarily fenced.",
            ),
            &auth,
        ));
    }
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
        if let Err(error) = fence.commit().await {
            return Err(error).context("failed to commit mutation fence transaction");
        }
    }
    response.map(|response| {
        with_region_headers(
            response,
            storage_region.as_deref(),
            &active_dataplane_region,
            failover_mode,
            &backend_id,
            writer_generation,
            backend_generation,
        )
    })
}

fn action_uses_backing_storage(action: &str) -> bool {
    matches!(
        action,
        "AbortMultipartUpload"
            | "CompleteMultipartUpload"
            | "CopyObject"
            | "CreateMultipartUpload"
            | "DeleteObject"
            | "DeleteObjects"
            | "GetObject"
            | "HeadObject"
            | "ListMultipartUploads"
            | "ListObjectsV2"
            | "ListParts"
            | "PutObject"
            | "UploadPart"
    )
}

fn start_writer_renewal(state: AppState) {
    tokio::spawn(async move {
        let renew_every = u64::try_from((state.cfg.writer_lease_seconds / 3).max(5)).unwrap_or(10);
        let mut interval = tokio::time::interval(Duration::from_secs(renew_every));
        interval.tick().await;
        loop {
            interval.tick().await;
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            let regions = state
                .cfg
                .regions
                .served_regions()
                .map(str::to_string)
                .collect::<Vec<_>>();
            for region in regions {
                match writer::renew(&state, &region).await {
                    Ok(true) => {}
                    Ok(false) => warn!(
                        storage_region = region,
                        "writer lease is owned by another dataplane"
                    ),
                    Err(error) => {
                        warn!(
                            error = %error,
                            storage_region = region,
                            "writer lease renewal failed; mutations will fail closed when it expires"
                        )
                    }
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

fn with_region_headers(
    mut response: Response<Body>,
    storage_region: Option<&str>,
    active_dataplane_region: &str,
    failover_mode: bool,
    _backend_id: &str,
    writer_generation: Option<i64>,
    backend_generation: Option<i64>,
) -> Response<Body> {
    if let Some(storage_region) = storage_region {
        if let Ok(value) = axum::http::HeaderValue::from_str(storage_region) {
            response.headers_mut().insert(
                axum::http::header::HeaderName::from_static("x-amz-bucket-region"),
                value,
            );
        }
    }
    if let Ok(value) = axum::http::HeaderValue::from_str(active_dataplane_region) {
        response.headers_mut().insert(
            axum::http::header::HeaderName::from_static("x-silo-active-region"),
            value,
        );
    }
    if failover_mode {
        response.headers_mut().insert(
            axum::http::header::HeaderName::from_static("x-silo-failover"),
            axum::http::HeaderValue::from_static("active"),
        );
    }
    if let Some(generation) = writer_generation {
        if let Ok(value) = axum::http::HeaderValue::from_str(&generation.to_string()) {
            response.headers_mut().insert(
                axum::http::header::HeaderName::from_static("x-silo-writer-generation"),
                value,
            );
        }
    }
    if let Some(generation) = backend_generation {
        if let Ok(value) = axum::http::HeaderValue::from_str(&generation.to_string()) {
            response.headers_mut().insert(
                axum::http::header::HeaderName::from_static("x-silo-backend-generation"),
                value,
            );
        }
    }
    response
}

fn wrong_region_response(cfg: &Config, storage_region: &str) -> Response<Body> {
    let mut response = s3_error(
        StatusCode::MISDIRECTED_REQUEST,
        "WrongRegion",
        "This endpoint is not currently authorized to serve the bucket's storage region.",
    );
    if let Ok(value) = axum::http::HeaderValue::from_str(storage_region) {
        response.headers_mut().insert(
            axum::http::header::HeaderName::from_static("x-amz-bucket-region"),
            value,
        );
    }
    if let Some(endpoint) = cfg
        .regions
        .preferred_ingress_domain(storage_region, &cfg.s3_domain)
    {
        if let Ok(value) = axum::http::HeaderValue::from_str(endpoint) {
            response.headers_mut().insert(
                axum::http::header::HeaderName::from_static("x-silo-preferred-endpoint"),
                value,
            );
        }
    }
    response
}

fn is_region_draining(state: &AppState, storage_region: &str) -> bool {
    state.draining.load(Ordering::SeqCst)
        || state
            .draining_regions
            .read()
            .map(|regions| regions.contains(storage_region))
            .unwrap_or(true)
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

async fn proxy_region_peer(
    state: AppState,
    peer: &url::Url,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Body,
) -> Result<Response<Body>> {
    let path_and_query = uri
        .path_and_query()
        .map(|value| value.as_str())
        .unwrap_or_else(|| uri.path());
    let url = peer.join(path_and_query.trim_start_matches('/'))?;
    let mut builder = state.http.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes())?,
        url,
    );
    for (name, value) in &headers {
        if should_forward_peer_header(name.as_str()) {
            builder = builder.header(name, value);
        }
    }
    if let Some(host) = headers.get(HOST) {
        builder = builder.header(HOST, host);
    }
    builder = builder.header("x-silo-peer-hop", state.cfg.regions.local_region());
    let has_body = method != Method::GET && method != Method::HEAD
        || headers.contains_key(header::CONTENT_LENGTH)
        || headers.contains_key(header::TRANSFER_ENCODING);
    let response = if has_body {
        let stream = body
            .into_data_stream()
            .map(|chunk| chunk.map_err(std::io::Error::other));
        builder
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await?
    } else {
        builder.send().await?
    };
    let status = StatusCode::from_u16(response.status().as_u16())?;
    let mut output = Response::builder().status(status);
    for (name, value) in response.headers() {
        if should_forward_peer_header(name.as_str()) {
            output = output.header(name, value);
        }
    }
    output = output.header("x-silo-peer-proxy", state.cfg.regions.local_region());
    let stream = response
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    Ok(output.body(Body::from_stream(stream))?)
}

fn should_forward_peer_header(name: &str) -> bool {
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
            | "x-dataplane-secret"
            | "x-silo-peer-hop"
    )
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
    let bucket = authorized_bucket(&auth)?;
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
        bucket,
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
    let bucket = authorized_bucket(&auth)?;
    if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
        state.disk_cache.record_demand(bucket, key, 0).await;
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
        bucket,
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
            .record_demand(bucket, key, content_length)
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
        && state.cfg.regions.is_local(&bucket.resolved_region)
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
                .should_admit(bucket, key, content_length)
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
    let bucket = authorized_bucket(&auth)?;
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
    let existing_size = if let Some(key) = auth.key.as_ref() {
        cached_existing_size(
            &state,
            bucket,
            key,
            auth.path_with_query.as_deref().unwrap_or(""),
        )
        .await?
        .unwrap_or(0)
    } else {
        head_existing_size(
            &state,
            bucket,
            auth.path_with_query.as_deref().unwrap_or(""),
        )
        .await?
        .unwrap_or(0)
    };
    let mut storage_reservation = None;

    if let Some(res) = check_ingress_bytes(&state, &auth, content_length).await? {
        return Ok(with_s3_headers(res, &auth));
    }

    if let Some(user) = &auth.user {
        let delta = content_length.saturating_sub(existing_size);
        if delta > 0 {
            match reserve_storage(&state, user, delta).await {
                Ok(reservation) => storage_reservation = Some(reservation),
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
        }
    }

    let replication_events = match replication::prepare(
        &state,
        bucket,
        &[auth.path_with_query.as_deref().unwrap_or("").to_string()],
        replication::Operation::Put,
    )
    .await
    {
        Ok(events) => events,
        Err(error) => {
            if let Some(reservation) = storage_reservation.take() {
                let _ = release_storage_reservation(&state, reservation).await;
            }
            return Err(error).context("failed to prepare provider replication for PUT");
        }
    };
    let object_path = auth.path_with_query.as_deref().unwrap_or("");
    let mutation_intent = match accounting::prepare_mutation_intent(
        &state,
        &bucket.resolved_region,
        &bucket.id,
        auth.user.as_ref().map(|user| user.id.as_str()),
        object_path
            .split_once('?')
            .map(|(path, _)| path)
            .unwrap_or(object_path),
        "put",
        existing_size,
        content_length,
        storage_reservation.and_then(|reservation| reservation.id()),
        replication_events
            .first()
            .map(replication::PreparedEvent::event_id),
    )
    .await
    {
        Ok(intent) => intent,
        Err(error) => {
            replication::cancel(
                &state,
                &replication_events,
                "accounting intent preparation failed",
            )
            .await?;
            if let Some(reservation) = storage_reservation.take() {
                let _ = release_storage_reservation(&state, reservation).await;
            }
            return Err(error).context("failed to prepare durable PUT accounting intent");
        }
    };

    let upstream = signed_upstream_request(
        &state,
        bucket,
        Method::PUT,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        Some(content_length),
    )?
    .body(upload_body(headers, body));

    let res = match upstream.send().await {
        Ok(res) => res,
        Err(error) => return Err(error.into()),
    };
    let status = res.status();

    if !status.is_success() {
        accounting::cancel_mutation_intent(
            &state,
            mutation_intent,
            "authoritative PUT was rejected",
        )
        .await?;
        replication::cancel(
            &state,
            &replication_events,
            "authoritative PUT was rejected",
        )
        .await?;
    } else if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
        accounting::commit_mutation_intent(&state, mutation_intent).await?;
        replication::commit(&state, &replication_events).await?;
        record_ingress(&state, &auth, content_length).await;
        invalidate_object_caches(&state, bucket, key).await;
        storage_reservation.take();
    }

    reqwest_to_s3_response(res, &auth).await
}

async fn fast_delete_object(
    state: AppState,
    auth: AuthorizeResponse,
    headers: &HeaderMap,
) -> Result<Response<Body>> {
    let bucket = authorized_bucket(&auth)?;
    let existing_size = if let Some(key) = auth.key.as_ref() {
        cached_existing_size(
            &state,
            bucket,
            key,
            auth.path_with_query.as_deref().unwrap_or(""),
        )
        .await?
        .unwrap_or(0)
    } else {
        head_existing_size(
            &state,
            bucket,
            auth.path_with_query.as_deref().unwrap_or(""),
        )
        .await?
        .unwrap_or(0)
    };
    let replication_events = replication::prepare(
        &state,
        bucket,
        &[auth.path_with_query.as_deref().unwrap_or("").to_string()],
        replication::Operation::Delete,
    )
    .await
    .context("failed to prepare provider replication for DELETE")?;
    let object_path = auth.path_with_query.as_deref().unwrap_or("");
    let mutation_intent = match accounting::prepare_mutation_intent(
        &state,
        &bucket.resolved_region,
        &bucket.id,
        auth.user.as_ref().map(|user| user.id.as_str()),
        object_path
            .split_once('?')
            .map(|(path, _)| path)
            .unwrap_or(object_path),
        "delete",
        existing_size,
        0,
        None,
        replication_events
            .first()
            .map(replication::PreparedEvent::event_id),
    )
    .await
    {
        Ok(intent) => intent,
        Err(error) => {
            replication::cancel(
                &state,
                &replication_events,
                "accounting intent preparation failed",
            )
            .await?;
            return Err(error).context("failed to prepare durable DELETE accounting intent");
        }
    };
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
    let should_invalidate = status.is_success() || status == reqwest::StatusCode::NOT_FOUND;

    if status.is_success() || status == reqwest::StatusCode::NOT_FOUND {
        accounting::commit_mutation_intent(&state, mutation_intent).await?;
        replication::commit(&state, &replication_events).await?;
    } else {
        accounting::cancel_mutation_intent(
            &state,
            mutation_intent,
            "authoritative DELETE was rejected",
        )
        .await?;
        replication::cancel(
            &state,
            &replication_events,
            "authoritative DELETE was rejected",
        )
        .await?;
    }

    if should_invalidate {
        if let (Some(bucket), Some(key)) = (auth.bucket.as_ref(), auth.key.as_ref()) {
            invalidate_object_caches(&state, bucket, key).await;
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
    let bucket = authorized_bucket(&auth)?;
    let bucket_id = auth
        .bucket
        .as_ref()
        .map(|bucket| bucket.id.as_str())
        .unwrap_or("");
    let upload_id = auth.upload_id.as_deref().unwrap_or("");
    if !writer::multipart_matches(
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
        reserved_part = Some((
            user.id.clone(),
            bucket_id.to_string(),
            upload_id.to_string(),
            part_number.to_string(),
        ));
    }

    let upstream = signed_upstream_request(
        &state,
        bucket,
        Method::PUT,
        auth.path_with_query.as_deref().unwrap_or(""),
        headers,
        Some(content_length),
    )?
    .body(upload_body(headers, body));

    let res = match upstream.send().await {
        Ok(res) => res,
        Err(error) => return Err(error.into()),
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

fn authorized_bucket(auth: &AuthorizeResponse) -> Result<&AuthBucket> {
    auth.bucket
        .as_ref()
        .ok_or_else(|| anyhow!("authorized storage request is missing bucket metadata"))
}

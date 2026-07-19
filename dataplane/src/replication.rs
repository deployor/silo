use std::{collections::BTreeSet, time::Duration};

use anyhow::{anyhow, Context, Result};
use axum::http::{HeaderMap, Method};
use futures_util::{stream, StreamExt};
use sha2::{Digest, Sha256};
use sqlx::Row;
use tracing::{info, warn};

use crate::{upstream::signed_backend_request, AppState, AuthBucket};

const STALE_DELIVERY_SECONDS: i64 = 5 * 60;
const BOOTSTRAP_CLAIM_SECONDS: i64 = 5 * 60;
const BOOTSTRAP_PAGE_SIZE: usize = 1_000;

#[derive(Clone, Copy, Debug)]
pub(crate) enum Operation {
    Put,
    Delete,
}

impl Operation {
    fn as_str(self) -> &'static str {
        match self {
            Self::Put => "put",
            Self::Delete => "delete",
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct PreparedEvent {
    sequence: i64,
    event_id: uuid::Uuid,
    object_key: String,
}

impl PreparedEvent {
    pub(crate) fn object_key(&self) -> &str {
        &self.object_key
    }

    pub(crate) fn event_id(&self) -> uuid::Uuid {
        self.event_id
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum ReconcileResolution {
    Committed,
    Cancelled,
}

#[derive(Debug)]
pub(crate) struct ReconcileResult {
    pub(crate) sequence: i64,
    pub(crate) region: String,
    pub(crate) resolution: &'static str,
}

#[derive(Debug)]
pub(crate) struct BootstrapResult {
    pub(crate) region: String,
    pub(crate) backend_id: String,
    pub(crate) state: String,
    pub(crate) barrier_sequence: i64,
}

#[derive(Debug)]
struct BootstrapJob {
    region: String,
    backend_id: String,
    state: String,
    barrier_sequence: i64,
    cursor: Option<String>,
    source_backend_id: String,
    source_generation: i64,
}

#[derive(Debug)]
struct ListedObject {
    key: String,
    size: u64,
}

#[derive(Debug)]
struct ObjectPage {
    objects: Vec<ListedObject>,
    next_cursor: Option<String>,
}

#[derive(Debug)]
enum CopyOutcome {
    Copied(u64),
    Missing,
}

#[derive(Debug)]
struct Delivery {
    sequence: i64,
    region: String,
    source_backend: String,
    target_backend: String,
    object_key: String,
    operation: String,
    attempts: i64,
}

/// Persist replication intent before the authoritative provider is mutated.
/// The trigger advances the required checkpoint immediately, so a crash in
/// the provider-commit ambiguity window blocks promotion until reconciled.
pub(crate) async fn prepare(
    state: &AppState,
    bucket: &AuthBucket,
    object_keys: &[String],
    operation: Operation,
) -> Result<Vec<PreparedEvent>> {
    if object_keys.is_empty() {
        return Ok(Vec::new());
    }
    let active = bucket.active_backend()?;
    let targets = sqlx::query_scalar::<_, String>(
        r#"
        SELECT backend_id
        FROM storage_region_backends
        WHERE region_id = $1 AND backend_id <> $2 AND status <> 'disabled'
        ORDER BY backend_id
        "#,
    )
    .bind(&bucket.resolved_region)
    .bind(&active.id)
    .fetch_all(&state.pg)
    .await?
    .into_iter()
    .filter(|backend| {
        state
            .cfg
            .regions
            .configured_backend(&bucket.resolved_region, backend)
            .is_some()
    })
    .collect::<Vec<_>>();
    let mut unique_keys = BTreeSet::new();
    for key in object_keys {
        let key = key.split_once('?').map(|(path, _)| path).unwrap_or(key);
        if key.is_empty() || key.len() > 32 * 1024 {
            return Err(anyhow!("replication object key is invalid"));
        }
        unique_keys.insert(key.to_string());
    }

    let mut tx = state.pg.begin().await?;
    let mut prepared = Vec::with_capacity(unique_keys.len());
    for object_key in unique_keys {
        let row = sqlx::query(
            r#"
            INSERT INTO storage_replication_events
              (region_id, source_backend_id, backend_generation, bucket_id,
               object_key, operation, state, created_at)
            VALUES ($1, $2, $3, $4::uuid, $5, $6, 'prepared', now())
            RETURNING sequence, event_id
            "#,
        )
        .bind(&bucket.resolved_region)
        .bind(&active.id)
        .bind(active.generation)
        .bind(&bucket.id)
        .bind(&object_key)
        .bind(operation.as_str())
        .fetch_one(&mut *tx)
        .await?;
        let sequence: i64 = row.try_get("sequence")?;
        let event_id: uuid::Uuid = row.try_get("event_id")?;
        for target in &targets {
            sqlx::query(
                r#"
                INSERT INTO storage_replication_deliveries
                  (sequence, region_id, target_backend_id, status, attempts,
                   next_attempt_at, updated_at)
                VALUES ($1, $2, $3, 'pending', 0, now(), now())
                "#,
            )
            .bind(sequence)
            .bind(&bucket.resolved_region)
            .bind(target)
            .execute(&mut *tx)
            .await?;
        }
        prepared.push(PreparedEvent {
            sequence,
            event_id,
            object_key,
        });
    }
    tx.commit().await?;
    Ok(prepared)
}

pub(crate) async fn commit(state: &AppState, events: &[PreparedEvent]) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let mut tx = state.pg.begin().await?;
    for event in events {
        let updated = sqlx::query(
            r#"
            UPDATE storage_replication_events
            SET state = 'committed', committed_at = now(), finalized_at = now(),
                failure_reason = NULL
            WHERE sequence = $1 AND state = 'prepared'
            "#,
        )
        .bind(event.sequence)
        .execute(&mut *tx)
        .await?;
        if updated.rows_affected() != 1 {
            return Err(anyhow!("replication event was not in prepared state"));
        }
        advance_source_checkpoint(&mut tx, event.sequence).await?;
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn cancel(state: &AppState, events: &[PreparedEvent], reason: &str) -> Result<()> {
    if events.is_empty() {
        return Ok(());
    }
    let reason = reason.chars().take(2_000).collect::<String>();
    let mut tx = state.pg.begin().await?;
    let mut targets = BTreeSet::new();
    for event in events {
        sqlx::query(
            r#"
            UPDATE storage_replication_events
            SET state = 'cancelled', failure_reason = $2, finalized_at = now()
            WHERE sequence = $1 AND state = 'prepared'
            "#,
        )
        .bind(event.sequence)
        .bind(&reason)
        .execute(&mut *tx)
        .await?;
        let rows = sqlx::query(
            r#"
            UPDATE storage_replication_deliveries
            SET status = 'complete', completed_at = now(), locked_at = NULL,
                last_error = NULL, updated_at = now()
            WHERE sequence = $1
            RETURNING region_id, target_backend_id
            "#,
        )
        .bind(event.sequence)
        .fetch_all(&mut *tx)
        .await?;
        for row in rows {
            targets.insert((
                row.try_get::<String, _>("region_id")?,
                row.try_get::<String, _>("target_backend_id")?,
            ));
        }
        advance_source_checkpoint(&mut tx, event.sequence).await?;
    }
    for (region, target) in targets {
        advance_checkpoint(&mut tx, &region, &target).await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Resolve only the unavoidable crash ambiguity between an authoritative
/// provider response and event finalization. The caller must name both the
/// sequence and UUID and provide an auditable actor/reason; this function
/// never infers success from mutable provider state.
pub(crate) async fn reconcile(
    state: &AppState,
    sequence: i64,
    event_id: &str,
    resolution: ReconcileResolution,
    actor: &str,
    reason: &str,
) -> Result<ReconcileResult> {
    if sequence <= 0
        || uuid::Uuid::parse_str(event_id).is_err()
        || actor.trim().is_empty()
        || reason.trim().is_empty()
        || actor.len() > 200
        || reason.len() > 2_000
    {
        return Err(anyhow!("replication reconciliation input is invalid"));
    }
    let event_uuid = uuid::Uuid::parse_str(event_id)?;
    let region = sqlx::query_scalar::<_, String>(
        "SELECT region_id FROM storage_replication_events WHERE sequence = $1 AND event_id = $2::uuid",
    )
    .bind(sequence)
    .bind(event_id)
    .fetch_optional(&state.pg)
    .await?
    .ok_or_else(|| anyhow!("replication event does not exist"))?;
    state.cfg.regions.ensure_served(&region)?;
    let mut tx = state.writer_pg.begin().await?;
    crate::writer::lock_region_exclusive(&mut tx, &region).await?;
    let current = sqlx::query_scalar::<_, String>(
        r#"
        SELECT state FROM storage_replication_events
        WHERE sequence = $1 AND event_id = $2::uuid AND region_id = $3
        FOR UPDATE
        "#,
    )
    .bind(sequence)
    .bind(event_id)
    .bind(&region)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("replication event changed during reconciliation"))?;
    if current != "prepared" {
        return Err(anyhow!(
            "only prepared replication events can be reconciled"
        ));
    }
    let audit = format!(
        "manual reconciliation by {}: {}",
        actor.trim(),
        reason.trim()
    );
    let resolution_name = match resolution {
        ReconcileResolution::Committed => {
            crate::accounting::reconcile_mutation_for_replication(
                &mut tx, event_uuid, true, &audit,
            )
            .await?;
            sqlx::query(
                r#"
                UPDATE storage_replication_events
                SET state = 'committed', committed_at = now(), finalized_at = now(),
                    failure_reason = $3
                WHERE sequence = $1 AND event_id = $2::uuid AND state = 'prepared'
                "#,
            )
            .bind(sequence)
            .bind(event_id)
            .bind(&audit)
            .execute(&mut *tx)
            .await?;
            "committed"
        }
        ReconcileResolution::Cancelled => {
            crate::accounting::reconcile_mutation_for_replication(
                &mut tx, event_uuid, false, &audit,
            )
            .await?;
            sqlx::query(
                r#"
                UPDATE storage_replication_events
                SET state = 'cancelled', finalized_at = now(), failure_reason = $3
                WHERE sequence = $1 AND event_id = $2::uuid AND state = 'prepared'
                "#,
            )
            .bind(sequence)
            .bind(event_id)
            .bind(&audit)
            .execute(&mut *tx)
            .await?;
            let rows = sqlx::query(
                r#"
                UPDATE storage_replication_deliveries
                SET status = 'complete', completed_at = now(), locked_at = NULL,
                    last_error = NULL, updated_at = now()
                WHERE sequence = $1
                RETURNING region_id, target_backend_id
                "#,
            )
            .bind(sequence)
            .fetch_all(&mut *tx)
            .await?;
            let mut targets = BTreeSet::new();
            for row in rows {
                targets.insert((
                    row.try_get::<String, _>("region_id")?,
                    row.try_get::<String, _>("target_backend_id")?,
                ));
            }
            for (target_region, target) in targets {
                advance_checkpoint(&mut tx, &target_region, &target).await?;
            }
            "cancelled"
        }
    };
    advance_source_checkpoint(&mut tx, sequence).await?;
    tx.commit().await?;
    info!(
        sequence,
        event_id,
        region,
        actor = actor.trim(),
        resolution = resolution_name,
        "prepared replication event manually reconciled"
    );
    Ok(ReconcileResult {
        sequence,
        region,
        resolution: resolution_name,
    })
}

/// Begin (or explicitly retry) a crash-resumable historical bootstrap for a
/// newly registered provider backend. The region-exclusive writer fence makes
/// the captured event barrier an exact cut: all mutations before it are
/// represented by the base inventory and every later mutation is replayed by
/// the ordinary ordered replication queue.
pub(crate) async fn start_bootstrap(
    state: &AppState,
    region: &str,
    backend_id: &str,
    actor: &str,
    reason: &str,
    retry: bool,
) -> Result<BootstrapResult> {
    if actor.trim().is_empty()
        || reason.trim().is_empty()
        || actor.len() > 200
        || reason.len() > 2_000
    {
        return Err(anyhow!("bootstrap audit identity is invalid"));
    }
    state.cfg.regions.ensure_served(region)?;
    state
        .cfg
        .regions
        .backend(region, backend_id)
        .context("bootstrap target backend is not configured")?;

    let mut tx = state.writer_pg.begin().await?;
    crate::writer::lock_region_exclusive(&mut tx, region).await?;
    let owns_writer = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM dataplane_writer_lease
          WHERE name = $1 AND holder_id = $2 AND lease_expires_at > now()
        )
        "#,
    )
    .bind(format!("s3:{region}"))
    .bind(&state.cfg.writer_instance_id)
    .fetch_one(&mut *tx)
    .await?;
    if !owns_writer {
        return Err(anyhow!("bootstrap requires the active regional writer"));
    }
    let region_state = sqlx::query(
        r#"
        SELECT active_backend_id, backend_generation
        FROM storage_region_state WHERE region_id = $1 FOR UPDATE
        "#,
    )
    .bind(region)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("storage region state does not exist"))?;
    let source_backend: String = region_state.try_get("active_backend_id")?;
    let source_generation: i64 = region_state.try_get("backend_generation")?;
    if source_backend == backend_id {
        return Err(anyhow!("active backend cannot be bootstrapped from itself"));
    }
    state
        .cfg
        .regions
        .backend(region, &source_backend)
        .context("bootstrap source backend is not configured")?;

    let target = sqlx::query(
        r#"
        SELECT status, bootstrap_state, bootstrap_barrier_sequence,
               bootstrap_cursor, bootstrap_source_backend_id,
               bootstrap_source_generation
        FROM storage_region_backends
        WHERE region_id = $1 AND backend_id = $2
        FOR UPDATE
        "#,
    )
    .bind(region)
    .bind(backend_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("bootstrap target is not registered"))?;
    let status: String = target.try_get("status")?;
    let current_state: String = target.try_get("bootstrap_state")?;
    if status != "standby" {
        return Err(anyhow!("only a standby backend can be bootstrapped"));
    }

    if current_state == "running" || current_state == "verifying" {
        let barrier = target
            .try_get::<Option<i64>, _>("bootstrap_barrier_sequence")?
            .ok_or_else(|| anyhow!("running bootstrap has no barrier"))?;
        tx.commit().await?;
        return Ok(BootstrapResult {
            region: region.to_string(),
            backend_id: backend_id.to_string(),
            state: current_state,
            barrier_sequence: barrier,
        });
    }
    if current_state == "complete" {
        return Err(anyhow!("backend bootstrap is already complete"));
    }
    if retry != (current_state == "failed") {
        return Err(anyhow!(if retry {
            "bootstrap retry requires failed state"
        } else {
            "bootstrap start requires pending state"
        }));
    }

    let (barrier, cursor, objects, bytes) = if retry {
        let captured_source: Option<String> = target.try_get("bootstrap_source_backend_id")?;
        let captured_generation: Option<i64> = target.try_get("bootstrap_source_generation")?;
        if captured_source.as_deref() != Some(source_backend.as_str())
            || captured_generation != Some(source_generation)
        {
            return Err(anyhow!(
                "bootstrap source changed; partial target requires operator cleanup and a fresh registration"
            ));
        }
        (
            target
                .try_get::<Option<i64>, _>("bootstrap_barrier_sequence")?
                .ok_or_else(|| anyhow!("failed bootstrap has no barrier"))?,
            target.try_get::<Option<String>, _>("bootstrap_cursor")?,
            sqlx::query_scalar::<_, i64>(
                "SELECT bootstrap_objects_copied FROM storage_region_backends WHERE region_id = $1 AND backend_id = $2",
            )
            .bind(region)
            .bind(backend_id)
            .fetch_one(&mut *tx)
            .await?,
            sqlx::query_scalar::<_, i64>(
                "SELECT bootstrap_bytes_copied FROM storage_region_backends WHERE region_id = $1 AND backend_id = $2",
            )
            .bind(region)
            .bind(backend_id)
            .fetch_one(&mut *tx)
            .await?,
        )
    } else {
        prove_target_empty(state, region, backend_id).await?;
        let prepared = sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*)::bigint FROM storage_replication_events WHERE region_id = $1 AND state = 'prepared'",
        )
        .bind(region)
        .fetch_one(&mut *tx)
        .await?;
        if prepared != 0 {
            return Err(anyhow!(
                "unresolved prepared replication events block a safe bootstrap barrier"
            ));
        }
        let barrier = sqlx::query_scalar::<_, i64>(
            "SELECT COALESCE(MAX(sequence), 0)::bigint FROM storage_replication_events WHERE region_id = $1",
        )
        .bind(region)
        .fetch_one(&mut *tx)
        .await?;
        (barrier, None, 0, 0)
    };

    let audit = format!("bootstrap requested by {}: {}", actor.trim(), reason.trim());
    let updated = sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET bootstrap_state = 'running', bootstrap_barrier_sequence = $3,
            bootstrap_cursor = $4, bootstrap_objects_copied = $5,
            bootstrap_bytes_copied = $6,
            bootstrap_source_backend_id = $7,
            bootstrap_source_generation = $8,
            bootstrap_started_at = COALESCE(bootstrap_started_at, now()),
            bootstrap_heartbeat_at = NULL, bootstrap_completed_at = NULL,
            bootstrap_verified_at = NULL, bootstrap_last_error = NULL,
            promotion_authorized = false, updated_at = now()
        WHERE region_id = $1 AND backend_id = $2
        "#,
    )
    .bind(region)
    .bind(backend_id)
    .bind(barrier)
    .bind(cursor)
    .bind(objects)
    .bind(bytes)
    .bind(&source_backend)
    .bind(source_generation)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("bootstrap state update was lost"));
    }
    sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET bootstrap_last_error = NULL
        WHERE region_id = $1 AND backend_id = $2
        "#,
    )
    .bind(region)
    .bind(backend_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    info!(
        region,
        backend_id, barrier, audit, "provider bootstrap started"
    );
    Ok(BootstrapResult {
        region: region.to_string(),
        backend_id: backend_id.to_string(),
        state: "running".to_string(),
        barrier_sequence: barrier,
    })
}

pub(crate) fn start_workers(state: AppState) {
    let workers = std::env::var("DATAPLANE_REPLICATION_WORKERS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| (1..=32).contains(value))
        .unwrap_or(4);
    for worker in 0..workers {
        let state = state.clone();
        tokio::spawn(async move {
            loop {
                if state
                    .shutting_down
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    break;
                }
                match claim_delivery(&state).await {
                    Ok(Some(delivery)) => {
                        if let Err(error) = deliver(&state, &delivery).await {
                            warn!(
                                error = %error,
                                sequence = delivery.sequence,
                                region = delivery.region,
                                source_backend = delivery.source_backend,
                                target_backend = delivery.target_backend,
                                "provider replication delivery failed"
                            );
                            if let Err(mark_error) = mark_failed(&state, &delivery, &error).await {
                                warn!(error = %mark_error, "failed to persist replication retry");
                            }
                        } else if let Err(error) = mark_complete(&state, &delivery).await {
                            warn!(error = %error, "failed to commit replication checkpoint");
                        }
                    }
                    Ok(None) => tokio::time::sleep(Duration::from_millis(500)).await,
                    Err(error) => {
                        warn!(error = %error, worker, "replication worker query failed");
                        tokio::time::sleep(Duration::from_secs(2)).await;
                    }
                }
            }
        });
    }
    let bootstrap_state = state.clone();
    tokio::spawn(async move {
        loop {
            if bootstrap_state
                .shutting_down
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                break;
            }
            match claim_bootstrap(&bootstrap_state).await {
                Ok(Some(job)) => {
                    if let Err(error) = run_bootstrap_step(&bootstrap_state, &job).await {
                        warn!(
                            error = %error,
                            region = job.region,
                            backend_id = job.backend_id,
                            "provider bootstrap step failed"
                        );
                        if let Err(mark_error) =
                            mark_bootstrap_failed(&bootstrap_state, &job, &error).await
                        {
                            warn!(error = %mark_error, "failed to persist bootstrap failure");
                        }
                    }
                }
                Ok(None) => tokio::time::sleep(Duration::from_secs(1)).await,
                Err(error) => {
                    warn!(error = %error, "provider bootstrap worker query failed");
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
            }
        }
    });
    info!(workers, "provider replication workers started");
}

/// Refresh promotion evidence after a signed provider probe. A completed
/// inventory baseline plus a contiguous, empty ordered delivery queue proves
/// the backend still represents the authoritative event log without rescanning
/// a multi-terabyte bucket on every health interval.
pub(crate) async fn record_backend_probe(
    state: &AppState,
    region: &str,
    backend_id: &str,
    healthy: bool,
) -> Result<()> {
    if !healthy {
        return Ok(());
    }
    sqlx::query(
        r#"
        UPDATE storage_region_backends b
        SET last_verified_at = now(),
            replication_caught_up_at = CASE
              WHEN b.replication_checkpoint >= s.required_replication_checkpoint
                AND NOT EXISTS (
                  SELECT 1 FROM storage_replication_deliveries d
                  WHERE d.region_id = b.region_id
                    AND d.target_backend_id = b.backend_id
                    AND d.status <> 'complete'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM storage_replication_events e
                  WHERE e.region_id = b.region_id AND e.state = 'prepared'
                )
              THEN now() ELSE b.replication_caught_up_at END,
            bootstrap_verified_at = CASE
              WHEN b.bootstrap_state = 'complete'
                AND b.replication_checkpoint >= s.required_replication_checkpoint
                AND NOT EXISTS (
                  SELECT 1 FROM storage_replication_deliveries d
                  WHERE d.region_id = b.region_id
                    AND d.target_backend_id = b.backend_id
                    AND d.status <> 'complete'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM storage_replication_events e
                  WHERE e.region_id = b.region_id AND e.state = 'prepared'
                )
              THEN now() ELSE b.bootstrap_verified_at END,
            updated_at = now()
        FROM storage_region_state s
        WHERE b.region_id = $1 AND b.backend_id = $2
          AND s.region_id = b.region_id
        "#,
    )
    .bind(region)
    .bind(backend_id)
    .execute(&state.pg)
    .await?;
    Ok(())
}

async fn claim_bootstrap(state: &AppState) -> Result<Option<BootstrapJob>> {
    let served = state
        .cfg
        .regions
        .served_regions()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut tx = state.pg.begin().await?;
    let row = sqlx::query(
        r#"
        SELECT region_id, backend_id, bootstrap_state,
               bootstrap_barrier_sequence, bootstrap_cursor,
               bootstrap_source_backend_id, bootstrap_source_generation
        FROM storage_region_backends
        WHERE region_id = ANY($1)
          AND bootstrap_state IN ('running', 'verifying')
          AND (bootstrap_heartbeat_at IS NULL
               OR bootstrap_heartbeat_at < now() - make_interval(secs => $2))
        ORDER BY bootstrap_started_at, region_id, backend_id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        "#,
    )
    .bind(&served)
    .bind(BOOTSTRAP_CLAIM_SECONDS)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let region: String = row.try_get("region_id")?;
    let backend_id: String = row.try_get("backend_id")?;
    if state
        .cfg
        .regions
        .configured_backend(&region, &backend_id)
        .is_none()
    {
        tx.commit().await?;
        return Ok(None);
    }
    let updated = sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET bootstrap_heartbeat_at = now(), updated_at = now()
        WHERE region_id = $1 AND backend_id = $2
          AND bootstrap_state IN ('running', 'verifying')
        "#,
    )
    .bind(&region)
    .bind(&backend_id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("bootstrap claim was lost"));
    }
    let job = BootstrapJob {
        region,
        backend_id,
        state: row.try_get("bootstrap_state")?,
        barrier_sequence: row
            .try_get::<Option<i64>, _>("bootstrap_barrier_sequence")?
            .ok_or_else(|| anyhow!("bootstrap barrier is missing"))?,
        cursor: row.try_get("bootstrap_cursor")?,
        source_backend_id: row
            .try_get::<Option<String>, _>("bootstrap_source_backend_id")?
            .ok_or_else(|| anyhow!("bootstrap source is missing"))?,
        source_generation: row
            .try_get::<Option<i64>, _>("bootstrap_source_generation")?
            .ok_or_else(|| anyhow!("bootstrap source generation is missing"))?,
    };
    tx.commit().await?;
    Ok(Some(job))
}

async fn run_bootstrap_step(state: &AppState, job: &BootstrapJob) -> Result<()> {
    if job.state == "verifying" {
        if !verify_bootstrap(state, job).await? {
            release_bootstrap_claim(state, job).await?;
        }
        return Ok(());
    }
    if job.state != "running" {
        return Err(anyhow!("unknown bootstrap worker state"));
    }
    ensure_bootstrap_source_current(state, job).await?;
    let page = list_object_page(
        state,
        &job.region,
        &job.source_backend_id,
        job.cursor.as_deref(),
    )
    .await?;
    let objects = page
        .objects
        .into_iter()
        .filter(|object| !is_excluded(state, &object.key))
        .collect::<Vec<_>>();
    let outcomes = stream::iter(objects)
        .map(|object| {
            let region = job.region.clone();
            let source_backend = job.source_backend_id.clone();
            let target_backend = job.backend_id.clone();
            async move {
                copy_object_between(
                    state,
                    &region,
                    &source_backend,
                    &target_backend,
                    &object.key,
                )
                .await
            }
        })
        .buffer_unordered(state.cfg.bootstrap_copy_concurrency)
        .collect::<Vec<_>>()
        .await;
    let mut copied = 0_i64;
    let mut bytes = 0_i64;
    for outcome in outcomes {
        match outcome? {
            CopyOutcome::Copied(size) => {
                copied = copied.saturating_add(1);
                bytes = bytes.saturating_add(i64::try_from(size).unwrap_or(i64::MAX));
            }
            CopyOutcome::Missing => {}
        }
    }

    let mut tx = state.pg.begin().await?;
    let updated = sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET bootstrap_cursor = $3,
            bootstrap_objects_copied = bootstrap_objects_copied + $4,
            bootstrap_bytes_copied = bootstrap_bytes_copied + $5,
            bootstrap_heartbeat_at = NULL, updated_at = now()
        WHERE region_id = $1 AND backend_id = $2
          AND bootstrap_state = 'running'
          AND bootstrap_barrier_sequence = $6
          AND bootstrap_source_backend_id = $7
          AND bootstrap_source_generation = $8
          AND bootstrap_cursor IS NOT DISTINCT FROM $9
        "#,
    )
    .bind(&job.region)
    .bind(&job.backend_id)
    .bind(&page.next_cursor)
    .bind(copied)
    .bind(bytes)
    .bind(job.barrier_sequence)
    .bind(&job.source_backend_id)
    .bind(job.source_generation)
    .bind(&job.cursor)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("bootstrap cursor advance was lost"));
    }
    if page.next_cursor.is_none() {
        // The historical inventory now represents all state at the barrier.
        // Existing deliveries through that cut are satisfied by the base copy;
        // post-barrier deliveries remain ordered and will replay next.
        sqlx::query(
            r#"
            UPDATE storage_replication_deliveries
            SET status = 'complete', completed_at = COALESCE(completed_at, now()),
                locked_at = NULL, last_error = NULL, updated_at = now()
            WHERE region_id = $1 AND target_backend_id = $2
              AND sequence <= $3 AND status <> 'complete'
            "#,
        )
        .bind(&job.region)
        .bind(&job.backend_id)
        .bind(job.barrier_sequence)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            r#"
            UPDATE storage_region_backends
            SET bootstrap_state = 'verifying', bootstrap_cursor = NULL,
                bootstrap_completed_at = now(),
                replication_checkpoint = GREATEST(replication_checkpoint, $3),
                bootstrap_heartbeat_at = NULL, updated_at = now()
            WHERE region_id = $1 AND backend_id = $2
              AND bootstrap_state = 'running'
            "#,
        )
        .bind(&job.region)
        .bind(&job.backend_id)
        .bind(job.barrier_sequence)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn ensure_bootstrap_source_current(state: &AppState, job: &BootstrapJob) -> Result<()> {
    let row = sqlx::query(
        "SELECT active_backend_id, backend_generation FROM storage_region_state WHERE region_id = $1",
    )
    .bind(&job.region)
    .fetch_optional(&state.pg)
    .await?
    .ok_or_else(|| anyhow!("bootstrap region state disappeared"))?;
    if row.try_get::<String, _>("active_backend_id")? != job.source_backend_id
        || row.try_get::<i64, _>("backend_generation")? != job.source_generation
    {
        return Err(anyhow!("bootstrap authoritative source changed"));
    }
    Ok(())
}

async fn release_bootstrap_claim(state: &AppState, job: &BootstrapJob) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE storage_region_backends SET bootstrap_heartbeat_at = NULL, updated_at = now()
        WHERE region_id = $1 AND backend_id = $2
          AND bootstrap_state = 'verifying'
        "#,
    )
    .bind(&job.region)
    .bind(&job.backend_id)
    .execute(&state.pg)
    .await?;
    tokio::time::sleep(Duration::from_secs(1)).await;
    Ok(())
}

async fn verify_bootstrap(state: &AppState, job: &BootstrapJob) -> Result<bool> {
    let ready = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT b.replication_checkpoint >= s.required_replication_checkpoint
          AND b.replication_checkpoint >= $3
          AND NOT EXISTS (
            SELECT 1 FROM storage_replication_deliveries d
            WHERE d.region_id = b.region_id
              AND d.target_backend_id = b.backend_id
              AND d.status <> 'complete'
          )
          AND NOT EXISTS (
            SELECT 1 FROM storage_replication_events e
            WHERE e.region_id = b.region_id AND e.state = 'prepared'
          )
        FROM storage_region_backends b
        JOIN storage_region_state s ON s.region_id = b.region_id
        WHERE b.region_id = $1 AND b.backend_id = $2
          AND b.bootstrap_state = 'verifying'
        "#,
    )
    .bind(&job.region)
    .bind(&job.backend_id)
    .bind(job.barrier_sequence)
    .fetch_optional(&state.pg)
    .await?
    .unwrap_or(false);
    if !ready {
        return Ok(false);
    }

    let mut tx = state.writer_pg.begin().await?;
    crate::writer::lock_region_exclusive(&mut tx, &job.region).await?;
    ensure_bootstrap_source_current_in_tx(&mut tx, job).await?;
    let still_ready = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT b.bootstrap_state = 'verifying'
          AND b.replication_checkpoint >= s.required_replication_checkpoint
          AND b.replication_checkpoint >= $3
          AND NOT EXISTS (
            SELECT 1 FROM storage_replication_deliveries d
            WHERE d.region_id = b.region_id
              AND d.target_backend_id = b.backend_id
              AND d.status <> 'complete'
          )
          AND NOT EXISTS (
            SELECT 1 FROM storage_replication_events e
            WHERE e.region_id = b.region_id AND e.state = 'prepared'
          )
        FROM storage_region_backends b
        JOIN storage_region_state s ON s.region_id = b.region_id
        WHERE b.region_id = $1 AND b.backend_id = $2
        FOR UPDATE OF b, s
        "#,
    )
    .bind(&job.region)
    .bind(&job.backend_id)
    .bind(job.barrier_sequence)
    .fetch_optional(&mut *tx)
    .await?
    .unwrap_or(false);
    if !still_ready {
        tx.rollback().await?;
        return Ok(false);
    }

    let source_digest = inventory_digest(state, &job.region, &job.source_backend_id).await?;
    let target_digest = inventory_digest(state, &job.region, &job.backend_id).await?;
    if source_digest != target_digest {
        return Err(anyhow!("bootstrap inventory verification mismatch"));
    }
    let updated = sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET bootstrap_state = 'complete', bootstrap_verified_at = now(),
            bootstrap_heartbeat_at = NULL, bootstrap_last_error = NULL,
            last_verified_at = now(), replication_caught_up_at = now(),
            updated_at = now()
        WHERE region_id = $1 AND backend_id = $2
          AND bootstrap_state = 'verifying'
          AND bootstrap_barrier_sequence = $3
        "#,
    )
    .bind(&job.region)
    .bind(&job.backend_id)
    .bind(job.barrier_sequence)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("bootstrap completion was lost"));
    }
    tx.commit().await?;
    info!(
        region = job.region,
        backend_id = job.backend_id,
        barrier = job.barrier_sequence,
        "provider bootstrap completed and inventory verified"
    );
    Ok(true)
}

async fn ensure_bootstrap_source_current_in_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    job: &BootstrapJob,
) -> Result<()> {
    let row = sqlx::query(
        "SELECT active_backend_id, backend_generation FROM storage_region_state WHERE region_id = $1 FOR UPDATE",
    )
    .bind(&job.region)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| anyhow!("bootstrap region state disappeared"))?;
    if row.try_get::<String, _>("active_backend_id")? != job.source_backend_id
        || row.try_get::<i64, _>("backend_generation")? != job.source_generation
    {
        return Err(anyhow!("bootstrap authoritative source changed"));
    }
    Ok(())
}

async fn mark_bootstrap_failed(
    state: &AppState,
    job: &BootstrapJob,
    error: &anyhow::Error,
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET bootstrap_state = 'failed', bootstrap_heartbeat_at = NULL,
            bootstrap_last_error = $3, promotion_authorized = false,
            updated_at = now()
        WHERE region_id = $1 AND backend_id = $2
          AND bootstrap_state IN ('running', 'verifying')
        "#,
    )
    .bind(&job.region)
    .bind(&job.backend_id)
    .bind(error.to_string().chars().take(2_000).collect::<String>())
    .execute(&state.pg)
    .await?;
    Ok(())
}

async fn prove_target_empty(state: &AppState, region: &str, backend_id: &str) -> Result<()> {
    let mut cursor = None;
    let mut seen = BTreeSet::new();
    loop {
        let page = list_object_page(state, region, backend_id, cursor.as_deref()).await?;
        if page
            .objects
            .iter()
            .any(|object| !is_excluded(state, &object.key))
        {
            return Err(anyhow!(
                "bootstrap target contains managed objects and is not empty"
            ));
        }
        let Some(next) = page.next_cursor else {
            return Ok(());
        };
        if !seen.insert(next.clone()) {
            return Err(anyhow!("bootstrap target listing cursor repeated"));
        }
        cursor = Some(next);
    }
}

async fn inventory_digest(
    state: &AppState,
    region: &str,
    backend_id: &str,
) -> Result<(u64, u64, [u8; 32])> {
    let mut cursor = None;
    let mut seen = BTreeSet::new();
    let mut count = 0_u64;
    let mut bytes = 0_u64;
    let mut hasher = Sha256::new();
    loop {
        let page = list_object_page(state, region, backend_id, cursor.as_deref()).await?;
        for object in page
            .objects
            .into_iter()
            .filter(|object| !is_excluded(state, &object.key))
        {
            count = count.saturating_add(1);
            bytes = bytes.saturating_add(object.size);
            hasher.update(object.key.as_bytes());
            hasher.update(b"\0");
            hasher.update(object.size.to_string().as_bytes());
            hasher.update(b"\n");
        }
        let Some(next) = page.next_cursor else {
            return Ok((count, bytes, hasher.finalize().into()));
        };
        if !seen.insert(next.clone()) {
            return Err(anyhow!("inventory listing cursor repeated"));
        }
        cursor = Some(next);
    }
}

async fn list_object_page(
    state: &AppState,
    region: &str,
    backend_id: &str,
    cursor: Option<&str>,
) -> Result<ObjectPage> {
    let query = {
        let mut serializer = url::form_urlencoded::Serializer::new(String::new());
        serializer.append_pair("list-type", "2");
        serializer.append_pair("max-keys", &BOOTSTRAP_PAGE_SIZE.to_string());
        if let Some(cursor) = cursor {
            serializer.append_pair("continuation-token", cursor);
        }
        serializer.finish()
    };
    let response = signed_backend_request(
        state,
        region,
        backend_id,
        Method::GET,
        &format!("?{query}"),
        &HeaderMap::new(),
        None,
    )?
    .send()
    .await?;
    if !response.status().is_success() {
        return Err(anyhow!(
            "bootstrap list returned status {}",
            response.status()
        ));
    }
    let xml = response.text().await?;
    let mut objects = Vec::new();
    for block in xml_blocks(&xml, "Contents") {
        let key = xml_value(block, "Key")
            .map(xml_unescape)
            .ok_or_else(|| anyhow!("bootstrap list object omitted Key"))?;
        let size = xml_value(block, "Size")
            .ok_or_else(|| anyhow!("bootstrap list object omitted Size"))?
            .parse::<u64>()?;
        objects.push(ListedObject { key, size });
    }
    let truncated = xml_value(&xml, "IsTruncated")
        .is_some_and(|value| value.trim().eq_ignore_ascii_case("true"));
    let next_cursor = xml_value(&xml, "NextContinuationToken").map(xml_unescape);
    if truncated && next_cursor.is_none() {
        return Err(anyhow!(
            "truncated bootstrap list omitted continuation token"
        ));
    }
    Ok(ObjectPage {
        objects,
        next_cursor: truncated.then_some(next_cursor).flatten(),
    })
}

fn is_excluded(state: &AppState, key: &str) -> bool {
    state
        .cfg
        .replication_excluded_prefixes
        .iter()
        .any(|prefix| key.starts_with(prefix))
}

async fn claim_delivery(state: &AppState) -> Result<Option<Delivery>> {
    let served = state
        .cfg
        .regions
        .served_regions()
        .map(str::to_string)
        .collect::<Vec<_>>();
    let mut tx = state.pg.begin().await?;
    sqlx::query(
        r#"
        UPDATE storage_replication_deliveries
        SET status = 'failed', locked_at = NULL,
            last_error = 'worker lease expired', next_attempt_at = now(), updated_at = now()
        WHERE status = 'running'
          AND locked_at < now() - make_interval(secs => $1)
          AND region_id = ANY($2)
        "#,
    )
    .bind(STALE_DELIVERY_SECONDS)
    .bind(&served)
    .execute(&mut *tx)
    .await?;
    let row = sqlx::query(
        r#"
        SELECT d.sequence, d.region_id, e.source_backend_id,
               d.target_backend_id, e.object_key, e.operation, d.attempts
        FROM storage_replication_deliveries d
        JOIN storage_replication_events e ON e.sequence = d.sequence
        JOIN storage_region_backends b
          ON b.region_id = d.region_id
         AND b.backend_id = d.target_backend_id
        WHERE e.state = 'committed'
          AND b.bootstrap_state IN ('verifying', 'complete')
          AND d.status IN ('pending', 'failed')
          AND d.next_attempt_at <= now()
          AND d.region_id = ANY($1)
          AND NOT EXISTS (
            SELECT 1
            FROM storage_replication_deliveries prior
            WHERE prior.region_id = d.region_id
              AND prior.target_backend_id = d.target_backend_id
              AND prior.sequence < d.sequence
              AND prior.status <> 'complete'
          )
        ORDER BY d.sequence
        FOR UPDATE OF d SKIP LOCKED
        LIMIT 1
        "#,
    )
    .bind(&served)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(None);
    };
    let sequence: i64 = row.try_get("sequence")?;
    let attempts: i64 = row.try_get("attempts")?;
    let updated = sqlx::query(
        r#"
        UPDATE storage_replication_deliveries
        SET status = 'running', attempts = attempts + 1, locked_at = now(),
            updated_at = now()
        WHERE sequence = $1 AND target_backend_id = $2
          AND status IN ('pending', 'failed')
        "#,
    )
    .bind(sequence)
    .bind(row.try_get::<String, _>("target_backend_id")?)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("replication delivery claim was lost"));
    }
    let delivery = Delivery {
        sequence,
        region: row.try_get("region_id")?,
        source_backend: row.try_get("source_backend_id")?,
        target_backend: row.try_get("target_backend_id")?,
        object_key: row.try_get("object_key")?,
        operation: row.try_get("operation")?,
        attempts: attempts.saturating_add(1),
    };
    tx.commit().await?;
    Ok(Some(delivery))
}

async fn deliver(state: &AppState, delivery: &Delivery) -> Result<()> {
    let later = sqlx::query(
        r#"
        SELECT later.sequence, later.state
        FROM storage_replication_events current
        JOIN storage_replication_events later
          ON later.region_id = current.region_id
         AND later.bucket_id = current.bucket_id
         AND later.object_key = current.object_key
         AND later.sequence > current.sequence
        WHERE current.sequence = $1
        ORDER BY later.sequence
        "#,
    )
    .bind(delivery.sequence)
    .fetch_all(&state.pg)
    .await?;
    if later.iter().any(|row| {
        later_committed_supersedes(
            delivery.sequence,
            row.try_get("sequence").unwrap_or(0),
            row.try_get::<String, _>("state").as_deref().unwrap_or(""),
        )
    }) {
        info!(
            sequence = delivery.sequence,
            region = delivery.region,
            target_backend = delivery.target_backend,
            "replication delivery superseded by a later committed object state"
        );
        return Ok(());
    }
    if delivery.operation == "delete" {
        let response = signed_backend_request(
            state,
            &delivery.region,
            &delivery.target_backend,
            Method::DELETE,
            &delivery.object_key,
            &HeaderMap::new(),
            None,
        )?
        .send()
        .await?;
        if response.status().is_success() || response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        return Err(anyhow!(
            "target delete returned status {}",
            response.status()
        ));
    }
    if delivery.operation != "put" {
        return Err(anyhow!("unknown replication operation"));
    }
    match copy_object_between(
        state,
        &delivery.region,
        &delivery.source_backend,
        &delivery.target_backend,
        &delivery.object_key,
    )
    .await?
    {
        CopyOutcome::Copied(_) => Ok(()),
        CopyOutcome::Missing => Err(anyhow!("source object disappeared before replication")),
    }
}

async fn copy_object_between(
    state: &AppState,
    region: &str,
    source_backend: &str,
    target_backend: &str,
    object_key: &str,
) -> Result<CopyOutcome> {
    let object_tags = fetch_object_tags(state, region, source_backend, object_key).await;
    let source = signed_backend_request(
        state,
        region,
        source_backend,
        Method::GET,
        object_key,
        &HeaderMap::new(),
        None,
    )?
    .send()
    .await?;
    if source.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(CopyOutcome::Missing);
    }
    if !source.status().is_success() {
        return Err(anyhow!("source object returned status {}", source.status()));
    }
    let content_length = source
        .content_length()
        .ok_or_else(|| anyhow!("replication source omitted Content-Length"))?;
    let mut source_headers = source.headers().clone();
    if let Some(tags) = object_tags {
        source_headers.insert("x-amz-tagging", tags.parse()?);
    }
    let stream = source
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    let target = signed_backend_request(
        state,
        region,
        target_backend,
        Method::PUT,
        object_key,
        &source_headers,
        Some(content_length),
    )?
    .body(reqwest::Body::wrap_stream(stream))
    .send()
    .await?;
    if !target.status().is_success() {
        return Err(anyhow!(
            "target object write returned status {}",
            target.status()
        ));
    }
    Ok(CopyOutcome::Copied(content_length))
}

async fn fetch_object_tags(
    state: &AppState,
    region: &str,
    source_backend: &str,
    object_key: &str,
) -> Option<String> {
    let path = format!("{object_key}?tagging");
    let response = signed_backend_request(
        state,
        region,
        source_backend,
        Method::GET,
        &path,
        &HeaderMap::new(),
        None,
    )
    .ok()?
    .send()
    .await
    .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let xml = response.text().await.ok()?;
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    let mut count = 0usize;
    for block in xml_blocks(&xml, "Tag") {
        let key = xml_value(block, "Key")?;
        let value = xml_value(block, "Value")?;
        serializer.append_pair(&xml_unescape(key), &xml_unescape(value));
        count += 1;
        if count >= 10 {
            break;
        }
    }
    (count > 0).then(|| serializer.finish())
}

fn xml_blocks<'a>(xml: &'a str, tag: &str) -> Vec<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut blocks = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find(&open) {
        let after = &rest[start + open.len()..];
        let Some(end) = after.find(&close) else {
            break;
        };
        blocks.push(&after[..end]);
        rest = &after[end + close.len()..];
    }
    blocks
}

fn xml_value<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    xml_blocks(xml, tag).into_iter().next()
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn later_committed_supersedes(current: i64, later: i64, state: &str) -> bool {
    later > current && state == "committed"
}

async fn mark_complete(state: &AppState, delivery: &Delivery) -> Result<()> {
    let mut tx = state.pg.begin().await?;
    let updated = sqlx::query(
        r#"
        UPDATE storage_replication_deliveries
        SET status = 'complete', completed_at = now(), locked_at = NULL,
            last_error = NULL, updated_at = now()
        WHERE sequence = $1 AND target_backend_id = $2 AND status = 'running'
        "#,
    )
    .bind(delivery.sequence)
    .bind(&delivery.target_backend)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("replication delivery completion was lost"));
    }
    advance_checkpoint(&mut tx, &delivery.region, &delivery.target_backend).await?;
    tx.commit().await?;
    Ok(())
}

async fn mark_failed(state: &AppState, delivery: &Delivery, error: &anyhow::Error) -> Result<()> {
    let exponent = u32::try_from(delivery.attempts.clamp(0, 8)).unwrap_or(8);
    let delay = i32::try_from(2_i64.pow(exponent).min(300)).unwrap_or(300);
    sqlx::query(
        r#"
        UPDATE storage_replication_deliveries
        SET status = 'failed', last_error = $3, locked_at = NULL,
            next_attempt_at = now() + make_interval(secs => $4), updated_at = now()
        WHERE sequence = $1 AND target_backend_id = $2 AND status = 'running'
        "#,
    )
    .bind(delivery.sequence)
    .bind(&delivery.target_backend)
    .bind(error.to_string().chars().take(2_000).collect::<String>())
    .bind(delay)
    .execute(&state.pg)
    .await?;
    Ok(())
}

async fn advance_checkpoint(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    region: &str,
    target: &str,
) -> Result<()> {
    let checkpoint = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE(MAX(candidate.sequence), 0)::bigint
        FROM storage_replication_deliveries candidate
        WHERE candidate.region_id = $1
          AND candidate.target_backend_id = $2
          AND candidate.status = 'complete'
          AND NOT EXISTS (
            SELECT 1 FROM storage_replication_deliveries prior
            WHERE prior.region_id = candidate.region_id
              AND prior.target_backend_id = candidate.target_backend_id
              AND prior.sequence < candidate.sequence
              AND prior.status <> 'complete'
          )
        "#,
    )
    .bind(region)
    .bind(target)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE storage_region_backends b
        SET replication_checkpoint = GREATEST(b.replication_checkpoint, $3),
            last_verified_at = now(),
            replication_caught_up_at = CASE
              WHEN $3 >= s.required_replication_checkpoint THEN now()
              ELSE b.replication_caught_up_at
            END,
            updated_at = now()
        FROM storage_region_state s
        WHERE b.region_id = $1 AND b.backend_id = $2 AND s.region_id = b.region_id
        "#,
    )
    .bind(region)
    .bind(target)
    .bind(checkpoint)
    .execute(&mut **tx)
    .await
    .context("failed to advance provider replication checkpoint")?;
    Ok(())
}

async fn advance_source_checkpoint(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sequence: i64,
) -> Result<()> {
    sqlx::query(
        r#"
        UPDATE storage_region_backends b
        SET replication_checkpoint = GREATEST(b.replication_checkpoint, $1),
            last_verified_at = now(),
            replication_caught_up_at = CASE
              WHEN $1 >= s.required_replication_checkpoint THEN now()
              ELSE b.replication_caught_up_at
            END,
            bootstrap_verified_at = CASE
              WHEN b.bootstrap_state = 'complete'
                AND $1 >= s.required_replication_checkpoint THEN now()
              ELSE b.bootstrap_verified_at
            END,
            updated_at = now()
        FROM storage_replication_events e
        JOIN storage_region_state s ON s.region_id = e.region_id
        WHERE e.sequence = $1
          AND b.region_id = e.region_id
          AND b.backend_id = e.source_backend_id
        "#,
    )
    .bind(sequence)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_later_committed_state_supersedes_delivery() {
        assert!(later_committed_supersedes(10, 11, "committed"));
        assert!(!later_committed_supersedes(10, 11, "prepared"));
        assert!(!later_committed_supersedes(10, 11, "cancelled"));
        assert!(!later_committed_supersedes(10, 10, "committed"));
    }
}

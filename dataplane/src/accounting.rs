use anyhow::{anyhow, Context, Result};
use redis::AsyncCommands;
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::time::timeout;
use uuid::Uuid;

use crate::AppState;

const PENDING: &str = "accounting:pending";
const PROCESSING: &str = "accounting:processing";
const DIRECT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const QUEUE_WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Serialize, Deserialize)]
struct AccountingEvent {
    id: String,
    #[serde(flatten)]
    kind: AccountingKind,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum AccountingKind {
    Stats {
        user_id: String,
        bucket_id: Option<String>,
        ingress: i64,
        egress: i64,
        requests: i64,
        period: String,
    },
    BucketDelta {
        bucket_id: String,
        delta: i64,
    },
}

#[derive(Debug, Serialize)]
pub(crate) struct FlushResult {
    pub(crate) ok: bool,
    pub(crate) flushed: u64,
    pub(crate) pending: u64,
    pub(crate) unsafe_state: bool,
}

pub(crate) async fn record_stats(
    state: &AppState,
    user_id: &str,
    bucket_id: Option<&str>,
    ingress: i64,
    egress: i64,
    requests: i64,
    period: String,
) -> Result<()> {
    let event = AccountingEvent {
        id: Uuid::new_v4().to_string(),
        kind: AccountingKind::Stats {
            user_id: user_id.to_string(),
            bucket_id: bucket_id.map(str::to_string),
            ingress,
            egress,
            requests,
            period,
        },
    };
    apply_or_queue(state, &event).await
}

pub(crate) async fn record_bucket_delta(
    state: &AppState,
    bucket_id: &str,
    delta: i64,
) -> Result<()> {
    let event = AccountingEvent {
        id: Uuid::new_v4().to_string(),
        kind: AccountingKind::BucketDelta {
            bucket_id: bucket_id.to_string(),
            delta,
        },
    };
    apply_or_queue(state, &event).await
}

async fn apply_or_queue(state: &AppState, event: &AccountingEvent) -> Result<()> {
    if matches!(
        timeout(DIRECT_WRITE_TIMEOUT, apply_direct(state, &event.kind)).await,
        Ok(Ok(()))
    ) {
        return Ok(());
    }
    let encoded = serde_json::to_string(event)?;
    let mut conn = state.redis.clone();
    let queued = timeout(
        QUEUE_WRITE_TIMEOUT,
        conn.lpush::<_, _, usize>(PENDING, encoded),
    )
    .await;
    if !matches!(queued, Ok(Ok(_))) {
        state.accounting_unsafe.store(true, Ordering::SeqCst);
        if let Some(path) = state.cfg.accounting_unsafe_marker.as_ref() {
            if let Err(marker_error) = tokio::fs::write(
                path,
                format!(
                    "{} accounting event could not reach Aiven or Valkey\n",
                    event.id
                ),
            )
            .await
            {
                tracing::error!(error = %marker_error, "failed to persist accounting unsafe marker");
            }
        }
        return Err(anyhow!(
            "PostgreSQL accounting failed and the durable Valkey fallback queue was unavailable"
        ));
    }
    Ok(())
}

async fn apply_direct(state: &AppState, kind: &AccountingKind) -> Result<()> {
    let mut tx = state.pg.begin().await?;
    apply_kind(&mut tx, kind).await?;
    tx.commit().await?;
    Ok(())
}

async fn apply_event(state: &AppState, event: &AccountingEvent) -> Result<()> {
    let mut tx = state.pg.begin().await?;
    let inserted = sqlx::query(
        "INSERT INTO dataplane_accounting_events (id, applied_at) VALUES ($1, now()) ON CONFLICT (id) DO NOTHING RETURNING id",
    )
    .bind(&event.id)
    .fetch_optional(&mut *tx)
    .await?;
    if inserted.is_none() {
        tx.commit().await?;
        return Ok(());
    }

    apply_kind(&mut tx, &event.kind).await?;
    tx.commit().await?;
    Ok(())
}

async fn apply_kind(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    kind: &AccountingKind,
) -> Result<()> {
    match kind {
        AccountingKind::Stats {
            user_id,
            bucket_id,
            ingress,
            egress,
            requests,
            period,
        } => {
            sqlx::query(
                r#"
                UPDATE users
                SET ingress_bytes = COALESCE(ingress_bytes, 0) + $1,
                    egress_bytes = CASE
                      WHEN $2 = 0 THEN COALESCE(egress_bytes, 0)
                      WHEN egress_period = $3 THEN COALESCE(egress_bytes, 0) + $2
                      ELSE $2
                    END,
                    egress_period = CASE WHEN $2 = 0 THEN egress_period ELSE $3 END,
                    total_requests = COALESCE(total_requests, 0) + $4
                WHERE id = $5
                "#,
            )
            .bind(ingress)
            .bind(egress)
            .bind(period)
            .bind(requests)
            .bind(user_id)
            .execute(&mut **tx)
            .await?;
            if *requests > 0 {
                if let Some(bucket_id) = bucket_id {
                    sqlx::query(
                        "UPDATE buckets SET total_requests = COALESCE(total_requests, 0) + $1 WHERE id = $2::uuid",
                    )
                    .bind(requests)
                    .bind(bucket_id)
                    .execute(&mut **tx)
                    .await?;
                }
            }
        }
        AccountingKind::BucketDelta { bucket_id, delta } => {
            sqlx::query(
                "UPDATE buckets SET total_bytes = GREATEST(0, total_bytes + $1) WHERE id = $2::uuid",
            )
            .bind(delta)
            .bind(bucket_id)
            .execute(&mut **tx)
            .await?;
        }
    }
    Ok(())
}

pub(crate) async fn flush(state: &AppState) -> Result<FlushResult> {
    let _guard = state.accounting_flush_lock.lock().await;
    let mut conn = state.redis.clone();

    // Return any item left in the processing list after a crash. Event IDs are
    // idempotent in Aiven, so replaying after a commit is safe.
    loop {
        let moved: Option<String> = redis::cmd("RPOPLPUSH")
            .arg(PROCESSING)
            .arg(PENDING)
            .query_async(&mut conn)
            .await?;
        if moved.is_none() {
            break;
        }
    }

    let mut flushed = 0_u64;
    loop {
        let encoded: Option<String> = redis::cmd("RPOPLPUSH")
            .arg(PENDING)
            .arg(PROCESSING)
            .query_async(&mut conn)
            .await?;
        let Some(encoded) = encoded else { break };
        let event: AccountingEvent = serde_json::from_str(&encoded)
            .context("invalid event in emergency accounting queue")?;
        apply_event(state, &event).await?;
        let removed: i64 = redis::cmd("LREM")
            .arg(PROCESSING)
            .arg(1)
            .arg(&encoded)
            .query_async(&mut conn)
            .await?;
        if removed != 1 {
            return Err(anyhow!("failed to acknowledge flushed accounting event"));
        }
        flushed += 1;
    }

    // A teardown proof includes a live Aiven round trip, both queue lengths,
    // and the sticky unsafe marker raised if an event could not be queued.
    let _: i32 = sqlx::query("SELECT 1")
        .fetch_one(&state.pg)
        .await?
        .try_get(0)?;
    let pending: u64 = redis::cmd("LLEN")
        .arg(PENDING)
        .query_async(&mut conn)
        .await?;
    let processing: u64 = redis::cmd("LLEN")
        .arg(PROCESSING)
        .query_async(&mut conn)
        .await?;
    let unsafe_state = state.accounting_unsafe.load(Ordering::SeqCst);
    let pending = pending + processing;
    Ok(FlushResult {
        ok: pending == 0 && !unsafe_state,
        flushed,
        pending,
        unsafe_state,
    })
}

pub(crate) fn start_background_flush(state: AppState) {
    if !state.cfg.emergency_mode {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        interval.tick().await;
        loop {
            interval.tick().await;
            if let Err(error) = flush(&state).await {
                tracing::warn!(error = %error, "emergency accounting flush failed");
            }
        }
    });
}

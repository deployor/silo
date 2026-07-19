use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;
use tokio::time::timeout;
use uuid::Uuid;

use crate::AppState;

const DIRECT_WRITE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Copy, Debug)]
pub(crate) struct MutationIntent(Option<Uuid>);

impl MutationIntent {
    pub(crate) fn none() -> Self {
        Self(None)
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct AccountingEvent {
    id: String,
    created_at_ms: u64,
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
        created_at_ms: now_ms(),
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

#[allow(clippy::too_many_arguments)]
pub(crate) async fn prepare_mutation_intent(
    state: &AppState,
    region: &str,
    bucket_id: &str,
    user_id: Option<&str>,
    object_key: &str,
    operation: &str,
    old_size: u64,
    new_size: u64,
    quota_reservation_id: Option<Uuid>,
    replication_event_id: Option<Uuid>,
) -> Result<MutationIntent> {
    if old_size == new_size {
        return Ok(MutationIntent::none());
    }
    if !matches!(operation, "put" | "delete") || object_key.is_empty() {
        return Err(anyhow!("mutation accounting intent is invalid"));
    }
    let old_size = i64::try_from(old_size).context("old object size exceeds bigint")?;
    let new_size = i64::try_from(new_size).context("new object size exceeds bigint")?;
    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO dataplane_mutation_intents
          (id, region_id, bucket_id, user_id, object_key, operation,
           old_size, new_size, quota_reservation_id, replication_event_id,
           state, created_at)
        VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8, $9, $10,
                'prepared', now())
        "#,
    )
    .bind(id)
    .bind(region)
    .bind(bucket_id)
    .bind(user_id)
    .bind(object_key)
    .bind(operation)
    .bind(old_size)
    .bind(new_size)
    .bind(quota_reservation_id)
    .bind(replication_event_id)
    .execute(&state.pg)
    .await?;
    Ok(MutationIntent(Some(id)))
}

pub(crate) async fn commit_mutation_intent(state: &AppState, intent: MutationIntent) -> Result<()> {
    let Some(id) = intent.0 else {
        return Ok(());
    };
    let mut tx = state.pg.begin().await?;
    let current = sqlx::query_scalar::<_, String>(
        "SELECT state FROM dataplane_mutation_intents WHERE id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("mutation accounting intent disappeared"))?;
    match current.as_str() {
        "prepared" => {
            sqlx::query(
                "UPDATE dataplane_mutation_intents SET state = 'committed', committed_at = now(), last_error = NULL WHERE id = $1",
            )
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
        "committed" => {}
        "applied" => {
            tx.commit().await?;
            return Ok(());
        }
        "cancelled" => return Err(anyhow!("cancelled mutation intent cannot be committed")),
        _ => return Err(anyhow!("unknown mutation accounting state")),
    }
    apply_mutation_intent(&mut tx, id).await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn correct_prepared_mutation_size(
    state: &AppState,
    intent: MutationIntent,
    new_size: u64,
) -> Result<()> {
    let Some(id) = intent.0 else {
        return Ok(());
    };
    let new_size = i64::try_from(new_size).context("corrected object size exceeds bigint")?;
    let mut tx = state.pg.begin().await?;
    let row = sqlx::query(
        r#"
        UPDATE dataplane_mutation_intents
        SET new_size = $2, last_error = 'provider result size differed from preflight size'
        WHERE id = $1 AND state = 'prepared'
        RETURNING old_size, quota_reservation_id
        "#,
    )
    .bind(id)
    .bind(new_size)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("mutation accounting size correction was lost"))?;
    if let Some(reservation_id) = row.try_get::<Option<Uuid>, _>("quota_reservation_id")? {
        let old_size: i64 = row.try_get("old_size")?;
        let growth = new_size.saturating_sub(old_size);
        if growth > 0 {
            sqlx::query("UPDATE dataplane_quota_reservations SET bytes = $2 WHERE id = $1")
                .bind(reservation_id)
                .bind(growth)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("DELETE FROM dataplane_quota_reservations WHERE id = $1")
                .bind(reservation_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn cancel_mutation_intent(
    state: &AppState,
    intent: MutationIntent,
    reason: &str,
) -> Result<()> {
    let Some(id) = intent.0 else {
        return Ok(());
    };
    let mut tx = state.pg.begin().await?;
    let row = sqlx::query(
        r#"
        UPDATE dataplane_mutation_intents
        SET state = 'cancelled', last_error = $2
        WHERE id = $1 AND state = 'prepared'
        RETURNING quota_reservation_id
        "#,
    )
    .bind(id)
    .bind(reason.chars().take(2_000).collect::<String>())
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(row) = row {
        if let Some(reservation_id) = row.try_get::<Option<Uuid>, _>("quota_reservation_id")? {
            sqlx::query("DELETE FROM dataplane_quota_reservations WHERE id = $1")
                .bind(reservation_id)
                .execute(&mut *tx)
                .await?;
        }
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn reconcile_mutation_for_replication(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    replication_event_id: Uuid,
    committed: bool,
    audit: &str,
) -> Result<()> {
    let row = sqlx::query(
        r#"
        SELECT id, state, quota_reservation_id
        FROM dataplane_mutation_intents
        WHERE replication_event_id = $1
        FOR UPDATE
        "#,
    )
    .bind(replication_event_id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let id: Uuid = row.try_get("id")?;
    let current: String = row.try_get("state")?;
    if committed {
        match current.as_str() {
            "prepared" => {
                sqlx::query(
                    "UPDATE dataplane_mutation_intents SET state = 'committed', committed_at = now(), last_error = $2 WHERE id = $1",
                )
                .bind(id)
                .bind(audit)
                .execute(&mut **tx)
                .await?;
                apply_mutation_intent(tx, id).await?;
            }
            "committed" => apply_mutation_intent(tx, id).await?,
            "applied" => {}
            "cancelled" => {
                return Err(anyhow!(
                    "replication commit conflicts with cancelled accounting intent"
                ))
            }
            _ => return Err(anyhow!("unknown mutation accounting state")),
        }
    } else {
        match current.as_str() {
            "prepared" => {
                sqlx::query(
                    "UPDATE dataplane_mutation_intents SET state = 'cancelled', last_error = $2 WHERE id = $1",
                )
                .bind(id)
                .bind(audit)
                .execute(&mut **tx)
                .await?;
                if let Some(reservation_id) =
                    row.try_get::<Option<Uuid>, _>("quota_reservation_id")?
                {
                    sqlx::query("DELETE FROM dataplane_quota_reservations WHERE id = $1")
                        .bind(reservation_id)
                        .execute(&mut **tx)
                        .await?;
                }
            }
            "cancelled" => {}
            "committed" | "applied" => {
                return Err(anyhow!(
                    "replication cancellation conflicts with committed accounting intent"
                ))
            }
            _ => return Err(anyhow!("unknown mutation accounting state")),
        }
    }
    Ok(())
}

async fn apply_mutation_intent(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: Uuid,
) -> Result<()> {
    let row = sqlx::query(
        r#"
        SELECT bucket_id::text AS bucket_id, old_size, new_size,
               quota_reservation_id
        FROM dataplane_mutation_intents
        WHERE id = $1 AND state = 'committed'
        FOR UPDATE
        "#,
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await?;
    let Some(row) = row else {
        return Ok(());
    };
    let old_size: i64 = row.try_get("old_size")?;
    let new_size: i64 = row.try_get("new_size")?;
    let delta = new_size
        .checked_sub(old_size)
        .ok_or_else(|| anyhow!("mutation accounting delta overflowed"))?;
    sqlx::query(
        "UPDATE buckets SET total_bytes = GREATEST(0, total_bytes + $1) WHERE id = $2::uuid",
    )
    .bind(delta)
    .bind(row.try_get::<String, _>("bucket_id")?)
    .execute(&mut **tx)
    .await?;
    if let Some(reservation_id) = row.try_get::<Option<Uuid>, _>("quota_reservation_id")? {
        sqlx::query("DELETE FROM dataplane_quota_reservations WHERE id = $1")
            .bind(reservation_id)
            .execute(&mut **tx)
            .await?;
    }
    let updated = sqlx::query(
        "UPDATE dataplane_mutation_intents SET state = 'applied', applied_at = now(), last_error = NULL WHERE id = $1 AND state = 'committed'",
    )
    .bind(id)
    .execute(&mut **tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("mutation accounting apply was lost"));
    }
    Ok(())
}

async fn apply_committed_mutations(state: &AppState) -> Result<u64> {
    let ids = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM dataplane_mutation_intents WHERE state = 'committed' ORDER BY committed_at LIMIT 100",
    )
    .fetch_all(&state.pg)
    .await?;
    let count = ids.len() as u64;
    for id in ids {
        let mut tx = state.pg.begin().await?;
        apply_mutation_intent(&mut tx, id).await?;
        tx.commit().await?;
    }
    Ok(count)
}

async fn apply_or_queue(state: &AppState, event: &AccountingEvent) -> Result<()> {
    if matches!(
        timeout(DIRECT_WRITE_TIMEOUT, apply_event(state, event)).await,
        Ok(Ok(()))
    ) {
        return Ok(());
    }
    if let Err(spool_error) = write_spool_event(&state.cfg.accounting_spool_dir, event).await {
        state.accounting_unsafe.store(true, Ordering::SeqCst);
        if let Some(path) = state.cfg.accounting_unsafe_marker.as_ref() {
            if let Err(marker_error) = write_durable_file(
                path,
                format!(
                    "{} accounting event could not reach Aiven or the local durable spool: {spool_error}\n",
                    event.id
                )
                .as_bytes(),
            )
            .await
            {
                tracing::error!(error = %marker_error, "failed to persist accounting unsafe marker");
            }
        }
        return Err(anyhow!(
            "PostgreSQL accounting failed and the fsync-backed local spool was unavailable"
        ));
    }
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
    }
    Ok(())
}

pub(crate) async fn flush(state: &AppState) -> Result<FlushResult> {
    let _guard = state.accounting_flush_lock.lock().await;
    let mut flushed = 0_u64;
    flushed = flushed.saturating_add(apply_committed_mutations(state).await?);
    for path in spool_paths(&state.cfg.accounting_spool_dir).await? {
        let encoded = tokio::fs::read(&path).await?;
        let event: AccountingEvent = serde_json::from_slice(&encoded)
            .with_context(|| format!("invalid accounting spool event {}", path.display()))?;
        apply_event(state, &event).await?;
        tokio::fs::remove_file(&path).await?;
        sync_directory(&state.cfg.accounting_spool_dir).await?;
        flushed += 1;
    }

    // A teardown proof includes a live Aiven round trip, an empty fsync-backed
    // spool, and the sticky unsafe marker raised if an event could not be
    // persisted anywhere.
    let _: i32 = sqlx::query("SELECT 1")
        .fetch_one(&state.pg)
        .await?
        .try_get(0)?;
    let pending = pending_count(&state.cfg.accounting_spool_dir).await?;
    let unsafe_state = state.accounting_unsafe.load(Ordering::SeqCst);
    Ok(FlushResult {
        ok: pending == 0 && !unsafe_state,
        flushed,
        pending,
        unsafe_state,
    })
}

pub(crate) fn initialize_spool(path: &Path) -> Result<()> {
    std::fs::create_dir_all(path)
        .with_context(|| format!("failed to create accounting spool {}", path.display()))?;
    let probe = path.join(format!(".writable-{}", Uuid::new_v4()));
    std::fs::write(&probe, b"probe")?;
    std::fs::File::open(&probe)?.sync_all()?;
    std::fs::remove_file(&probe)?;
    std::fs::File::open(path)?.sync_all()?;
    Ok(())
}

pub(crate) async fn status(state: &AppState) -> Result<serde_json::Value> {
    let pending = pending_count(&state.cfg.accounting_spool_dir).await?;
    let mutation_rows = sqlx::query(
        r#"
        SELECT COUNT(*) FILTER (WHERE state = 'prepared')::bigint AS reconciliation_needed,
               COUNT(*) FILTER (WHERE state = 'committed')::bigint AS committed_pending
        FROM dataplane_mutation_intents
        "#,
    )
    .fetch_one(&state.pg)
    .await?;
    let reconciliation_needed = mutation_rows
        .try_get::<i64, _>("reconciliation_needed")?
        .max(0);
    let committed_pending = mutation_rows.try_get::<i64, _>("committed_pending")?.max(0);
    Ok(serde_json::json!({
        "durable": true,
        "pending": pending,
        "mutationReconciliationNeeded": reconciliation_needed,
        "committedMutationsPending": committed_pending,
        "unsafe": state.accounting_unsafe.load(Ordering::SeqCst),
        "region": state.cfg.regions.local_region(),
    }))
}

pub(crate) async fn mark_unsafe(state: &AppState, reason: &str) {
    state.accounting_unsafe.store(true, Ordering::SeqCst);
    let Some(path) = state.cfg.accounting_unsafe_marker.as_ref() else {
        return;
    };
    let message = format!("{} {reason}\n", Uuid::new_v4());
    if let Err(error) = write_durable_file(path, message.as_bytes()).await {
        tracing::error!(error = %error, "failed to persist accounting unsafe marker");
    }
}

async fn write_spool_event(path: &Path, event: &AccountingEvent) -> Result<()> {
    let filename = format!("{:020}-{}.json", event.created_at_ms, event.id);
    let final_path = path.join(filename);
    if tokio::fs::try_exists(&final_path).await? {
        return Ok(());
    }
    let encoded = serde_json::to_vec(event)?;
    write_durable_file(&final_path, &encoded).await
}

async fn write_durable_file(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("durable file has no parent directory"))?;
    tokio::fs::create_dir_all(parent).await?;
    let tmp = parent.join(format!(
        ".{}.tmp-{}",
        path.file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("event"),
        Uuid::new_v4()
    ));
    let mut file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .await?;
    file.write_all(bytes).await?;
    file.sync_all().await?;
    drop(file);
    if let Err(error) = tokio::fs::rename(&tmp, path).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(error.into());
    }
    sync_directory(parent).await
}

async fn sync_directory(path: &Path) -> Result<()> {
    let path = path.to_path_buf();
    tokio::task::spawn_blocking(move || std::fs::File::open(path)?.sync_all())
        .await
        .context("accounting directory sync task failed")??;
    Ok(())
}

async fn spool_paths(path: &Path) -> Result<Vec<PathBuf>> {
    let mut paths = Vec::new();
    let mut entries = tokio::fs::read_dir(path).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) == Some("json") {
            paths.push(path);
        }
    }
    paths.sort_unstable();
    Ok(paths)
}

async fn pending_count(path: &Path) -> Result<u64> {
    Ok(u64::try_from(spool_paths(path).await?.len()).unwrap_or(u64::MAX))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

pub(crate) fn start_background_flush(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
        interval.tick().await;
        loop {
            interval.tick().await;
            if state.shutting_down.load(Ordering::SeqCst) {
                break;
            }
            if let Err(error) = flush(&state).await {
                tracing::warn!(error = %error, "durable accounting flush failed");
            }
        }
    });
}

use anyhow::Result;

use crate::{AppState, AuthBucket};

/// Keep bucket totals authoritative in Aiven. User usage is derived from the
/// sum of owned buckets so dashboard and S3 writes share one source of truth.
/// PawHost and the emergency VM intentionally use separate Redis instances,
/// so successful mutations must cross that boundary through PostgreSQL.
pub(crate) async fn commit_bucket_usage_delta(
    state: &AppState,
    bucket: &AuthBucket,
    delta: i64,
) -> Result<()> {
    if delta == 0 {
        return Ok(());
    }
    if state.cfg.emergency_mode {
        return crate::accounting::record_bucket_delta(state, &bucket.id, delta).await;
    }
    sqlx::query(
        "UPDATE buckets SET total_bytes = GREATEST(0, total_bytes + $1) WHERE id = $2::uuid",
    )
    .bind(delta)
    .bind(&bucket.id)
    .execute(&state.pg)
    .await?;
    Ok(())
}

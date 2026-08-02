use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    http::{Response, StatusCode},
};
use chrono::{Datelike, Utc};
use sqlx::Row;
use uuid::Uuid;

use crate::{
    rate_limit::check_egress_bytes, response::s3_error, AppState, AuthBucket, AuthUser,
    AuthorizeResponse,
};

const STORAGE_RESERVATION_SECONDS: i32 = 6 * 60 * 60;
const MULTIPART_RESERVATION_SECONDS: i32 = 7 * 24 * 60 * 60;

/// A durable, globally visible reservation. Every dataplane talks to the same
/// Aiven database, so this token prevents EU and US writers from admitting the
/// same final quota byte concurrently.
#[derive(Clone, Copy, Debug)]
pub(crate) struct StorageReservation(Option<Uuid>);

impl StorageReservation {
    fn none() -> Self {
        Self(None)
    }

    pub(crate) fn id(self) -> Option<Uuid> {
        self.0
    }
}

pub(crate) async fn reserve_storage(
    state: &AppState,
    user: &AuthUser,
    delta: u64,
) -> Result<StorageReservation> {
    if delta == 0 || user.is_immortal {
        return Ok(StorageReservation::none());
    }
    let delta = i64::try_from(delta).context("storage reservation exceeds bigint")?;
    let mut tx = state.pg.begin().await?;
    lock_user_quota(&mut tx, &user.id).await?;
    cleanup_expired(&mut tx, &user.id).await?;

    let (is_immortal, limit) = load_storage_limit(&mut tx, &user.id).await?;
    if is_immortal {
        tx.commit().await?;
        return Ok(StorageReservation::none());
    }
    let limit = limit.ok_or_else(|| anyhow!("storage quota denied"))?;
    let used = load_reserved_storage_usage(&mut tx, &user.id).await?;
    if used > limit || delta > limit.saturating_sub(used) {
        return Err(anyhow!("storage quota exceeded"));
    }

    let id = Uuid::new_v4();
    sqlx::query(
        r#"
        INSERT INTO dataplane_quota_reservations
          (id, user_id, kind, bytes, expires_at, created_at)
        VALUES ($1, $2, 'storage', $3, now() + make_interval(secs => $4), now())
        "#,
    )
    .bind(id)
    .bind(&user.id)
    .bind(delta)
    .bind(STORAGE_RESERVATION_SECONDS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StorageReservation(Some(id)))
}

pub(crate) async fn release_storage_reservation(
    state: &AppState,
    reservation: StorageReservation,
) -> Result<()> {
    let Some(id) = reservation.0 else {
        return Ok(());
    };
    sqlx::query("DELETE FROM dataplane_quota_reservations WHERE id = $1")
        .bind(id)
        .execute(&state.pg)
        .await?;
    Ok(())
}

/// Egress accounting and enforcement are one Aiven row lock. This is both the
/// usage write and the quota reservation; callers must not enqueue a second
/// egress increment after this succeeds.
pub(crate) async fn reserve_egress(state: &AppState, user: &AuthUser, delta: u64) -> Result<()> {
    if delta == 0 {
        return Ok(());
    }
    let delta = i64::try_from(delta).context("egress reservation exceeds bigint")?;
    let period = current_egress_period();
    let mut tx = state.pg.begin().await?;
    lock_user_quota(&mut tx, &user.id).await?;
    let row = sqlx::query(
        r#"
        SELECT is_immortal, storage_limit_bytes, egress_limit_bytes,
               egress_bytes, egress_period
        FROM users
        WHERE id = $1
        FOR UPDATE
        "#,
    )
    .bind(&user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("quota user does not exist"))?;
    let immortal: bool = row.try_get("is_immortal")?;
    let storage_limit: Option<i64> = row.try_get("storage_limit_bytes")?;
    let explicit_limit: Option<i64> = row.try_get("egress_limit_bytes")?;
    let previous_period: Option<String> = row.try_get("egress_period")?;
    let previous = if previous_period.as_deref() == Some(period.as_str()) {
        row.try_get::<i64, _>("egress_bytes")?.max(0)
    } else {
        0
    };
    let limit = if immortal || explicit_limit == Some(-1) {
        None
    } else if let Some(limit) = explicit_limit {
        Some(limit.max(0))
    } else {
        Some(
            storage_limit
                .unwrap_or(0)
                .max(0)
                .saturating_mul(3)
                .max(10 * 1024 * 1024 * 1024),
        )
    };
    if limit.is_some_and(|limit| previous > limit || delta > limit.saturating_sub(previous)) {
        return Err(anyhow!("egress quota exceeded"));
    }
    let next = previous
        .checked_add(delta)
        .ok_or_else(|| anyhow!("egress counter exceeds bigint"))?;
    let updated = sqlx::query(
        "UPDATE users SET egress_bytes = $1, egress_period = $2, updated_at = now() WHERE id = $3",
    )
    .bind(next)
    .bind(&period)
    .bind(&user.id)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() != 1 {
        return Err(anyhow!("egress quota user disappeared"));
    }
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn reserve_served_egress(
    state: &AppState,
    auth: &AuthorizeResponse,
    bytes: u64,
) -> Result<Option<Response<Body>>> {
    if bytes == 0 {
        return Ok(None);
    }
    if let Some(response) = check_egress_bytes(state, auth, bytes).await? {
        return Ok(Some(response));
    }
    if let Some(user) = &auth.user {
        if reserve_egress(state, user, bytes).await.is_err() {
            return Ok(Some(s3_error(
                StatusCode::FORBIDDEN,
                "QuotaExceeded",
                "You have exceeded your egress quota.",
            )));
        }
    }
    Ok(None)
}

pub(crate) async fn register_multipart_upload(
    state: &AppState,
    user_id: &str,
    bucket: &AuthBucket,
    upload_id: &str,
    existing_size: u64,
) -> Result<()> {
    if user_id.is_empty() || bucket.id.is_empty() || upload_id.is_empty() {
        return Err(anyhow!("multipart quota identity is incomplete"));
    }
    let existing_size = i64::try_from(existing_size).context("existing object exceeds bigint")?;
    let backend = bucket.active_backend()?;
    let mut tx = state.pg.begin().await?;
    lock_user_quota(&mut tx, user_id).await?;
    cleanup_expired(&mut tx, user_id).await?;
    sqlx::query(
        r#"
        INSERT INTO dataplane_multipart_quota_uploads
          (upload_id, user_id, bucket_id, storage_region, backend_id,
           backend_generation, existing_credit, expires_at)
        VALUES ($1, $2, $3::uuid, $4, $5, $6, $7,
                now() + make_interval(secs => $8))
        ON CONFLICT (upload_id) DO UPDATE SET
          expires_at = EXCLUDED.expires_at
        WHERE dataplane_multipart_quota_uploads.user_id = EXCLUDED.user_id
          AND dataplane_multipart_quota_uploads.bucket_id = EXCLUDED.bucket_id
          AND dataplane_multipart_quota_uploads.storage_region = EXCLUDED.storage_region
          AND dataplane_multipart_quota_uploads.backend_id = EXCLUDED.backend_id
          AND dataplane_multipart_quota_uploads.backend_generation = EXCLUDED.backend_generation
        "#,
    )
    .bind(upload_id)
    .bind(user_id)
    .bind(&bucket.id)
    .bind(&bucket.resolved_region)
    .bind(&backend.id)
    .bind(backend.generation)
    .bind(existing_size)
    .bind(MULTIPART_RESERVATION_SECONDS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn reserve_multipart_part(
    state: &AppState,
    user: &AuthUser,
    bucket_id: &str,
    upload_id: &str,
    part_number: &str,
    part_size: u64,
) -> Result<()> {
    let part_number = part_number
        .parse::<i32>()
        .context("multipart part number is invalid")?;
    if !(1..=10_000).contains(&part_number) || bucket_id.is_empty() || upload_id.is_empty() {
        return Err(anyhow!("multipart quota identity is invalid"));
    }
    let part_size = i64::try_from(part_size).context("multipart part exceeds bigint")?;
    let mut tx = state.pg.begin().await?;
    lock_user_quota(&mut tx, &user.id).await?;
    cleanup_expired(&mut tx, &user.id).await?;
    let upload_exists = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1
          FROM dataplane_multipart_quota_uploads
          WHERE upload_id = $1 AND user_id = $2 AND bucket_id = $3::uuid
            AND expires_at > now()
          FOR UPDATE
        )
        "#,
    )
    .bind(upload_id)
    .bind(&user.id)
    .bind(bucket_id)
    .fetch_one(&mut *tx)
    .await?;
    if !upload_exists {
        return Err(anyhow!("multipart quota upload is missing or expired"));
    }
    let (is_immortal, limit) = load_storage_limit(&mut tx, &user.id).await?;
    let previous = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COALESCE((
          SELECT part_bytes FROM dataplane_multipart_quota_parts
          WHERE upload_id = $1 AND part_number = $2
        ), 0)::bigint
        "#,
    )
    .bind(upload_id)
    .bind(part_number)
    .fetch_one(&mut *tx)
    .await?;
    if !is_immortal && part_size > previous {
        let limit = limit.ok_or_else(|| anyhow!("storage quota denied"))?;
        let used = load_reserved_storage_usage(&mut tx, &user.id).await?;
        let growth = part_size - previous;
        if used > limit || growth > limit.saturating_sub(used) {
            return Err(anyhow!("multipart quota exceeded"));
        }
    }
    sqlx::query(
        r#"
        INSERT INTO dataplane_multipart_quota_parts (upload_id, part_number, part_bytes)
        VALUES ($1, $2, $3)
        ON CONFLICT (upload_id, part_number) DO UPDATE
        SET part_bytes = EXCLUDED.part_bytes
        "#,
    )
    .bind(upload_id)
    .bind(part_number)
    .bind(part_size)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        r#"
        UPDATE dataplane_multipart_quota_uploads
        SET expires_at = now() + make_interval(secs => $2)
        WHERE upload_id = $1
        "#,
    )
    .bind(upload_id)
    .bind(MULTIPART_RESERVATION_SECONDS)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

pub(crate) async fn multipart_completed_size(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
    part_numbers: &[i32],
) -> Result<u64> {
    if part_numbers.is_empty() || part_numbers.len() > 10_000 {
        return Err(anyhow!("multipart completion has no valid parts"));
    }
    let mut unique = part_numbers.to_vec();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() != part_numbers.len() || unique.iter().any(|part| !(1..=10_000).contains(part))
    {
        return Err(anyhow!("multipart completion part list is invalid"));
    }
    let row = sqlx::query(
        r#"
        SELECT COUNT(*)::bigint AS part_count,
               COALESCE(SUM(p.part_bytes), 0)::bigint AS total_bytes
        FROM dataplane_multipart_quota_uploads u
        JOIN dataplane_multipart_quota_parts p ON p.upload_id = u.upload_id
        WHERE u.upload_id = $1 AND u.user_id = $2 AND u.bucket_id = $3::uuid
          AND u.expires_at > now() AND p.part_number = ANY($4)
        "#,
    )
    .bind(upload_id)
    .bind(user_id)
    .bind(bucket_id)
    .bind(&unique)
    .fetch_one(&state.pg)
    .await?;
    let count: i64 = row.try_get("part_count")?;
    if usize::try_from(count).ok() != Some(unique.len()) {
        return Err(anyhow!("multipart completion references an untracked part"));
    }
    let total: i64 = row.try_get("total_bytes")?;
    u64::try_from(total).context("multipart completed size is invalid")
}

pub(crate) async fn release_multipart_part(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
    part_number: &str,
) -> Result<()> {
    let Ok(part_number) = part_number.parse::<i32>() else {
        return Ok(());
    };
    sqlx::query(
        r#"
        DELETE FROM dataplane_multipart_quota_parts p
        USING dataplane_multipart_quota_uploads u
        WHERE p.upload_id = u.upload_id
          AND p.upload_id = $1 AND p.part_number = $2
          AND u.user_id = $3 AND u.bucket_id = $4::uuid
        "#,
    )
    .bind(upload_id)
    .bind(part_number)
    .bind(user_id)
    .bind(bucket_id)
    .execute(&state.pg)
    .await?;
    Ok(())
}

pub(crate) async fn clear_multipart_upload(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
) -> Result<()> {
    sqlx::query(
        r#"
        DELETE FROM dataplane_multipart_quota_uploads
        WHERE upload_id = $1 AND user_id = $2 AND bucket_id = $3::uuid
        "#,
    )
    .bind(upload_id)
    .bind(user_id)
    .bind(bucket_id)
    .execute(&state.pg)
    .await?;
    Ok(())
}

pub(crate) async fn release_multipart_upload(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
) -> Result<()> {
    clear_multipart_upload(state, user_id, bucket_id, upload_id).await
}

async fn lock_user_quota(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended('silo:quota:' || $1, 0))")
        .bind(user_id)
        .execute(&mut **tx)
        .await?;
    Ok(())
}

async fn cleanup_expired(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
) -> Result<()> {
    sqlx::query(
        r#"
        DELETE FROM dataplane_quota_reservations r
        WHERE r.user_id = $1 AND r.expires_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM dataplane_mutation_intents i
            WHERE i.quota_reservation_id = r.id
              AND i.state IN ('prepared', 'committed')
          )
        "#,
    )
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    sqlx::query(
        "DELETE FROM dataplane_multipart_quota_uploads WHERE user_id = $1 AND expires_at <= now()",
    )
    .bind(user_id)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn load_storage_limit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
) -> Result<(bool, Option<i64>)> {
    let row = sqlx::query(
        r#"
        SELECT u.is_immortal, u.storage_limit_bytes,
               (SELECT default_storage_limit_bytes FROM app_settings LIMIT 1)
                 AS default_storage_limit_bytes
        FROM users u
        WHERE u.id = $1
        FOR UPDATE
        "#,
    )
    .bind(user_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| anyhow!("quota user does not exist"))?;
    let immortal: bool = row.try_get("is_immortal")?;
    let explicit: Option<i64> = row.try_get("storage_limit_bytes")?;
    let default: Option<i64> = row.try_get("default_storage_limit_bytes")?;
    Ok(resolve_storage_limit(immortal, explicit, default))
}

fn resolve_storage_limit(
    immortal: bool,
    explicit: Option<i64>,
    configured_default: Option<i64>,
) -> (bool, Option<i64>) {
    if immortal {
        return (true, None);
    }
    // Keep this byte-for-byte equivalent in meaning to auth/control-plane:
    // COALESCE(NULLIF(users.storage_limit_bytes, 0),
    //          app_settings.default_storage_limit_bytes, 1 GiB).
    let resolved = explicit
        .filter(|value| *value != 0)
        .or(configured_default)
        .unwrap_or(1024 * 1024 * 1024);
    if resolved == -1 {
        (false, None)
    } else {
        (false, Some(resolved.max(0)))
    }
}

async fn load_reserved_storage_usage(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: &str,
) -> Result<i64> {
    sqlx::query_scalar::<_, i64>(
        r#"
        SELECT (
          COALESCE((
            SELECT SUM(GREATEST(total_bytes, 0)) FROM buckets WHERE user_id = $1
          ), 0)
          + COALESCE((
            SELECT SUM(bytes) FROM dataplane_quota_reservations
            WHERE user_id = $1 AND kind = 'storage'
              AND (
                expires_at > now()
                OR EXISTS (
                  SELECT 1 FROM dataplane_mutation_intents i
                  WHERE i.quota_reservation_id = dataplane_quota_reservations.id
                    AND i.state IN ('prepared', 'committed')
                )
              )
          ), 0)
          + COALESCE((
            SELECT SUM(GREATEST(COALESCE(parts.total_bytes, 0) - uploads.existing_credit, 0))
            FROM dataplane_multipart_quota_uploads uploads
            LEFT JOIN (
              SELECT upload_id, SUM(part_bytes) AS total_bytes
              FROM dataplane_multipart_quota_parts
              GROUP BY upload_id
            ) parts ON parts.upload_id = uploads.upload_id
            WHERE uploads.user_id = $1 AND uploads.expires_at > now()
          ), 0)
          + COALESCE((
            SELECT SUM(GREATEST(new_size - old_size, 0))
            FROM dataplane_mutation_intents
            WHERE user_id = $1 AND state IN ('prepared', 'committed')
              AND quota_reservation_id IS NULL
          ), 0)
        )::bigint
        "#,
    )
    .bind(user_id)
    .fetch_one(&mut **tx)
    .await
    .context("failed to calculate global reserved storage usage")
}

fn current_egress_period() -> String {
    let now = Utc::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

#[cfg(test)]
mod tests {
    use super::resolve_storage_limit;

    #[test]
    fn storage_limit_uses_product_default_semantics() {
        assert_eq!(
            resolve_storage_limit(false, None, Some(5_000)),
            (false, Some(5_000))
        );
        assert_eq!(
            resolve_storage_limit(false, Some(0), Some(5_000)),
            (false, Some(5_000))
        );
        assert_eq!(
            resolve_storage_limit(false, None, None),
            (false, Some(1024 * 1024 * 1024))
        );
        assert_eq!(
            resolve_storage_limit(false, Some(42), Some(5_000)),
            (false, Some(42))
        );
    }

    #[test]
    fn storage_limit_preserves_unlimited_decisions() {
        assert_eq!(
            resolve_storage_limit(false, Some(-1), Some(5_000)),
            (false, None)
        );
        assert_eq!(resolve_storage_limit(true, Some(1), Some(1)), (true, None));
    }
}

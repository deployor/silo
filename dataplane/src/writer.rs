use anyhow::{Context, Result};
use sqlx::Row;

use crate::AppState;

const LEASE_NAME: &str = "s3";
const WRITER_LOCK_ID: i64 = 1_397_313_615;

pub(crate) async fn claim(state: &AppState) -> Result<i64> {
    let mut tx = state.writer_pg.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(WRITER_LOCK_ID)
        .execute(&mut *tx)
        .await?;
    let row = sqlx::query(
        r#"
        INSERT INTO dataplane_writer_lease
          (name, holder_id, generation, lease_expires_at, updated_at)
        VALUES ($1, $2, 1, now() + make_interval(secs => $3), now())
        ON CONFLICT (name) DO UPDATE SET
          holder_id = EXCLUDED.holder_id,
          generation = CASE
            WHEN dataplane_writer_lease.holder_id = EXCLUDED.holder_id
              THEN dataplane_writer_lease.generation
            ELSE dataplane_writer_lease.generation + 1
          END,
          lease_expires_at = EXCLUDED.lease_expires_at,
          updated_at = now()
        RETURNING generation
        "#,
    )
    .bind(LEASE_NAME)
    .bind(&state.cfg.writer_instance_id)
    .bind(state.cfg.writer_lease_seconds)
    .fetch_one(&mut *tx)
    .await?;
    let generation = row
        .try_get("generation")
        .context("missing writer generation")?;
    tx.commit().await?;
    Ok(generation)
}

/// The shared transaction lock spans the complete upstream mutation. A lease
/// transfer takes the exclusive form, so it cannot change generations while
/// an old writer still has a PUT/DELETE/multipart request in flight.
pub(crate) async fn begin_mutation(
    state: &AppState,
) -> Result<(sqlx::Transaction<'static, sqlx::Postgres>, Option<i64>)> {
    let mut tx = state.writer_pg.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(WRITER_LOCK_ID)
        .execute(&mut *tx)
        .await?;
    let generation = sqlx::query_scalar(
        r#"
        SELECT generation
        FROM dataplane_writer_lease
        WHERE name = $1 AND holder_id = $2 AND lease_expires_at > now()
        "#,
    )
    .bind(LEASE_NAME)
    .bind(&state.cfg.writer_instance_id)
    .fetch_optional(&mut *tx)
    .await?;
    Ok((tx, generation))
}

/// Startup is deliberately conservative. A normal primary restart may renew
/// its own lease or create the initial row, but it may never steal a lease
/// from an emergency writer. Only the external controller calls `claim`.
pub(crate) async fn claim_initial(state: &AppState) -> Result<Option<i64>> {
    let row = sqlx::query(
        r#"
        INSERT INTO dataplane_writer_lease
          (name, holder_id, generation, lease_expires_at, updated_at)
        VALUES ($1, $2, 1, now() + make_interval(secs => $3), now())
        ON CONFLICT (name) DO UPDATE SET
          lease_expires_at = EXCLUDED.lease_expires_at,
          updated_at = now()
        WHERE dataplane_writer_lease.holder_id = EXCLUDED.holder_id
        RETURNING generation
        "#,
    )
    .bind(LEASE_NAME)
    .bind(&state.cfg.writer_instance_id)
    .bind(state.cfg.writer_lease_seconds)
    .fetch_optional(&state.writer_pg)
    .await?;
    row.map(|row| row.try_get("generation"))
        .transpose()
        .context("missing writer generation")
}

pub(crate) async fn renew(state: &AppState) -> Result<bool> {
    let result = sqlx::query(
        r#"
        UPDATE dataplane_writer_lease
        SET lease_expires_at = now() + make_interval(secs => $1), updated_at = now()
        WHERE name = $2 AND holder_id = $3
        "#,
    )
    .bind(state.cfg.writer_lease_seconds)
    .bind(LEASE_NAME)
    .bind(&state.cfg.writer_instance_id)
    .execute(&state.writer_pg)
    .await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn active_generation(state: &AppState) -> Result<Option<i64>> {
    sqlx::query_scalar(
        r#"
        SELECT generation
        FROM dataplane_writer_lease
        WHERE name = $1
          AND holder_id = $2
          AND lease_expires_at > now()
        "#,
    )
    .bind(LEASE_NAME)
    .bind(&state.cfg.writer_instance_id)
    .fetch_optional(&state.writer_pg)
    .await
    .context("failed to verify active writer lease")
}

pub(crate) fn is_mutation(action: &str) -> bool {
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

pub(crate) async fn register_multipart(
    state: &AppState,
    bucket_id: &str,
    upload_id: &str,
    generation: i64,
) -> Result<()> {
    sqlx::query(
        r#"
        INSERT INTO multipart_upload_generations
          (upload_id, bucket_id, writer_generation, created_at)
        VALUES ($1, $2::uuid, $3, now())
        ON CONFLICT (upload_id) DO UPDATE SET
          bucket_id = EXCLUDED.bucket_id,
          writer_generation = EXCLUDED.writer_generation,
          created_at = now()
        "#,
    )
    .bind(upload_id)
    .bind(bucket_id)
    .bind(generation)
    .execute(&state.pg)
    .await?;
    Ok(())
}

pub(crate) async fn multipart_matches(
    state: &AppState,
    bucket_id: &str,
    upload_id: &str,
    generation: i64,
) -> Result<bool> {
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM multipart_upload_generations
          WHERE upload_id = $1
            AND bucket_id = $2::uuid
            AND writer_generation = $3
        )
        "#,
    )
    .bind(upload_id)
    .bind(bucket_id)
    .bind(generation)
    .fetch_one(&state.pg)
    .await
    .context("failed to validate multipart writer generation")
}

pub(crate) async fn clear_multipart(state: &AppState, upload_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM multipart_upload_generations WHERE upload_id = $1")
        .bind(upload_id)
        .execute(&state.pg)
        .await?;
    Ok(())
}

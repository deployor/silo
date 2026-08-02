use std::collections::BTreeMap;

use anyhow::{anyhow, Context, Result};
use axum::http::{HeaderMap, Method};
use sha2::{Digest, Sha256};
use sqlx::Row;

use crate::AppState;

const WRITER_LOCK_DOMAIN: &[u8] = b"silo:writer:";
const BUCKET_LOCK_DOMAIN: &[u8] = b"silo:bucket:";
const BUCKET_OBJECT_GATE_DOMAIN: &[u8] = b"silo:bucket-objects:";
const OBJECT_LOCK_DOMAIN: &[u8] = b"silo:object:";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ActiveBackend {
    pub(crate) id: String,
    pub(crate) generation: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MutationContext {
    pub(crate) writer_generation: i64,
    pub(crate) backend: ActiveBackend,
}

#[derive(Debug)]
pub(crate) struct PromotionResult {
    pub(crate) region: String,
    pub(crate) from_backend_id: String,
    pub(crate) to_backend_id: String,
    pub(crate) old_backend_generation: i64,
    pub(crate) new_backend_generation: i64,
}

pub(crate) async fn claim(state: &AppState, storage_region: &str) -> Result<i64> {
    state.cfg.regions.ensure_served(storage_region)?;
    let mut tx = state.writer_pg.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(writer_lock_id(storage_region))
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
    .bind(lease_name(storage_region))
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
    storage_region: &str,
    bucket_id: &str,
    allow_paused: bool,
    object_key: Option<&str>,
    exclusive_bucket_objects: bool,
) -> Result<(
    sqlx::Transaction<'static, sqlx::Postgres>,
    Option<MutationContext>,
)> {
    state.cfg.regions.ensure_served(storage_region)?;
    let mut tx = state.writer_pg.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(writer_lock_id(storage_region))
        .execute(&mut *tx)
        .await?;
    if exclusive_bucket_objects {
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(bucket_object_gate_lock_id(bucket_id))
            .execute(&mut *tx)
            .await?;
    } else if let Some(object_key) = object_key {
        sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
            .bind(bucket_object_gate_lock_id(bucket_id))
            .execute(&mut *tx)
            .await?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(object_lock_id(bucket_id, object_key))
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("SELECT pg_advisory_xact_lock_shared($1)")
        .bind(bucket_lock_id(bucket_id))
        .execute(&mut *tx)
        .await?;
    let bucket_writable = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM buckets
          WHERE id = $1::uuid AND ($2 OR NOT is_paused)
        )
        "#,
    )
    .bind(bucket_id)
    .bind(allow_paused)
    .fetch_one(&mut *tx)
    .await?;
    if !bucket_writable {
        return Ok((tx, None));
    }
    let writer_generation = sqlx::query_scalar(
        r#"
        SELECT generation
        FROM dataplane_writer_lease
        WHERE name = $1 AND holder_id = $2 AND lease_expires_at > now()
        "#,
    )
    .bind(lease_name(storage_region))
    .bind(&state.cfg.writer_instance_id)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(writer_generation) = writer_generation else {
        return Ok((tx, None));
    };
    let backend = active_backend_in_transaction(state, &mut tx, storage_region).await?;
    Ok((
        tx,
        Some(MutationContext {
            writer_generation,
            backend,
        }),
    ))
}

/// Hold this transaction across the control plane's final emptiness proof and
/// metadata deletion. Every object mutation takes the shared form of the same
/// advisory lock and rechecks `is_paused` after acquiring it.
pub(crate) async fn begin_bucket_teardown(
    state: &AppState,
    bucket_id: &str,
) -> Result<sqlx::Transaction<'static, sqlx::Postgres>> {
    let mut tx = state.writer_pg.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(bucket_lock_id(bucket_id))
        .execute(&mut *tx)
        .await?;
    let paused = sqlx::query_scalar::<_, bool>("SELECT is_paused FROM buckets WHERE id = $1::uuid")
        .bind(bucket_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| anyhow!("bucket does not exist"))?;
    if !paused {
        return Err(anyhow!(
            "bucket must be paused before teardown verification"
        ));
    }
    Ok(tx)
}

pub(crate) async fn lock_region_exclusive(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    storage_region: &str,
) -> Result<()> {
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(writer_lock_id(storage_region))
        .execute(&mut **tx)
        .await?;
    Ok(())
}

/// Startup is deliberately conservative. A normal primary restart may renew
/// its own lease or create the initial row, but it may never steal a lease
/// from an emergency writer. Only the external controller calls `claim`.
pub(crate) async fn claim_initial(state: &AppState, storage_region: &str) -> Result<Option<i64>> {
    if storage_region != state.cfg.regions.local_region() {
        return Err(anyhow!("startup may only claim the local writer lease"));
    }
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
    .bind(lease_name(storage_region))
    .bind(&state.cfg.writer_instance_id)
    .bind(state.cfg.writer_lease_seconds)
    .fetch_optional(&state.writer_pg)
    .await?;
    row.map(|row| row.try_get("generation"))
        .transpose()
        .context("missing writer generation")
}

pub(crate) async fn renew(state: &AppState, storage_region: &str) -> Result<bool> {
    state.cfg.regions.ensure_served(storage_region)?;
    let result = sqlx::query(
        r#"
        UPDATE dataplane_writer_lease
        SET lease_expires_at = now() + make_interval(secs => $1), updated_at = now()
        WHERE name = $2 AND holder_id = $3
        "#,
    )
    .bind(state.cfg.writer_lease_seconds)
    .bind(lease_name(storage_region))
    .bind(&state.cfg.writer_instance_id)
    .execute(&state.writer_pg)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// Expire only a lease still owned by this exact instance. The exclusive
/// regional advisory lock waits for every shared mutation fence, while the
/// holder predicate prevents a late shutdown from touching a newly claimed
/// lease.
pub(crate) async fn relinquish(state: &AppState, storage_region: &str) -> Result<bool> {
    state.cfg.regions.ensure_served(storage_region)?;
    let mut tx = state.writer_pg.begin().await?;
    lock_region_exclusive(&mut tx, storage_region).await?;
    let result = sqlx::query(
        r#"
        UPDATE dataplane_writer_lease
        SET lease_expires_at = now(), updated_at = now()
        WHERE name = $1 AND holder_id = $2
        "#,
    )
    .bind(lease_name(storage_region))
    .bind(&state.cfg.writer_instance_id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(result.rows_affected() == 1)
}

pub(crate) async fn active_generation(
    state: &AppState,
    storage_region: &str,
) -> Result<Option<i64>> {
    state.cfg.regions.ensure_served(storage_region)?;
    sqlx::query_scalar(
        r#"
        SELECT generation
        FROM dataplane_writer_lease
        WHERE name = $1
          AND holder_id = $2
          AND lease_expires_at > now()
        "#,
    )
    .bind(lease_name(storage_region))
    .bind(&state.cfg.writer_instance_id)
    .fetch_optional(&state.writer_pg)
    .await
    .context("failed to verify active writer lease")
}

/// Return the durable lease generation regardless of which dataplane owns it.
/// Read caches use this as a fencing namespace, so a node that was offline
/// during failover cannot reuse pre-failover entries after it comes back.
pub(crate) async fn current_generation(state: &AppState, storage_region: &str) -> Result<i64> {
    state.cfg.regions.ensure_served(storage_region)?;
    sqlx::query_scalar("SELECT generation FROM dataplane_writer_lease WHERE name = $1")
        .bind(lease_name(storage_region))
        .fetch_optional(&state.writer_pg)
        .await?
        .ok_or_else(|| anyhow!("writer lease generation does not exist"))
}

pub(crate) async fn active_generations(state: &AppState) -> Result<BTreeMap<String, i64>> {
    let mut generations = BTreeMap::new();
    for region in state.cfg.regions.served_regions() {
        if let Some(generation) = active_generation(state, region).await? {
            generations.insert(region.to_string(), generation);
        }
    }
    Ok(generations)
}

/// Resolve the database-selected physical backend for a logical storage
/// region. The registry only supplies credentials; it never chooses which
/// backend is active.
pub(crate) async fn active_backend(
    state: &AppState,
    storage_region: &str,
) -> Result<ActiveBackend> {
    state.cfg.regions.ensure_served(storage_region)?;
    if let Some((backend, cached_at)) = state
        .active_backend_cache
        .read()
        .await
        .get(storage_region)
        .cloned()
    {
        if cached_at.elapsed() <= state.cfg.active_backend_cache_ttl {
            return Ok(backend);
        }
    }
    let row = sqlx::query(
        r#"
        SELECT s.active_backend_id, s.backend_generation, b.bucket_name
        FROM storage_region_state s
        JOIN storage_region_backends b
          ON b.region_id = s.region_id
         AND b.backend_id = s.active_backend_id
        WHERE s.region_id = $1
        "#,
    )
    .bind(storage_region)
    .fetch_optional(&state.pg)
    .await?
    .ok_or_else(|| anyhow!("storage region {storage_region} has no active backend state"))?;
    let backend_id: String = row.try_get("active_backend_id")?;
    let generation: i64 = row.try_get("backend_generation")?;
    let configured = state.cfg.regions.backend(storage_region, &backend_id)?;
    let bound_bucket: Option<String> = row.try_get("bucket_name")?;
    bind_or_validate_bucket_pool(
        state,
        storage_region,
        &backend_id,
        bound_bucket.as_deref(),
        &configured.bucket,
    )
    .await?;
    let active = ActiveBackend {
        id: backend_id,
        generation,
    };
    state.active_backend_cache.write().await.insert(
        storage_region.to_string(),
        (active.clone(), std::time::Instant::now()),
    );
    Ok(active)
}

async fn active_backend_in_transaction(
    state: &AppState,
    tx: &mut sqlx::Transaction<'static, sqlx::Postgres>,
    storage_region: &str,
) -> Result<ActiveBackend> {
    let row = sqlx::query(
        r#"
        SELECT s.active_backend_id, s.backend_generation, b.bucket_name
        FROM storage_region_state s
        JOIN storage_region_backends b
          ON b.region_id = s.region_id
         AND b.backend_id = s.active_backend_id
        WHERE s.region_id = $1
        "#,
    )
    .bind(storage_region)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| anyhow!("storage region {storage_region} has no active backend state"))?;
    let backend_id: String = row.try_get("active_backend_id")?;
    let generation: i64 = row.try_get("backend_generation")?;
    let configured = state.cfg.regions.backend(storage_region, &backend_id)?;
    let bound_bucket: Option<String> = row.try_get("bucket_name")?;
    if let Some(bound_bucket) = bound_bucket {
        if bound_bucket != configured.bucket {
            return Err(anyhow!(
                "configured bucket does not match the database binding for {storage_region}/{backend_id}"
            ));
        }
    } else {
        let result = sqlx::query(
            r#"
            UPDATE storage_region_backends
            SET bucket_name = $3, updated_at = now()
            WHERE region_id = $1 AND backend_id = $2 AND bucket_name IS NULL
            "#,
        )
        .bind(storage_region)
        .bind(&backend_id)
        .bind(&configured.bucket)
        .execute(&mut **tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(anyhow!(
                "failed to bind configured bucket for {storage_region}/{backend_id}"
            ));
        }
    }
    Ok(ActiveBackend {
        id: backend_id,
        generation,
    })
}

async fn bind_or_validate_bucket_pool(
    state: &AppState,
    storage_region: &str,
    backend_id: &str,
    bound_bucket: Option<&str>,
    configured_bucket: &str,
) -> Result<()> {
    if let Some(bound_bucket) = bound_bucket {
        if bound_bucket == configured_bucket {
            return Ok(());
        }
        return Err(anyhow!(
            "configured bucket does not match the database binding for {storage_region}/{backend_id}"
        ));
    }
    let bound = sqlx::query_scalar::<_, String>(
        r#"
        UPDATE storage_region_backends
        SET bucket_name = $3, updated_at = now()
        WHERE region_id = $1 AND backend_id = $2 AND bucket_name IS NULL
        RETURNING bucket_name
        "#,
    )
    .bind(storage_region)
    .bind(backend_id)
    .bind(configured_bucket)
    .fetch_optional(&state.pg)
    .await?;
    if bound.as_deref() == Some(configured_bucket) {
        return Ok(());
    }
    let current = sqlx::query_scalar::<_, Option<String>>(
        "SELECT bucket_name FROM storage_region_backends WHERE region_id = $1 AND backend_id = $2",
    )
    .bind(storage_region)
    .bind(backend_id)
    .fetch_optional(&state.pg)
    .await?
    .flatten();
    if current.as_deref() != Some(configured_bucket) {
        return Err(anyhow!(
            "configured bucket does not match the database binding for {storage_region}/{backend_id}"
        ));
    }
    Ok(())
}

pub(crate) async fn promote_backend(
    state: &AppState,
    storage_region: &str,
    target_backend_id: &str,
    expected_backend_generation: i64,
    actor: &str,
    reason: &str,
) -> Result<PromotionResult> {
    state.cfg.regions.ensure_served(storage_region)?;
    let target_config = state
        .cfg
        .regions
        .backend(storage_region, target_backend_id)?;
    if actor.trim().is_empty()
        || reason.trim().is_empty()
        || actor.len() > 200
        || reason.len() > 2_000
    {
        return Err(anyhow!(
            "promotion actor and reason are required and bounded"
        ));
    }

    let mut tx = state.writer_pg.begin().await?;
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(writer_lock_id(storage_region))
        .execute(&mut *tx)
        .await?;
    let current = sqlx::query(
        r#"
        SELECT active_backend_id, backend_generation, required_replication_checkpoint
        FROM storage_region_state
        WHERE region_id = $1
        FOR UPDATE
        "#,
    )
    .bind(storage_region)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("storage region has no provider state"))?;
    let from_backend_id: String = current.try_get("active_backend_id")?;
    let old_backend_generation: i64 = current.try_get("backend_generation")?;
    let required_checkpoint: i64 = current.try_get("required_replication_checkpoint")?;
    let owns_writer = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM dataplane_writer_lease
          WHERE name = $1 AND holder_id = $2 AND lease_expires_at > now()
        )
        "#,
    )
    .bind(lease_name(storage_region))
    .bind(&state.cfg.writer_instance_id)
    .fetch_one(&mut *tx)
    .await?;
    if !owns_writer {
        return Err(anyhow!(
            "this dataplane does not own the active writer lease for the storage region"
        ));
    }
    let unresolved_accounting = sqlx::query_scalar::<_, i64>(
        r#"
        SELECT COUNT(*)::bigint FROM dataplane_mutation_intents
        WHERE region_id = $1 AND state IN ('prepared', 'committed')
        "#,
    )
    .bind(storage_region)
    .fetch_one(&mut *tx)
    .await?;
    if unresolved_accounting != 0 {
        return Err(anyhow!(
            "unresolved mutation accounting intents block provider promotion"
        ));
    }
    if old_backend_generation != expected_backend_generation {
        return Err(anyhow!(
            "storage backend generation changed; refresh and retry"
        ));
    }
    if from_backend_id == target_backend_id {
        return Err(anyhow!("target backend is already active"));
    }

    let target = sqlx::query(
        r#"
        SELECT status, promotion_authorized, replication_checkpoint,
               replication_caught_up_at, last_verified_at, bucket_name,
               bootstrap_state, bootstrap_barrier_sequence,
               bootstrap_verified_at
        FROM storage_region_backends
        WHERE region_id = $1 AND backend_id = $2
        FOR UPDATE
        "#,
    )
    .bind(storage_region)
    .bind(target_backend_id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| anyhow!("target backend is not registered in PostgreSQL"))?;
    let status: String = target.try_get("status")?;
    let authorized: bool = target.try_get("promotion_authorized")?;
    let observed_checkpoint: i64 = target.try_get("replication_checkpoint")?;
    let caught_up_at: Option<chrono::DateTime<chrono::Utc>> =
        target.try_get("replication_caught_up_at")?;
    let last_verified_at: Option<chrono::DateTime<chrono::Utc>> =
        target.try_get("last_verified_at")?;
    let bootstrap_state: String = target.try_get("bootstrap_state")?;
    let bootstrap_barrier: Option<i64> = target.try_get("bootstrap_barrier_sequence")?;
    let bootstrap_verified_at: Option<chrono::DateTime<chrono::Utc>> =
        target.try_get("bootstrap_verified_at")?;
    let bound_bucket: Option<String> = target.try_get("bucket_name")?;
    if let Some(bound_bucket) = bound_bucket {
        if bound_bucket != target_config.bucket {
            return Err(anyhow!(
                "target backend bucket binding does not match configuration"
            ));
        }
    } else {
        let result = sqlx::query(
            r#"
            UPDATE storage_region_backends
            SET bucket_name = $3, updated_at = now()
            WHERE region_id = $1 AND backend_id = $2 AND bucket_name IS NULL
            "#,
        )
        .bind(storage_region)
        .bind(target_backend_id)
        .bind(&target_config.bucket)
        .execute(&mut *tx)
        .await?;
        if result.rows_affected() != 1 {
            return Err(anyhow!("failed to bind target backend bucket"));
        }
    }
    let verification_fresh = last_verified_at.is_some_and(|verified| {
        chrono::Utc::now()
            .signed_duration_since(verified)
            .num_seconds()
            <= state.cfg.backend_verification_max_age_seconds
    });
    let caught_up_fresh = caught_up_at.is_some_and(|caught_up| {
        chrono::Utc::now()
            .signed_duration_since(caught_up)
            .num_seconds()
            <= state.cfg.backend_verification_max_age_seconds
    });
    let bootstrap_fresh = bootstrap_verified_at.is_some_and(|verified| {
        chrono::Utc::now()
            .signed_duration_since(verified)
            .num_seconds()
            <= state.cfg.backend_verification_max_age_seconds
    });
    if status != "standby"
        || !authorized
        || bootstrap_state != "complete"
        || bootstrap_barrier.is_none()
        || !bootstrap_fresh
        || !caught_up_fresh
        || !verification_fresh
        || observed_checkpoint < required_checkpoint.max(bootstrap_barrier.unwrap_or(i64::MAX))
    {
        return Err(anyhow!(
            "target backend is not an authorized, verified, caught-up standby"
        ));
    }

    let target_probe = crate::upstream::signed_backend_request(
        state,
        storage_region,
        target_backend_id,
        Method::HEAD,
        "",
        &HeaderMap::new(),
        None,
    )?;
    let target_healthy =
        tokio::time::timeout(std::time::Duration::from_secs(10), target_probe.send())
            .await
            .ok()
            .and_then(Result::ok)
            .is_some_and(|response| response.status().is_success());
    if !target_healthy {
        return Err(anyhow!("target backend signed readiness probe failed"));
    }
    let writer_still_active = sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM dataplane_writer_lease
          WHERE name = $1 AND holder_id = $2 AND lease_expires_at > now()
        )
        "#,
    )
    .bind(lease_name(storage_region))
    .bind(&state.cfg.writer_instance_id)
    .fetch_one(&mut *tx)
    .await?;
    if !writer_still_active {
        return Err(anyhow!("writer lease expired during target backend probe"));
    }

    let demoted = sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET status = 'standby', updated_at = now()
        WHERE region_id = $1 AND backend_id = $2 AND status = 'active'
        "#,
    )
    .bind(storage_region)
    .bind(&from_backend_id)
    .execute(&mut *tx)
    .await?;
    if demoted.rows_affected() != 1 {
        return Err(anyhow!("current active backend changed before promotion"));
    }
    let promoted = sqlx::query(
        r#"
        UPDATE storage_region_backends
        SET status = 'active', promotion_authorized = false, updated_at = now()
        WHERE region_id = $1 AND backend_id = $2 AND status = 'standby'
        "#,
    )
    .bind(storage_region)
    .bind(target_backend_id)
    .execute(&mut *tx)
    .await?;
    if promoted.rows_affected() != 1 {
        return Err(anyhow!("target backend changed before promotion"));
    }
    let new_backend_generation = old_backend_generation
        .checked_add(1)
        .ok_or_else(|| anyhow!("storage backend generation overflow"))?;
    let state_updated = sqlx::query(
        r#"
        UPDATE storage_region_state
        SET active_backend_id = $2, backend_generation = $3, updated_at = now()
        WHERE region_id = $1 AND backend_generation = $4
        "#,
    )
    .bind(storage_region)
    .bind(target_backend_id)
    .bind(new_backend_generation)
    .bind(old_backend_generation)
    .execute(&mut *tx)
    .await?;
    if state_updated.rows_affected() != 1 {
        return Err(anyhow!("storage region state changed before promotion"));
    }
    sqlx::query(
        r#"
        INSERT INTO storage_backend_promotions
          (region_id, from_backend_id, to_backend_id,
           old_backend_generation, new_backend_generation,
           required_replication_checkpoint, observed_replication_checkpoint,
           actor, reason, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
        "#,
    )
    .bind(storage_region)
    .bind(&from_backend_id)
    .bind(target_backend_id)
    .bind(old_backend_generation)
    .bind(new_backend_generation)
    .bind(required_checkpoint)
    .bind(observed_checkpoint)
    .bind(actor.trim())
    .bind(reason.trim())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    state
        .active_backend_cache
        .write()
        .await
        .remove(storage_region);

    Ok(PromotionResult {
        region: storage_region.to_string(),
        from_backend_id,
        to_backend_id: target_backend_id.to_string(),
        old_backend_generation,
        new_backend_generation,
    })
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
    storage_region: &str,
    backend: &ActiveBackend,
    upload_id: &str,
    generation: i64,
) -> Result<()> {
    state.cfg.regions.ensure_served(storage_region)?;
    sqlx::query(
        r#"
        INSERT INTO multipart_upload_generations
          (upload_id, bucket_id, storage_region, backend_id, backend_generation, writer_generation, created_at)
        VALUES ($1, $2::uuid, $3, $4, $5, $6, now())
        ON CONFLICT (upload_id) DO UPDATE SET
          bucket_id = EXCLUDED.bucket_id,
          storage_region = EXCLUDED.storage_region,
          backend_id = EXCLUDED.backend_id,
          backend_generation = EXCLUDED.backend_generation,
          writer_generation = EXCLUDED.writer_generation,
          created_at = now()
        "#,
    )
    .bind(upload_id)
    .bind(bucket_id)
    .bind(storage_region)
    .bind(&backend.id)
    .bind(backend.generation)
    .bind(generation)
    .execute(&state.pg)
    .await?;
    Ok(())
}

pub(crate) async fn multipart_matches(
    state: &AppState,
    bucket_id: &str,
    storage_region: &str,
    backend: &ActiveBackend,
    upload_id: &str,
    generation: i64,
) -> Result<bool> {
    state.cfg.regions.ensure_served(storage_region)?;
    sqlx::query_scalar::<_, bool>(
        r#"
        SELECT EXISTS (
          SELECT 1 FROM multipart_upload_generations
          WHERE upload_id = $1
            AND bucket_id = $2::uuid
            AND storage_region = $3
            AND backend_id = $4
            AND backend_generation = $5
            AND writer_generation = $6
        )
        "#,
    )
    .bind(upload_id)
    .bind(bucket_id)
    .bind(storage_region)
    .bind(&backend.id)
    .bind(backend.generation)
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

fn lease_name(storage_region: &str) -> String {
    format!("s3:{storage_region}")
}

fn writer_lock_id(storage_region: &str) -> i64 {
    let mut hasher = Sha256::new();
    hasher.update(WRITER_LOCK_DOMAIN);
    hasher.update(storage_region.as_bytes());
    let digest = hasher.finalize();
    i64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 prefix is eight bytes"),
    )
}

fn bucket_lock_id(bucket_id: &str) -> i64 {
    stable_lock_id(BUCKET_LOCK_DOMAIN, bucket_id.as_bytes())
}

fn stable_lock_id(domain: &[u8], identity: &[u8]) -> i64 {
    let mut hasher = Sha256::new();
    hasher.update(domain);
    hasher.update(identity);
    let digest = hasher.finalize();
    i64::from_be_bytes(
        digest[..8]
            .try_into()
            .expect("SHA-256 prefix is eight bytes"),
    )
}

fn bucket_object_gate_lock_id(bucket_id: &str) -> i64 {
    stable_lock_id(BUCKET_OBJECT_GATE_DOMAIN, bucket_id.as_bytes())
}

fn object_lock_id(bucket_id: &str, object_key: &str) -> i64 {
    let mut identity = Vec::with_capacity(bucket_id.len() + object_key.len() + 1);
    identity.extend_from_slice(bucket_id.as_bytes());
    identity.push(0);
    identity.extend_from_slice(object_key.as_bytes());
    stable_lock_id(OBJECT_LOCK_DOMAIN, &identity)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_and_lock_are_independent_per_storage_region() {
        assert_eq!(lease_name("eu-central"), "s3:eu-central");
        assert_eq!(lease_name("us-east"), "s3:us-east");
        assert_ne!(writer_lock_id("eu-central"), writer_lock_id("us-east"));
        assert_eq!(writer_lock_id("eu-central"), writer_lock_id("eu-central"));
        assert_ne!(bucket_lock_id("bucket-a"), bucket_lock_id("bucket-b"));
        assert_eq!(
            object_lock_id("bucket-a", "objects/key"),
            object_lock_id("bucket-a", "objects/key")
        );
        assert_ne!(
            object_lock_id("bucket-a", "objects/key"),
            object_lock_id("bucket-a", "objects/other")
        );
        assert_ne!(
            object_lock_id("bucket-a", "objects/key"),
            object_lock_id("bucket-b", "objects/key")
        );
    }

    #[test]
    fn regional_drain_classification_keeps_reads_available() {
        assert!(is_mutation("PutObject"));
        assert!(is_mutation("DeleteObjects"));
        assert!(!is_mutation("GetObject"));
        assert!(!is_mutation("HeadObject"));
        assert!(!is_mutation("ListObjectsV2"));
    }
}

use anyhow::{Context, Result};
use chrono::Utc;
use tracing::warn;

use crate::{AppState, AuthorizeResponse};

pub(crate) async fn record_request(state: &AppState, auth: &AuthorizeResponse) {
    record(state, auth, 0, 0, true).await;
}

pub(crate) async fn record_ingress(state: &AppState, auth: &AuthorizeResponse, bytes: u64) {
    if bytes > 0 {
        record(state, auth, bytes, 0, false).await;
    }
}

async fn record(
    state: &AppState,
    auth: &AuthorizeResponse,
    ingress: u64,
    egress: u64,
    count_request: bool,
) {
    if let Err(error) = record_inner(state, auth, ingress, egress, count_request).await {
        warn!(error = %error, "dataplane stats write failed");
    }
}

async fn record_inner(
    state: &AppState,
    auth: &AuthorizeResponse,
    ingress: u64,
    egress: u64,
    count_request: bool,
) -> Result<()> {
    if auth.user.is_none() {
        return Ok(());
    }
    // Every region writes through the same idempotent Aiven/fsync-backed
    // accounting path. Dragonfly is deliberately never authoritative.
    record_direct_to_postgres(state, auth, ingress, egress, count_request).await
}

async fn record_direct_to_postgres(
    state: &AppState,
    auth: &AuthorizeResponse,
    ingress: u64,
    egress: u64,
    count_request: bool,
) -> Result<()> {
    let user = auth.user.as_ref().context("missing user for stats")?;
    let ingress = i64::try_from(ingress).context("ingress exceeds bigint")?;
    let egress = i64::try_from(egress).context("egress exceeds bigint")?;
    let requests = i64::from(count_request);
    let period = Utc::now().format("%Y-%m").to_string();
    crate::accounting::record_stats(
        state,
        &user.id,
        auth.bucket.as_ref().map(|bucket| bucket.id.as_str()),
        ingress,
        egress,
        requests,
        period,
    )
    .await
}

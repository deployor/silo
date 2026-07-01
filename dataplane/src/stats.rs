use anyhow::Result;
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

pub(crate) async fn record_egress(state: &AppState, auth: &AuthorizeResponse, bytes: u64) {
    if bytes > 0 {
        record(state, auth, 0, bytes, false).await;
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
    let Some(user) = auth.user.as_ref() else {
        return Ok(());
    };
    let mut pipe = redis::pipe();
    if ingress > 0 {
        pipe.incr(format!("stats:user:{}:ingress", user.id), ingress as i64);
    }
    if egress > 0 {
        pipe.incr(format!("stats:user:{}:egress", user.id), egress as i64);
    }
    if count_request {
        pipe.incr(format!("stats:user:{}:requests", user.id), 1);
        pipe.sadd("stats:active:users", &user.id);
        if let Some(bucket) = auth.bucket.as_ref() {
            pipe.incr(format!("stats:bucket:{}:requests", bucket.id), 1);
            pipe.sadd("stats:active:buckets", &bucket.id);
        }
    } else if ingress > 0 || egress > 0 {
        pipe.sadd("stats:active:users", &user.id);
    }

    let mut conn = state.redis.clone();
    let _: () = pipe.query_async(&mut conn).await?;
    Ok(())
}

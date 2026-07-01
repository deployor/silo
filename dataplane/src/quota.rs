use anyhow::{anyhow, Result};
use chrono::{Datelike, Utc};
use std::collections::HashMap;

use crate::{AppState, AuthUser};

const STORAGE_QUOTA_LUA: &str = r#"
local key = KEYS[1]
local delta = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local seed = tonumber(ARGV[3])

local current = tonumber(redis.call('GET', key))
if current == nil then
  current = seed
  redis.call('SET', key, current)
end

if (current + delta) > limit then
  return {0, current}
end

local nextValue = redis.call('INCRBY', key, delta)
return {1, nextValue}
"#;

const RELEASE_QUOTA_LUA: &str = r#"
local key = KEYS[1]
local delta = tonumber(ARGV[1])
local current = tonumber(redis.call('GET', key))
if current == nil then
  return 0
end
local nextValue = current - delta
if nextValue < 0 then nextValue = 0 end
redis.call('SET', key, nextValue)
return nextValue
"#;

const MPU_QUOTA_LUA: &str = r#"
local quotaKey = KEYS[1]
local mpuKey = KEYS[2]
local partNumber = ARGV[1]
local partSize = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local seed = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])

local existingCredit = tonumber(redis.call('HGET', mpuKey, '__existingCredit') or '0')
local previousPartSize = tonumber(redis.call('HGET', mpuKey, partNumber) or '0')
local previousTotal = tonumber(redis.call('HGET', mpuKey, '__total') or '0')
local nextTotal = previousTotal - previousPartSize + partSize
if nextTotal < 0 then nextTotal = 0 end

local previousReserved = previousTotal - existingCredit
if previousReserved < 0 then previousReserved = 0 end
local nextReserved = nextTotal - existingCredit
if nextReserved < 0 then nextReserved = 0 end
local delta = nextReserved - previousReserved

if delta > 0 then
  local current = tonumber(redis.call('GET', quotaKey))
  if current == nil then
    current = seed
    redis.call('SET', quotaKey, current)
  end
  if (current + delta) > limit then
    return {0, current, previousTotal}
  end
  redis.call('INCRBY', quotaKey, delta)
elseif delta < 0 then
  local current = tonumber(redis.call('GET', quotaKey))
  if current ~= nil then
    local nextValue = current + delta
    if nextValue < 0 then nextValue = 0 end
    redis.call('SET', quotaKey, nextValue)
  end
end

redis.call('HSET', mpuKey, partNumber, partSize, '__total', nextTotal)
redis.call('EXPIRE', mpuKey, ttl)
return {1, nextReserved, nextTotal}
"#;

const RELEASE_MPU_PART_LUA: &str = r#"
local quotaKey = KEYS[1]
local mpuKey = KEYS[2]
local partNumber = ARGV[1]
local ttl = tonumber(ARGV[2])

local existingCredit = tonumber(redis.call('HGET', mpuKey, '__existingCredit') or '0')
local previousPartSize = tonumber(redis.call('HGET', mpuKey, partNumber) or '0')
local previousTotal = tonumber(redis.call('HGET', mpuKey, '__total') or '0')
local nextTotal = previousTotal - previousPartSize
if nextTotal < 0 then nextTotal = 0 end

local previousReserved = previousTotal - existingCredit
if previousReserved < 0 then previousReserved = 0 end
local nextReserved = nextTotal - existingCredit
if nextReserved < 0 then nextReserved = 0 end
local release = previousReserved - nextReserved

if release > 0 then
  local current = tonumber(redis.call('GET', quotaKey))
  if current ~= nil then
    local nextValue = current - release
    if nextValue < 0 then nextValue = 0 end
    redis.call('SET', quotaKey, nextValue)
  end
end

redis.call('HDEL', mpuKey, partNumber)
redis.call('HSET', mpuKey, '__total', nextTotal)
redis.call('EXPIRE', mpuKey, ttl)
return {release, nextTotal}
"#;

fn storage_key(user_id: &str) -> String {
    format!("quota:storage:{user_id}")
}

fn egress_key(user_id: &str) -> String {
    format!("quota:egress:{user_id}:{}", current_egress_period())
}

fn mpu_key(user_id: &str, bucket_id: &str, upload_id: &str) -> String {
    format!("quota:mpu:{user_id}:{bucket_id}:{upload_id}")
}

fn egress_limit(user: &AuthUser) -> Option<u64> {
    if user.is_immortal {
        return None;
    }
    if let Some(limit) = user.egress_limit_bytes {
        if limit == -1 {
            return None;
        }
        return u64::try_from(limit).ok();
    }
    let storage = u64::try_from(user.storage_limit_bytes.unwrap_or(0)).unwrap_or(0);
    Some(std::cmp::max(
        storage.saturating_mul(3),
        10 * 1024 * 1024 * 1024,
    ))
}

pub(crate) async fn reserve_storage(state: &AppState, user: &AuthUser, delta: u64) -> Result<()> {
    if user.is_immortal || delta == 0 {
        return Ok(());
    }
    let limit = user
        .storage_limit_bytes
        .and_then(|v| u64::try_from(v).ok())
        .unwrap_or(0);
    if limit == 0 {
        return Err(anyhow!("storage quota denied"));
    }
    check_and_incr_quota(
        state,
        &storage_key(&user.id),
        delta,
        limit,
        u64::try_from(user.storage_usage_bytes).unwrap_or(0),
        "storage",
    )
    .await
}

pub(crate) async fn reserve_egress(state: &AppState, user: &AuthUser, delta: u64) -> Result<()> {
    let Some(limit) = egress_limit(user) else {
        return Ok(());
    };
    let period = current_egress_period();
    let seed = if user.egress_period.as_deref() == Some(period.as_str()) {
        u64::try_from(user.egress_bytes).unwrap_or(0)
    } else {
        0
    };
    check_and_incr_quota(state, &egress_key(&user.id), delta, limit, seed, "egress").await
}

fn current_egress_period() -> String {
    let now = Utc::now();
    format!("{:04}-{:02}", now.year(), now.month())
}

async fn check_and_incr_quota(
    state: &AppState,
    key: &str,
    delta: u64,
    limit: u64,
    seed: u64,
    label: &str,
) -> Result<()> {
    let mut conn = state.redis.clone();
    let result: Vec<i64> = redis::Script::new(STORAGE_QUOTA_LUA)
        .key(key)
        .arg(delta)
        .arg(limit)
        .arg(seed)
        .invoke_async(&mut conn)
        .await?;
    if result.first().copied() == Some(1) {
        Ok(())
    } else {
        Err(anyhow!("{label} quota exceeded"))
    }
}

pub(crate) async fn release_storage(state: &AppState, user_id: &str, delta: u64) -> Result<()> {
    let mut conn = state.redis.clone();
    let _: i64 = redis::Script::new(RELEASE_QUOTA_LUA)
        .key(storage_key(user_id))
        .arg(delta)
        .invoke_async(&mut conn)
        .await?;
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
    if user.is_immortal {
        return Ok(());
    }
    let limit = user
        .storage_limit_bytes
        .and_then(|v| u64::try_from(v).ok())
        .unwrap_or(0);
    if limit == 0 || bucket_id.is_empty() || upload_id.is_empty() || part_number.is_empty() {
        return Err(anyhow!("multipart quota denied"));
    }

    let mut conn = state.redis.clone();
    let result: Vec<i64> = redis::Script::new(MPU_QUOTA_LUA)
        .key(storage_key(&user.id))
        .key(mpu_key(&user.id, bucket_id, upload_id))
        .arg(part_number)
        .arg(part_size)
        .arg(limit)
        .arg(u64::try_from(user.storage_usage_bytes).unwrap_or(0))
        .arg(7 * 24 * 60 * 60)
        .invoke_async(&mut conn)
        .await?;
    if result.first().copied() == Some(1) {
        Ok(())
    } else {
        Err(anyhow!("multipart quota exceeded"))
    }
}

pub(crate) async fn release_multipart_part(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
    part_number: &str,
) -> Result<()> {
    if bucket_id.is_empty() || upload_id.is_empty() || part_number.is_empty() {
        return Ok(());
    }

    let mut conn = state.redis.clone();
    let _: Vec<i64> = redis::Script::new(RELEASE_MPU_PART_LUA)
        .key(storage_key(user_id))
        .key(mpu_key(user_id, bucket_id, upload_id))
        .arg(part_number)
        .arg(7 * 24 * 60 * 60)
        .invoke_async(&mut conn)
        .await?;
    Ok(())
}

pub(crate) async fn register_multipart_upload(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
    existing_size: u64,
) -> Result<()> {
    if user_id.is_empty() || bucket_id.is_empty() || upload_id.is_empty() {
        return Ok(());
    }
    let mut conn = state.redis.clone();
    let _: () = redis::pipe()
        .hset(
            mpu_key(user_id, bucket_id, upload_id),
            "__existingCredit",
            existing_size,
        )
        .expire(mpu_key(user_id, bucket_id, upload_id), 7 * 24 * 60 * 60)
        .query_async(&mut conn)
        .await?;
    Ok(())
}

pub(crate) async fn clear_multipart_upload(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
) -> Result<()> {
    if user_id.is_empty() || bucket_id.is_empty() || upload_id.is_empty() {
        return Ok(());
    }
    let mut conn = state.redis.clone();
    let _: () = redis::cmd("DEL")
        .arg(mpu_key(user_id, bucket_id, upload_id))
        .query_async(&mut conn)
        .await?;
    Ok(())
}

pub(crate) async fn release_multipart_upload(
    state: &AppState,
    user_id: &str,
    bucket_id: &str,
    upload_id: &str,
) -> Result<()> {
    if user_id.is_empty() || bucket_id.is_empty() || upload_id.is_empty() {
        return Ok(());
    }
    let key = mpu_key(user_id, bucket_id, upload_id);
    let mut conn = state.redis.clone();
    let values: HashMap<String, String> = redis::cmd("HGETALL")
        .arg(&key)
        .query_async(&mut conn)
        .await?;
    let existing_credit = quota_number(values.get("__existingCredit"));
    let mut total = quota_number(values.get("__total"));
    if total == 0 {
        for (field, value) in &values {
            if field != "__existingCredit" && field != "__total" {
                total = total.saturating_add(quota_number(Some(value)));
            }
        }
    }
    let reserved = total.saturating_sub(existing_credit);
    if reserved > 0 {
        release_storage(state, user_id, reserved).await?;
    }
    let mut conn = state.redis.clone();
    let _: () = redis::cmd("DEL").arg(key).query_async(&mut conn).await?;
    Ok(())
}

fn quota_number(value: Option<&String>) -> u64 {
    value
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
}

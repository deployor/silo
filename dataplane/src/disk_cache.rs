use std::{
    collections::{BTreeMap, HashMap},
    env, fs, io,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use axum::{
    body::Body,
    http::{HeaderMap, Response, StatusCode},
};
use bytes::Bytes;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::{mpsc, Mutex},
};
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::ReaderStream;
use tracing::{info, warn};

use crate::{quota::reserve_served_egress, AppState, AuthBucket, AuthorizeResponse};

const REDIS_OBJECT_LIMIT_BYTES: u64 = 10 * 1024 * 1024;
const META_WRITEBACK_MIN_INTERVAL: Duration = Duration::from_secs(30);
const EVICTION_INTERVAL: Duration = Duration::from_secs(120);
const DEMAND_DECAY_INTERVAL: Duration = Duration::from_secs(600);
const EVICTION_LOW_WATERMARK: f64 = 0.70;
const MAX_DEMAND_ENTRIES: usize = 50_000;
const DISK_READ_BUFFER_BYTES: usize = 256 * 1024;

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
pub(crate) struct DiskCache {
    cfg: Arc<DiskCacheConfig>,
    inner: Arc<Mutex<DiskCacheInner>>,
}

#[derive(Clone)]
struct DiskCacheConfig {
    enabled: bool,
    local_region: String,
    dir: PathBuf,
    max_total_size: u64,
    min_size: u64,
    max_file_size: u64,
    base_admission_hits: u64,
    max_entry_age: Duration,
}

struct DiskCacheInner {
    writable: bool,
    total_size: u64,
    demand: HashMap<String, DemandEntry>,
    last_meta_writeback: HashMap<String, SystemTime>,
}

#[derive(Clone)]
struct DemandEntry {
    hits: u64,
    last_hit: SystemTime,
    size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheMeta {
    etag: String,
    content_type: String,
    size: u64,
    headers: BTreeMap<String, String>,
    cached_at_ms: u64,
    last_access_ms: u64,
    hit_count: u64,
    bucket: String,
    key: String,
}

struct EvictionCandidate {
    hash: String,
    blob_path: PathBuf,
    meta_path: PathBuf,
    meta: CacheMeta,
    score: f64,
}

#[derive(Clone, Copy)]
struct ByteRange {
    start: u64,
    end: u64,
}

impl DiskCache {
    pub(crate) fn from_env(emergency_mode: bool, local_region: &str) -> Result<Self> {
        let cfg = DiskCacheConfig {
            enabled: !emergency_mode
                && env::var("DISK_CACHE_ENABLED").map_or(true, |v| v != "false"),
            local_region: local_region.to_string(),
            dir: cache_dir(),
            max_total_size: env_u64("DISK_CACHE_MAX_TOTAL_SIZE", 20 * 1024 * 1024 * 1024),
            min_size: env_u64("DISK_CACHE_MIN_SIZE", REDIS_OBJECT_LIMIT_BYTES),
            max_file_size: env_u64("DISK_CACHE_MAX_FILE_SIZE", 2 * 1024 * 1024 * 1024),
            base_admission_hits: env_u64("DISK_CACHE_ADMISSION_HITS", 2),
            max_entry_age: Duration::from_millis(env_u64(
                "DISK_CACHE_MAX_ENTRY_AGE_MS",
                12 * 60 * 60 * 1000,
            )),
        };

        let writable = if cfg.enabled {
            ensure_writable(&cfg.dir)
        } else {
            false
        };
        let total_size = if cfg.enabled && writable {
            scan_cache_size(&cfg.dir)
        } else {
            0
        };
        let cache = Self {
            cfg: Arc::new(cfg),
            inner: Arc::new(Mutex::new(DiskCacheInner {
                writable,
                total_size,
                demand: HashMap::new(),
                last_meta_writeback: HashMap::new(),
            })),
        };
        if cache.cfg.enabled {
            info!(
                dir = %cache.cfg.dir.display(),
                total_size,
                max_total_size = cache.cfg.max_total_size,
                writable,
                "disk cache initialized"
            );
        }
        Ok(cache)
    }

    pub(crate) fn start_background_tasks(&self) {
        if !self.cfg.enabled {
            return;
        }

        let eviction_cache = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(EVICTION_INTERVAL);
            loop {
                interval.tick().await;
                if let Err(error) = eviction_cache.run_eviction().await {
                    warn!(error = %error, "disk cache eviction failed");
                }
            }
        });

        let demand_cache = self.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(DEMAND_DECAY_INTERVAL);
            loop {
                interval.tick().await;
                demand_cache.decay_demand().await;
            }
        });
    }

    pub(crate) fn min_size(&self) -> u64 {
        self.cfg.min_size
    }

    pub(crate) async fn record_demand(&self, bucket: &AuthBucket, key: &str, size_hint: u64) {
        if !self.cache_local_bucket(bucket) {
            return;
        }
        let mut inner = self.inner.lock().await;
        if !inner.writable {
            return;
        }

        let demand_key = demand_key(&bucket.id, key);
        if let Some(entry) = inner.demand.get_mut(&demand_key) {
            entry.hits = entry.hits.saturating_add(1);
            entry.last_hit = SystemTime::now();
            if size_hint > 0 {
                entry.size = size_hint;
            }
            return;
        }

        if inner.demand.len() >= MAX_DEMAND_ENTRIES {
            if let Some(oldest) = inner
                .demand
                .iter()
                .min_by_key(|(_, entry)| entry.last_hit)
                .map(|(key, _)| key.clone())
            {
                inner.demand.remove(&oldest);
            }
        }
        inner.demand.insert(
            demand_key,
            DemandEntry {
                hits: 1,
                last_hit: SystemTime::now(),
                size: size_hint,
            },
        );
    }

    pub(crate) async fn get_response(
        &self,
        state: &AppState,
        auth: &AuthorizeResponse,
        headers: &HeaderMap,
        bucket: &AuthBucket,
        key: &str,
    ) -> Result<Option<Response<Body>>> {
        if !self.cache_local_bucket(bucket) || !self.is_enabled_and_writable().await {
            return Ok(None);
        }

        let Some(hash) = self.cache_hash(bucket, key) else {
            return Ok(None);
        };
        let blob_path = self.blob_path(&hash);
        let meta_path = self.meta_path(&hash);
        let Some(mut meta) = self.read_valid_meta(&hash, &blob_path, &meta_path).await? else {
            return Ok(None);
        };

        if if_none_match_matches(headers, &meta.headers) {
            self.record_hit(&hash, &blob_path, &meta_path, &mut meta)
                .await;
            let mut builder = Response::builder().status(StatusCode::NOT_MODIFIED);
            if let Some(etag) = header_value_case_insensitive(&meta.headers, "etag") {
                builder = builder.header("etag", etag);
            }
            if let Some(last_modified) =
                header_value_case_insensitive(&meta.headers, "last-modified")
            {
                builder = builder.header("last-modified", last_modified);
            }
            return Ok(Some(
                builder.header("x-cache", "DISK-HIT").body(Body::empty())?,
            ));
        }

        self.record_hit(&hash, &blob_path, &meta_path, &mut meta)
            .await;
        self.record_demand(bucket, key, meta.size).await;

        if let Some(range_header) = header_value(headers, axum::http::header::RANGE.as_str()) {
            return self
                .range_response(state, auth, &blob_path, &meta, range_header)
                .await
                .map(Some);
        }
        self.full_response(state, auth, &blob_path, &meta)
            .await
            .map(Some)
    }

    pub(crate) async fn get_meta_response(
        &self,
        bucket: &AuthBucket,
        key: &str,
    ) -> Result<Option<Response<Body>>> {
        if !self.cache_local_bucket(bucket) || !self.is_enabled_and_writable().await {
            return Ok(None);
        }
        let Some(hash) = self.cache_hash(bucket, key) else {
            return Ok(None);
        };
        let blob_path = self.blob_path(&hash);
        let meta_path = self.meta_path(&hash);
        let Some(mut meta) = self.read_valid_meta(&hash, &blob_path, &meta_path).await? else {
            return Ok(None);
        };
        self.record_hit(&hash, &blob_path, &meta_path, &mut meta)
            .await;
        self.record_demand(bucket, key, meta.size).await;

        let mut builder = Response::builder().status(StatusCode::OK);
        for (key, value) in &meta.headers {
            builder = builder.header(key, value);
        }
        Ok(Some(
            builder.header("x-cache", "DISK-HIT").body(Body::empty())?,
        ))
    }

    pub(crate) async fn object_size(&self, bucket: &AuthBucket, key: &str) -> Option<u64> {
        if !self.cache_local_bucket(bucket) || !self.is_enabled_and_writable().await {
            return None;
        }
        let hash = self.cache_hash(bucket, key)?;
        let blob_path = self.blob_path(&hash);
        let meta_path = self.meta_path(&hash);
        self.read_valid_meta(&hash, &blob_path, &meta_path)
            .await
            .ok()
            .flatten()
            .map(|meta| meta.size)
    }

    pub(crate) async fn stream_and_cache_response(
        &self,
        res: reqwest::Response,
        bucket: &AuthBucket,
        key: &str,
        content_length: u64,
    ) -> Result<Response<Body>> {
        let status = StatusCode::from_u16(res.status().as_u16())?;
        let headers = response_headers(res.headers());
        let hash = self
            .cache_hash(bucket, key)
            .ok_or_else(|| anyhow!("disk cache attempted for an unresolved or remote backend"))?;
        let blob_path = self.blob_path(&hash);
        let meta_path = self.meta_path(&hash);
        let tmp_suffix = format!(
            "{}.{}.{}",
            std::process::id(),
            now_ms(),
            TMP_COUNTER.fetch_add(1, Ordering::Relaxed),
        );
        let tmp_blob = blob_path.with_extension(format!("blob.tmp.{tmp_suffix}"));
        let tmp_meta = meta_path.with_extension(format!("meta.tmp.{tmp_suffix}"));
        ensure_parent_dir(&blob_path).await?;

        let (tx, rx) = mpsc::channel::<Result<Bytes, io::Error>>(32);
        let response_headers = headers.clone();
        let cache = self.clone();
        let bucket_id = bucket.id.clone();
        let key = key.to_string();
        tokio::spawn(async move {
            if let Err(error) = cache
                .write_through(
                    res,
                    tx,
                    WriteThroughTarget {
                        bucket_id,
                        key,
                        blob_path,
                        meta_path,
                        tmp_blob,
                        tmp_meta,
                        headers,
                        content_length,
                    },
                )
                .await
            {
                warn!(error = %error, "disk cache write-through failed");
            }
        });

        let mut builder = Response::builder()
            .status(status)
            .header("content-length", content_length.to_string())
            .header("x-cache", "MISS-CACHE-FILL");
        for (key, value) in response_headers {
            if !header_name_eq(&key, "content-length") {
                builder = builder.header(key, value);
            }
        }
        Ok(builder.body(Body::from_stream(ReceiverStream::new(rx)))?)
    }

    pub(crate) async fn should_admit(&self, bucket: &AuthBucket, key: &str, size: u64) -> bool {
        if !self.cache_local_bucket(bucket)
            || !self.is_eligible(size)
            || !self.is_enabled_and_writable().await
        {
            return false;
        }
        let mut inner = self.inner.lock().await;
        let pressure = cache_pressure(&inner, self.cfg.max_total_size);
        let threshold = admission_threshold(self.cfg.base_admission_hits, pressure);
        let hits = inner
            .demand
            .get(&demand_key(&bucket.id, key))
            .map(|entry| entry.hits)
            .unwrap_or(0);
        if hits < threshold {
            return false;
        }

        if inner.total_size.saturating_add(size) > (self.cfg.max_total_size as f64 * 1.1) as u64 {
            drop(inner);
            if let Err(error) = self.run_eviction().await {
                warn!(error = %error, "disk cache pre-admission eviction failed");
            }
            inner = self.inner.lock().await;
            if inner.total_size.saturating_add(size) > self.cfg.max_total_size {
                return false;
            }
        }
        true
    }

    pub(crate) async fn invalidate(&self, bucket: &AuthBucket, key: &str) {
        if !self.cache_local_bucket(bucket) {
            return;
        }
        let Some(hash) = self.cache_hash(bucket, key) else {
            return;
        };
        let size = fs::metadata(self.blob_path(&hash))
            .map(|m| m.len())
            .unwrap_or(0);
        self.evict_hash(&hash, size).await;
    }

    fn is_eligible(&self, size: u64) -> bool {
        self.cfg.enabled && size >= self.cfg.min_size && size <= self.cfg.max_file_size
    }

    async fn is_enabled_and_writable(&self) -> bool {
        if !self.cfg.enabled {
            return false;
        }
        self.inner.lock().await.writable
    }

    fn cache_local_bucket(&self, bucket: &AuthBucket) -> bool {
        self.cfg.enabled
            && bucket.resolved_region == self.cfg.local_region
            && bucket.active_backend.is_some()
    }

    fn cache_hash(&self, bucket: &AuthBucket, key: &str) -> Option<String> {
        let backend = bucket.active_backend.as_ref()?;
        Some(hash_key(
            &self.cfg.local_region,
            &bucket.resolved_region,
            &backend.id,
            backend.generation,
            bucket.writer_generation?,
            &bucket.id,
            key,
        ))
    }

    async fn read_valid_meta(
        &self,
        hash: &str,
        blob_path: &Path,
        meta_path: &Path,
    ) -> Result<Option<CacheMeta>> {
        if tokio::fs::metadata(blob_path).await.is_err()
            || tokio::fs::metadata(meta_path).await.is_err()
        {
            return Ok(None);
        }
        let raw = match tokio::fs::read_to_string(meta_path).await {
            Ok(raw) => raw,
            Err(_) => return Ok(None),
        };
        let meta = match serde_json::from_str::<CacheMeta>(&raw) {
            Ok(meta) => meta,
            Err(_) => {
                self.evict_hash(hash, 0).await;
                return Ok(None);
            }
        };
        if self.is_expired(&meta) {
            self.evict_hash(hash, meta.size).await;
            return Ok(None);
        }
        Ok(Some(meta))
    }

    async fn record_hit(
        &self,
        hash: &str,
        _blob_path: &Path,
        meta_path: &Path,
        meta: &mut CacheMeta,
    ) {
        meta.hit_count = meta.hit_count.saturating_add(1);
        meta.last_access_ms = now_ms();

        let mut inner = self.inner.lock().await;
        let should_write = inner
            .last_meta_writeback
            .get(hash)
            .and_then(|last| last.elapsed().ok())
            .is_none_or(|elapsed| elapsed >= META_WRITEBACK_MIN_INTERVAL);
        if should_write {
            inner
                .last_meta_writeback
                .insert(hash.to_string(), SystemTime::now());
            let meta_path = meta_path.to_path_buf();
            let meta = meta.clone();
            tokio::spawn(async move {
                if let Ok(raw) = serde_json::to_vec(&meta) {
                    let _ = tokio::fs::write(meta_path, raw).await;
                }
            });
        }
        drop(inner);
    }

    async fn full_response(
        &self,
        state: &AppState,
        auth: &AuthorizeResponse,
        blob_path: &Path,
        meta: &CacheMeta,
    ) -> Result<Response<Body>> {
        if let Some(quota_response) = reserve_disk_hit_egress(state, auth, meta.size).await? {
            return Ok(quota_response);
        }
        let file = File::open(blob_path).await?;
        let stream = ReaderStream::with_capacity(file, DISK_READ_BUFFER_BYTES);
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header("content-length", meta.size.to_string())
            .header("accept-ranges", "bytes")
            .header("x-cache", "DISK-HIT");
        for (key, value) in &meta.headers {
            if !header_name_eq(key, "content-length") && !header_name_eq(key, "content-range") {
                builder = builder.header(key, value);
            }
        }
        Ok(builder.body(Body::from_stream(stream))?)
    }

    async fn range_response(
        &self,
        state: &AppState,
        auth: &AuthorizeResponse,
        blob_path: &Path,
        meta: &CacheMeta,
        range_header: &str,
    ) -> Result<Response<Body>> {
        let Some(range) = parse_range_header(range_header, meta.size) else {
            return Ok(Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header("content-range", format!("bytes */{}", meta.size))
                .body(Body::empty())?);
        };
        let bytes_to_send = range.end - range.start + 1;
        if let Some(quota_response) = reserve_disk_hit_egress(state, auth, bytes_to_send).await? {
            return Ok(quota_response);
        }
        let mut file = File::open(blob_path).await?;
        file.seek(std::io::SeekFrom::Start(range.start)).await?;
        let stream = ReaderStream::with_capacity(file.take(bytes_to_send), DISK_READ_BUFFER_BYTES);

        let mut builder = Response::builder()
            .status(StatusCode::PARTIAL_CONTENT)
            .header("content-length", bytes_to_send.to_string())
            .header(
                "content-range",
                format!("bytes {}-{}/{}", range.start, range.end, meta.size),
            )
            .header("accept-ranges", "bytes")
            .header("x-cache", "DISK-HIT");
        for (key, value) in &meta.headers {
            if !header_name_eq(key, "content-length") && !header_name_eq(key, "content-range") {
                builder = builder.header(key, value);
            }
        }

        Ok(builder.body(Body::from_stream(stream))?)
    }

    async fn write_through(
        &self,
        res: reqwest::Response,
        tx: mpsc::Sender<Result<Bytes, io::Error>>,
        target: WriteThroughTarget,
    ) -> Result<()> {
        let mut bytes_written = 0u64;
        let mut stream = res.bytes_stream();
        let (disk_tx, mut disk_rx) = mpsc::channel::<Bytes>(64);
        let tmp_blob = target.tmp_blob.clone();
        let disk_writer = tokio::spawn(async move {
            let mut file = File::create(&tmp_blob).await?;
            let mut written = 0u64;
            while let Some(chunk) = disk_rx.recv().await {
                written = written.saturating_add(chunk.len() as u64);
                file.write_all(&chunk).await?;
            }
            file.flush().await?;
            Ok::<u64, io::Error>(written)
        });

        while let Some(chunk) = stream.next().await {
            let chunk = match chunk {
                Ok(chunk) => chunk,
                Err(error) => {
                    disk_writer.abort();
                    self.remove_tmp(&target).await;
                    return Err(io::Error::other(error).into());
                }
            };
            bytes_written = bytes_written.saturating_add(chunk.len() as u64);
            if bytes_written > target.content_length.saturating_add(1024) {
                disk_writer.abort();
                return self
                    .abort_write(&target, "disk cache response exceeded Content-Length")
                    .await;
            }
            let disk_chunk = chunk.clone();
            if tx.send(Ok(chunk)).await.is_err() {
                disk_writer.abort();
                self.remove_tmp(&target).await;
                return Ok(());
            }
            if disk_tx.send(disk_chunk).await.is_err() {
                disk_writer.abort();
                return self.abort_write(&target, "disk cache writer stopped").await;
            }
        }
        drop(disk_tx);

        let disk_bytes = disk_writer
            .await
            .map_err(|error| anyhow!("disk cache writer join failed: {error}"))?
            .map_err(|error| anyhow!("disk cache writer failed: {error}"))?;
        if bytes_written != target.content_length {
            return self
                .abort_write(&target, "disk cache response size mismatch")
                .await;
        }
        if disk_bytes != bytes_written {
            return self
                .abort_write(&target, "disk cache writer size mismatch")
                .await;
        }

        let previous_size = fs::metadata(&target.blob_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let demand_hits = {
            let inner = self.inner.lock().await;
            inner
                .demand
                .get(&demand_key(&target.bucket_id, &target.key))
                .map(|entry| entry.hits)
                .unwrap_or(1)
        };
        let meta = CacheMeta {
            etag: header_value_case_insensitive(&target.headers, "etag").unwrap_or_default(),
            content_type: header_value_case_insensitive(&target.headers, "content-type")
                .unwrap_or_else(|| "application/octet-stream".to_string()),
            size: bytes_written,
            headers: target.headers,
            cached_at_ms: now_ms(),
            last_access_ms: now_ms(),
            hit_count: demand_hits,
            bucket: target.bucket_id,
            key: target.key,
        };

        tokio::fs::write(&target.tmp_meta, serde_json::to_vec(&meta)?).await?;
        tokio::fs::rename(&target.tmp_blob, &target.blob_path).await?;
        tokio::fs::rename(&target.tmp_meta, &target.meta_path).await?;

        let mut inner = self.inner.lock().await;
        inner.total_size = inner
            .total_size
            .saturating_sub(previous_size)
            .saturating_add(bytes_written);
        drop(inner);

        let cache = self.clone();
        tokio::spawn(async move {
            if let Err(error) = cache.run_eviction().await {
                warn!(error = %error, "disk cache post-write eviction failed");
            }
        });
        Ok(())
    }

    async fn abort_write(&self, target: &WriteThroughTarget, message: &str) -> Result<()> {
        self.remove_tmp(target).await;
        Err(anyhow!(message.to_string()))
    }

    async fn remove_tmp(&self, target: &WriteThroughTarget) {
        let _ = tokio::fs::remove_file(&target.tmp_blob).await;
        let _ = tokio::fs::remove_file(&target.tmp_meta).await;
    }

    async fn evict_hash(&self, hash: &str, size: u64) {
        let _ = tokio::fs::remove_file(self.blob_path(hash)).await;
        let _ = tokio::fs::remove_file(self.meta_path(hash)).await;
        let mut inner = self.inner.lock().await;
        inner.total_size = inner.total_size.saturating_sub(size);
        inner.last_meta_writeback.remove(hash);
    }

    async fn run_eviction(&self) -> Result<()> {
        if !self.is_enabled_and_writable().await {
            return Ok(());
        }
        let mut candidates = Vec::new();
        let mut reclaimed = 0u64;
        let mut evicted = 0usize;
        let now = now_ms();

        for entry in fs::read_dir(&self.cfg.dir)
            .with_context(|| format!("failed to scan disk cache dir {}", self.cfg.dir.display()))?
        {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            for meta_entry in fs::read_dir(entry.path())? {
                let meta_entry = meta_entry?;
                let meta_path = meta_entry.path();
                if meta_path.extension().and_then(|e| e.to_str()) != Some("meta") {
                    continue;
                }
                let Some(hash) = meta_path.file_stem().and_then(|s| s.to_str()) else {
                    continue;
                };
                let blob_path = self.blob_path(hash);
                let raw = match fs::read_to_string(&meta_path) {
                    Ok(raw) => raw,
                    Err(_) => {
                        let _ = fs::remove_file(&blob_path);
                        let _ = fs::remove_file(&meta_path);
                        continue;
                    }
                };
                let meta = match serde_json::from_str::<CacheMeta>(&raw) {
                    Ok(meta) => meta,
                    Err(_) => {
                        let _ = fs::remove_file(&blob_path);
                        let _ = fs::remove_file(&meta_path);
                        continue;
                    }
                };
                if is_expired_meta(&meta, now, self.cfg.max_entry_age) {
                    let _ = fs::remove_file(&blob_path);
                    let _ = fs::remove_file(&meta_path);
                    reclaimed = reclaimed.saturating_add(meta.size);
                    evicted += 1;
                    continue;
                }
                candidates.push(EvictionCandidate {
                    hash: hash.to_string(),
                    blob_path,
                    meta_path,
                    score: heat_score(&meta, now),
                    meta,
                });
            }
        }

        let mut inner = self.inner.lock().await;
        inner.total_size = inner.total_size.saturating_sub(reclaimed);
        if inner.total_size <= self.cfg.max_total_size {
            drop(inner);
            if evicted > 0 {
                info!(evicted, reclaimed, "disk cache evicted stale entries");
            }
            return Ok(());
        }

        let target = (self.cfg.max_total_size as f64 * EVICTION_LOW_WATERMARK) as u64;
        candidates.sort_by(|a, b| a.score.total_cmp(&b.score));
        let mut reclaimed_cold = 0u64;
        let mut evicted_cold = 0usize;
        for candidate in candidates {
            if inner.total_size.saturating_sub(reclaimed_cold) <= target {
                break;
            }
            let _ = fs::remove_file(candidate.blob_path);
            let _ = fs::remove_file(candidate.meta_path);
            inner.last_meta_writeback.remove(&candidate.hash);
            reclaimed_cold = reclaimed_cold.saturating_add(candidate.meta.size);
            evicted_cold += 1;
        }
        inner.total_size = inner.total_size.saturating_sub(reclaimed_cold);
        drop(inner);

        if evicted + evicted_cold > 0 {
            info!(
                evicted = evicted + evicted_cold,
                reclaimed = reclaimed + reclaimed_cold,
                "disk cache eviction completed"
            );
        }
        Ok(())
    }

    async fn decay_demand(&self) {
        let mut inner = self.inner.lock().await;
        let now = SystemTime::now();
        inner.demand.retain(|_, entry| {
            entry.hits /= 2;
            entry.hits > 0
                || now
                    .duration_since(entry.last_hit)
                    .map_or(true, |age| age < DEMAND_DECAY_INTERVAL * 2)
        });
    }

    fn blob_path(&self, hash: &str) -> PathBuf {
        self.cfg.dir.join(&hash[..2]).join(format!("{hash}.blob"))
    }

    fn meta_path(&self, hash: &str) -> PathBuf {
        self.cfg.dir.join(&hash[..2]).join(format!("{hash}.meta"))
    }

    fn is_expired(&self, meta: &CacheMeta) -> bool {
        is_expired_meta(meta, now_ms(), self.cfg.max_entry_age)
    }
}

struct WriteThroughTarget {
    bucket_id: String,
    key: String,
    blob_path: PathBuf,
    meta_path: PathBuf,
    tmp_blob: PathBuf,
    tmp_meta: PathBuf,
    headers: BTreeMap<String, String>,
    content_length: u64,
}

pub(crate) async fn reserve_disk_hit_egress(
    state: &crate::AppState,
    auth: &AuthorizeResponse,
    bytes: u64,
) -> Result<Option<Response<Body>>> {
    reserve_served_egress(state, auth, bytes).await
}

fn response_headers(headers: &reqwest::header::HeaderMap) -> BTreeMap<String, String> {
    headers
        .iter()
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|value| (name.as_str().to_string(), value.to_string()))
        })
        .collect()
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn cache_dir() -> PathBuf {
    if let Ok(dir) = env::var("DISK_CACHE_DIR") {
        return PathBuf::from(dir);
    }
    if env::var("NODE_ENV").ok().as_deref() == Some("production") {
        PathBuf::from("/tmp/s3-disk-cache")
    } else {
        env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(".s3-disk-cache")
    }
}

fn ensure_writable(dir: &Path) -> bool {
    fs::create_dir_all(dir)
        .and_then(|_| {
            let probe = dir.join(".write-test");
            fs::write(&probe, b"ok")?;
            fs::remove_file(probe)
        })
        .is_ok()
}

fn scan_cache_size(dir: &Path) -> u64 {
    let Ok(prefixes) = fs::read_dir(dir) else {
        return 0;
    };
    let mut total = 0u64;
    for prefix in prefixes.flatten() {
        let Ok(file_type) = prefix.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Ok(files) = fs::read_dir(prefix.path()) else {
            continue;
        };
        for file in files.flatten() {
            if file.path().extension().and_then(|e| e.to_str()) == Some("blob") {
                if let Ok(meta) = file.metadata() {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    total
}

async fn ensure_parent_dir(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    Ok(())
}

fn demand_key(bucket_id: &str, key: &str) -> String {
    format!("{bucket_id}\0{key}")
}

fn hash_key(
    local_region: &str,
    storage_region: &str,
    backend_id: &str,
    backend_generation: i64,
    writer_generation: i64,
    bucket_id: &str,
    key: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(local_region.as_bytes());
    hasher.update(b":");
    hasher.update(storage_region.as_bytes());
    hasher.update(b":");
    hasher.update(backend_id.as_bytes());
    hasher.update(b":");
    hasher.update(backend_generation.to_string().as_bytes());
    hasher.update(b":");
    hasher.update(writer_generation.to_string().as_bytes());
    hasher.update(b":");
    hasher.update(bucket_id.as_bytes());
    hasher.update(b":");
    hasher.update(key.as_bytes());
    hex::encode(hasher.finalize())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn cache_pressure(inner: &DiskCacheInner, max_total_size: u64) -> f64 {
    if max_total_size == 0 {
        return 1.0;
    }
    inner.total_size as f64 / max_total_size as f64
}

fn admission_threshold(base: u64, pressure: f64) -> u64 {
    if pressure > 0.9 {
        base.saturating_mul(3)
    } else if pressure > 0.7 {
        base.saturating_mul(2)
    } else {
        base
    }
}

fn is_expired_meta(meta: &CacheMeta, now: u64, max_age: Duration) -> bool {
    now.saturating_sub(meta.cached_at_ms) > max_age.as_millis() as u64
}

fn heat_score(meta: &CacheMeta, now: u64) -> f64 {
    let age_ms = now.saturating_sub(meta.last_access_ms).max(1) as f64;
    let recency_boost = 0.5_f64.powf(age_ms / (30.0 * 60.0 * 1000.0));
    let size_cost = ((meta.size as f64 / (1024.0 * 1024.0)) + 1.0).log2() + 1.0;
    meta.hit_count as f64 * recency_boost * size_cost
}

fn header_value<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(key, _)| key.as_str().eq_ignore_ascii_case(name))
        .and_then(|(_, value)| value.to_str().ok())
}

fn header_value_case_insensitive(headers: &BTreeMap<String, String>, name: &str) -> Option<String> {
    headers
        .iter()
        .find(|(key, _)| header_name_eq(key, name))
        .map(|(_, value)| value.clone())
}

fn header_name_eq(left: &str, right: &str) -> bool {
    left.eq_ignore_ascii_case(right)
}

fn if_none_match_matches(headers: &HeaderMap, meta: &BTreeMap<String, String>) -> bool {
    let Some(if_none_match) = header_value(headers, axum::http::header::IF_NONE_MATCH.as_str())
    else {
        return false;
    };
    if if_none_match.trim() == "*" {
        return true;
    }
    let Some(etag) = header_value_case_insensitive(meta, "etag") else {
        return false;
    };
    let normalized_etag = normalize_etag(&etag);
    if_none_match
        .split(',')
        .map(str::trim)
        .any(|candidate| normalize_etag(candidate) == normalized_etag)
}

fn normalize_etag(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("W/")
        .trim_matches('"')
        .to_string()
}

fn parse_range_header(range_header: &str, total_size: u64) -> Option<ByteRange> {
    if total_size == 0 {
        return None;
    }
    let range = range_header.strip_prefix("bytes=")?;
    if range.contains(',') {
        return None;
    }
    let (start_raw, end_raw) = range.split_once('-')?;
    if start_raw.is_empty() && end_raw.is_empty() {
        return None;
    }

    let (start, mut end) = if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<u64>().ok()?;
        if suffix_len == 0 {
            return None;
        }
        (total_size.saturating_sub(suffix_len), total_size - 1)
    } else {
        let start = start_raw.parse::<u64>().ok()?;
        let end = if end_raw.is_empty() {
            total_size - 1
        } else {
            end_raw.parse::<u64>().ok()?
        };
        (start, end)
    };

    if start >= total_size || start > end {
        return None;
    }
    end = end.min(total_size - 1);
    Some(ByteRange { start, end })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_disk_cache_ranges() {
        let range = parse_range_header("bytes=10-19", 100).unwrap();
        assert_eq!((range.start, range.end), (10, 19));

        let range = parse_range_header("bytes=-10", 100).unwrap();
        assert_eq!((range.start, range.end), (90, 99));

        assert!(parse_range_header("bytes=100-101", 100).is_none());
        assert!(parse_range_header("bytes=1-2,3-4", 100).is_none());
    }

    #[test]
    fn admission_threshold_rises_under_pressure() {
        assert_eq!(admission_threshold(2, 0.1), 2);
        assert_eq!(admission_threshold(2, 0.8), 4);
        assert_eq!(admission_threshold(2, 0.95), 6);
    }

    #[test]
    fn writer_transfer_changes_disk_cache_namespace() {
        let before = hash_key("eu", "eu", "b2-eu", 4, 12, "bucket", "key");
        let after = hash_key("eu", "eu", "b2-eu", 4, 13, "bucket", "key");
        assert_ne!(before, after);
    }
}

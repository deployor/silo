CREATE DATABASE IF NOT EXISTS silo_logs;

CREATE TABLE IF NOT EXISTS silo_logs.request_logs
(
    event_time DateTime64(3, 'UTC') CODEC(Delta, ZSTD(1)),
    ingested_at DateTime64(3, 'UTC') DEFAULT now64(3) CODEC(Delta, ZSTD(1)),
    request_id UUID,
    region LowCardinality(String),
    service LowCardinality(String),
    instance LowCardinality(String),
    storage_region LowCardinality(String),
    action LowCardinality(String),
    bucket_id String CODEC(ZSTD(1)),
    bucket_name String CODEC(ZSTD(1)),
    owner_id String CODEC(ZSTD(1)),
    requester_id String CODEC(ZSTD(1)),
    method LowCardinality(String),
    path String CODEC(ZSTD(3)),
    status_code UInt16,
    ingress_bytes UInt64,
    egress_bytes UInt64,
    latency_ms UInt32,
    ip_address String CODEC(ZSTD(1)),
    user_agent String CODEC(ZSTD(3)),
    version UInt64 DEFAULT toUnixTimestamp64Milli(ingested_at),
    INDEX request_id_bloom request_id TYPE bloom_filter(0.001) GRANULARITY 1,
    INDEX path_tokens path TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 4,
    INDEX owner_bloom owner_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX requester_bloom requester_id TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX ip_bloom ip_address TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(version)
PARTITION BY toYYYYMM(event_time)
ORDER BY (bucket_name, event_time, request_id)
TTL event_time + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE IF NOT EXISTS silo_logs.ingest_heartbeats
(
    observed_at DateTime64(3, 'UTC'),
    source_region LowCardinality(String),
    collector_instance LowCardinality(String),
    event_id UUID
)
ENGINE = ReplacingMergeTree
ORDER BY (source_region, observed_at, event_id)
TTL observed_at + INTERVAL 7 DAY DELETE;

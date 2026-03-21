/**
 * Smart Disk Cache — Adaptive L2 cache tier for S3 objects.
 *
 * This is NOT a dumb LRU. It uses demand-driven admission + hybrid
 * LFU/LRU eviction to maximize cache hit value per byte of disk used.
 *
 * Architecture:
 *  ┌──────────────┐     miss     ┌───────────┐     miss     ┌────────┐
 *  │   Client     │ ──────────→  │  Redis L1  │ ──────────→  │  S3    │
 *  │   Request    │              │  (≤10 MB)  │              │ Origin │
 *  └──────────────┘              └───────────┘              └────────┘
 *         ↕ hit                        ↕ hit                    │
 *  ┌──────────────┐              ┌───────────┐                  │
 *  │  Response    │ ←── stream ──│ Disk L2   │ ←── populate ────┘
 *  └──────────────┘              │ (≤10 GB)  │  (if hot enough)
 *                                └───────────┘
 *
 * Key behaviors:
 *  1. DEMAND TRACKING: Every GET increments an in-memory heat counter.
 *     Objects must reach a configurable hit threshold before being
 *     admitted to disk. One-off downloads never waste cache space.
 *
 *  2. HEAT SCORING: score = hitCount × recencyBoost × sizeCostFactor
 *     - hitCount: raw access frequency
 *     - recencyBoost: exponential decay from last access time
 *     - sizeCostFactor: larger objects get a bonus because they're
 *       more expensive to re-fetch (saves more latency per eviction)
 *
 *  3. SMART EVICTION: When budget exceeded, evict coldest entries
 *     (lowest heat score) until we're at 70% capacity. This prevents
 *     thrashing at the boundary.
 *
 *  4. ADAPTIVE ADMISSION: The hit threshold auto-adjusts based on
 *     cache pressure. When cache is >90% full, threshold increases
 *     so only truly hot objects get admitted.
 *
 *  5. INTEGRITY: ETag-based validation, atomic writes (tmp+rename),
 *     streaming reads (never loads whole files into memory).
 *
 *  6. ZERO CLUTTER: Content-addressable storage with 2-char prefix
 *     sharding. Periodic background sweeps. Self-managing.
 */

import { createHash } from "node:crypto";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readdirSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Configuration (all tunable via env)
// ---------------------------------------------------------------------------

/** Total disk budget (default 20 GB). */
const MAX_TOTAL_SIZE =
	parseInt(process.env.DISK_CACHE_MAX_TOTAL_SIZE || "", 10) ||
	20 * 1024 * 1024 * 1024;

/** Minimum object size to even consider (default 10 MB). Below this Redis handles it fine. */
const MIN_SIZE =
	parseInt(process.env.DISK_CACHE_MIN_SIZE || "", 10) || 10 * 1024 * 1024;

/** Maximum single file size (default 2 GB). */
const MAX_FILE_SIZE =
	parseInt(process.env.DISK_CACHE_MAX_FILE_SIZE || "", 10) ||
	2 * 1024 * 1024 * 1024;

/** Number of GETs before an object is admitted to disk cache (base threshold). */
const BASE_ADMISSION_HITS =
	parseInt(process.env.DISK_CACHE_ADMISSION_HITS || "", 10) || 2;

/** Eviction target: trim down to this fraction when over budget. */
const EVICTION_LOW_WATERMARK = 0.7;

/** Background sweep interval (ms). */
const EVICTION_INTERVAL_MS = 120_000;

/** Max age for a cached object before it self-destructs. */
const MAX_ENTRY_AGE_MS =
	parseInt(process.env.DISK_CACHE_MAX_ENTRY_AGE_MS || "", 10) ||
	12 * 60 * 60 * 1000;

/** Heat counter decay: halve counters every N ms to prevent stale popularity. */
const HEAT_DECAY_INTERVAL_MS = 600_000; // 10 min

/** Max number of demand-tracking entries (prevents unbounded memory). */
const MAX_DEMAND_ENTRIES = 50_000;

/** Cache root directory. */
const CACHE_DIR = resolveCacheDir();

/** Kill switch. */
const ENABLED = process.env.DISK_CACHE_ENABLED !== "false";

function resolveCacheDir(): string {
	if (process.env.DISK_CACHE_DIR) {
		return process.env.DISK_CACHE_DIR;
	}

	if (process.env.NODE_ENV === "production") {
		return "/tmp/s3-disk-cache";
	}

	return join(process.cwd(), ".s3-disk-cache");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CacheMeta {
	etag: string;
	contentType: string;
	size: number;
	headers: Record<string, string>;
	cachedAt: number;
	lastAccess: number;
	hitCount: number;
	bucket: string;
	key: string;
}

export interface CacheHit {
	meta: CacheMeta;
	stream: ReadableStream<Uint8Array>;
}

export interface CachePathHit {
	meta: CacheMeta;
	filePath: string;
}

interface DemandEntry {
	hits: number;
	lastHit: number;
	size: number; // last known size hint
}

interface EvictCandidate {
	hash: string;
	blobPath: string;
	metaPath: string;
	meta: CacheMeta;
	score: number;
}

// ---------------------------------------------------------------------------
// In-memory demand tracker (lightweight, bounded)
// ---------------------------------------------------------------------------

const demandMap = new Map<string, DemandEntry>();

function demandKey(bucket: string, key: string): string {
	return `${bucket}\0${key}`;
}

/**
 * Record a demand signal for an object. Called on every GET,
 * regardless of whether the object is cached.
 */
export function recordDemand(
	bucket: string,
	key: string,
	sizeHint: number,
): void {
	if (!ENABLED) return;

	const dk = demandKey(bucket, key);
	const existing = demandMap.get(dk);

	if (existing) {
		existing.hits++;
		existing.lastHit = Date.now();
		if (sizeHint > 0) existing.size = sizeHint;
	} else {
		// Enforce bounded size — evict oldest entry if full
		if (demandMap.size >= MAX_DEMAND_ENTRIES) {
			let oldestKey: string | null = null;
			let oldestTime = Infinity;
			for (const [k, v] of demandMap) {
				if (v.lastHit < oldestTime) {
					oldestTime = v.lastHit;
					oldestKey = k;
				}
			}
			if (oldestKey) demandMap.delete(oldestKey);
		}

		demandMap.set(dk, {
			hits: 1,
			lastHit: Date.now(),
			size: sizeHint,
		});
	}
}

/**
 * Check if an object has enough demand to be admitted to disk cache.
 * Threshold adapts based on current cache pressure.
 */
function meetsAdmissionThreshold(bucket: string, key: string): boolean {
	const dk = demandKey(bucket, key);
	const entry = demandMap.get(dk);
	if (!entry) return false;

	// Adaptive threshold: raise bar when cache is full
	const pressure = getCachePressure();
	let threshold = BASE_ADMISSION_HITS;
	if (pressure > 0.9) threshold = BASE_ADMISSION_HITS * 3;
	else if (pressure > 0.7) threshold = BASE_ADMISSION_HITS * 2;

	return entry.hits >= threshold;
}

/** Get current cache utilization as 0..1 fraction. */
function getCachePressure(): number {
	return currentTotalSize / MAX_TOTAL_SIZE;
}

// Periodic decay of demand counters to prevent stale entries hogging admission
let decayTimer: ReturnType<typeof setInterval> | null = null;

function startDemandDecay(): void {
	if (decayTimer) return;
	decayTimer = setInterval(() => {
		const now = Date.now();
		for (const [k, entry] of demandMap) {
			// Halve hit count
			entry.hits = Math.floor(entry.hits / 2);
			// Remove entries that have decayed to zero and are stale
			if (
				entry.hits === 0 &&
				now - entry.lastHit > HEAT_DECAY_INTERVAL_MS * 2
			) {
				demandMap.delete(k);
			}
		}
	}, HEAT_DECAY_INTERVAL_MS);

	if (decayTimer && typeof decayTimer === "object" && "unref" in decayTimer) {
		decayTimer.unref();
	}
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function hashKey(bucket: string, key: string): string {
	return createHash("sha256").update(`${bucket}:${key}`).digest("hex");
}

function blobPath(hash: string): string {
	return join(CACHE_DIR, hash.slice(0, 2), `${hash}.blob`);
}

function metaPath(hash: string): string {
	return join(CACHE_DIR, hash.slice(0, 2), `${hash}.meta`);
}

function ensureParentDir(filePath: string): void {
	const dir = filePath.substring(0, filePath.lastIndexOf("/"));
	if (dir && !existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}

function ensureCacheDirectoryWritable(): boolean {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		accessSync(CACHE_DIR, constants.W_OK);
		return true;
	} catch (error) {
		console.warn(
			`[disk-cache] disabled writes for dir=${CACHE_DIR}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

function isExpired(meta: CacheMeta, now = Date.now()): boolean {
	return now - meta.cachedAt > MAX_ENTRY_AGE_MS;
}

// ---------------------------------------------------------------------------
// Bookkeeping — track total size without scanning disk every time
// ---------------------------------------------------------------------------

let currentTotalSize = 0;
let sizeInitialized = false;
let cacheWritable = ENABLED;

function initSizeTracking(): void {
	if (sizeInitialized || !ENABLED) return;
	sizeInitialized = true;

	try {
		if (!existsSync(CACHE_DIR)) return;

		const prefixDirs = readdirSync(CACHE_DIR, { withFileTypes: true });
		for (const dir of prefixDirs) {
			if (!dir.isDirectory()) continue;
			const subDir = join(CACHE_DIR, dir.name);
			const files = readdirSync(subDir).filter((f) => f.endsWith(".blob"));
			for (const file of files) {
				try {
					currentTotalSize += statSync(join(subDir, file)).size;
				} catch {
					/* file vanished */
				}
			}
		}
	} catch {
		/* cache dir doesn't exist yet */
	}
}

// ---------------------------------------------------------------------------
// Heat scoring for eviction
// ---------------------------------------------------------------------------

function computeHeatScore(meta: CacheMeta): number {
	const now = Date.now();
	const ageMs = Math.max(now - meta.lastAccess, 1);

	// Recency boost: exponential decay, halves every 30 minutes
	const halfLifeMs = 30 * 60 * 1000;
	const recencyBoost = 0.5 ** (ageMs / halfLifeMs);

	// Size cost factor: larger files are more expensive to re-fetch
	// Logarithmic scaling so a 100MB file isn't 100× more valuable than 1MB
	const sizeCostFactor = Math.log2(meta.size / (1024 * 1024) + 1) + 1;

	// Combined score
	return meta.hitCount * recencyBoost * sizeCostFactor;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Should this object be considered for disk caching?
 * (Size check only — demand check happens at admission time.)
 */
export function isDiskCacheEligible(sizeBytes: number): boolean {
	return ENABLED && sizeBytes >= MIN_SIZE && sizeBytes <= MAX_FILE_SIZE;
}

export function getDiskCacheMinSizeBytes(): number {
	return MIN_SIZE;
}

/**
 * Attempt a disk cache read. Returns null on miss.
 *
 * If `expectedEtag` is provided, validates the cached ETag. Stale
 * entries are evicted in the background and null is returned.
 */
export async function diskCacheGet(
	bucket: string,
	key: string,
	expectedEtag?: string,
): Promise<CacheHit | null> {
	if (!ENABLED || !cacheWritable) return null;

	const hash = hashKey(bucket, key);
	const bp = blobPath(hash);
	const mp = metaPath(hash);

	try {
		if (!existsSync(bp) || !existsSync(mp)) return null;

		const rawMeta = await readFile(mp, "utf-8");
		const meta: CacheMeta = JSON.parse(rawMeta);

		if (isExpired(meta)) {
			setImmediate(() => evictEntry(hash, meta.size));
			return null;
		}

		// ETag validation
		if (expectedEtag && meta.etag !== expectedEtag) {
			setImmediate(() => evictEntry(hash, meta.size));
			return null;
		}

		// Update hit stats (non-blocking write-back)
		meta.hitCount++;
		meta.lastAccess = Date.now();
		setImmediate(() => {
			try {
				writeFileSync(mp, JSON.stringify(meta));
			} catch {
				/* best effort */
			}
		});

		// Touch atime for OS-level tracking too
		utimes(bp, new Date(), statSync(bp).mtime).catch(() => {});

		// Also update in-memory demand tracker
		recordDemand(bucket, key, meta.size);

		// Stream from disk — never loads whole file into memory
		const file = Bun.file(bp);
		const stream = file.stream();

		return { meta, stream };
	} catch {
		return null;
	}
}

/**
 * Get the file path of a cached object (for Range request support).
 *
 * Similar to diskCacheGet but returns the file path instead of a stream,
 * allowing callers to use Bun.file().slice() for partial reads.
 */
export async function diskCacheGetPath(
	bucket: string,
	key: string,
): Promise<CachePathHit | null> {
	if (!ENABLED || !cacheWritable) return null;

	const hash = hashKey(bucket, key);
	const bp = blobPath(hash);
	const mp = metaPath(hash);

	try {
		if (!existsSync(bp) || !existsSync(mp)) return null;

		const rawMeta = await readFile(mp, "utf-8");
		const meta: CacheMeta = JSON.parse(rawMeta);

		if (isExpired(meta)) {
			setImmediate(() => evictEntry(hash, meta.size));
			return null;
		}

		// Update hit stats (non-blocking write-back)
		meta.hitCount++;
		meta.lastAccess = Date.now();
		setImmediate(() => {
			try {
				writeFileSync(mp, JSON.stringify(meta));
			} catch {
				/* best effort */
			}
		});

		// Touch atime for OS-level tracking too
		utimes(bp, new Date(), statSync(bp).mtime).catch(() => {});

		// Also update in-memory demand tracker
		recordDemand(bucket, key, meta.size);

		return { meta, filePath: bp };
	} catch {
		return null;
	}
}

/**
 * Write an object to the disk cache.
 *
 * This performs both admission control (demand check) and the actual
 * write. Call this from a background task — it never blocks the client
 * response.
 *
 * @returns true if actually cached, false if skipped
 */
export async function diskCachePut(
	bucket: string,
	key: string,
	body: Uint8Array | Buffer,
	headers: Record<string, string>,
): Promise<boolean> {
	if (!ENABLED || !cacheWritable) return false;

	const size = body.byteLength;

	// Size eligibility
	if (!isDiskCacheEligible(size)) return false;

	// Demand gate: must have enough prior hits
	if (!meetsAdmissionThreshold(bucket, key)) return false;

	// Space check: don't admit if it would push us way over budget
	// (eviction will run, but we don't want to spike disk usage)
	initSizeTracking();
	if (currentTotalSize + size > MAX_TOTAL_SIZE * 1.1) {
		// Force an eviction cycle first
		runEviction();
		if (currentTotalSize + size > MAX_TOTAL_SIZE) {
			return false; // Still no room after eviction
		}
	}

	const hash = hashKey(bucket, key);
	const bp = blobPath(hash);
	const mp = metaPath(hash);
	const tmpBlob = `${bp}.tmp.${process.pid}`;
	const tmpMeta = `${mp}.tmp.${process.pid}`;

	try {
		ensureParentDir(bp);

		// If already cached, check if this is an update (ETag changed)
		let previousSize = 0;
		if (existsSync(bp)) {
			try {
				previousSize = statSync(bp).size;
			} catch {
				/* ignore */
			}
		}

		const dk = demandKey(bucket, key);
		const demand = demandMap.get(dk);

		const meta: CacheMeta = {
			etag: headers.etag || headers.ETag || "",
			contentType:
				headers["content-type"] ||
				headers["Content-Type"] ||
				"application/octet-stream",
			size,
			headers,
			cachedAt: Date.now(),
			lastAccess: Date.now(),
			hitCount: demand?.hits || 1,
			bucket,
			key,
		};

		// Atomic blob write
		await writeFile(tmpBlob, body);
		renameSync(tmpBlob, bp);

		// Atomic meta write
		await writeFile(tmpMeta, JSON.stringify(meta));
		renameSync(tmpMeta, mp);

		// Update bookkeeping
		currentTotalSize = currentTotalSize - previousSize + size;

		// Schedule eviction check
		scheduleEviction();

		return true;
	} catch (e) {
		try {
			unlinkSync(tmpBlob);
		} catch {
			/* ignore */
		}
		try {
			unlinkSync(tmpMeta);
		} catch {
			/* ignore */
		}
		console.error("[disk-cache] write error:", e);
		return false;
	}
}

/**
 * Invalidate a specific cached object (e.g., on PUT/DELETE).
 */
export function diskCacheInvalidate(bucket: string, key: string): void {
	if (!ENABLED) return;

	const hash = hashKey(bucket, key);
	setImmediate(() => {
		try {
			const bp = blobPath(hash);
			let size = 0;
			try {
				size = statSync(bp).size;
			} catch {
				/* doesn't exist */
			}
			evictEntry(hash, size);
		} catch {
			/* ignore */
		}
	});
}

// ---------------------------------------------------------------------------
// Eviction engine
// ---------------------------------------------------------------------------

function evictEntry(hash: string, size: number): void {
	try {
		unlinkSync(blobPath(hash));
	} catch {
		/* ignore */
	}
	try {
		unlinkSync(metaPath(hash));
	} catch {
		/* ignore */
	}
	currentTotalSize = Math.max(0, currentTotalSize - size);
}

let evictionScheduled = false;

function scheduleEviction(): void {
	if (evictionScheduled) return;
	evictionScheduled = true;

	setTimeout(() => {
		evictionScheduled = false;
		runEviction();
	}, 1_000); // Debounce rapid writes
}

function runEviction(): void {
	try {
		if (!cacheWritable || !existsSync(CACHE_DIR)) return;
		initSizeTracking();

		const candidates: EvictCandidate[] = [];
		const prefixDirs = readdirSync(CACHE_DIR, { withFileTypes: true });
		const now = Date.now();
		let reclaimed = 0;
		let evicted = 0;

		for (const dir of prefixDirs) {
			if (!dir.isDirectory()) continue;
			const subDir = join(CACHE_DIR, dir.name);
			const metaFiles = readdirSync(subDir).filter((f) => f.endsWith(".meta"));

			for (const file of metaFiles) {
				const hash = file.replace(".meta", "");
				const bp = blobPath(hash);
				const mp = join(subDir, file);

				try {
					const rawMeta = require("node:fs").readFileSync(mp, "utf-8");
					const meta: CacheMeta = JSON.parse(rawMeta);

					if (isExpired(meta, now)) {
						try {
							unlinkSync(bp);
						} catch {
							/* ignore */
						}
						try {
							unlinkSync(mp);
						} catch {
							/* ignore */
						}
						reclaimed += meta.size;
						evicted++;
						continue;
					}

					const score = computeHeatScore(meta);

					candidates.push({ hash, blobPath: bp, metaPath: mp, meta, score });
				} catch {
					// Corrupt meta — evict it
					try {
						unlinkSync(bp);
					} catch {
						/* ignore */
					}
					try {
						unlinkSync(mp);
					} catch {
						/* ignore */
					}
				}
			}
		}

		currentTotalSize = Math.max(0, currentTotalSize - reclaimed);

		if (currentTotalSize <= MAX_TOTAL_SIZE) {
			if (evicted > 0) {
				const totalMB = (currentTotalSize / (1024 * 1024)).toFixed(1);
				console.log(
					`[disk-cache] evicted ${evicted} stale entries, reclaimed ${(reclaimed / (1024 * 1024)).toFixed(1)} MB, now at ${totalMB} MB / ${(MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0)} MB`,
				);
			}
			return;
		}

		// Sort by score ascending — coldest entries first
		candidates.sort((a, b) => a.score - b.score);

		const target = MAX_TOTAL_SIZE * EVICTION_LOW_WATERMARK;
		let reclaimedCold = 0;
		let evictedCold = 0;

		for (const candidate of candidates) {
			if (currentTotalSize - reclaimedCold <= target) break;

			try {
				unlinkSync(candidate.blobPath);
			} catch {
				/* ignore */
			}
			try {
				unlinkSync(candidate.metaPath);
			} catch {
				/* ignore */
			}
			reclaimedCold += candidate.meta.size;
			evictedCold++;
		}

		currentTotalSize = Math.max(0, currentTotalSize - reclaimedCold);

		if (evicted + evictedCold > 0) {
			const totalMB = (currentTotalSize / (1024 * 1024)).toFixed(1);
			console.log(
				`[disk-cache] evicted ${evicted + evictedCold} entries, reclaimed ${((reclaimed + reclaimedCold) / (1024 * 1024)).toFixed(1)} MB, now at ${totalMB} MB / ${(MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0)} MB`,
			);
		}

		// Clean empty prefix dirs
		for (const dir of prefixDirs) {
			if (!dir.isDirectory()) continue;
			try {
				const remaining = readdirSync(join(CACHE_DIR, dir.name));
				if (remaining.length === 0) {
					require("node:fs").rmdirSync(join(CACHE_DIR, dir.name));
				}
			} catch {
				/* ignore */
			}
		}
	} catch (e) {
		console.error("[disk-cache] eviction error:", e);
	}
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let periodicTimer: ReturnType<typeof setInterval> | null = null;

export function startPeriodicEviction(): void {
	if (periodicTimer || !ENABLED) return;
	periodicTimer = setInterval(runEviction, EVICTION_INTERVAL_MS);
	if (
		periodicTimer &&
		typeof periodicTimer === "object" &&
		"unref" in periodicTimer
	) {
		periodicTimer.unref();
	}
}

export function stopPeriodicEviction(): void {
	if (periodicTimer) {
		clearInterval(periodicTimer);
		periodicTimer = null;
	}
	if (decayTimer) {
		clearInterval(decayTimer);
		decayTimer = null;
	}
}

// ---------------------------------------------------------------------------
// Stats (for admin/monitoring endpoints)
// ---------------------------------------------------------------------------

export interface DiskCacheStats {
	enabled: boolean;
	writable: boolean;
	directory: string;
	entryCount: number;
	totalSizeBytes: number;
	totalSizeMB: number;
	maxTotalSizeBytes: number;
	maxTotalSizeMB: number;
	utilizationPercent: number;
	minFileSizeBytes: number;
	minFileSizeLabel: string;
	maxFileSizeBytes: number;
	maxEntryAgeMs: number;
	baseAdmissionHits: number;
	currentAdmissionThreshold: number;
	demandTrackerEntries: number;
	topHotObjects: Array<{
		bucket: string;
		key: string;
		hits: number;
		sizeBytes: number;
		sizeMB: number;
		cachedOnDisk: boolean;
	}>;
}

export function isDiskCached(bucket: string, key: string): boolean {
	if (!ENABLED || !cacheWritable) return false;

	const hash = hashKey(bucket, key);
	return existsSync(blobPath(hash)) && existsSync(metaPath(hash));
}

export function getDiskCacheStats(): DiskCacheStats {
	initSizeTracking();

	const pressure = getCachePressure();
	let threshold = BASE_ADMISSION_HITS;
	if (pressure > 0.9) threshold = BASE_ADMISSION_HITS * 3;
	else if (pressure > 0.7) threshold = BASE_ADMISSION_HITS * 2;

	// Top 10 hottest objects from demand tracker
	const sorted = [...demandMap.entries()]
		.sort((a, b) => b[1].hits - a[1].hits)
		.slice(0, 10)
		.map(([k, v]) => {
			const [bucket, key] = k.split("\0");
			return {
				bucket,
				key,
				hits: v.hits,
				sizeBytes: v.size,
				sizeMB: Math.round((v.size / (1024 * 1024)) * 100) / 100,
				cachedOnDisk: isDiskCached(bucket, key),
			};
		});

	let entryCount = 0;
	if (ENABLED && existsSync(CACHE_DIR)) {
		try {
			const prefixDirs = readdirSync(CACHE_DIR, { withFileTypes: true });
			for (const dir of prefixDirs) {
				if (!dir.isDirectory()) continue;
				const files = readdirSync(join(CACHE_DIR, dir.name)).filter((f) =>
					f.endsWith(".blob"),
				);
				entryCount += files.length;
			}
		} catch {
			/* ignore */
		}
	}

	return {
		enabled: ENABLED,
		writable: cacheWritable,
		directory: CACHE_DIR,
		entryCount,
		totalSizeBytes: currentTotalSize,
		totalSizeMB: Math.round((currentTotalSize / (1024 * 1024)) * 100) / 100,
		maxTotalSizeBytes: MAX_TOTAL_SIZE,
		maxTotalSizeMB: Math.round(MAX_TOTAL_SIZE / (1024 * 1024)),
		utilizationPercent: Math.round(pressure * 100),
		minFileSizeBytes: MIN_SIZE,
		minFileSizeLabel:
			MIN_SIZE < 1024
				? `${MIN_SIZE} B`
				: MIN_SIZE < 1024 * 1024
					? `${(MIN_SIZE / 1024).toFixed(0)} KB`
					: `${(MIN_SIZE / (1024 * 1024)).toFixed(2)} MB`,
		maxFileSizeBytes: MAX_FILE_SIZE,
		maxEntryAgeMs: MAX_ENTRY_AGE_MS,
		baseAdmissionHits: BASE_ADMISSION_HITS,
		currentAdmissionThreshold: threshold,
		demandTrackerEntries: demandMap.size,
		topHotObjects: sorted,
	};
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

if (ENABLED) {
	cacheWritable = ensureCacheDirectoryWritable();
	initSizeTracking();
	startPeriodicEviction();
	startDemandDecay();

	const sizeMB = (currentTotalSize / (1024 * 1024)).toFixed(1);
	const budgetMB = (MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0);
	console.log(
		`[disk-cache] initialized: ${sizeMB} MB used / ${budgetMB} MB budget, dir=${CACHE_DIR}`,
	);
}

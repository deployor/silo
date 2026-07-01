import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MAX_TOTAL_SIZE =
	Number.parseInt(process.env.DISK_CACHE_MAX_TOTAL_SIZE || "", 10) ||
	20 * 1024 * 1024 * 1024;
const MIN_SIZE =
	Number.parseInt(process.env.DISK_CACHE_MIN_SIZE || "", 10) ||
	10 * 1024 * 1024;
const MAX_FILE_SIZE =
	Number.parseInt(process.env.DISK_CACHE_MAX_FILE_SIZE || "", 10) ||
	2 * 1024 * 1024 * 1024;
const BASE_ADMISSION_HITS =
	Number.parseInt(process.env.DISK_CACHE_ADMISSION_HITS || "", 10) || 2;
const MAX_ENTRY_AGE_MS =
	Number.parseInt(process.env.DISK_CACHE_MAX_ENTRY_AGE_MS || "", 10) ||
	12 * 60 * 60 * 1000;
const ENABLED = process.env.DISK_CACHE_ENABLED !== "false";
const CACHE_DIR = resolveCacheDir();

type DiskCacheMeta = {
	bucket?: string;
	key?: string;
	size?: number;
	hit_count?: number;
	hitCount?: number;
};

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

function resolveCacheDir(): string {
	if (process.env.DISK_CACHE_DIR) return process.env.DISK_CACHE_DIR;
	if (process.env.NODE_ENV === "production") return "/tmp/s3-disk-cache";
	return join(process.cwd(), ".s3-disk-cache");
}

function hashKey(bucket: string, key: string): string {
	return createHash("sha256").update(`${bucket}:${key}`).digest("hex");
}

function blobPath(hash: string): string {
	return join(CACHE_DIR, hash.slice(0, 2), `${hash}.blob`);
}

function metaPath(hash: string): string {
	return join(CACHE_DIR, hash.slice(0, 2), `${hash}.meta`);
}

function formatMinSizeLabel() {
	if (MIN_SIZE < 1024) return `${MIN_SIZE} B`;
	if (MIN_SIZE < 1024 * 1024) return `${(MIN_SIZE / 1024).toFixed(0)} KB`;
	return `${(MIN_SIZE / (1024 * 1024)).toFixed(2)} MB`;
}

function currentAdmissionThreshold(pressure: number) {
	if (pressure > 0.9) return BASE_ADMISSION_HITS * 3;
	if (pressure > 0.7) return BASE_ADMISSION_HITS * 2;
	return BASE_ADMISSION_HITS;
}

const STATS_CACHE_TTL_MS =
	Number.parseInt(process.env.DISK_CACHE_STATS_CACHE_TTL_MS || "", 10) ||
	30_000;

type DiskEntriesSnapshot = Pick<
	DiskCacheStats,
	"entryCount" | "totalSizeBytes" | "topHotObjects"
>;
let cachedEntries:
	| { expiresAt: number; snapshot: DiskEntriesSnapshot }
	| undefined;

function readDiskEntries(): DiskEntriesSnapshot {
	let entryCount = 0;
	let totalSizeBytes = 0;
	const topHotObjects: DiskCacheStats["topHotObjects"] = [];

	if (!ENABLED || !existsSync(CACHE_DIR)) {
		return { entryCount, totalSizeBytes, topHotObjects };
	}

	try {
		for (const dir of readdirSync(CACHE_DIR, { withFileTypes: true })) {
			if (!dir.isDirectory()) continue;
			const subdir = join(CACHE_DIR, dir.name);
			for (const file of readdirSync(subdir)) {
				if (!file.endsWith(".blob")) continue;
				entryCount += 1;
				const hash = file.slice(0, -".blob".length);
				const blob = join(subdir, file);
				const sizeBytes = statSync(blob).size;
				totalSizeBytes += sizeBytes;

				try {
					const meta = JSON.parse(
						readFileSync(join(subdir, `${hash}.meta`), "utf8"),
					) as DiskCacheMeta;
					topHotObjects.push({
						bucket: meta.bucket || "",
						key: meta.key || "",
						hits: meta.hit_count || meta.hitCount || 0,
						sizeBytes: meta.size || sizeBytes,
						sizeMB:
							Math.round(((meta.size || sizeBytes) / (1024 * 1024)) * 100) /
							100,
						cachedOnDisk: true,
					});
				} catch {
					/* Metadata may be mid-write; ignore it for admin stats. */
				}
			}
		}
	} catch {
		return { entryCount, totalSizeBytes, topHotObjects: [] };
	}

	topHotObjects.sort((a, b) => b.hits - a.hits);
	return {
		entryCount,
		totalSizeBytes,
		topHotObjects: topHotObjects.slice(0, 10),
	};
}

export function isDiskCached(bucket: string, key: string): boolean {
	if (!ENABLED) return false;
	const hash = hashKey(bucket, key);
	return existsSync(blobPath(hash)) && existsSync(metaPath(hash));
}

export function getDiskCacheStats(): DiskCacheStats {
	const now = Date.now();
	const snapshot =
		cachedEntries && cachedEntries.expiresAt > now
			? cachedEntries.snapshot
			: readDiskEntries();
	if (!cachedEntries || cachedEntries.expiresAt <= now) {
		cachedEntries = { expiresAt: now + STATS_CACHE_TTL_MS, snapshot };
	}
	const { entryCount, totalSizeBytes, topHotObjects } = snapshot;
	const pressure = MAX_TOTAL_SIZE > 0 ? totalSizeBytes / MAX_TOTAL_SIZE : 0;

	return {
		enabled: ENABLED,
		writable: ENABLED && existsSync(CACHE_DIR),
		directory: CACHE_DIR,
		entryCount,
		totalSizeBytes,
		totalSizeMB: Math.round((totalSizeBytes / (1024 * 1024)) * 100) / 100,
		maxTotalSizeBytes: MAX_TOTAL_SIZE,
		maxTotalSizeMB: Math.round(MAX_TOTAL_SIZE / (1024 * 1024)),
		utilizationPercent: Math.round(pressure * 100),
		minFileSizeBytes: MIN_SIZE,
		minFileSizeLabel: formatMinSizeLabel(),
		maxFileSizeBytes: MAX_FILE_SIZE,
		maxEntryAgeMs: MAX_ENTRY_AGE_MS,
		baseAdmissionHits: BASE_ADMISSION_HITS,
		currentAdmissionThreshold: currentAdmissionThreshold(pressure),
		demandTrackerEntries: 0,
		topHotObjects,
	};
}

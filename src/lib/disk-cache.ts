import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdir, unlink } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createHash } from "crypto";

const CACHE_DIR = ".cache";
const DATA_DIR = join(CACHE_DIR, "data");
const DB_PATH = join(CACHE_DIR, "disk-index.sqlite");
const MAX_CACHE_SIZE = 50 * 1024 * 1024 * 1024; // 50GB

// Ensure directories exist
try {
    mkdirSync(DATA_DIR, { recursive: true });
} catch {}

const db = new Database(DB_PATH);

// High-performance mode
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA synchronous = NORMAL;");
db.exec("PRAGMA temp_store = MEMORY;");

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    key TEXT PRIMARY KEY,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    last_accessed INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_access ON files(last_accessed);
`);

const stmtGet = db.query("SELECT path FROM files WHERE key = $key");
const stmtInsert = db.query("INSERT OR REPLACE INTO files (key, path, size, last_accessed) VALUES ($key, $path, $size, $now)");
const stmtDelete = db.query("DELETE FROM files WHERE key = $key");
const stmtTouch = db.query("UPDATE files SET last_accessed = $now WHERE key = $key");
const stmtTotalSize = db.query("SELECT SUM(size) as total FROM files");
const stmtGetEvictable = db.query("SELECT key, path, size FROM files ORDER BY last_accessed ASC LIMIT 50");

function getCachePath(bucket: string, key: string) {
    const hash = createHash("sha256").update(`${bucket}:${key}`).digest("hex");
    const subdir = hash.substring(0, 2);
    const filename = hash.substring(2) + ".bin";
    return {
        dir: join(DATA_DIR, subdir),
        path: join(DATA_DIR, subdir, filename),
        relPath: join(subdir, filename)
    };
}

let isPruning = false;
async function pruneCache() {
    if (isPruning) return;
    isPruning = true;
    
    try {
        const result = stmtTotalSize.get() as { total: number };
        let currentSize = result?.total || 0;

        if (currentSize > MAX_CACHE_SIZE) {
            const targetSize = MAX_CACHE_SIZE * 0.9;
            while (currentSize > targetSize) {
                const candidates = stmtGetEvictable.all() as { key: string, path: string, size: number }[];
                if (!candidates.length) break;

                for (const file of candidates) {
                    try {
                        await unlink(join(DATA_DIR, file.path)).catch(() => {});
                        stmtDelete.run({ $key: file.key });
                        currentSize -= file.size;
                    } catch {
                        stmtDelete.run({ $key: file.key });
                    }
                }
            }
        }
    } finally {
        isPruning = false;
    }
}

export const diskCache = {
    /**
     * Get stream for file. Updates LRU in background.
     */
    async get(bucket: string, key: string): Promise<ReadableStream | null> {
        const cacheKey = `${bucket}:${key}`;
        const entry = stmtGet.get({ $key: cacheKey }) as { path: string } | null;
        
        if (!entry) return null;
        
        const fullPath = join(DATA_DIR, entry.path);
        const file = Bun.file(fullPath);
        
        if (!await file.exists()) {
            stmtDelete.run({ $key: cacheKey });
            return null;
        }

        // Fire-and-forget LRU update
        setTimeout(() => stmtTouch.run({ $now: Date.now(), $key: cacheKey }), 0);

        return file.stream();
    },

    /**
     * Write file to disk and index.
     */
    async put(bucket: string, key: string, body: ReadableStream | Uint8Array | Blob): Promise<void> {
        const cacheKey = `${bucket}:${key}`;
        const { dir, path, relPath } = getCachePath(bucket, key);

        try {
            await mkdir(dir, { recursive: true });
            
            // Write to disk
            const size = await Bun.write(path, body as any);
            
            // Update Index
            stmtInsert.run({
                $key: cacheKey,
                $path: relPath,
                $size: size,
                $now: Date.now()
            });

            // Occasional prune check
            if (Math.random() < 0.05) {
                pruneCache();
            }
        } catch (e) {
            console.error(`Disk cache write failed for ${cacheKey}:`, e);
        }
    },

    /**
     * Remove file from disk and index.
     */
    async del(bucket: string, key: string): Promise<void> {
        const cacheKey = `${bucket}:${key}`;
        const entry = stmtGet.get({ $key: cacheKey }) as { path: string } | null;
        
        if (entry) {
            await unlink(join(DATA_DIR, entry.path)).catch(() => {});
            stmtDelete.run({ $key: cacheKey });
        }
    }
};

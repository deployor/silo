import { eq } from "drizzle-orm";
import { db } from "../db";
import { appSettings } from "../db/schema";

export type AppSettings = {
	defaultStorageLimitBytes: number;
	egressMultiplier: number;
	minEgressBytes: number;
	defaultMaxBucketsPerUser: number;
	defaultMaxKeysPerBucket: number;
};

export const DEFAULT_APP_SETTINGS: AppSettings = {
	defaultStorageLimitBytes: 1_073_741_824, // 1GB
	egressMultiplier: 3,
	minEgressBytes: 10 * 1024 * 1024 * 1024, // 10GB
	defaultMaxBucketsPerUser: 50,
	defaultMaxKeysPerBucket: 20,
};

let cached: { value: AppSettings; fetchedAtMs: number } | null = null;
const CACHE_TTL_MS = 10_000;

async function ensureRowExists() {
	// Single-row table pattern; this is safe even before migrations are applied
	// because this code will only be exercised when the table exists.
	await db
		.insert(appSettings)
		.values({
			id: "global",
			defaultStorageLimitBytes: DEFAULT_APP_SETTINGS.defaultStorageLimitBytes,
			egressMultiplier: DEFAULT_APP_SETTINGS.egressMultiplier,
			minEgressBytes: DEFAULT_APP_SETTINGS.minEgressBytes,
			defaultMaxBucketsPerUser: DEFAULT_APP_SETTINGS.defaultMaxBucketsPerUser,
			defaultMaxKeysPerBucket: DEFAULT_APP_SETTINGS.defaultMaxKeysPerBucket,
		})
		.onConflictDoNothing();
}

export async function getAppSettings(force = false): Promise<AppSettings> {
	if (!force && cached && Date.now() - cached.fetchedAtMs < CACHE_TTL_MS) {
		return cached.value;
	}

	await ensureRowExists();

	const rows = await db.select().from(appSettings).limit(1);
	const row = rows[0];

	const value: AppSettings = row
		? {
			defaultStorageLimitBytes: Number(row.defaultStorageLimitBytes),
			egressMultiplier: Number(row.egressMultiplier),
			minEgressBytes: Number(row.minEgressBytes),
			defaultMaxBucketsPerUser: Number(row.defaultMaxBucketsPerUser),
			defaultMaxKeysPerBucket: Number(row.defaultMaxKeysPerBucket),
		}
		: DEFAULT_APP_SETTINGS;

	cached = { value, fetchedAtMs: Date.now() };
	return value;
}

export async function updateAppSettings(patch: Partial<AppSettings>) {
	await ensureRowExists();

	const next: AppSettings = {
		...(await getAppSettings(true)),
		...patch,
	};

	await db
		.update(appSettings)
		.set({
			defaultStorageLimitBytes: next.defaultStorageLimitBytes,
			egressMultiplier: next.egressMultiplier,
			minEgressBytes: next.minEgressBytes,
			defaultMaxBucketsPerUser: next.defaultMaxBucketsPerUser,
			defaultMaxKeysPerBucket: next.defaultMaxKeysPerBucket,
			updatedAt: new Date(),
		})
		.where(eq(appSettings.id, "global"));

	cached = { value: next, fetchedAtMs: Date.now() };
	return next;
}

export const SettingsService = {
	getAppSettings,
	updateAppSettings,
};

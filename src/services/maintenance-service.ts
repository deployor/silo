import { eq } from "drizzle-orm";
import { db } from "../db";
import { appSettings } from "../db/schema";

export type MaintenanceStatus = {
	s3MaintenanceMode: boolean;
	fullMaintenanceMode: boolean;
};

const DEFAULT_STATUS: MaintenanceStatus = {
	s3MaintenanceMode: false,
	fullMaintenanceMode: false,
};

let cached: { value: MaintenanceStatus; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 1_000;

/** Read-only, low-TTL status check used at every trust boundary. */
export async function getMaintenanceStatus(
	force = false,
): Promise<MaintenanceStatus> {
	if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
		return cached.value;
	}

	const row = await db
		.select({
			s3MaintenanceMode: appSettings.s3MaintenanceMode,
			fullMaintenanceMode: appSettings.fullMaintenanceMode,
		})
		.from(appSettings)
		.where(eq(appSettings.id, "global"))
		.limit(1);
	const value = row[0] || DEFAULT_STATUS;
	cached = { value, fetchedAt: Date.now() };
	return value;
}

export function invalidateMaintenanceStatusCache() {
	cached = null;
}

export const MAINTENANCE_ERROR = "Planned maintenance is in progress.";

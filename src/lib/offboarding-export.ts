import { createHash, createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull, lte } from "drizzle-orm";
import { config } from "../config";
import { getInternalPath } from "../core/s3/utils";
import { db } from "../db";
import { buckets, offboardingExportSessions, users } from "../db/schema";

export const OFFBOARDING_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function createOffboardingExportAccessKey() {
	return `ox_${randomBytes(16).toString("hex")}`;
}

export function deriveOffboardingExportSecret(accessKey: string) {
	return createHmac("sha256", config.hcAuth.clientSecret)
		.update(`offboarding-export:${accessKey}`)
		.digest("hex");
}

export function hashOffboardingExportSecret(secret: string) {
	return createHash("sha256").update(secret).digest("hex");
}

export function buildOffboardingAllowedPrefix(user: typeof users.$inferSelect) {
	return getInternalPath("", user, {
		id: "",
		name: "",
		userId: user.id,
		region: "auto",
		isPublic: false,
		isSystem: false,
		isPaused: false,
		pauseReason: null,
		deepFreezeState: "active",
		deepFreezeReason: null,
		deepFreezeRequestedAt: null,
		deepFreezeStartedAt: null,
		deepFreezeCompletedAt: null,
		deepFreezeArchiveKey: null,
		deepFreezeArchiveBytes: 0,
		deepFreezeProgress: 0,
		deepFreezeEstimatedFreezeSeconds: 0,
		deepFreezeEstimatedUnfreezeSeconds: 0,
		deepFreezeLastUpdatedAt: null,
		corsConfig: null,
		customDomains: null,
		totalBytes: 0,
		totalRequests: 0,
		createdAt: null,
		updatedAt: null,
	});
}

function shellQuote(value: string) {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function buildOffboardingRcloneS3Flags(params: {
	endpoint: string;
	accessKey: string;
	secretKey: string;
}) {
	return [
		"--s3-provider Other",
		`--s3-access-key-id ${shellQuote(params.accessKey)}`,
		`--s3-secret-access-key ${shellQuote(params.secretKey)}`,
		`--s3-endpoint ${shellQuote(params.endpoint.replace(/\/+$/, ""))}`,
		"--s3-region auto",
		"--s3-force-path-style",
		"--s3-no-check-bucket",
	].join(" ");
}

export function buildOffboardingRcloneCommand(params: {
	endpoint: string;
	accessKey: string;
	secretKey: string;
	bucketNames: string[];
	destinationPath?: string;
}) {
	const destinationPath = params.destinationPath || "./silo-export";
	const s3Flags = buildOffboardingRcloneS3Flags(params);
	const copyFlags = "--fast-list --transfers 16 --checkers 32 --progress";
	const bucketCopies = params.bucketNames
		.map(
			(bucketName) =>
				`echo Downloading ${shellQuote(bucketName)} && rclone copy ${shellQuote(`:s3:${bucketName}/`)} "$DEST/${bucketName}" ${s3Flags} ${copyFlags}`,
		)
		.join(" && ");
	return `DEST=${shellQuote(destinationPath)}; mkdir -p "$DEST" && ${bucketCopies}`;
}

export async function expireOffboardingExportSessions() {
	const now = new Date();
	const expired = await db
		.select({
			id: offboardingExportSessions.id,
			userId: offboardingExportSessions.userId,
		})
		.from(offboardingExportSessions)
		.where(
			and(
				isNull(offboardingExportSessions.downloadCompletedAt),
				isNull(offboardingExportSessions.revokedAt),
				lte(offboardingExportSessions.expiresAt, now),
			),
		);

	for (const session of expired) {
		await db
			.update(offboardingExportSessions)
			.set({
				downloadCompletedAt: now,
				revokedAt: now,
				updatedAt: now,
			})
			.where(eq(offboardingExportSessions.id, session.id));
		await db
			.update(users)
			.set({ dataExported: true, updatedAt: now })
			.where(eq(users.id, session.userId));
	}
}

export async function getOffboardingExportBucketForUser(userId: string) {
	const rows = await db
		.select()
		.from(buckets)
		.where(eq(buckets.userId, userId))
		.limit(1);
	return rows[0] || null;
}

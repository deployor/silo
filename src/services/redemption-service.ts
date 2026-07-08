import { createHash, randomBytes } from "node:crypto";
import {
	and,
	count,
	desc,
	eq,
	gt,
	inArray,
	isNull,
	or,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import {
	redemptionCodes,
	redemptionLogs,
	redemptionPrograms,
	redemptionTransactions,
	users,
} from "../db/schema";

const MAX_PROGRAM_GRANT_BYTES = 100 * 1024 ** 4;
const MAX_CODES_PER_BATCH = 1000;
const IDENTITY_USER_ID_RE = /^ident![a-zA-Z0-9_-]{3,128}$/;

function hashApiKey(apiKey: string) {
	return createHash("sha256").update(apiKey).digest("hex");
}

function assertGrantAmount(amountBytes: number) {
	if (!Number.isSafeInteger(amountBytes) || amountBytes <= 0) {
		throw new Error("Grant amount must be a positive integer byte value.");
	}
	if (amountBytes > MAX_PROGRAM_GRANT_BYTES) {
		throw new Error("Grant amount is too large.");
	}
}

function normalizeOptionalText(value?: string) {
	const trimmed = value?.trim();
	return trimmed || undefined;
}

function normalizeEmail(value?: string) {
	return normalizeOptionalText(value)?.toLowerCase();
}

function isIdentityUserId(userId: string) {
	return IDENTITY_USER_ID_RE.test(userId);
}

// --- Programs ---

export async function createProgram(data: {
	name: string;
	prefix: string;
	description?: string;
	quotaCreditBytes: number;
}) {
	const [program] = await db
		.insert(redemptionPrograms)
		.values({
			name: data.name,
			prefix: normalizeRedemptionCode(data.prefix),
			description: data.description,
			quotaCreditBytes: data.quotaCreditBytes,
		})
		.returning();
	return program;
}

export async function getPrograms() {
	return db
		.select()
		.from(redemptionPrograms)
		.orderBy(desc(redemptionPrograms.createdAt));
}

export async function getProgramById(id: string) {
	const results = await db
		.select()
		.from(redemptionPrograms)
		.where(eq(redemptionPrograms.id, id))
		.limit(1);
	return results[0];
}

export async function rotateProgramApiKey(programId: string) {
	const program = await getProgramById(programId);
	if (!program) throw new Error("Program not found");

	const apiKey = `silo_ysws_${randomBytes(32).toString("hex")}`;
	const apiKeyHash = hashApiKey(apiKey);
	const apiKeySuffix = apiKey.slice(-8);

	const [updated] = await db
		.update(redemptionPrograms)
		.set({
			apiKeyHash,
			apiKeySuffix,
			apiKeyCreatedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(redemptionPrograms.id, programId))
		.returning();

	return {
		program: updated,
		apiKey,
	};
}

export async function authenticateProgramApiKey(apiKey: string) {
	const key = apiKey.trim();
	if (!key) return null;

	const [program] = await db
		.select()
		.from(redemptionPrograms)
		.where(
			and(
				eq(redemptionPrograms.apiKeyHash, hashApiKey(key)),
				eq(redemptionPrograms.isActive, true),
			),
		)
		.limit(1);

	return program || null;
}

// --- Codes ---

export async function generateCodes(
	programId: string,
	count: number,
	createdBy: string | null,
	length = 16, // Total length of random part (excluding dashes/prefix)
	customCodes: string[] = [],
	quotaCreditBytes?: number,
) {
	const program = await getProgramById(programId);
	if (!program) throw new Error("Program not found");
	if (quotaCreditBytes !== undefined) assertGrantAmount(quotaCreditBytes);
	const randomCount = Math.max(0, Math.floor(count));
	const totalRequested = randomCount + customCodes.length;
	if (totalRequested <= 0) throw new Error("Create at least one code.");
	if (totalRequested > MAX_CODES_PER_BATCH) {
		throw new Error(
			`Cannot create more than ${MAX_CODES_PER_BATCH} codes at once.`,
		);
	}

	const codesToInsert: {
		programId: string;
		code: string;
		createdBy?: string | null;
		quotaCreditBytes?: number;
	}[] = [];

	for (const rawCode of customCodes) {
		const customCode = normalizeCodeForProgram(program.prefix, rawCode);
		if (!customCode) continue;
		codesToInsert.push({
			programId,
			code: customCode,
			createdBy,
			quotaCreditBytes,
		});
	}

	for (let i = 0; i < randomCount; i++) {
		// Generate random hex string
		const randomPart = randomBytes(Math.ceil(length / 2))
			.toString("hex")
			.slice(0, length)
			.toUpperCase();

		// Format: PREFIX-XXXX-XXXX-XXXX-XXXX
		// Split into chunks of 4
		const chunks = randomPart.match(/.{1,4}/g)?.join("-") || randomPart;
		const code = `${program.prefix}-${chunks}`;

		codesToInsert.push({
			programId,
			code,
			createdBy,
			quotaCreditBytes,
		});
	}

	// Insert in batches if necessary, but for now just one go assuming sensible limits
	if (codesToInsert.length > 0) {
		const inserted = await db
			.insert(redemptionCodes)
			.values(codesToInsert)
			.onConflictDoNothing()
			.returning({
				code: redemptionCodes.code,
				quotaCreditBytes: redemptionCodes.quotaCreditBytes,
			});
		return inserted;
	}

	return [];
}

export async function getCodes(programId: string, page = 1, limit = 100) {
	const offset = (page - 1) * limit;

	const data = await db
		.select()
		.from(redemptionCodes)
		.where(eq(redemptionCodes.programId, programId))
		.limit(limit)
		.offset(offset)
		.orderBy(desc(redemptionCodes.createdAt));

	const [{ count: total }] = await db
		.select({ count: count() })
		.from(redemptionCodes)
		.where(eq(redemptionCodes.programId, programId));

	return {
		data,
		pagination: {
			page,
			limit,
			total,
			totalPages: Math.ceil(total / limit),
		},
	};
}

export async function getTransactions(programId: string, page = 1, limit = 50) {
	const safeLimit = Math.min(Math.max(limit, 1), 200);
	const safePage = Math.max(page, 1);
	const offset = (safePage - 1) * safeLimit;

	const data = await db
		.select()
		.from(redemptionTransactions)
		.where(eq(redemptionTransactions.programId, programId))
		.limit(safeLimit)
		.offset(offset)
		.orderBy(desc(redemptionTransactions.createdAt));

	const [{ count: total }] = await db
		.select({ count: count() })
		.from(redemptionTransactions)
		.where(eq(redemptionTransactions.programId, programId));

	return {
		data,
		pagination: {
			page: safePage,
			limit: safeLimit,
			total,
			totalPages: Math.max(1, Math.ceil(total / safeLimit)),
		},
	};
}

// --- Redemption ---

export async function checkRateLimit(ipAddress: string): Promise<boolean> {
	// Limit: 5 failed attempts in the last 15 minutes
	const windowMinutes = 15;
	const maxFailures = 5;
	const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

	const [{ count: failures }] = await db
		.select({ count: count() })
		.from(redemptionLogs)
		.where(
			and(
				eq(redemptionLogs.ipAddress, ipAddress),
				eq(redemptionLogs.success, false),
				gt(redemptionLogs.createdAt, windowStart),
			),
		);

	return failures >= maxFailures;
}

export function normalizeRedemptionCode(code: string) {
	const raw = code.trim();
	if (!raw) return "";

	try {
		const parsed = new URL(raw);
		const codeParam = parsed.searchParams.get("code");
		if (codeParam) return normalizeRedemptionCode(codeParam);
	} catch {
		// Not a URL; normalize as a code below.
	}

	return raw
		.toUpperCase()
		.replace(/[_\s]+/g, "-")
		.replace(/[^A-Z0-9-]/g, "")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function normalizeCodeForProgram(prefix: string, code: string) {
	const normalizedPrefix = normalizeRedemptionCode(prefix);
	const normalizedCode = normalizeRedemptionCode(code);
	if (!normalizedCode || !normalizedPrefix) return "";
	if (normalizedCode === normalizedPrefix) return "";
	if (normalizedCode.startsWith(`${normalizedPrefix}-`)) return normalizedCode;
	return `${normalizedPrefix}-${normalizedCode}`;
}

async function grantStorageToUser(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	userId: string,
	amountBytes: number,
) {
	await tx
		.update(users)
		.set({
			storageLimitBytes: sql`COALESCE(${users.storageLimitBytes}, (SELECT default_storage_limit_bytes FROM app_settings LIMIT 1)) + ${amountBytes}`,
		})
		.where(eq(users.id, userId));
}

export async function grantProgramStorage(params: {
	programId: string;
	amountBytes: number;
	userId?: string;
	email?: string;
	slackId?: string;
	actorUserId?: string;
	source: "api" | "admin";
	externalId?: string;
	reason?: string;
	ipAddress?: string;
	apiKeySuffix?: string | null;
	userAgent?: string | null;
}) {
	assertGrantAmount(params.amountBytes);

	const program = await getProgramById(params.programId);
	if (!program) throw new Error("Program not found");
	if (!program.isActive) throw new Error("Program is not active.");

	const targetUserId = normalizeOptionalText(params.userId);
	const targetEmail = normalizeEmail(params.email);
	const targetSlackId = normalizeOptionalText(params.slackId);
	const conditions = [];
	if (targetUserId) conditions.push(eq(users.id, targetUserId));
	if (targetEmail) conditions.push(eq(users.email, targetEmail));
	if (targetSlackId) conditions.push(eq(users.slackId, targetSlackId));
	if (!conditions.length) {
		throw new Error("Provide userId, email, or slackId.");
	}

	const [targetUser] = await db
		.select()
		.from(users)
		.where(conditions.length === 1 ? conditions[0] : or(...conditions))
		.limit(1);

	if (!targetUser && (!targetUserId || !isIdentityUserId(targetUserId))) {
		throw new Error("User not found.");
	}

	return db.transaction(async (tx) => {
		if (params.externalId) {
			const [existing] = await tx
				.select()
				.from(redemptionTransactions)
				.where(
					and(
						eq(redemptionTransactions.programId, params.programId),
						eq(redemptionTransactions.externalId, params.externalId),
					),
				)
				.limit(1);

			if (existing) {
				return {
					transaction: existing,
					program,
					user: targetUser || null,
					status: existing.userId ? "applied" : "pending",
					duplicate: true,
				};
			}
		}

		if (!targetUser) {
			const [transaction] = await tx
				.insert(redemptionTransactions)
				.values({
					programId: params.programId,
					userId: null,
					targetUserId,
					targetEmail,
					targetSlackId,
					actorUserId: params.actorUserId,
					source: params.source,
					externalId: params.externalId,
					amountBytes: params.amountBytes,
					reason: params.reason,
					ipAddress: params.ipAddress,
					apiKeySuffix: params.apiKeySuffix,
					requestUserAgent: params.userAgent,
				})
				.returning();

			return {
				transaction,
				program,
				user: null,
				status: "pending",
				duplicate: false,
			};
		}

		await grantStorageToUser(tx, targetUser.id, params.amountBytes);

		const [transaction] = await tx
			.insert(redemptionTransactions)
			.values({
				programId: params.programId,
				userId: targetUser.id,
				targetUserId: targetUser.id,
				targetEmail: targetEmail ?? targetUser.email,
				targetSlackId: targetSlackId ?? targetUser.slackId,
				actorUserId: params.actorUserId,
				source: params.source,
				externalId: params.externalId,
				amountBytes: params.amountBytes,
				reason: params.reason,
				ipAddress: params.ipAddress,
				apiKeySuffix: params.apiKeySuffix,
				requestUserAgent: params.userAgent,
				fulfilledAt: new Date(),
			})
			.returning();

		return {
			transaction,
			program,
			user: targetUser,
			status: "applied",
			duplicate: false,
		};
	});
}

export async function applyPendingProgramGrants(userId: string) {
	if (!isIdentityUserId(userId)) return [];

	return db.transaction(async (tx) => {
		const fulfilledAt = new Date();
		const applied = await tx
			.update(redemptionTransactions)
			.set({
				userId,
				fulfilledAt,
			})
			.where(
				and(
					eq(redemptionTransactions.targetUserId, userId),
					isNull(redemptionTransactions.userId),
					isNull(redemptionTransactions.fulfilledAt),
				),
			)
			.returning({
				id: redemptionTransactions.id,
				programId: redemptionTransactions.programId,
				amountBytes: redemptionTransactions.amountBytes,
				externalId: redemptionTransactions.externalId,
				reason: redemptionTransactions.reason,
				createdAt: redemptionTransactions.createdAt,
				fulfilledAt: redemptionTransactions.fulfilledAt,
			});

		if (!applied.length) return [];

		const totalBytes = applied.reduce(
			(total, transaction) => total + transaction.amountBytes,
			0,
		);
		await grantStorageToUser(tx, userId, totalBytes);

		const programs = await tx
			.select({
				id: redemptionPrograms.id,
				name: redemptionPrograms.name,
				prefix: redemptionPrograms.prefix,
			})
			.from(redemptionPrograms)
			.where(
				inArray(redemptionPrograms.id, [
					...new Set(applied.map((transaction) => transaction.programId)),
				]),
			);
		const programById = new Map(
			programs.map((program) => [program.id, program]),
		);

		return applied.map((transaction) => ({
			...transaction,
			program: programById.get(transaction.programId) || null,
		}));
	});
}

export async function redeemCode(
	code: string,
	userId: string,
	ipAddress: string,
) {
	const normalizedCode = normalizeRedemptionCode(code);

	// Check rate limit
	if (await checkRateLimit(ipAddress)) {
		throw new Error("Too many failed attempts. Please try again later.");
	}

	// Find code
	const [foundCode] = await db
		.select({
			code: redemptionCodes,
			program: redemptionPrograms,
		})
		.from(redemptionCodes)
		.innerJoin(
			redemptionPrograms,
			eq(redemptionCodes.programId, redemptionPrograms.id),
		)
		.where(eq(redemptionCodes.code, normalizedCode))
		.limit(1);

	if (!foundCode) {
		// Log failure
		await db.insert(redemptionLogs).values({
			ipAddress,
			userId,
			codeAttempted: normalizedCode,
			success: false,
		});
		throw new Error("Invalid code.");
	}

	if (foundCode.code.isRedeemed) {
		// Log failure (already redeemed)
		await db.insert(redemptionLogs).values({
			ipAddress,
			userId,
			codeAttempted: normalizedCode,
			success: false,
		});
		throw new Error("Code already redeemed.");
	}

	if (!foundCode.program.isActive) {
		await db.insert(redemptionLogs).values({
			ipAddress,
			userId,
			codeAttempted: normalizedCode,
			success: false,
		});
		throw new Error("This redemption program is no longer active.");
	}

	// Proceed with redemption
	try {
		const creditBytes =
			foundCode.code.quotaCreditBytes ?? foundCode.program.quotaCreditBytes;
		await db.transaction(async (tx) => {
			// 1. Mark code as redeemed
			const [claimedCode] = await tx
				.update(redemptionCodes)
				.set({
					isRedeemed: true,
					redeemedBy: userId,
					redeemedAt: new Date(),
				})
				.where(
					and(
						eq(redemptionCodes.id, foundCode.code.id),
						eq(redemptionCodes.isRedeemed, false),
					),
				)
				.returning({ id: redemptionCodes.id });

			if (!claimedCode) {
				await tx.insert(redemptionLogs).values({
					ipAddress,
					userId,
					codeAttempted: normalizedCode,
					success: false,
				});
				throw new Error("Code already redeemed.");
			}

			await grantStorageToUser(tx, userId, creditBytes);

			// 3. Log success
			await tx.insert(redemptionLogs).values({
				ipAddress,
				userId,
				codeAttempted: normalizedCode,
				success: true,
			});
			await tx.insert(redemptionTransactions).values({
				programId: foundCode.program.id,
				userId,
				targetUserId: userId,
				actorUserId: userId,
				source: "code",
				codeId: foundCode.code.id,
				amountBytes: creditBytes,
				reason: "Code redemption",
				ipAddress,
				fulfilledAt: new Date(),
			});
		});

		return {
			success: true,
			credits: creditBytes,
			programName: foundCode.program.name,
		};
	} catch (e) {
		if (e instanceof Error && e.message === "Code already redeemed.") {
			throw e;
		}
		console.error("Redemption transaction failed", e);
		throw new Error("Redemption failed due to system error.");
	}
}

import { db } from "../db";
import {
	redemptionPrograms,
	redemptionCodes,
	redemptionLogs,
	users,
} from "../db/schema";
import { eq, and, desc, sql, count, gt } from "drizzle-orm";
import { randomBytes } from "crypto";

export class RedemptionService {
	// --- Programs ---

	static async createProgram(data: {
		name: string;
		prefix: string;
		description?: string;
		quotaCreditBytes: number;
	}) {
		const [program] = await db
			.insert(redemptionPrograms)
			.values({
				name: data.name,
				prefix: data.prefix.toUpperCase(),
				description: data.description,
				quotaCreditBytes: data.quotaCreditBytes,
			})
			.returning();
		return program;
	}

	static async getPrograms() {
		return db.select().from(redemptionPrograms).orderBy(desc(redemptionPrograms.createdAt));
	}

	static async getProgramById(id: string) {
		const results = await db
			.select()
			.from(redemptionPrograms)
			.where(eq(redemptionPrograms.id, id))
			.limit(1);
		return results[0];
	}

	// --- Codes ---

	static async generateCodes(
		programId: string,
		count: number,
		length = 16, // Total length of random part (excluding dashes/prefix)
	) {
		const program = await this.getProgramById(programId);
		if (!program) throw new Error("Program not found");

		const codesToInsert: { programId: string; code: string }[] = [];

		for (let i = 0; i < count; i++) {
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
			});
		}

		// Insert in batches if necessary, but for now just one go assuming sensible limits
		if (codesToInsert.length > 0) {
			await db.insert(redemptionCodes).values(codesToInsert).onConflictDoNothing();
		}

		return codesToInsert.map((c) => c.code);
	}

	static async getCodes(programId: string, page = 1, limit = 100) {
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

	// --- Redemption ---

	static async checkRateLimit(ipAddress: string): Promise<boolean> {
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

	static async redeemCode(code: string, userId: string, ipAddress: string) {
		const normalizedCode = code.trim().toUpperCase();

		// Check rate limit
		if (await this.checkRateLimit(ipAddress)) {
			throw new Error("Too many failed attempts. Please try again later.");
		}

		// Find code
		      const [foundCode] = await db
            .select({
                code: redemptionCodes,
                program: redemptionPrograms
            })
            .from(redemptionCodes)
            .innerJoin(redemptionPrograms, eq(redemptionCodes.programId, redemptionPrograms.id))
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
			await db.transaction(async (tx) => {
				// 1. Mark code as redeemed
				await tx
					.update(redemptionCodes)
					.set({
						isRedeemed: true,
						redeemedBy: userId,
						redeemedAt: new Date(),
					})
					.where(eq(redemptionCodes.id, foundCode.code.id));

				// 2. Add quota to user
                // We need to fetch current user limit first or just increment if possible.
                // Drizzle increment: sql`${users.storageLimitBytes} + ${foundCode.program.quotaCreditBytes}`
                
                // Fetch user first to handle null storageLimitBytes (which implies default?)
                // Actually user.storageLimitBytes is nullable. If null, they use global default.
                // If we redeem, we probably want to set it to (current_effective + bonus).
                // Or if it's strictly an override, we set it.
                // But usually "redeem quota" means ADDING to what they have.
                // If they have NULL (default), we should resolve default + bonus.
                // BUT, to keep it simple: if null, we assume default 1GB (or whatever system setting)
                // However, I can't easily access system settings inside this static method without importing SettingsService.
                // Let's just update using SQL and coalesce.
                
                // Wait, if it's null, SQL `coalesce(storage_limit_bytes, 0) + X` might be weird if 0 isn't the default.
                // I should fetch the user and handle it in application logic to be safe, or just assume if it's null we start from a base + bonus.
                // The `users` table: `storageLimitBytes` is number, nullable.
                
                // Let's rely on application logic.
                const [user] = await tx.select().from(users).where(eq(users.id, userId));
                
                // If user has no custom limit, they are on default. 
                // We should probably NOT hardcode default here.
                // Let's assume we read the current limit. If null, we leave it null? No, we need to increase it.
                // If it is null, it means "System Default". If we redeem a code, we MUST set a specific limit now because they are deviating from default.
                // So we need to know the SYSTEM DEFAULT to add to it.
                
                // For now, let's assume if it's null, we treat it as 1GB (1073741824) as a fallback, or better, 
                // I should really fetch the app settings.
                
				await tx
					.update(users)
					.set({
                        // If null, we set it to (quota). But wait, if they had default (1GB) and redeem 1GB, they should have 2GB.
                        // So if null, we need (Default + Credit).
                        // I will fetch settings service in the handler, or here. 
                        // Let's just do a raw SQL update assuming a default if null for now to avoid circular deps or complex logic in transaction.
                        // Actually, I can import SettingsService.
                        
                        // Let's just do this:
						storageLimitBytes: sql`COALESCE(${users.storageLimitBytes}, (SELECT default_storage_limit_bytes FROM app_settings LIMIT 1)) + ${foundCode.program.quotaCreditBytes}`,
					})
					.where(eq(users.id, userId));

				// 3. Log success
				await tx.insert(redemptionLogs).values({
					ipAddress,
					userId,
					codeAttempted: normalizedCode,
					success: true,
				});
			});

            return {
                success: true,
                credits: foundCode.program.quotaCreditBytes,
                programName: foundCode.program.name
            };

		} catch (e) {
            console.error("Redemption transaction failed", e);
			throw new Error("Redemption failed due to system error.");
		}
	}
}

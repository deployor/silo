import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;
const confirmation = process.env.CONFIRM_REQUEST_LOG_ARCHIVE;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
if (confirmation !== "both-clickhouse-replicas-verified")
	throw new Error(
		"Set CONFIRM_REQUEST_LOG_ARCHIVE=both-clickhouse-replicas-verified only after backfill validation and a PostgreSQL backup",
	);

const pg = postgres(databaseUrl, { max: 1 });
try {
	await pg.begin(async (transaction) => {
		const [existing] = await transaction<{ exists: boolean }[]>`
			SELECT to_regclass('public.request_logs_pg_archive') IS NOT NULL AS exists
		`;
		if (existing?.exists)
			throw new Error("request_logs_pg_archive already exists");
		await transaction.unsafe(
			"ALTER TABLE request_logs RENAME TO request_logs_pg_archive",
		);
	});
	console.log(
		"PostgreSQL request_logs was renamed to request_logs_pg_archive. Keep it through the rollback window; drop it manually only after another verified backup.",
	);
} finally {
	await pg.end({ timeout: 5 });
}

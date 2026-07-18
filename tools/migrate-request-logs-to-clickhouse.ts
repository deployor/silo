import postgres from "postgres";

type LegacyRequestLog = {
	id: string;
	bucket_id: string | null;
	bucket_name: string | null;
	owner_id: string | null;
	requester_id: string | null;
	method: string;
	path: string;
	status_code: number | string;
	ingress_bytes: number | string | null;
	egress_bytes: number | string | null;
	ip_address: string | null;
	user_agent: string | null;
	latency_ms: number | string | null;
	created_at: Date;
};

const databaseUrl = process.env.SOURCE_DATABASE_URL || process.env.DATABASE_URL;
const endpoints = (process.env.CLICKHOUSE_INGEST_URLS || "")
	.split(",")
	.map((value) => value.trim().replace(/\/$/, ""))
	.filter((value) => value.startsWith("https://"));
const user = process.env.CLICKHOUSE_INGEST_USER || "silo_ingest";
const password = process.env.CLICKHOUSE_INGEST_PASSWORD || "";
const queryUser = process.env.CLICKHOUSE_QUERY_USER || "silo_query";
const queryPassword = process.env.CLICKHOUSE_QUERY_PASSWORD || "";
const batchSize = Math.max(
	1_000,
	Math.min(Number(process.env.MIGRATION_BATCH_SIZE || 10_000), 100_000),
);

if (!databaseUrl)
	throw new Error("SOURCE_DATABASE_URL or DATABASE_URL is required");
if (endpoints.length !== 2)
	throw new Error(
		"CLICKHOUSE_INGEST_URLS must contain exactly the EU and US HTTPS endpoints",
	);
if (!password) throw new Error("CLICKHOUSE_INGEST_PASSWORD is required");
if (!queryPassword) throw new Error("CLICKHOUSE_QUERY_PASSWORD is required");

const pg = postgres(databaseUrl, { max: 1, prepare: true });
let cursorTime = new Date(0);
let cursorId = "00000000-0000-0000-0000-000000000000";
let migrated = 0;

try {
	for (;;) {
		const rows = await pg<LegacyRequestLog[]>`
			SELECT id::text, bucket_id::text, bucket_name, owner_id, requester_id,
				method, path, status_code, ingress_bytes, egress_bytes,
				ip_address, user_agent, latency_ms, created_at
			FROM request_logs
			WHERE (created_at, id) > (${cursorTime}, ${cursorId}::uuid)
			ORDER BY created_at, id
			LIMIT ${batchSize}
		`;
		if (!rows.length) break;
		const body = rows
			.map((row) =>
				JSON.stringify({
					event_time: clickHouseTimestamp(row.created_at),
					request_id: row.id,
					region: "legacy",
					service: "silo-control-plane",
					instance: "postgres-backfill",
					storage_region: "",
					action: "legacy",
					bucket_id: row.bucket_id || "",
					bucket_name: row.bucket_name || "",
					owner_id: row.owner_id || "",
					requester_id: row.requester_id || "",
					method: row.method,
					path: row.path,
					status_code: Number(row.status_code),
					ingress_bytes: Number(row.ingress_bytes || 0),
					egress_bytes: Number(row.egress_bytes || 0),
					latency_ms: Number(row.latency_ms || 0),
					ip_address: row.ip_address || "",
					user_agent: row.user_agent || "",
				}),
			)
			.join("\n");
		await Promise.all(endpoints.map((endpoint) => insertBatch(endpoint, body)));
		const last = rows.at(-1);
		if (!last) throw new Error("migration batch unexpectedly became empty");
		cursorTime = last.created_at;
		cursorId = last.id;
		migrated += rows.length;
		console.log(
			`migrated ${migrated} request logs through ${cursorTime.toISOString()}`,
		);
	}

	const [{ count: pgCount }] = await pg<{ count: string }[]>`
		SELECT count(*)::text AS count FROM request_logs
	`;
	const replicaCounts = await Promise.all(endpoints.map(migratedDistinctCount));
	console.log(
		JSON.stringify(
			{
				postgresRows: Number(pgCount),
				clickhouseDistinctRequestIds: replicaCounts,
				verified: replicaCounts.every((count) => count === Number(pgCount)),
			},
			null,
			2,
		),
	);
	if (!replicaCounts.every((count) => count === Number(pgCount)))
		process.exitCode = 2;
} finally {
	await pg.end({ timeout: 5 });
}

async function insertBatch(endpoint: string, body: string): Promise<void> {
	const url = new URL(endpoint);
	url.searchParams.set("database", "silo_logs");
	url.searchParams.set("query", "INSERT INTO request_logs FORMAT JSONEachRow");
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Basic ${btoa(`${user}:${password}`)}`,
			"Content-Type": "application/x-ndjson",
		},
		body,
	});
	if (!response.ok)
		throw new Error(
			`${new URL(endpoint).host} insert failed (${response.status}): ${(await response.text()).slice(0, 500)}`,
		);
}

async function migratedDistinctCount(endpoint: string): Promise<number> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Basic ${btoa(`${queryUser}:${queryPassword}`)}`,
		},
		body: "SELECT uniqExact(request_id) FROM silo_logs.request_logs WHERE instance = 'postgres-backfill'",
	});
	if (!response.ok)
		throw new Error(
			`${new URL(endpoint).host} validation failed (${response.status})`,
		);
	return Number((await response.text()).trim());
}

function clickHouseTimestamp(value: Date): string {
	return value.toISOString().replace("T", " ").replace("Z", "");
}

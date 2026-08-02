import postgres from "postgres";

export type DatabaseRegion = "eu-central" | "us-east";

export type DatabaseProbe = {
	region: DatabaseRegion;
	reachable: boolean;
	role: "primary" | "replica" | "unknown";
	inRecovery?: boolean;
	walLsn?: string;
	receiveLsn?: string;
	replayLsn?: string;
	replayAgeSeconds?: number;
	generation?: number;
	activeRegion?: string;
	synchronousStandbys?: string;
	synchronousCommit?: string;
	defaultTransactionReadOnly?: boolean;
	replication: Array<{
		applicationName: string;
		state: string;
		syncState: string;
		writeLsn?: string;
		flushLsn?: string;
		replayLsn?: string;
	}>;
	error?: string;
};

type HyperdriveLike = { connectionString: string };

export async function probeDatabase(
	region: DatabaseRegion,
	binding: HyperdriveLike | undefined,
): Promise<DatabaseProbe> {
	if (!binding)
		return {
			region,
			reachable: false,
			role: "unknown",
			replication: [],
			error: "Hyperdrive binding is not configured",
		};
	try {
		return await withDatabase(binding, async (sql) => {
			const [row] = await sql<
				{
					in_recovery: boolean;
					wal_lsn: string | null;
					receive_lsn: string | null;
					replay_lsn: string | null;
					replay_age_seconds: number | null;
					generation: string | number;
					active_region: string;
					synchronous_standbys: string;
					synchronous_commit: string;
					default_transaction_read_only: boolean;
				}[]
			>`
				SELECT
					pg_is_in_recovery() AS in_recovery,
					CASE WHEN pg_is_in_recovery() THEN pg_last_wal_replay_lsn()::text ELSE pg_current_wal_lsn()::text END AS wal_lsn,
					pg_last_wal_receive_lsn()::text AS receive_lsn,
					pg_last_wal_replay_lsn()::text AS replay_lsn,
					CASE
						WHEN pg_is_in_recovery() AND pg_last_xact_replay_timestamp() IS NOT NULL
						THEN EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp())::double precision
						ELSE NULL
					END AS replay_age_seconds,
					h.generation,
					h.active_region,
					current_setting('synchronous_standby_names') AS synchronous_standbys,
					current_setting('synchronous_commit') AS synchronous_commit
					, current_setting('default_transaction_read_only')::boolean AS default_transaction_read_only
				FROM database_ha_state h
				WHERE h.singleton = true
			`;
			if (!row) throw new Error("database_ha_state singleton is missing");
			const replication = row.in_recovery
				? []
				: await sql<
						{
							application_name: string;
							state: string;
							sync_state: string;
							write_lsn: string | null;
							flush_lsn: string | null;
							replay_lsn: string | null;
						}[]
					>`
						SELECT application_name, state, sync_state,
							write_lsn::text, flush_lsn::text, replay_lsn::text
						FROM pg_stat_replication
						ORDER BY application_name
					`;
			return {
				region,
				reachable: true,
				role: row.in_recovery ? "replica" : "primary",
				inRecovery: row.in_recovery,
				walLsn: row.wal_lsn ?? undefined,
				receiveLsn: row.receive_lsn ?? undefined,
				replayLsn: row.replay_lsn ?? undefined,
				replayAgeSeconds: row.replay_age_seconds ?? undefined,
				generation: Number(row.generation),
				activeRegion: row.active_region,
				synchronousStandbys: row.synchronous_standbys,
				synchronousCommit: row.synchronous_commit,
				defaultTransactionReadOnly: row.default_transaction_read_only,
				replication: replication.map((item) => ({
					applicationName: item.application_name,
					state: item.state,
					syncState: item.sync_state,
					writeLsn: item.write_lsn ?? undefined,
					flushLsn: item.flush_lsn ?? undefined,
					replayLsn: item.replay_lsn ?? undefined,
				})),
			};
		});
	} catch (error) {
		return {
			region,
			reachable: false,
			role: "unknown",
			replication: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function promotionEligible(
	probe: DatabaseProbe,
	expectedGeneration: number,
): boolean {
	return (
		probe.reachable &&
		probe.role === "replica" &&
		probe.generation === expectedGeneration &&
		Boolean(probe.replayLsn) &&
		probe.receiveLsn === probe.replayLsn &&
		(probe.replayAgeSeconds ?? Number.POSITIVE_INFINITY) <= 15
	);
}

export async function promoteDatabase(
	region: DatabaseRegion,
	binding: HyperdriveLike,
	expectedGeneration: number,
	appRole: string,
	databaseName: string,
): Promise<DatabaseProbe> {
	if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1)
		throw new Error("expected database generation is invalid");
	const before = await probeDatabase(region, binding);
	if (!promotionEligible(before, expectedGeneration))
		throw new Error("replica did not pass the lossless promotion gate");
	await withDatabase(binding, async (sql) => {
		const [{ promoted }] = await sql<{ promoted: boolean }[]>`
			SELECT pg_promote(true, 60) AS promoted
		`;
		if (!promoted) throw new Error("PostgreSQL promotion did not complete");
		await sql.unsafe("SET default_transaction_read_only = 'off'");
		await sql.unsafe("ALTER SYSTEM SET synchronous_standby_names = ''");
		await sql.unsafe("ALTER SYSTEM SET default_transaction_read_only = 'off'");
		await sql`SELECT pg_reload_conf()`;
		const updated = await sql`
			UPDATE database_ha_state
			SET generation = generation + 1,
				active_region = ${region},
				promoted_at = now(),
				updated_at = now()
			WHERE singleton = true AND generation = ${expectedGeneration}
			RETURNING generation
		`;
		if (updated.length !== 1)
			throw new Error("database generation compare-and-swap failed");
		await sql.unsafe(
			`GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${identifier(appRole)}`,
		);
	});
	const after = await probeDatabase(region, binding);
	if (
		!after.reachable ||
		after.role !== "primary" ||
		after.generation !== expectedGeneration + 1 ||
		after.activeRegion !== region
	)
		throw new Error("promoted database did not confirm its new generation");
	return after;
}

export async function fenceDatabase(
	binding: HyperdriveLike,
	appRole: string,
	databaseName: string,
): Promise<void> {
	await withDatabase(binding, async (sql) => {
		await sql.unsafe(
			`REVOKE CONNECT ON DATABASE ${identifier(databaseName)} FROM ${identifier(appRole)}`,
		);
		await sql.unsafe("ALTER SYSTEM SET default_transaction_read_only = 'on'");
		await sql`SELECT pg_reload_conf()`;
		await sql`
			SELECT pg_terminate_backend(pid)
			FROM pg_stat_activity
			WHERE usename = ${appRole} AND pid <> pg_backend_pid()
		`;
	});
}

export async function unfenceDatabase(
	binding: HyperdriveLike,
	appRole: string,
	databaseName: string,
	expectedGeneration: number,
	expectedRegion: DatabaseRegion,
): Promise<void> {
	await withDatabase(binding, async (sql) => {
		const [state] = await sql<
			{
				in_recovery: boolean;
				generation: string | number;
				active_region: string;
			}[]
		>`
			SELECT pg_is_in_recovery() AS in_recovery, generation, active_region
			FROM database_ha_state WHERE singleton = true
		`;
		if (
			!state ||
			state.in_recovery ||
			Number(state.generation) !== expectedGeneration ||
			state.active_region !== expectedRegion
		)
			throw new Error("database generation does not authorize unfencing");
		await sql.unsafe("SET default_transaction_read_only = 'off'");
		await sql.unsafe("ALTER SYSTEM SET default_transaction_read_only = 'off'");
		await sql.unsafe(
			`GRANT CONNECT ON DATABASE ${identifier(databaseName)} TO ${identifier(appRole)}`,
		);
		await sql`SELECT pg_reload_conf()`;
	});
}

export async function enableSynchronousReplication(
	binding: HyperdriveLike,
	standbyApplicationName: string,
	expectedGeneration: number,
): Promise<void> {
	if (!/^[a-zA-Z0-9_-]+$/.test(standbyApplicationName))
		throw new Error("standby application name is invalid");
	await withDatabase(binding, async (sql) => {
		const [state] = await sql<
			{
				in_recovery: boolean;
				generation: string | number;
				streaming: boolean;
			}[]
		>`
			SELECT pg_is_in_recovery() AS in_recovery, h.generation,
				EXISTS (
					SELECT 1 FROM pg_stat_replication
					WHERE application_name = ${standbyApplicationName}
						AND state = 'streaming'
						AND flush_lsn = pg_current_wal_lsn()
				) AS streaming
			FROM database_ha_state h WHERE h.singleton = true
		`;
		if (
			!state ||
			state.in_recovery ||
			Number(state.generation) !== expectedGeneration ||
			!state.streaming
		)
			throw new Error("standby is not caught up with the current primary");
		await sql.unsafe("SET default_transaction_read_only = 'off'");
		await sql.unsafe(
			`ALTER SYSTEM SET synchronous_standby_names = 'FIRST 1 ("${standbyApplicationName}")'`,
		);
		await sql.unsafe("ALTER SYSTEM SET synchronous_commit = 'on'");
		await sql.unsafe("ALTER SYSTEM SET default_transaction_read_only = 'off'");
		await sql`SELECT pg_reload_conf()`;
	});
}

async function withDatabase<T>(
	binding: HyperdriveLike,
	callback: (sql: ReturnType<typeof postgres>) => Promise<T>,
): Promise<T> {
	const sql = postgres(binding.connectionString, {
		max: 1,
		prepare: false,
		connect_timeout: 5,
		idle_timeout: 5,
		max_lifetime: 30,
	});
	try {
		return await callback(sql);
	} finally {
		await sql.end({ timeout: 2 });
	}
}

function identifier(value: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value))
		throw new Error("unsafe PostgreSQL identifier");
	return `"${value.replaceAll('"', '""')}"`;
}

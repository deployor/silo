import {
	type DatabaseProbe,
	enableSynchronousReplication,
	fenceDatabase,
	probeDatabase,
	promoteDatabase,
	promotionEligible,
	unfenceDatabase,
} from "./database-ha";

type ComponentStatus = "operational" | "degraded" | "outage" | "unknown";
type OverallStatus = "operational" | "degraded" | "major_outage";
type RegionPhase =
	| "normal"
	| "investigating"
	| "ready"
	| "activating"
	| "active"
	| "failing_back"
	| "credential_cleanup"
	| "blocked";
type ProviderPhase =
	| "normal"
	| "investigating"
	| "ready"
	| "promoting"
	| "replica_active"
	| "blocked";

type BackendConfig = {
	id: string;
	label: string;
	provider: string;
	role: "primary" | "replica";
	canaryRef: string;
};

type RegionConfig = {
	id: string;
	label: string;
	flag: string;
	origin: string;
	endpointHosts: string[];
	default: boolean;
	backends: BackendConfig[];
};

type CanaryCredential = {
	endpoint: string;
	bucket: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	signingRegion: string;
	prefix: string;
	addressingStyle: "path" | "virtual";
};

type OperationChecks = {
	configured: boolean;
	authentication: boolean;
	upload: boolean;
	download: boolean;
	delete: boolean;
};

type ReplicationGate = {
	caughtUp: boolean;
	fresh: boolean;
	authorized: boolean;
	checkpoint?: string;
	checkpointAgeSeconds?: number;
	lagObjects?: number;
};

type AccountingReadiness = {
	durable: boolean;
	pending: number;
	unsafe: boolean;
};

type ReadinessChecks = {
	ok: boolean;
	region?: string;
	postgres?: boolean;
	regionalSchema?: boolean;
	redis?: boolean;
	accounting?: AccountingReadiness;
	storage?: boolean;
	storageRegions: Record<string, boolean>;
	failoverRegions: string[];
	activeWriterRegions: Record<string, number>;
	activeStorageBackends: Record<string, string>;
	backendGenerations: Record<string, number>;
	storageBackends: Record<string, Record<string, boolean>>;
	replication: Record<string, Record<string, ReplicationGate>>;
};

type DataplaneProbe = {
	health: boolean;
	readiness: ReadinessChecks;
};

type BackendProbe = {
	checks: OperationChecks;
	operational: boolean;
};

type RegionRuntime = {
	phase: RegionPhase;
	providerPhase: ProviderPhase;
	activeDataplane: string;
	failoverDataplane?: string;
	activeBackend: string;
	writerGeneration?: number;
	backendGeneration?: number;
	consecutiveFailures: number;
	consecutiveRecoveries: number;
	recoveryHealthySince?: string;
	cleanupAfter?: string;
	cleanupNotified: boolean;
	cleanupRequested: boolean;
	manualRecoveryLock: boolean;
	backendFailures: Record<string, number>;
};

type StatusState = {
	overall: OverallStatus;
	components: Record<string, ComponentStatus>;
	regions: Record<string, RegionRuntime>;
	database: {
		phase: "normal" | "investigating" | "promoting" | "active" | "blocked";
		activeRegion: "eu-central" | "us-east";
		generation: number;
		consecutiveFailures: number;
		synchronousConfirmed: boolean;
	};
	activeIncidentId?: string;
	productionMaintenance?: {
		title: string;
		message: string;
		startsAt: string;
		lastVerifiedAt: string;
	};
	updatedAt: string;
};

type MonitorSnapshot = {
	dashboard: boolean;
	database?: Record<"eu-central" | "us-east", DatabaseProbe>;
	clickhouse?: Record<"eu-central" | "us-east", ClickHouseProbe>;
	dataplanes: Record<string, DataplaneProbe>;
	backends: Record<string, Record<string, BackendProbe>>;
	logical: Record<string, OperationChecks>;
	homeReadOnly: Record<string, boolean>;
};

type ClickHouseProbe = {
	reachable: boolean;
	recentRows: number;
	latestEventAt?: string;
	error?: string;
};

type ComponentDefinition = {
	id: string;
	name: string;
	description: string;
	group: "global" | "regional" | "backends";
};

const STATE_ID = "regional-v1";
const FAILURE_THRESHOLD = 5;
const RECOVERY_THRESHOLD = 10;
const RECOVERY_STABILITY_MS = 10 * 60_000;
const DNS_GRACE_MS = 10 * 60_000;
const CHECK_TIMEOUT_MS = 12_000;
const MUTATION_TIMEOUT_MS = 60_000;
const MONITOR_LEASE_MS = 4 * 60_000;
const AUTHORIZATION_POLL_MS = 2_000;
const AUTHORIZATION_TIMEOUT_MS = 55_000;

export default {
	async scheduled(
		_controller: ScheduledController,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(runMonitor(env));
	},
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			const registry = parseRegistry(env.REGION_REGISTRY);
			if (
				registry.some((region) => region.endpointHosts.includes(url.hostname))
			)
				return outageFallback(request);
			if (url.hostname === env.DASHBOARD_DNS_NAME)
				return dashboardStatusRedirect();
			if (request.method === "OPTIONS")
				return corsPreflight(request, env, url.pathname);
			if (request.method === "GET" && url.pathname === "/api/status")
				return json(await publicStatus(env, registry));
			if (
				url.pathname === "/api/admin/incidents" ||
				url.pathname.startsWith("/api/admin/incidents/") ||
				url.pathname.startsWith("/api/admin/notes/")
			)
				return incidentAdmin(request, env, url.pathname, registry);
			if (
				url.pathname === "/api/admin/maintenance" ||
				url.pathname.startsWith("/api/admin/maintenance/")
			)
				return maintenanceAdmin(request, env, url.pathname);
			if (request.method === "GET" && url.pathname === "/api/admin/operations")
				return operationsAdmin(request, env, registry);
			if (request.method === "POST" && url.pathname.startsWith("/api/admin/"))
				return operationsAction(request, env, url.pathname.slice(11), registry);
			return json({ error: "not found" }, 404);
		} catch (error) {
			logError("request_failed", error, {
				method: request.method,
				path: url.pathname,
			});
			if (url.pathname.startsWith("/api/admin/"))
				return adminJson(request, env, { error: errorMessage(error) }, 500);
			return json({ error: "request failed" }, 500);
		}
	},
} satisfies ExportedHandler<Env>;

async function runMonitor(env: Env): Promise<void> {
	const leaseHolder = crypto.randomUUID();
	if (!(await acquireMonitorLease(env, leaseHolder))) {
		console.log(
			JSON.stringify({
				event: "regional_monitor_skipped",
				reason: "monitor lease is held",
			}),
		);
		return;
	}
	try {
		const registry = parseRegistry(env.REGION_REGISTRY);
		const state = await getState(env, registry);
		await refreshProductionMaintenance(env, state);
		const plannedMaintenance = Boolean(
			state.productionMaintenance || (await getActiveMaintenance(env)),
		);
		const snapshot = await takeSnapshot(env, registry, state);
		try {
			await processDatabaseHealth(env, state, snapshot);
		} catch (error) {
			state.database.phase = "blocked";
			logError("database_ha_automation_blocked", error, {
				activeRegion: state.database.activeRegion,
				generation: state.database.generation,
			});
		}

		for (const region of registry) {
			const providerWasBlocked =
				state.regions[region.id].providerPhase === "blocked";
			try {
				await processProviderHealth(
					env,
					state,
					snapshot,
					region,
					plannedMaintenance,
				);
			} catch (error) {
				state.regions[region.id].providerPhase = "blocked";
				if (providerWasBlocked)
					logError("regional_automation_still_blocked", error, {
						region: region.id,
						subsystem: "provider",
					});
				else
					await recordAutomationFailure(env, state, region, "provider", error);
			}
			const dataplaneWasBlocked = state.regions[region.id].phase === "blocked";
			try {
				await processDataplaneHealth(
					env,
					registry,
					state,
					snapshot,
					region,
					plannedMaintenance,
				);
			} catch (error) {
				state.regions[region.id].phase = "blocked";
				if (dataplaneWasBlocked)
					logError("regional_automation_still_blocked", error, {
						region: region.id,
						subsystem: "dataplane",
					});
				else
					await recordAutomationFailure(env, state, region, "dataplane", error);
			}
		}

		state.components = deriveComponents(registry, state, snapshot);
		state.overall = deriveOverall(registry, state.components);
		if (plannedMaintenance) {
			state.overall = "degraded";
			for (const [id, value] of Object.entries(state.components)) {
				if (value === "outage") state.components[id] = "degraded";
			}
		}

		const allNormal = registry.every((region) => {
			const runtime = state.regions[region.id];
			return runtime.phase === "normal" && runtime.providerPhase === "normal";
		});
		if (
			allNormal &&
			state.overall === "operational" &&
			state.activeIncidentId
		) {
			await resolveIncident(
				env,
				state,
				"All regional dataplanes, active storage backends, and signed S3 canaries recovered.",
			);
		}

		state.updatedAt = new Date().toISOString();
		await recordAvailability(env, state, plannedMaintenance);
		await putState(env, state);
		console.log(
			JSON.stringify({
				event: "regional_monitor_complete",
				overall: state.overall,
				components: state.components,
				regions: publicRegionStates(registry, state),
				updatedAt: state.updatedAt,
			}),
		);
	} finally {
		await releaseMonitorLease(env, leaseHolder).catch((error) =>
			logError("monitor_lease_release_failed", error),
		);
	}
}

async function acquireMonitorLease(env: Env, holder: string): Promise<boolean> {
	const now = new Date().toISOString();
	const expiresAt = new Date(Date.now() + MONITOR_LEASE_MS).toISOString();
	await env.DB.prepare(
		"INSERT OR IGNORE INTO status_monitor_leases (id, holder, expires_at) VALUES (?, ?, ?)",
	)
		.bind(STATE_ID, holder, expiresAt)
		.run();
	const result = await env.DB.prepare(
		"UPDATE status_monitor_leases SET holder = ?, expires_at = ? WHERE id = ? AND (holder = ? OR datetime(expires_at) <= datetime(?))",
	)
		.bind(holder, expiresAt, STATE_ID, holder, now)
		.run();
	return Number(result.meta.changes || 0) === 1;
}

async function releaseMonitorLease(env: Env, holder: string): Promise<void> {
	await env.DB.prepare(
		"DELETE FROM status_monitor_leases WHERE id = ? AND holder = ?",
	)
		.bind(STATE_ID, holder)
		.run();
}

async function processDatabaseHealth(
	env: Env,
	state: StatusState,
	snapshot: MonitorSnapshot,
): Promise<void> {
	if (!snapshot.database) return;
	const databaseEnv = env as Env & {
		DATABASE_EU?: Hyperdrive;
		DATABASE_US?: Hyperdrive;
		AUTO_FAILOVER_DATABASE?: string;
		DATABASE_APP_ROLE?: string;
		DATABASE_NAME?: string;
	};
	const probes = Object.values(snapshot.database);
	const primaries = probes.filter(
		(probe) => probe.reachable && probe.role === "primary",
	);
	if (primaries.length > 1) {
		const authoritative = primaries.find(
			(probe) =>
				probe.region === state.database.activeRegion &&
				probe.generation === state.database.generation,
		);
		for (const stale of primaries.filter((probe) => probe !== authoritative)) {
			const binding =
				stale.region === "eu-central"
					? databaseEnv.DATABASE_EU
					: databaseEnv.DATABASE_US;
			if (binding)
				await fenceDatabase(
					binding,
					databaseEnv.DATABASE_APP_ROLE || "silo_app",
					databaseEnv.DATABASE_NAME || "silo",
				);
		}
		throw new Error(
			"multiple PostgreSQL primaries detected; stale nodes fenced",
		);
	}

	const active = snapshot.database[state.database.activeRegion];
	if (
		active.reachable &&
		active.role === "primary" &&
		active.activeRegion === state.database.activeRegion
	) {
		if (active.defaultTransactionReadOnly) {
			const binding =
				state.database.activeRegion === "eu-central"
					? databaseEnv.DATABASE_EU
					: databaseEnv.DATABASE_US;
			if (!binding)
				throw new Error("active database Hyperdrive binding is missing");
			await unfenceDatabase(
				binding,
				databaseEnv.DATABASE_APP_ROLE || "silo_app",
				databaseEnv.DATABASE_NAME || "silo",
				state.database.generation,
				state.database.activeRegion,
			);
		}
		state.database.phase =
			state.database.activeRegion === "eu-central" ? "normal" : "active";
		state.database.generation = active.generation || state.database.generation;
		state.database.consecutiveFailures = 0;
		state.database.synchronousConfirmed ||= active.replication.some(
			(peer) => peer.state === "streaming" && peer.syncState === "sync",
		);
		return;
	}

	state.database.consecutiveFailures += 1;
	state.database.phase = "investigating";
	if (state.database.consecutiveFailures < FAILURE_THRESHOLD) return;
	const candidateRegion =
		state.database.activeRegion === "eu-central" ? "us-east" : "eu-central";
	const candidate = snapshot.database[candidateRegion];
	if (
		!state.database.synchronousConfirmed ||
		!promotionEligible(candidate, state.database.generation)
	) {
		state.database.phase = "blocked";
		return;
	}
	if (
		databaseEnv.AUTO_FAILOVER_DATABASE !== "true" ||
		env.FAILOVER_DRILL_APPROVED !== "true"
	) {
		state.database.phase = "blocked";
		return;
	}
	const binding =
		candidateRegion === "eu-central"
			? databaseEnv.DATABASE_EU
			: databaseEnv.DATABASE_US;
	if (!binding) throw new Error("promotion Hyperdrive binding is missing");
	state.database.phase = "promoting";
	const promoted = await promoteDatabase(
		candidateRegion,
		binding,
		state.database.generation,
		databaseEnv.DATABASE_APP_ROLE || "silo_app",
		databaseEnv.DATABASE_NAME || "silo",
	);
	state.database.activeRegion = candidateRegion;
	state.database.generation =
		promoted.generation || state.database.generation + 1;
	state.database.consecutiveFailures = 0;
	state.database.synchronousConfirmed = false;
	state.database.phase = candidateRegion === "eu-central" ? "normal" : "active";
}

async function recordAutomationFailure(
	env: Env,
	state: StatusState,
	region: RegionConfig,
	subsystem: "dataplane" | "provider",
	error: unknown,
): Promise<void> {
	logError("regional_automation_blocked", error, {
		region: region.id,
		subsystem,
	});
	await ensureIncident(
		env,
		state,
		`${region.flag} ${region.label} ${subsystem} automation hit a safety gate. No additional traffic or storage transition was attempted.`,
		`${region.label} automation blocked`,
	);
	await addUpdate(
		env,
		state,
		"identified",
		`${region.flag} ${region.label} ${subsystem} failover is blocked pending operator review.`,
	);
	await notifyMaintainers(
		env,
		"regional_automation_blocked",
		`${region.id} ${subsystem} automation blocked: ${errorMessage(error)}`,
	);
}

async function processDataplaneHealth(
	env: Env,
	registry: RegionConfig[],
	state: StatusState,
	snapshot: MonitorSnapshot,
	region: RegionConfig,
	plannedMaintenance: boolean,
): Promise<void> {
	const runtime = state.regions[region.id];
	const home = snapshot.dataplanes[region.id];
	const activeBackendHealthy =
		snapshot.backends[region.id]?.[runtime.activeBackend]?.operational === true;
	const logicalHealthy = operationChecksPassed(snapshot.logical[region.id]);
	const homeAvailable = dataplaneAvailable(home);
	if (
		home?.health &&
		home.readiness.accounting?.unsafe === true &&
		runtime.phase !== "active"
	) {
		const newlyBlocked = runtime.phase !== "blocked";
		runtime.phase = "blocked";
		if (newlyBlocked)
			await ensureIncident(
				env,
				state,
				`${region.flag} ${region.label} reports an unsafe accounting spool. Automated writer transfer is blocked until it is reconciled.`,
				`${region.label} accounting safety block`,
			);
		return;
	}

	if (runtime.phase === "active") {
		const active = snapshot.dataplanes[runtime.activeDataplane];
		if (!dataplaneAvailable(active) || !logicalHealthy) {
			await ensureIncident(
				env,
				state,
				`${region.flag} ${region.label} failover traffic is not passing its protected checks.`,
				"Regional failover disruption",
			);
		}
		const recovered =
			homeAvailable && snapshot.homeReadOnly[region.id] && activeBackendHealthy;
		if (recovered) {
			runtime.recoveryHealthySince ||= new Date().toISOString();
			runtime.consecutiveRecoveries += 1;
		} else {
			runtime.recoveryHealthySince = undefined;
			runtime.consecutiveRecoveries = 0;
		}
		const stable =
			runtime.recoveryHealthySince &&
			Date.now() - Date.parse(runtime.recoveryHealthySince) >=
				RECOVERY_STABILITY_MS;
		if (
			!plannedMaintenance &&
			!runtime.manualRecoveryLock &&
			env.AUTO_RECOVER !== "false" &&
			stable &&
			runtime.consecutiveRecoveries >= RECOVERY_THRESHOLD
		) {
			await failbackDataplane(env, state, snapshot, region, runtime);
		}
		return;
	}

	if (runtime.phase === "credential_cleanup") {
		const homeStillHealthy =
			homeAvailable && operationChecksPassed(snapshot.logical[region.id]);
		if (!homeStillHealthy && runtime.failoverDataplane) {
			const target = runtime.failoverDataplane;
			if (
				dataplaneAvailable(snapshot.dataplanes[target]) &&
				(eligibleFailoverTarget(registry, snapshot, region.id, target) ||
					hasFailoverHook(env.FAILOVER_ACTIVATION_URLS, region.id, target))
			) {
				await activateDataplaneFailover(env, state, snapshot, region, target);
			}
			return;
		}
		if (
			runtime.cleanupAfter &&
			Date.parse(runtime.cleanupAfter) <= Date.now() &&
			runtime.failoverDataplane
		) {
			if (
				!runtime.cleanupRequested &&
				hasFailoverHook(
					env.FAILOVER_DEACTIVATION_URLS,
					region.id,
					runtime.failoverDataplane,
				)
			) {
				await callFailoverHook(
					env,
					"deactivate",
					region.id,
					runtime.failoverDataplane,
				);
				runtime.cleanupRequested = true;
				await addUpdate(
					env,
					state,
					"monitoring",
					`${region.flag} ${region.label} DNS grace completed; remote credentials are being revoked from ${runtime.failoverDataplane}.`,
				);
			}
			const standby = snapshot.dataplanes[runtime.failoverDataplane];
			if (
				dataplaneAvailable(standby) &&
				!standby.readiness.failoverRegions.includes(region.id)
			) {
				runtime.phase = "normal";
				runtime.failoverDataplane = undefined;
				runtime.cleanupAfter = undefined;
				runtime.cleanupNotified = false;
				runtime.cleanupRequested = false;
				runtime.consecutiveFailures = 0;
				runtime.consecutiveRecoveries = 0;
				runtime.recoveryHealthySince = undefined;
				await addUpdate(
					env,
					state,
					"resolved",
					`${region.flag} ${region.label} DNS grace completed and the remote Infisical credential was revoked.`,
				);
			} else if (!runtime.cleanupNotified) {
				runtime.cleanupNotified = true;
				await addUpdate(
					env,
					state,
					"monitoring",
					`${region.flag} ${region.label} is healthy at home. Recovery remains open until the remote failover credential is removed from ${runtime.failoverDataplane}.`,
				);
				await notifyMaintainers(
					env,
					"credential_cleanup_required",
					`Remove ${region.id} failover credentials from ${runtime.failoverDataplane} after DNS grace.`,
				);
			}
		}
		return;
	}

	if (plannedMaintenance) {
		runtime.consecutiveFailures = 0;
		runtime.phase = "normal";
		return;
	}

	// A physical backend outage is handled by the provider state machine and
	// must never masquerade as a dataplane outage.
	const dataplaneFailure =
		!homeAvailable || (!logicalHealthy && activeBackendHealthy);
	if (!dataplaneFailure) {
		runtime.consecutiveFailures = 0;
		if (["investigating", "ready", "blocked"].includes(runtime.phase))
			runtime.phase = "normal";
		return;
	}

	runtime.consecutiveFailures += 1;
	if (runtime.consecutiveFailures === 1) {
		runtime.phase = "investigating";
		await ensureIncident(
			env,
			state,
			`${region.flag} ${region.label} dataplane failed its first complete protected check. Traffic has not moved.`,
			`${region.label} dataplane disruption`,
		);
		await notifyMaintainers(
			env,
			"regional_investigating",
			`${region.id} failed its first complete dataplane check.`,
		);
	}
	if (runtime.consecutiveFailures < FAILURE_THRESHOLD) return;
	if (!activeBackendHealthy) {
		runtime.phase = "blocked";
		return;
	}

	const target = chooseFailoverCandidate(env, registry, snapshot, region.id);
	if (!target) {
		runtime.phase = "blocked";
		if (runtime.consecutiveFailures === FAILURE_THRESHOLD) {
			await addUpdate(
				env,
				state,
				"identified",
				`${region.flag} ${region.label} failed five checks, but no surviving dataplane reports authorized access to its active backend. DNS and writer ownership were left unchanged.`,
			);
			await notifyMaintainers(
				env,
				"failover_authorization_required",
				`Authorize ${region.id} on a healthy peer through Infisical; no traffic was moved.`,
			);
		}
		return;
	}

	runtime.phase = "ready";
	if (autoActivate(env))
		await activateDataplaneFailover(env, state, snapshot, region, target);
}

async function processProviderHealth(
	env: Env,
	state: StatusState,
	snapshot: MonitorSnapshot,
	region: RegionConfig,
	plannedMaintenance: boolean,
): Promise<void> {
	const runtime = state.regions[region.id];
	const serving = snapshot.dataplanes[runtime.activeDataplane];
	const authoritativeActive =
		serving?.readiness.activeStorageBackends[region.id];
	if (
		authoritativeActive &&
		region.backends.some((backend) => backend.id === authoritativeActive)
	)
		runtime.activeBackend = authoritativeActive;
	const activeProbe = snapshot.backends[region.id]?.[runtime.activeBackend];
	const activeHealthy = activeProbe?.operational === true;
	const defaultBackend = primaryBackend(region).id;

	if (activeHealthy) {
		runtime.backendFailures[runtime.activeBackend] = 0;
		runtime.providerPhase =
			runtime.activeBackend === defaultBackend ? "normal" : "replica_active";
		return;
	}
	if (plannedMaintenance || !activeProbe?.checks.configured) return;

	runtime.backendFailures[runtime.activeBackend] =
		(runtime.backendFailures[runtime.activeBackend] || 0) + 1;
	const failures = runtime.backendFailures[runtime.activeBackend];
	if (failures === 1) {
		runtime.providerPhase = "investigating";
		await ensureIncident(
			env,
			state,
			`${region.flag} ${region.label} active physical backend ${runtime.activeBackend} failed its first direct signed canary.`,
			`${region.label} storage disruption`,
		);
	}
	if (failures < FAILURE_THRESHOLD) return;

	const candidate = chooseBackendCandidate(region, runtime, snapshot);
	if (!candidate) {
		runtime.providerPhase = "blocked";
		if (failures === FAILURE_THRESHOLD)
			await addUpdate(
				env,
				state,
				"identified",
				`${region.flag} ${region.label} active backend failed five canaries. No replica reported a fresh, caught-up, explicitly authorized checkpoint, so promotion was refused.`,
			);
		return;
	}
	runtime.providerPhase = "ready";
	if (autoPromoteStorage(env))
		await promoteBackend(env, state, snapshot, region, runtime, candidate);
}

async function activateDataplaneFailover(
	env: Env,
	state: StatusState,
	snapshot: MonitorSnapshot,
	region: RegionConfig,
	targetRegionId: string,
): Promise<void> {
	const runtime = state.regions[region.id];
	runtime.phase = "activating";
	runtime.failoverDataplane = targetRegionId;
	await ensureFailoverAuthorization(env, region.id, targetRegionId);
	const authorized = await checkReadiness(
		`${targetOrigin(env, targetRegionId)}/ready`,
		env.DATAPLANE_INTERNAL_SECRET,
	);
	if (!readinessCanServe(authorized, region.id, true))
		throw new Error(
			`failover target ${targetRegionId} did not prove authorized access to ${region.id}`,
		);
	const source = snapshot.dataplanes[region.id];
	if (dataplaneAvailable(source)) {
		await setDrain(env, region.origin, region.id, true);
		await flushAccounting(env, region.origin, region.id);
	}
	await setDrain(env, targetOrigin(env, targetRegionId), region.id, false);
	const generation = await claimWriter(
		env,
		targetOrigin(env, targetRegionId),
		region.id,
	);
	const verified = await checkReadiness(
		`${targetOrigin(env, targetRegionId)}/ready`,
		env.DATAPLANE_INTERNAL_SECRET,
	);
	if (verified.activeWriterRegions[region.id] !== generation)
		throw new Error(
			`writer generation ${generation} was not confirmed by ${targetRegionId}`,
		);
	const logicalCredential = canarySecrets(env).logical[region.id];
	if (
		!logicalCredential ||
		!operationChecksPassed(
			await s3CanaryChecks(
				logicalCredential,
				targetOrigin(env, targetRegionId),
			),
		)
	)
		throw new Error(
			`signed ${region.id} canary failed on ${targetRegionId} after writer claim`,
		);
	await routeRegionTo(env, region, targetRegionId);
	runtime.activeDataplane = targetRegionId;
	runtime.writerGeneration = generation;
	runtime.phase = "active";
	runtime.consecutiveRecoveries = 0;
	runtime.recoveryHealthySince = undefined;
	await addUpdate(
		env,
		state,
		"monitoring",
		`${region.flag} ${region.label} writer generation ${generation} moved to ${targetRegionId} after five failed rounds and a signed canary. Its logical storage region and active physical backend did not change.`,
	);
	await notifyMaintainers(
		env,
		"regional_failover_active",
		`${targetRegionId} is securely serving ${region.id}.`,
	);
}

async function failbackDataplane(
	env: Env,
	state: StatusState,
	snapshot: MonitorSnapshot,
	region: RegionConfig,
	runtime: RegionRuntime,
): Promise<void> {
	const targetId = runtime.activeDataplane;
	if (targetId === region.id) return;
	if (!snapshot.homeReadOnly[region.id])
		throw new Error(`${region.id} read-only recovery canary did not pass`);
	runtime.phase = "failing_back";
	await setDrain(env, targetOrigin(env, targetId), region.id, true);
	await flushAccounting(env, targetOrigin(env, targetId), region.id);
	await flushAccounting(env, region.origin, region.id);
	await setDrain(env, region.origin, region.id, false);
	const generation = await claimWriter(env, region.origin, region.id);
	const verified = await checkReadiness(
		`${region.origin}/ready`,
		env.DATAPLANE_INTERNAL_SECRET,
	);
	if (verified.activeWriterRegions[region.id] !== generation)
		throw new Error(`home writer generation ${generation} was not confirmed`);
	const credential = canarySecrets(env).logical[region.id];
	if (
		!credential ||
		!operationChecksPassed(await s3CanaryChecks(credential, region.origin))
	)
		throw new Error(
			`${region.id} home write canary failed after writer transfer`,
		);
	await routeRegionTo(env, region, region.id);
	runtime.failoverDataplane = targetId;
	runtime.activeDataplane = region.id;
	runtime.writerGeneration = generation;
	runtime.phase = "credential_cleanup";
	runtime.cleanupAfter = new Date(Date.now() + DNS_GRACE_MS).toISOString();
	runtime.cleanupNotified = false;
	runtime.cleanupRequested = false;
	await addUpdate(
		env,
		state,
		"monitoring",
		`${region.flag} ${region.label} drained remote writes and accounting, claimed home generation ${generation}, passed a signed canary, and returned DNS. Remote credentials remain until DNS grace completes.`,
	);
}

async function promoteBackend(
	env: Env,
	state: StatusState,
	snapshot: MonitorSnapshot,
	region: RegionConfig,
	runtime: RegionRuntime,
	targetBackendId: string,
): Promise<void> {
	const serving = snapshot.dataplanes[runtime.activeDataplane];
	const gate = serving?.readiness.replication[region.id]?.[targetBackendId];
	if (!gate?.caughtUp || !gate.fresh || !gate.authorized || !gate.checkpoint)
		throw new Error(
			`backend ${targetBackendId} is not caught up, fresh, and authorized`,
		);
	if (!snapshot.backends[region.id]?.[targetBackendId]?.operational)
		throw new Error(
			`backend ${targetBackendId} direct canary is not operational`,
		);
	runtime.providerPhase = "promoting";
	const url = new URL(
		"/api/internal/storage/promote",
		targetOrigin(env, runtime.activeDataplane),
	);
	const response = await fetchWithDeadline(
		url,
		{
			method: "POST",
			headers: {
				"x-dataplane-secret": env.DATAPLANE_INTERNAL_SECRET,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				region: region.id,
				targetBackendId,
				expectedBackendGeneration:
					serving.readiness.backendGenerations[region.id],
				actor: "silo-status-controller",
				reason: `authorized provider failover after ${FAILURE_THRESHOLD} failed active-backend canaries; replication checkpoint ${gate.checkpoint}`,
			}),
		},
		MUTATION_TIMEOUT_MS,
	);
	if (!response.ok)
		throw new Error(`protected backend promotion failed: ${response.status}`);
	const value = await responseJsonRecord(response);
	const generation =
		numberField(value, "newBackendGeneration") ??
		numberField(value, "generation");
	const confirmedBackend =
		stringField(value, "toBackendId") ?? stringField(value, "backendId");
	if (confirmedBackend !== targetBackendId || generation === undefined)
		throw new Error(
			"promotion response did not confirm backend and generation",
		);
	const logicalCredential = canarySecrets(env).logical[region.id];
	if (
		!logicalCredential ||
		!operationChecksPassed(
			await s3CanaryChecks(
				logicalCredential,
				targetOrigin(env, runtime.activeDataplane),
			),
		)
	)
		throw new Error("logical S3 canary failed after backend promotion");
	runtime.activeBackend = targetBackendId;
	runtime.backendGeneration = generation;
	runtime.providerPhase =
		targetBackendId === primaryBackend(region).id ? "normal" : "replica_active";
	await addUpdate(
		env,
		state,
		"monitoring",
		`${region.flag} ${region.label} physical backend generation ${generation} moved to ${targetBackendId} only after direct canaries and an authorized fresh replication checkpoint. Logical region and public DNS were unchanged.`,
	);
}

async function takeSnapshot(
	env: Env,
	registry: RegionConfig[],
	state: StatusState,
): Promise<MonitorSnapshot> {
	const databaseEnv = env as Env & {
		DATABASE_EU?: Hyperdrive;
		DATABASE_US?: Hyperdrive;
	};
	const database =
		databaseEnv.DATABASE_EU && databaseEnv.DATABASE_US
			? (Object.fromEntries(
					await Promise.all([
						probeDatabase("eu-central", databaseEnv.DATABASE_EU).then(
							(probe) => ["eu-central", probe] as const,
						),
						probeDatabase("us-east", databaseEnv.DATABASE_US).then(
							(probe) => ["us-east", probe] as const,
						),
					]),
				) as Record<"eu-central" | "us-east", DatabaseProbe>)
			: undefined;
	const clickhouseEnv = env as Env & {
		CLICKHOUSE_EU_HEALTH_URL?: string;
		CLICKHOUSE_US_HEALTH_URL?: string;
		CLICKHOUSE_QUERY_USER?: string;
		CLICKHOUSE_QUERY_PASSWORD?: string;
	};
	const clickhouse =
		clickhouseEnv.CLICKHOUSE_EU_HEALTH_URL &&
		clickhouseEnv.CLICKHOUSE_US_HEALTH_URL &&
		clickhouseEnv.CLICKHOUSE_QUERY_PASSWORD
			? await Promise.all([
					probeClickHouse(
						clickhouseEnv.CLICKHOUSE_EU_HEALTH_URL,
						clickhouseEnv.CLICKHOUSE_QUERY_USER || "silo_query",
						clickhouseEnv.CLICKHOUSE_QUERY_PASSWORD,
					).then((probe) => ["eu-central", probe] as const),
					probeClickHouse(
						clickhouseEnv.CLICKHOUSE_US_HEALTH_URL,
						clickhouseEnv.CLICKHOUSE_QUERY_USER || "silo_query",
						clickhouseEnv.CLICKHOUSE_QUERY_PASSWORD,
					).then((probe) => ["us-east", probe] as const),
				]).then(
					(entries) =>
						Object.fromEntries(entries) as Record<
							"eu-central" | "us-east",
							ClickHouseProbe
						>,
				)
			: undefined;
	const dataplaneEntries = await Promise.all(
		registry.map(async (region) => {
			const [health, readiness] = await Promise.all([
				ok(`${region.origin}/health`),
				checkReadiness(`${region.origin}/ready`, env.DATAPLANE_INTERNAL_SECRET),
			]);
			return [
				region.id,
				{ health, readiness } satisfies DataplaneProbe,
			] as const;
		}),
	);
	const dataplanes = Object.fromEntries(dataplaneEntries);
	const secrets = canarySecrets(env);
	const backendEntries = await Promise.all(
		registry.map(async (region) => {
			const probes = await Promise.all(
				region.backends.map(async (backend) => {
					const credential = secrets.backends[backend.canaryRef];
					const checks = credential
						? await s3CanaryChecks(credential, credential.endpoint).catch(
								failedOperationChecks,
							)
						: failedOperationChecks();
					return [
						backend.id,
						{
							checks,
							operational: operationChecksPassed(checks),
						} satisfies BackendProbe,
					] as const;
				}),
			);
			return [region.id, Object.fromEntries(probes)] as const;
		}),
	);
	const backends = Object.fromEntries(backendEntries);
	const logicalEntries = await Promise.all(
		registry.map(async (region) => {
			const credential = secrets.logical[region.id];
			const servingRegion = state.regions[region.id].activeDataplane;
			const checks = credential
				? await s3CanaryChecks(
						credential,
						targetOriginFromRegistry(registry, servingRegion),
					).catch(failedOperationChecks)
				: failedOperationChecks();
			return [region.id, checks] as const;
		}),
	);
	const readEntries = await Promise.all(
		registry.map(async (region) => {
			const credential = secrets.logical[region.id];
			return [
				region.id,
				credential ? await readOnlyCanary(credential, region.origin) : false,
			] as const;
		}),
	);
	return {
		dashboard: await ok(env.DASHBOARD_HEALTH_URL),
		database,
		clickhouse,
		dataplanes,
		backends,
		logical: Object.fromEntries(logicalEntries),
		homeReadOnly: Object.fromEntries(readEntries),
	};
}

function deriveComponents(
	registry: RegionConfig[],
	state: StatusState,
	snapshot: MonitorSnapshot,
): Record<string, ComponentStatus> {
	const components: Record<string, ComponentStatus> = {
		"control-plane": snapshot.dashboard ? "operational" : "outage",
		"database-ha-controller": "operational",
	};
	const postgresValues = Object.values(snapshot.dataplanes)
		.filter((probe) => probe.health)
		.map((probe) => probe.readiness.postgres)
		.filter((value): value is boolean => typeof value === "boolean");
	components["aiven-postgresql"] =
		postgresValues.length === 0
			? "unknown"
			: postgresValues.every(Boolean)
				? "operational"
				: postgresValues.some(Boolean)
					? "degraded"
					: "outage";
	if (snapshot.database) {
		const probes = Object.values(snapshot.database);
		const reachable = probes.filter((probe) => probe.reachable);
		const primaries = reachable.filter((probe) => probe.role === "primary");
		const replicas = reachable.filter((probe) => probe.role === "replica");
		const generations = new Set(
			reachable.map((probe) => probe.generation).filter(Number.isFinite),
		);
		components["postgresql-ha"] =
			primaries.length > 1 || reachable.length === 0
				? "outage"
				: primaries.length === 1 &&
						replicas.length === 1 &&
						generations.size === 1 &&
						primaries[0].activeRegion === primaries[0].region
					? "operational"
					: primaries.length === 1
						? "degraded"
						: "outage";
		const primary = primaries[0];
		const synchronous = primary?.replication.some(
			(peer) => peer.state === "streaming" && peer.syncState === "sync",
		);
		components["postgresql-replication"] =
			replicas.length === 1 && synchronous ? "operational" : "outage";
	}
	if (snapshot.clickhouse) {
		const probes = Object.values(snapshot.clickhouse);
		const reachable = probes.filter((probe) => probe.reachable);
		components["clickhouse-logs"] =
			reachable.length === 2
				? "operational"
				: reachable.length === 1
					? "degraded"
					: "outage";
		const [eu, us] = probes;
		const eventSkew =
			eu.latestEventAt && us.latestEventAt
				? Math.abs(Date.parse(eu.latestEventAt) - Date.parse(us.latestEventAt))
				: 0;
		const rowSkew = Math.abs(eu.recentRows - us.recentRows);
		components["clickhouse-log-redundancy"] =
			reachable.length === 2 && eventSkew <= 60_000 && rowSkew <= 100
				? "operational"
				: reachable.length > 0
					? "degraded"
					: "outage";
	}
	let logicalHealthy = 0;
	for (const region of registry) {
		const runtime = state.regions[region.id];
		const homeProbe = snapshot.dataplanes[region.id];
		const servingProbe = snapshot.dataplanes[runtime.activeDataplane];
		components[`dataplane:${region.id}`] = dataplaneAvailable(homeProbe)
			? "operational"
			: "outage";
		components[`accounting:${region.id}`] = !servingProbe?.readiness.accounting
			? "unknown"
			: servingProbe.readiness.accounting.durable &&
					!servingProbe.readiness.accounting.unsafe
				? "operational"
				: "outage";
		for (const backend of region.backends) {
			const probe = snapshot.backends[region.id]?.[backend.id];
			components[`backend:${region.id}:${backend.id}`] = !probe?.checks
				.configured
				? "unknown"
				: probe.operational
					? "operational"
					: "outage";
		}
		const activeProbe = snapshot.backends[region.id]?.[runtime.activeBackend];
		const activeHealthy = activeProbe?.operational === true;
		const physicalFailure = region.backends.some(
			(backend) =>
				snapshot.backends[region.id]?.[backend.id]?.checks.configured &&
				!snapshot.backends[region.id][backend.id].operational,
		);
		components[`storage:${region.id}`] = !activeProbe?.checks.configured
			? "unknown"
			: !activeHealthy
				? "outage"
				: runtime.activeBackend !== primaryBackend(region).id || physicalFailure
					? "degraded"
					: "operational";
		if (region.backends.length > 1) {
			const serving = snapshot.dataplanes[runtime.activeDataplane];
			const gates = region.backends
				.filter((backend) => backend.id !== runtime.activeBackend)
				.map(
					(backend) => serving?.readiness.replication[region.id]?.[backend.id],
				);
			components[`replication:${region.id}`] =
				gates.length && gates.every((gate) => gate?.caughtUp && gate.fresh)
					? "operational"
					: gates.some((gate) => gate?.caughtUp)
						? "degraded"
						: "outage";
		}
		if (operationChecksPassed(snapshot.logical[region.id])) logicalHealthy += 1;
	}
	if (logicalHealthy === 0) components["global-s3"] = "outage";
	else if (
		logicalHealthy < registry.length ||
		registry.some(
			(region) =>
				state.regions[region.id].phase !== "normal" ||
				state.regions[region.id].providerPhase !== "normal",
		)
	)
		components["global-s3"] = "degraded";
	else components["global-s3"] = "operational";
	return components;
}

function deriveOverall(
	registry: RegionConfig[],
	components: Record<string, ComponentStatus>,
): OverallStatus {
	if (
		(components["postgresql-ha"] ?? components["aiven-postgresql"]) ===
			"outage" ||
		components["global-s3"] === "outage" ||
		registry.some(
			(region) =>
				components[`storage:${region.id}`] === "outage" ||
				components[`accounting:${region.id}`] === "outage",
		)
	)
		return "major_outage";
	return Object.values(components).every((status) => status === "operational")
		? "operational"
		: "degraded";
}

function chooseFailoverTarget(
	registry: RegionConfig[],
	snapshot: MonitorSnapshot,
	storageRegion: string,
): string | undefined {
	return registry
		.map((region) => region.id)
		.find(
			(candidate) =>
				candidate !== storageRegion &&
				eligibleFailoverTarget(registry, snapshot, storageRegion, candidate),
		);
}

function chooseFailoverCandidate(
	env: Env,
	registry: RegionConfig[],
	snapshot: MonitorSnapshot,
	storageRegion: string,
): string | undefined {
	return (
		chooseFailoverTarget(registry, snapshot, storageRegion) ||
		registry
			.map((region) => region.id)
			.find(
				(candidate) =>
					candidate !== storageRegion &&
					dataplaneAvailable(snapshot.dataplanes[candidate]) &&
					hasFailoverHook(
						env.FAILOVER_ACTIVATION_URLS,
						storageRegion,
						candidate,
					),
			)
	);
}

function failoverHookMap(raw: string | undefined): Record<string, string> {
	if (!raw?.trim()) return {};
	try {
		const value: unknown = JSON.parse(raw);
		return stringMap(value);
	} catch {
		return {};
	}
}

function hasFailoverHook(
	raw: string | undefined,
	storageRegion: string,
	targetRegion: string,
): boolean {
	return Boolean(failoverHookMap(raw)[`${storageRegion}:${targetRegion}`]);
}

async function ensureFailoverAuthorization(
	env: Env,
	storageRegion: string,
	targetRegion: string,
): Promise<void> {
	const readinessUrl = `${targetOrigin(env, targetRegion)}/ready`;
	let readiness = await checkReadiness(
		readinessUrl,
		env.DATAPLANE_INTERNAL_SECRET,
	);
	if (readinessCanServe(readiness, storageRegion, true)) return;
	if (
		!hasFailoverHook(env.FAILOVER_ACTIVATION_URLS, storageRegion, targetRegion)
	) {
		throw new Error(
			`no failover authorization hook is configured for ${storageRegion}:${targetRegion}`,
		);
	}
	await callFailoverHook(env, "activate", storageRegion, targetRegion);
	const deadline = Date.now() + AUTHORIZATION_TIMEOUT_MS;
	while (Date.now() < deadline) {
		await sleep(AUTHORIZATION_POLL_MS);
		readiness = await checkReadiness(
			readinessUrl,
			env.DATAPLANE_INTERNAL_SECRET,
		);
		if (readinessCanServe(readiness, storageRegion, true)) return;
	}
	throw new Error(
		`failover authorization for ${storageRegion}:${targetRegion} did not become ready before the deadline`,
	);
}

async function callFailoverHook(
	env: Env,
	action: "activate" | "deactivate",
	storageRegion: string,
	targetRegion: string,
): Promise<void> {
	const raw =
		action === "activate"
			? env.FAILOVER_ACTIVATION_URLS
			: env.FAILOVER_DEACTIVATION_URLS;
	const endpoint = failoverHookMap(raw)[`${storageRegion}:${targetRegion}`];
	if (!endpoint)
		throw new Error(
			`no ${action} hook is configured for ${storageRegion}:${targetRegion}`,
		);
	const url = new URL(endpoint);
	if (url.protocol !== "https:")
		throw new Error("failover authorization hooks must use HTTPS");
	if (!env.FAILOVER_HOOK_SECRET || env.FAILOVER_HOOK_SECRET.length < 32)
		throw new Error("FAILOVER_HOOK_SECRET must contain at least 32 characters");
	const requestedAt = new Date().toISOString();
	const requestId = crypto.randomUUID();
	const body = JSON.stringify({
		action,
		storageRegion,
		targetDataplaneRegion: targetRegion,
		requestedAt,
		requestId,
	});
	const signature = hex(await hmacBytes(env.FAILOVER_HOOK_SECRET, body));
	const response = await fetchWithDeadline(
		url,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": requestId,
				"x-silo-request-timestamp": requestedAt,
				"x-silo-signature": `sha256=${signature}`,
			},
			body,
		},
		MUTATION_TIMEOUT_MS,
	);
	if (!response.ok)
		throw new Error(
			`${action} hook for ${storageRegion}:${targetRegion} failed with ${response.status}`,
		);
}

function eligibleFailoverTarget(
	registry: RegionConfig[],
	snapshot: MonitorSnapshot,
	storageRegion: string,
	candidate: string,
): boolean {
	if (!registry.some((region) => region.id === candidate)) return false;
	const probe = snapshot.dataplanes[candidate];
	return (
		dataplaneAvailable(probe) &&
		readinessCanServe(probe.readiness, storageRegion, true)
	);
}

function chooseBackendCandidate(
	region: RegionConfig,
	runtime: RegionRuntime,
	snapshot: MonitorSnapshot,
): string | undefined {
	const serving = snapshot.dataplanes[runtime.activeDataplane];
	return region.backends.find((backend) => {
		if (
			backend.id === runtime.activeBackend ||
			!snapshot.backends[region.id]?.[backend.id]?.operational
		)
			return false;
		const gate = serving?.readiness.replication[region.id]?.[backend.id];
		return (
			gate?.caughtUp === true &&
			gate.fresh === true &&
			gate.authorized === true &&
			Boolean(gate.checkpoint)
		);
	})?.id;
}

function dataplaneAvailable(probe: DataplaneProbe | undefined): boolean {
	return Boolean(
		probe?.health &&
			probe.readiness.postgres === true &&
			probe.readiness.regionalSchema === true &&
			probe.readiness.accounting?.durable === true &&
			probe.readiness.accounting.unsafe === false,
	);
}

function readinessCanServe(
	readiness: ReadinessChecks,
	storageRegion: string,
	requireFailoverAuthorization: boolean,
): boolean {
	return (
		readiness.postgres === true &&
		readiness.regionalSchema === true &&
		readiness.accounting?.durable === true &&
		readiness.accounting.unsafe === false &&
		readiness.storageRegions[storageRegion] === true &&
		(!requireFailoverAuthorization ||
			readiness.failoverRegions.includes(storageRegion))
	);
}

function primaryBackend(region: RegionConfig): BackendConfig {
	return (
		region.backends.find((backend) => backend.role === "primary") ||
		region.backends[0]
	);
}

function targetOrigin(env: Env, regionId: string): string {
	return targetOriginFromRegistry(parseRegistry(env.REGION_REGISTRY), regionId);
}

function targetOriginFromRegistry(
	registry: RegionConfig[],
	regionId: string,
): string {
	const region = registry.find((candidate) => candidate.id === regionId);
	if (!region) throw new Error(`unknown region ${regionId}`);
	return region.origin.replace(/\/$/, "");
}

function parseRegistry(raw: string): RegionConfig[] {
	const value: unknown = JSON.parse(raw);
	if (!Array.isArray(value) || value.length < 2)
		throw new Error("REGION_REGISTRY must contain at least two regions");
	const ids = new Set<string>();
	const hosts = new Set<string>();
	const regions = value.map((item): RegionConfig => {
		if (!isRecord(item)) throw new Error("invalid region registry entry");
		const id = requiredString(item.id, "region.id");
		if (
			!/^[a-z0-9][a-z0-9-]{1,39}$/.test(id) ||
			id.endsWith("-") ||
			ids.has(id)
		)
			throw new Error(`invalid or duplicate region ID ${id}`);
		ids.add(id);
		if (!Array.isArray(item.endpointHosts) || item.endpointHosts.length === 0)
			throw new Error(`${id} requires endpointHosts`);
		const endpointHosts = item.endpointHosts.map((host) => {
			const value = requiredString(host, `${id}.endpointHost`).toLowerCase();
			if (
				!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
					value,
				)
			)
				throw new Error(
					`${id}.endpointHost must be a hostname without a scheme, port, or path`,
				);
			return value;
		});
		for (const host of endpointHosts) {
			if (hosts.has(host))
				throw new Error(`endpoint ${host} has more than one home region`);
			hosts.add(host);
		}
		if (!Array.isArray(item.backends) || item.backends.length === 0)
			throw new Error(`${id} requires at least one backend`);
		const backendIds = new Set<string>();
		const backends = item.backends.map((backend): BackendConfig => {
			if (!isRecord(backend)) throw new Error(`invalid backend for ${id}`);
			const backendId = requiredString(backend.id, `${id}.backend.id`);
			if (
				!/^[a-z0-9][a-z0-9-]{0,62}$/.test(backendId) ||
				backendIds.has(backendId)
			)
				throw new Error(`invalid or duplicate backend ${id}/${backendId}`);
			backendIds.add(backendId);
			const role =
				backend.role === "replica"
					? "replica"
					: backend.role === "primary"
						? "primary"
						: undefined;
			if (!role) throw new Error(`invalid role for ${id}/${backendId}`);
			return {
				id: backendId,
				label: requiredString(backend.label, `${id}/${backendId}.label`),
				provider: requiredString(
					backend.provider,
					`${id}/${backendId}.provider`,
				),
				role,
				canaryRef: requiredString(
					backend.canaryRef,
					`${id}/${backendId}.canaryRef`,
				),
			};
		});
		if (backends.filter((backend) => backend.role === "primary").length !== 1)
			throw new Error(`${id} must have exactly one primary backend`);
		const origin = requiredString(item.origin, `${id}.origin`);
		const originUrl = new URL(origin);
		if (
			originUrl.protocol !== "https:" ||
			originUrl.username ||
			originUrl.password ||
			originUrl.search ||
			originUrl.hash ||
			(originUrl.pathname !== "/" && originUrl.pathname !== "")
		)
			throw new Error(`${id}.origin must be a clean HTTPS origin`);
		return {
			id,
			label: requiredString(item.label, `${id}.label`),
			flag: requiredString(item.flag, `${id}.flag`),
			origin: originUrl.origin,
			endpointHosts,
			default: item.default === true,
			backends,
		};
	});
	if (regions.filter((region) => region.default).length !== 1)
		throw new Error("REGION_REGISTRY must have exactly one default region");
	return regions;
}

function canarySecrets(env: Env): {
	logical: Record<string, CanaryCredential>;
	backends: Record<string, CanaryCredential>;
} {
	const value: unknown = JSON.parse(env.REGION_CANARIES);
	if (!isRecord(value)) throw new Error("REGION_CANARIES must be an object");
	return {
		logical: parseCredentialMap(value.logical),
		backends: parseCredentialMap(value.backends),
	};
}

function parseCredentialMap(value: unknown): Record<string, CanaryCredential> {
	if (!isRecord(value)) return {};
	const output: Record<string, CanaryCredential> = {};
	for (const [key, item] of Object.entries(value)) {
		if (!isRecord(item)) continue;
		try {
			const endpoint = new URL(
				requiredString(item.endpoint, `${key}.endpoint`),
			);
			if (
				endpoint.protocol !== "https:" ||
				endpoint.username ||
				endpoint.password ||
				endpoint.search ||
				endpoint.hash ||
				(endpoint.pathname !== "/" && endpoint.pathname !== "")
			) {
				throw new Error(`${key}.endpoint must be a clean HTTPS origin`);
			}
			const bucket = requiredString(item.bucket, `${key}.bucket`);
			if (
				!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
				bucket.includes("..")
			) {
				throw new Error(
					`${key}.bucket must be a DNS-compatible S3 bucket name`,
				);
			}
			const addressingStyle =
				item.addressingStyle === undefined || item.addressingStyle === "path"
					? "path"
					: item.addressingStyle === "virtual"
						? "virtual"
						: undefined;
			if (!addressingStyle)
				throw new Error(`${key}.addressingStyle must be path or virtual`);
			if (addressingStyle === "virtual" && bucket.includes(".")) {
				throw new Error(
					`${key}.bucket cannot contain dots with virtual addressing over TLS; use path addressing`,
				);
			}
			output[key] = {
				endpoint: endpoint.origin,
				bucket,
				accessKeyId: requiredString(item.accessKeyId, `${key}.accessKeyId`),
				secretAccessKey: requiredString(
					item.secretAccessKey,
					`${key}.secretAccessKey`,
				),
				sessionToken:
					typeof item.sessionToken === "string" && item.sessionToken.trim()
						? item.sessionToken.trim()
						: undefined,
				signingRegion: requiredString(
					item.signingRegion,
					`${key}.signingRegion`,
				),
				prefix:
					typeof item.prefix === "string" && item.prefix
						? item.prefix.replace(/^\/+|\/+$/g, "")
						: "__silo_healthcheck/status",
				addressingStyle,
			};
		} catch (error) {
			throw new Error(`invalid canary ${key}: ${errorMessage(error)}`);
		}
	}
	return output;
}

async function checkReadiness(
	url: string,
	secret: string,
): Promise<ReadinessChecks> {
	const empty = (): ReadinessChecks => ({
		ok: false,
		storageRegions: {},
		failoverRegions: [],
		activeWriterRegions: {},
		activeStorageBackends: {},
		backendGenerations: {},
		storageBackends: {},
		replication: {},
	});
	try {
		const response = await fetchWithDeadline(url, {
			redirect: "manual",
			headers: { "x-dataplane-secret": secret },
		});
		const value: Record<string, unknown> = await responseJsonRecord(
			response,
		).catch(() => ({}));
		const active = activeBackendMaps(value.activeBackends);
		return {
			...empty(),
			ok: response.ok,
			region: stringField(value, "region"),
			postgres: booleanField(value, "postgres"),
			regionalSchema: booleanField(value, "regionalSchema"),
			redis: booleanField(value, "redis"),
			storage: booleanField(value, "storage"),
			accounting: accountingReadiness(value.accounting),
			storageRegions: booleanMap(value.storageRegions),
			failoverRegions: stringArray(value.failoverRegions),
			activeWriterRegions: numberMap(value.activeWriterRegions),
			activeStorageBackends: {
				...active.ids,
				...stringMap(value.activeStorageBackends),
			},
			backendGenerations: {
				...active.generations,
				...numberMap(value.backendGenerations),
			},
			storageBackends: nestedBooleanMap(value.storageBackends),
			replication: replicationMap(value.replication),
		};
	} catch {
		return empty();
	}
}

function accountingReadiness(value: unknown): AccountingReadiness | undefined {
	if (!isRecord(value)) return undefined;
	const pending = finiteNumber(value.pending);
	if (
		value.durable !== true ||
		typeof value.unsafe !== "boolean" ||
		pending === undefined ||
		pending < 0
	)
		return undefined;
	return { durable: true, unsafe: value.unsafe, pending };
}

function activeBackendMaps(value: unknown): {
	ids: Record<string, string>;
	generations: Record<string, number>;
} {
	const ids: Record<string, string> = {};
	const generations: Record<string, number> = {};
	if (!isRecord(value)) return { ids, generations };
	for (const [region, backend] of Object.entries(value)) {
		if (!isRecord(backend)) continue;
		const id = stringField(backend, "backendId");
		const generation = numberField(backend, "backendGeneration");
		if (id) ids[region] = id;
		if (generation !== undefined) generations[region] = generation;
	}
	return { ids, generations };
}

function replicationMap(
	value: unknown,
): Record<string, Record<string, ReplicationGate>> {
	if (!isRecord(value)) return {};
	const output: Record<string, Record<string, ReplicationGate>> = {};
	for (const [region, backends] of Object.entries(value)) {
		if (!isRecord(backends)) continue;
		output[region] = {};
		for (const [backend, gate] of Object.entries(backends)) {
			if (!isRecord(gate)) continue;
			output[region][backend] = {
				caughtUp: gate.caughtUp === true,
				fresh: gate.fresh === true,
				authorized: gate.authorized === true,
				checkpoint:
					typeof gate.checkpoint === "string" ? gate.checkpoint : undefined,
				checkpointAgeSeconds: finiteNumber(gate.checkpointAgeSeconds),
				lagObjects: finiteNumber(gate.lagObjects),
			};
		}
	}
	return output;
}

async function s3CanaryChecks(
	credential: CanaryCredential,
	target: string,
): Promise<OperationChecks> {
	const authentication = (await signedFetch(credential, target, "HEAD")).ok;
	if (!authentication)
		return {
			configured: true,
			authentication,
			upload: false,
			download: false,
			delete: false,
		};
	const key = `${credential.prefix}/${crypto.randomUUID()}`;
	const body = `silo status canary ${new Date().toISOString()}`;
	const put = await signedFetch(credential, target, "PUT", key, body);
	if (!put.ok)
		return {
			configured: true,
			authentication,
			upload: false,
			download: false,
			delete: false,
		};
	let download = false;
	try {
		const get = await signedFetch(credential, target, "GET", key);
		download = get.ok && (await get.text()) === body;
	} catch {
		download = false;
	}
	try {
		const deletion = await signedFetch(credential, target, "DELETE", key);
		return {
			configured: true,
			authentication,
			upload: true,
			download,
			delete: deletion.ok,
		};
	} catch {
		return {
			configured: true,
			authentication,
			upload: true,
			download,
			delete: false,
		};
	}
}

async function readOnlyCanary(
	credential: CanaryCredential,
	target: string,
): Promise<boolean> {
	try {
		return (await signedFetch(credential, target, "HEAD")).ok;
	} catch {
		return false;
	}
}

function failedOperationChecks(): OperationChecks {
	return {
		configured: false,
		authentication: false,
		upload: false,
		download: false,
		delete: false,
	};
}
function operationChecksPassed(checks: OperationChecks | undefined): boolean {
	return Boolean(
		checks?.configured &&
			checks.authentication &&
			checks.upload &&
			checks.download &&
			checks.delete,
	);
}

async function signedFetch(
	credential: CanaryCredential,
	origin: string,
	method: string,
	key?: string,
	body = "",
): Promise<Response> {
	const url = s3RequestUrl(credential, origin, key);
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const day = amzDate.slice(0, 8);
	const payloadHash = await sha256(body);
	const headers: Record<string, string> = {
		host: url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	if (body) headers["content-type"] = "text/plain";
	if (credential.sessionToken)
		headers["x-amz-security-token"] = credential.sessionToken;
	const signedNames = Object.keys(headers).sort();
	const canonicalHeaders = signedNames
		.map((name) => `${name}:${headers[name]}\n`)
		.join("");
	const canonicalPath = url.pathname
		.split("/")
		.map((segment) => awsEncode(decodePathSegment(segment)))
		.join("/");
	const canonicalQuery = [...url.searchParams.entries()]
		.map(([key, value]) => [awsEncode(key), awsEncode(value)] as const)
		.sort(
			([leftKey, leftValue], [rightKey, rightValue]) =>
				leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
		)
		.map(([key, value]) => `${key}=${value}`)
		.join("&");
	const canonical = `${method}\n${canonicalPath}\n${canonicalQuery}\n${canonicalHeaders}\n${signedNames.join(";")}\n${payloadHash}`;
	const scope = `${day}/${credential.signingRegion}/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonical)}`;
	const signingKey = await awsSigningKey(
		credential.secretAccessKey,
		day,
		credential.signingRegion,
	);
	headers.authorization = `AWS4-HMAC-SHA256 Credential=${credential.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${await hmacHex(signingKey, stringToSign)}`;
	return fetchWithDeadline(url, { method, headers, body: body || undefined });
}

function s3RequestUrl(
	credential: CanaryCredential,
	origin: string,
	key?: string,
): URL {
	const url = new URL(origin);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/" && url.pathname !== "")
	) {
		throw new Error("S3 canary target must be a clean HTTPS origin");
	}
	const objectPath = key ? `/${key.replace(/^\/+/, "")}` : "/";
	if (credential.addressingStyle === "virtual") {
		url.hostname = `${credential.bucket}.${url.hostname}`;
		url.pathname = objectPath;
	} else {
		url.pathname = `/${credential.bucket}${key ? objectPath : ""}`;
	}
	return url;
}

function awsEncode(value: string): string {
	return encodeURIComponent(value).replace(
		/[!'()*]/g,
		(character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
	);
}

function decodePathSegment(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

async function awsSigningKey(
	secret: string,
	day: string,
	region: string,
): Promise<ArrayBuffer> {
	let key = await hmacBytes(`AWS4${secret}`, day);
	key = await hmacBytes(key, region);
	key = await hmacBytes(key, "s3");
	return hmacBytes(key, "aws4_request");
}
async function hmacBytes(
	key: string | ArrayBuffer,
	value: string,
): Promise<ArrayBuffer> {
	return crypto.subtle.sign(
		"HMAC",
		await crypto.subtle.importKey(
			"raw",
			typeof key === "string" ? new TextEncoder().encode(key) : key,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		),
		new TextEncoder().encode(value),
	);
}
async function hmacHex(key: ArrayBuffer, value: string): Promise<string> {
	return hex(await hmacBytes(key, value));
}
async function sha256(value: string): Promise<string> {
	return hex(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
	);
}
function hex(value: ArrayBuffer): string {
	return [...new Uint8Array(value)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function setDrain(
	env: Env,
	origin: string,
	region: string,
	enabled: boolean,
): Promise<void> {
	const response = await internalPost(env, origin, "/api/internal/drain", {
		region,
		enabled,
	});
	if (!response.ok) throw new Error(`region drain failed: ${response.status}`);
}

async function flushAccounting(
	env: Env,
	origin: string,
	region: string,
): Promise<void> {
	const response = await internalPost(
		env,
		origin,
		"/api/internal/accounting/flush",
		{ region },
	);
	if (!response.ok)
		throw new Error(`accounting flush failed: ${response.status}`);
	const value = await responseJsonRecord(response);
	if (
		numberField(value, "pending") !== 0 ||
		value.unsafe_state === true ||
		value.unsafeState === true
	)
		throw new Error(`accounting flush for ${region} was not safe and empty`);
}

async function claimWriter(
	env: Env,
	origin: string,
	region: string,
): Promise<number> {
	const response = await internalPost(
		env,
		origin,
		"/api/internal/writer/claim",
		{ region },
	);
	if (!response.ok) throw new Error(`writer claim failed: ${response.status}`);
	const generation = numberField(
		await responseJsonRecord(response),
		"generation",
	);
	if (generation === undefined)
		throw new Error("writer claim did not return a generation");
	return generation;
}

async function internalPost(
	env: Env,
	origin: string,
	pathname: string,
	body: Record<string, unknown>,
): Promise<Response> {
	const url = new URL(pathname, origin);
	return fetchWithDeadline(
		url,
		{
			method: "POST",
			headers: {
				"x-dataplane-secret": env.DATAPLANE_INTERNAL_SECRET,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		},
		MUTATION_TIMEOUT_MS,
	);
}

async function routeRegionTo(
	env: Env,
	region: RegionConfig,
	targetRegionId: string,
): Promise<void> {
	const target = parseRegistry(env.REGION_REGISTRY).find(
		(candidate) => candidate.id === targetRegionId,
	);
	if (!target) throw new Error(`unknown DNS target ${targetRegionId}`);
	const targetHost = new URL(target.origin).hostname;
	const recordIds = jsonStringMap(env.CF_ENDPOINT_RECORD_IDS);
	for (const hostname of region.endpointHosts) {
		const recordId = recordIds[hostname];
		if (!recordId)
			throw new Error(`missing Cloudflare record ID for ${hostname}`);
		await cloudflare(
			env,
			`/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
			"PUT",
			{
				type: "CNAME",
				name: hostname,
				content: targetHost,
				ttl: 60,
				proxied: false,
			},
		);
	}
}

async function pointDashboardAtStatus(env: Env): Promise<void> {
	await cloudflare(
		env,
		`/zones/${env.CF_ZONE_ID}/dns_records/${env.CF_DASHBOARD_RECORD_ID}`,
		"PUT",
		{
			type: "A",
			name: env.DASHBOARD_DNS_NAME,
			content: "192.0.2.1",
			ttl: 1,
			proxied: true,
		},
	);
}

async function pointDashboardAtControlPlane(env: Env): Promise<void> {
	await cloudflare(
		env,
		`/zones/${env.CF_ZONE_ID}/dns_records/${env.CF_DASHBOARD_RECORD_ID}`,
		"PUT",
		{
			type: "CNAME",
			name: env.DASHBOARD_DNS_NAME,
			content: env.CONTROL_PLANE_ORIGIN_HOST,
			ttl: 60,
			proxied: false,
		},
	);
}

async function cloudflare(
	env: Env,
	path: string,
	method: string,
	body?: unknown,
): Promise<void> {
	const response = await fetchWithDeadline(
		`${env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4"}${path}`,
		{
			method,
			headers: {
				authorization: `Bearer ${env.CF_DNS_TOKEN}`,
				...(body ? { "content-type": "application/json" } : {}),
			},
			body: body ? JSON.stringify(body) : undefined,
		},
		MUTATION_TIMEOUT_MS,
	);
	if (!response.ok)
		throw new Error(`Cloudflare DNS update failed: ${response.status}`);
	const value: unknown = await response.json().catch(() => null);
	if (isRecord(value) && value.success === false)
		throw new Error("Cloudflare DNS update was rejected");
}

async function refreshProductionMaintenance(
	env: Env,
	state: StatusState,
): Promise<void> {
	const previousDashboard = state.components["control-plane"];
	const maintenance = await checkProductionMaintenance(env);
	if (maintenance) {
		const now = new Date().toISOString();
		state.productionMaintenance = {
			title: maintenance.fullMaintenanceMode
				? "Full application maintenance"
				: "S3 maintenance",
			message: maintenance.fullMaintenanceMode
				? "Silo is temporarily offline for planned application maintenance."
				: "S3 storage is temporarily unavailable for planned maintenance.",
			startsAt: state.productionMaintenance?.startsAt || now,
			lastVerifiedAt: now,
		};
	} else if (
		maintenance === false ||
		(state.productionMaintenance &&
			Date.now() - Date.parse(state.productionMaintenance.lastVerifiedAt) >
				3 * 60_000)
	)
		state.productionMaintenance = undefined;
	const dashboard = await ok(env.DASHBOARD_HEALTH_URL);
	if (
		!dashboard &&
		previousDashboard !== "outage" &&
		autoRedirectDashboard(env)
	)
		await pointDashboardAtStatus(env);
	if (dashboard && previousDashboard === "outage" && autoRedirectDashboard(env))
		await pointDashboardAtControlPlane(env);
}

async function checkProductionMaintenance(
	env: Env,
): Promise<
	false | null | { s3MaintenanceMode: boolean; fullMaintenanceMode: boolean }
> {
	try {
		const response = await fetchWithDeadline(env.MAINTENANCE_URL, {
			redirect: "manual",
		});
		if (!response.ok) return null;
		const value = await responseJsonRecord(response);
		return value.s3MaintenanceMode === true ||
			value.fullMaintenanceMode === true
			? {
					s3MaintenanceMode: value.s3MaintenanceMode === true,
					fullMaintenanceMode: value.fullMaintenanceMode === true,
				}
			: false;
	} catch {
		return null;
	}
}

function defaultState(registry: RegionConfig[]): StatusState {
	const regions: Record<string, RegionRuntime> = {};
	for (const region of registry)
		regions[region.id] = {
			phase: "normal",
			providerPhase: "normal",
			activeDataplane: region.id,
			activeBackend: primaryBackend(region).id,
			consecutiveFailures: 0,
			consecutiveRecoveries: 0,
			cleanupNotified: false,
			cleanupRequested: false,
			manualRecoveryLock: false,
			backendFailures: Object.fromEntries(
				region.backends.map((backend) => [backend.id, 0]),
			),
		};
	return {
		overall: "operational",
		components: {},
		regions,
		database: {
			phase: "normal",
			activeRegion: "eu-central",
			generation: 1,
			consecutiveFailures: 0,
			synchronousConfirmed: false,
		},
		updatedAt: new Date().toISOString(),
	};
}

async function getState(
	env: Env,
	registry: RegionConfig[],
): Promise<StatusState> {
	const state = defaultState(registry);
	const row = await env.DB.prepare(
		"SELECT value FROM status_state WHERE id = ?",
	)
		.bind(STATE_ID)
		.first<{ value: string }>();
	if (!row) return state;
	try {
		const value: unknown = JSON.parse(row.value);
		if (!isRecord(value)) return state;
		state.overall =
			value.overall === "major_outage" || value.overall === "degraded"
				? value.overall
				: "operational";
		state.components = componentMap(value.components);
		state.activeIncidentId =
			typeof value.activeIncidentId === "string"
				? value.activeIncidentId
				: undefined;
		state.updatedAt =
			typeof value.updatedAt === "string" ? value.updatedAt : state.updatedAt;
		if (isRecord(value.database)) {
			state.database.phase = [
				"normal",
				"investigating",
				"promoting",
				"active",
				"blocked",
			].includes(String(value.database.phase))
				? (value.database.phase as typeof state.database.phase)
				: "normal";
			state.database.activeRegion =
				value.database.activeRegion === "us-east" ? "us-east" : "eu-central";
			state.database.generation = finiteNumber(value.database.generation) || 1;
			state.database.consecutiveFailures =
				finiteNumber(value.database.consecutiveFailures) || 0;
			state.database.synchronousConfirmed =
				value.database.synchronousConfirmed === true;
		}
		if (isRecord(value.productionMaintenance))
			state.productionMaintenance = {
				title: requiredString(
					value.productionMaintenance.title,
					"maintenance.title",
				),
				message: requiredString(
					value.productionMaintenance.message,
					"maintenance.message",
				),
				startsAt: requiredString(
					value.productionMaintenance.startsAt,
					"maintenance.startsAt",
				),
				lastVerifiedAt: requiredString(
					value.productionMaintenance.lastVerifiedAt,
					"maintenance.lastVerifiedAt",
				),
			};
		if (isRecord(value.regions))
			for (const region of registry) {
				const persisted = value.regions[region.id];
				if (!isRecord(persisted)) continue;
				const runtime = state.regions[region.id];
				runtime.phase = regionPhase(persisted.phase);
				runtime.providerPhase = providerPhase(persisted.providerPhase);
				runtime.activeDataplane =
					typeof persisted.activeDataplane === "string" &&
					registry.some((item) => item.id === persisted.activeDataplane)
						? persisted.activeDataplane
						: region.id;
				runtime.failoverDataplane =
					typeof persisted.failoverDataplane === "string"
						? persisted.failoverDataplane
						: undefined;
				runtime.activeBackend =
					typeof persisted.activeBackend === "string" &&
					region.backends.some(
						(backend) => backend.id === persisted.activeBackend,
					)
						? persisted.activeBackend
						: primaryBackend(region).id;
				runtime.writerGeneration = finiteNumber(persisted.writerGeneration);
				runtime.backendGeneration = finiteNumber(persisted.backendGeneration);
				runtime.consecutiveFailures =
					finiteNumber(persisted.consecutiveFailures) || 0;
				runtime.consecutiveRecoveries =
					finiteNumber(persisted.consecutiveRecoveries) || 0;
				runtime.recoveryHealthySince =
					typeof persisted.recoveryHealthySince === "string"
						? persisted.recoveryHealthySince
						: undefined;
				runtime.cleanupAfter =
					typeof persisted.cleanupAfter === "string"
						? persisted.cleanupAfter
						: undefined;
				runtime.cleanupNotified = persisted.cleanupNotified === true;
				runtime.cleanupRequested = persisted.cleanupRequested === true;
				runtime.manualRecoveryLock = persisted.manualRecoveryLock === true;
				runtime.backendFailures = {
					...runtime.backendFailures,
					...numberMap(persisted.backendFailures),
				};
			}
	} catch (error) {
		logError("state_parse_failed", error);
	}
	return state;
}

async function putState(env: Env, state: StatusState): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO status_state (id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
	)
		.bind(STATE_ID, JSON.stringify(state), state.updatedAt)
		.run();
}

async function recordAvailability(
	env: Env,
	state: StatusState,
	plannedMaintenance: boolean,
): Promise<void> {
	const global =
		plannedMaintenance || state.components["global-s3"] === "operational"
			? 1
			: 0;
	const dashboard =
		plannedMaintenance || state.components["control-plane"] === "operational"
			? 1
			: 0;
	const statements = [
		env.DB.prepare(
			"INSERT INTO uptime_checks (s3_operational, dashboard_operational, recorded_at) VALUES (?, ?, ?)",
		).bind(global, dashboard, state.updatedAt),
		...Object.entries(state.components).map(([id, status]) =>
			env.DB.prepare(
				"INSERT OR REPLACE INTO component_uptime_checks (component_id, operational, planned_maintenance, recorded_at) VALUES (?, ?, ?, ?)",
			).bind(
				id,
				plannedMaintenance || status === "operational" ? 1 : 0,
				plannedMaintenance ? 1 : 0,
				state.updatedAt,
			),
		),
		env.DB.prepare(
			"DELETE FROM uptime_checks WHERE datetime(recorded_at) < datetime('now', '-91 days')",
		),
		env.DB.prepare(
			"DELETE FROM component_uptime_checks WHERE datetime(recorded_at) < datetime('now', '-91 days')",
		),
	];
	await env.DB.batch(statements);
}

async function operationsAdmin(
	request: Request,
	env: Env,
	registry: RegionConfig[],
): Promise<Response> {
	if (!adminOriginAllowed(request, env))
		return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (!(await secretMatches(request, env.STATUS_ADMIN_SECRET)))
		return adminJson(request, env, { error: "unauthorized" }, 401);
	const state = await getState(env, registry);
	const snapshot = await takeSnapshot(env, registry, state);
	const databaseAutomation = env as Env & { AUTO_FAILOVER_DATABASE?: string };
	return adminJson(request, env, {
		databaseHa: {
			controller: "cloudflare-worker",
			...state.database,
			configured: Boolean(snapshot.database),
			probes: snapshot.database || null,
			automation: {
				failover: databaseAutomation.AUTO_FAILOVER_DATABASE === "true",
				drillApproved: env.FAILOVER_DRILL_APPROVED === "true",
			},
		},
		regions: registry.map((region) => ({
			id: region.id,
			label: `${region.flag} ${region.label}`,
			...state.regions[region.id],
			backends: region.backends.map((backend) => ({
				id: backend.id,
				label: backend.label,
				role: backend.role,
				operational:
					snapshot.backends[region.id]?.[backend.id]?.operational ?? false,
				replication:
					snapshot.dataplanes[state.regions[region.id].activeDataplane]
						?.readiness.replication[region.id]?.[backend.id] || null,
			})),
		})),
		automation: {
			activateDataplane: autoActivate(env),
			promoteStorage: autoPromoteStorage(env),
			redirectDashboard: autoRedirectDashboard(env),
			recover: env.AUTO_RECOVER !== "false",
		},
		productionMaintenance: state.productionMaintenance || null,
		updatedAt: state.updatedAt,
	});
}

async function operationsAction(
	request: Request,
	env: Env,
	action: string,
	registry: RegionConfig[],
): Promise<Response> {
	if (!adminOriginAllowed(request, env))
		return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (!(await secretMatches(request, env.STATUS_ADMIN_SECRET)))
		return adminJson(request, env, { error: "unauthorized" }, 401);
	const input = await requestJsonRecord(request);
	const regionId = stringField(input, "region");
	const region = registry.find((candidate) => candidate.id === regionId);
	const databaseAction = action.startsWith("database-");
	if (!databaseAction && !region)
		return adminJson(request, env, { error: "valid region is required" }, 400);
	const leaseHolder = crypto.randomUUID();
	if (!(await acquireMonitorLease(env, leaseHolder)))
		return adminJson(
			request,
			env,
			{ error: "another regional transition is already running" },
			409,
		);
	try {
		const state = await getState(env, registry);
		const snapshot = await takeSnapshot(env, registry, state);
		if (databaseAction) {
			const databaseEnv = env as Env & {
				DATABASE_EU?: Hyperdrive;
				DATABASE_US?: Hyperdrive;
				DATABASE_APP_ROLE?: string;
				DATABASE_NAME?: string;
			};
			if (!snapshot.database)
				return adminJson(
					request,
					env,
					{ error: "database Hyperdrive bindings are not configured" },
					409,
				);
			if (action === "database-enable-sync") {
				const binding =
					state.database.activeRegion === "eu-central"
						? databaseEnv.DATABASE_EU
						: databaseEnv.DATABASE_US;
				if (!binding)
					return adminJson(
						request,
						env,
						{ error: "active database Hyperdrive binding is missing" },
						409,
					);
				const standbyApplicationName =
					stringField(input, "standbyApplicationName") ||
					(state.database.activeRegion === "eu-central"
						? "silo_us"
						: "silo_eu");
				await enableSynchronousReplication(
					binding,
					standbyApplicationName,
					state.database.generation,
				);
				state.database.synchronousConfirmed = true;
			} else if (action === "database-promote") {
				if (regionId !== "eu-central" && regionId !== "us-east")
					return adminJson(
						request,
						env,
						{ error: "valid database region is required" },
						400,
					);
				if (regionId === state.database.activeRegion)
					return adminJson(
						request,
						env,
						{ error: "target is already the active database region" },
						409,
					);
				const candidate = snapshot.database[regionId];
				if (
					!state.database.synchronousConfirmed ||
					!promotionEligible(candidate, state.database.generation)
				)
					return adminJson(
						request,
						env,
						{ error: "target did not pass the lossless promotion gate" },
						409,
					);
				const binding =
					regionId === "eu-central"
						? databaseEnv.DATABASE_EU
						: databaseEnv.DATABASE_US;
				if (!binding)
					return adminJson(
						request,
						env,
						{ error: "target database Hyperdrive binding is missing" },
						409,
					);
				const promoted = await promoteDatabase(
					regionId,
					binding,
					state.database.generation,
					databaseEnv.DATABASE_APP_ROLE || "silo_app",
					databaseEnv.DATABASE_NAME || "silo",
				);
				state.database.activeRegion = regionId;
				state.database.generation =
					promoted.generation || state.database.generation + 1;
				state.database.consecutiveFailures = 0;
				state.database.synchronousConfirmed = false;
				state.database.phase = regionId === "eu-central" ? "normal" : "active";
			} else if (action === "database-fence-stale") {
				if (regionId !== "eu-central" && regionId !== "us-east")
					return adminJson(
						request,
						env,
						{ error: "valid database region is required" },
						400,
					);
				if (regionId === state.database.activeRegion)
					return adminJson(
						request,
						env,
						{ error: "refusing to fence the active database region" },
						409,
					);
				const binding =
					regionId === "eu-central"
						? databaseEnv.DATABASE_EU
						: databaseEnv.DATABASE_US;
				if (!binding)
					return adminJson(
						request,
						env,
						{ error: "target database Hyperdrive binding is missing" },
						409,
					);
				await fenceDatabase(
					binding,
					databaseEnv.DATABASE_APP_ROLE || "silo_app",
					databaseEnv.DATABASE_NAME || "silo",
				);
			} else {
				return adminJson(request, env, { error: "unknown action" }, 404);
			}
			state.updatedAt = new Date().toISOString();
			await putState(env, state);
			return adminJson(request, env, { ok: true, databaseHa: state.database });
		}
		if (!region)
			return adminJson(
				request,
				env,
				{ error: "valid region is required" },
				400,
			);
		const runtime = state.regions[region.id];
		if (action === "activate-failover") {
			const target = chooseFailoverCandidate(
				env,
				registry,
				snapshot,
				region.id,
			);
			if (!target)
				return adminJson(
					request,
					env,
					{ error: "no healthy peer or authorization hook is available" },
					409,
				);
			await activateDataplaneFailover(env, state, snapshot, region, target);
		} else if (action === "force-failback") {
			if (runtime.phase !== "active")
				return adminJson(
					request,
					env,
					{ error: "region is not running on a peer" },
					409,
				);
			if (
				!snapshot.homeReadOnly[region.id] ||
				!dataplaneAvailable(snapshot.dataplanes[region.id])
			)
				return adminJson(
					request,
					env,
					{ error: "home dataplane has not passed recovery checks" },
					409,
				);
			await failbackDataplane(env, state, snapshot, region, runtime);
		} else if (
			action === "hold-auto-recovery" ||
			action === "resume-auto-recovery"
		) {
			runtime.manualRecoveryLock = action === "hold-auto-recovery";
			await addUpdate(
				env,
				state,
				"monitoring",
				`${region.flag} ${region.label} automatic failback ${runtime.manualRecoveryLock ? "held" : "resumed"} by an operator.`,
			);
		} else if (action === "promote-backend") {
			const backendId = stringField(input, "backendId");
			if (
				!backendId ||
				!region.backends.some((backend) => backend.id === backendId)
			)
				return adminJson(
					request,
					env,
					{ error: "valid backendId is required" },
					400,
				);
			await promoteBackend(env, state, snapshot, region, runtime, backendId);
		} else return adminJson(request, env, { error: "unknown action" }, 404);
		state.updatedAt = new Date().toISOString();
		await putState(env, state);
		return adminJson(request, env, { ok: true, region: runtime });
	} finally {
		await releaseMonitorLease(env, leaseHolder).catch((error) =>
			logError("operator_lease_release_failed", error),
		);
	}
}

async function incidentAdmin(
	request: Request,
	env: Env,
	pathname: string,
	registry: RegionConfig[],
): Promise<Response> {
	if (!adminOriginAllowed(request, env))
		return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (
		!(await secretMatches(
			request,
			env.STATUS_INCIDENT_PASSWORD || env.STATUS_ADMIN_SECRET,
		))
	)
		return adminJson(request, env, { error: "unauthorized" }, 401);
	if (request.method === "GET" && pathname === "/api/admin/incidents") {
		const state = await getState(env, registry);
		const incidents = await env.DB.prepare(
			"SELECT id, status, title, started_at AS startedAt, resolved_at AS resolvedAt, acknowledged_at AS acknowledgedAt, acknowledgement_message AS acknowledgementMessage FROM incidents ORDER BY datetime(started_at) DESC LIMIT 25",
		).all();
		const notes = await env.DB.prepare(
			"SELECT id, incident_id AS incidentId, message, created_at AS createdAt, updated_at AS updatedAt FROM incident_notes ORDER BY datetime(created_at) DESC LIMIT 250",
		).all();
		return adminJson(request, env, {
			activeIncidentId: state.activeIncidentId,
			incidents: incidents.results,
			notes: notes.results,
		});
	}
	const incidentMatch = pathname.match(
		/^\/api\/admin\/incidents\/([^/]+)\/(acknowledge|notes)$/,
	);
	if (request.method === "POST" && incidentMatch) {
		const incidentId = decodeURIComponent(incidentMatch[1]);
		const incident = await env.DB.prepare(
			"SELECT id, status, acknowledged_at AS acknowledgedAt FROM incidents WHERE id = ?",
		)
			.bind(incidentId)
			.first<{ id: string; status: string; acknowledgedAt: string | null }>();
		if (!incident)
			return adminJson(request, env, { error: "incident not found" }, 404);
		const input = await requestJsonRecord(request);
		if (incidentMatch[2] === "acknowledge") {
			if (incident.status !== "open")
				return adminJson(
					request,
					env,
					{ error: "only open incidents can be acknowledged" },
					409,
				);
			if (incident.acknowledgedAt)
				return adminJson(request, env, { ok: true, alreadyAcknowledged: true });
			const message =
				optionalMessage(input.message, 500) ||
				"The Silo team has acknowledged this incident and is investigating.";
			const now = new Date().toISOString();
			await env.DB.batch([
				env.DB.prepare(
					"UPDATE incidents SET acknowledged_at = ?, acknowledgement_message = ? WHERE id = ?",
				).bind(now, message, incidentId),
				env.DB.prepare(
					"INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)",
				).bind(incidentId, "acknowledged", message, now),
			]);
			return adminJson(request, env, { ok: true, acknowledgedAt: now });
		}
		const message = requiredMessage(input.message, 2_000);
		if (message instanceof Response)
			return withAdminCors(request, env, message);
		const now = new Date().toISOString(),
			id = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO incident_notes (id, incident_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
			.bind(id, incidentId, message, now, now)
			.run();
		return adminJson(
			request,
			env,
			{
				ok: true,
				note: { id, incidentId, message, createdAt: now, updatedAt: now },
			},
			201,
		);
	}
	const noteMatch = pathname.match(/^\/api\/admin\/notes\/([^/]+)$/);
	if (noteMatch && ["PATCH", "DELETE"].includes(request.method)) {
		const noteId = decodeURIComponent(noteMatch[1]);
		if (
			!(await env.DB.prepare("SELECT id FROM incident_notes WHERE id = ?")
				.bind(noteId)
				.first())
		)
			return adminJson(request, env, { error: "note not found" }, 404);
		if (request.method === "DELETE") {
			await env.DB.prepare("DELETE FROM incident_notes WHERE id = ?")
				.bind(noteId)
				.run();
			return adminJson(request, env, { ok: true });
		}
		const message = requiredMessage(
			(await requestJsonRecord(request)).message,
			2_000,
		);
		if (message instanceof Response)
			return withAdminCors(request, env, message);
		const updatedAt = new Date().toISOString();
		await env.DB.prepare(
			"UPDATE incident_notes SET message = ?, updated_at = ? WHERE id = ?",
		)
			.bind(message, updatedAt, noteId)
			.run();
		return adminJson(request, env, { ok: true, updatedAt });
	}
	return adminJson(request, env, { error: "not found" }, 404);
}

async function maintenanceAdmin(
	request: Request,
	env: Env,
	pathname: string,
): Promise<Response> {
	if (!adminOriginAllowed(request, env))
		return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (!(await secretMatches(request, env.STATUS_ADMIN_SECRET)))
		return adminJson(request, env, { error: "unauthorized" }, 401);
	if (request.method === "GET" && pathname === "/api/admin/maintenance") {
		const rows = await env.DB.prepare(
			"SELECT id, title, message, starts_at AS startsAt, ends_at AS endsAt FROM maintenance_windows WHERE datetime(ends_at) >= datetime('now', '-1 day') ORDER BY datetime(starts_at) ASC LIMIT 50",
		).all();
		return adminJson(request, env, { maintenance: rows.results });
	}
	if (request.method === "POST" && pathname === "/api/admin/maintenance") {
		const input = await requestJsonRecord(request);
		const title = requiredMessage(input.title, 120),
			message = requiredMessage(input.message, 1_000);
		if (title instanceof Response) return withAdminCors(request, env, title);
		if (message instanceof Response)
			return withAdminCors(request, env, message);
		const startsAt = typeof input.startsAt === "string" ? input.startsAt : "",
			endsAt = typeof input.endsAt === "string" ? input.endsAt : "";
		if (
			!Date.parse(startsAt) ||
			!Date.parse(endsAt) ||
			Date.parse(endsAt) <= Date.parse(startsAt)
		)
			return adminJson(
				request,
				env,
				{ error: "invalid maintenance range" },
				400,
			);
		const id = crypto.randomUUID();
		await env.DB.prepare(
			"INSERT INTO maintenance_windows (id, title, message, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)",
		)
			.bind(id, title, message, startsAt, endsAt)
			.run();
		return adminJson(request, env, { ok: true, id }, 201);
	}
	const match = pathname.match(/^\/api\/admin\/maintenance\/([^/]+)$/);
	if (request.method === "DELETE" && match) {
		await env.DB.prepare("DELETE FROM maintenance_windows WHERE id = ?")
			.bind(decodeURIComponent(match[1]))
			.run();
		return adminJson(request, env, { ok: true });
	}
	return adminJson(request, env, { error: "not found" }, 404);
}

async function publicStatus(
	env: Env,
	registry: RegionConfig[],
): Promise<unknown> {
	const state = await getState(env, registry);
	const databaseAutomation = env as Env & { AUTO_FAILOVER_DATABASE?: string };
	const incidents = await env.DB.prepare(
		"SELECT id, status, title, started_at AS startedAt, resolved_at AS resolvedAt, acknowledged_at AS acknowledgedAt, acknowledgement_message AS acknowledgementMessage FROM incidents ORDER BY datetime(started_at) DESC LIMIT 10",
	).all();
	const updates = state.activeIncidentId
		? await env.DB.prepare(
				"SELECT status, message, created_at AS createdAt FROM incident_updates WHERE incident_id = ? ORDER BY id DESC LIMIT 30",
			)
				.bind(state.activeIncidentId)
				.all()
		: { results: [] };
	const notes = await env.DB.prepare(
		"SELECT id, incident_id AS incidentId, message, created_at AS createdAt, updated_at AS updatedAt FROM incident_notes ORDER BY datetime(created_at) DESC LIMIT 100",
	).all();
	const maintenance = await env.DB.prepare(
		"SELECT id, title, message, starts_at AS startsAt, ends_at AS endsAt FROM maintenance_windows WHERE datetime(ends_at) >= datetime('now') ORDER BY datetime(starts_at) ASC LIMIT 10",
	).all();
	const uptime = await env.DB.prepare(
		"SELECT COUNT(*) AS samples, COALESCE(SUM(s3_operational), 0) AS s3Ok, COALESCE(SUM(dashboard_operational), 0) AS dashboardOk, MIN(recorded_at) AS firstAt FROM uptime_checks WHERE datetime(recorded_at) >= datetime('now', '-90 days')",
	).first<{
		samples: number;
		s3Ok: number;
		dashboardOk: number;
		firstAt: string | null;
	}>();
	const uptimeHistory = await env.DB.prepare(
		"SELECT substr(recorded_at, 1, 10) AS day, COUNT(*) AS samples, SUM(s3_operational) AS s3Ok, SUM(dashboard_operational) AS dashboardOk FROM uptime_checks WHERE datetime(recorded_at) >= datetime('now', '-90 days') GROUP BY substr(recorded_at, 1, 10) ORDER BY day ASC",
	).all<{ day: string; samples: number; s3Ok: number; dashboardOk: number }>();
	const componentUptime = await env.DB.prepare(
		"SELECT component_id AS componentId, COUNT(*) AS samples, SUM(operational) AS operational, SUM(planned_maintenance) AS plannedMaintenance, MIN(recorded_at) AS firstAt FROM component_uptime_checks WHERE datetime(recorded_at) >= datetime('now', '-90 days') GROUP BY component_id",
	).all<{
		componentId: string;
		samples: number;
		operational: number;
		plannedMaintenance: number;
		firstAt: string;
	}>();
	const componentDefinitions = definitions(registry);
	const production = state.productionMaintenance
		? {
				id: "production-maintenance",
				...state.productionMaintenance,
				endsAt: null,
			}
		: null;
	const activeMaintenance =
		production ||
		(maintenance.results as Array<{ startsAt: string; endsAt: string }>).find(
			(item) =>
				Date.parse(item.startsAt) <= Date.now() &&
				Date.parse(item.endsAt) >= Date.now(),
		) ||
		null;
	const samples = Number(uptime?.samples || 0);
	const uptimeStart = uptime?.firstAt
		? Math.max(Date.parse(uptime.firstAt), Date.now() - 90 * 24 * 60 * 60_000)
		: Date.now();
	const expectedSamples = samples
		? Math.max(samples, Math.floor((Date.now() - uptimeStart) / 60_000) + 1)
		: 0;
	const percent = (value: number, denominator = expectedSamples) =>
		denominator
			? Math.round((100_000 * Number(value || 0)) / denominator) / 1000
			: null;
	const history = uptimeHistory.results.map((row) => ({
		day: row.day,
		samples: Number(row.samples || 0),
		s3: percent(row.s3Ok, Number(row.samples)),
		dashboard: percent(row.dashboardOk, Number(row.samples)),
	}));
	const componentAvailability = Object.fromEntries(
		componentUptime.results.map((row) => {
			const firstAt = Math.max(
				Date.parse(row.firstAt),
				Date.now() - 90 * 24 * 60 * 60_000,
			);
			const expected = Math.max(
				Number(row.samples),
				Math.floor((Date.now() - firstAt) / 60_000) + 1,
			);
			return [
				row.componentId,
				{
					samples: Number(row.samples),
					expectedSamples: expected,
					plannedMaintenanceSamples: Number(row.plannedMaintenance),
					availability: percent(row.operational, expected),
				},
			];
		}),
	);
	const legacyComponents: Record<string, ComponentStatus> = {
		dashboard: state.components["control-plane"] || "unknown",
		database:
			state.components["postgresql-ha"] ||
			state.components["aiven-postgresql"] ||
			"unknown",
		storage: state.components["global-s3"] || "unknown",
		s3Api: state.components["global-s3"] || "unknown",
		uploads: state.components["global-s3"] || "unknown",
		downloads: state.components["global-s3"] || "unknown",
		authentication: state.components["global-s3"] || "unknown",
	};
	return {
		overall: state.overall,
		databaseHa: {
			controller: "cloudflare-worker",
			...state.database,
			configured: "postgresql-ha" in state.components,
			automationEnabled: databaseAutomation.AUTO_FAILOVER_DATABASE === "true",
			drillApproved: env.FAILOVER_DRILL_APPROVED === "true",
		},
		components: { ...state.components, ...legacyComponents },
		componentDefinitions,
		componentAvailability,
		regions: publicRegionStates(registry, state),
		failoverPhase: aggregatePhase(registry, state),
		activeIncidentId: state.activeIncidentId,
		updatedAt: state.updatedAt,
		activeMaintenance,
		maintenance: production
			? [production, ...maintenance.results]
			: maintenance.results,
		incidents: incidents.results,
		updates: updates.results,
		notes: notes.results,
		uptime: {
			windowDays: 90,
			samples,
			expectedSamples,
			s3: percent(uptime?.s3Ok || 0),
			dashboard: percent(uptime?.dashboardOk || 0),
			history,
		},
	};
}

function definitions(registry: RegionConfig[]): ComponentDefinition[] {
	const result: ComponentDefinition[] = [
		{
			id: "control-plane",
			name: "Silo Dashboard and Control Plane",
			description: "Global Bun control plane",
			group: "global",
		},
		{
			id: "aiven-postgresql",
			name: "Aiven PostgreSQL",
			description: "Authoritative global metadata and coordination",
			group: "global",
		},
		{
			id: "postgresql-ha",
			name: "Silo PostgreSQL HA",
			description:
				"EU primary, US hot standby, and Cloudflare-controlled promotion",
			group: "global",
		},
		{
			id: "database-ha-controller",
			name: "Database HA Controller",
			description:
				"Independent Cloudflare Worker witness, fencing, and promotion controller",
			group: "global",
		},
		{
			id: "postgresql-replication",
			name: "PostgreSQL Cross-region Replication",
			description: "Synchronous WAL durability and replica freshness",
			group: "global",
		},
		{
			id: "clickhouse-logs",
			name: "Request Log Analytics",
			description: "EU and US ClickHouse query availability",
			group: "global",
		},
		{
			id: "clickhouse-log-redundancy",
			name: "Request Log Redundancy",
			description: "Durable dual-region delivery and recent-event parity",
			group: "global",
		},
	];
	for (const region of registry) {
		result.push({
			id: `dataplane:${region.id}`,
			name: `${region.flag} ${region.label} Dataplane`,
			description: `Preferred ingress in ${region.id}`,
			group: "regional",
		});
		result.push({
			id: `storage:${region.id}`,
			name: `${region.flag} ${region.label} Storage`,
			description: "Logical storage region",
			group: "regional",
		});
		result.push({
			id: `accounting:${region.id}`,
			name: `${region.flag} ${region.label} Accounting Safety`,
			description: "Durable regional accounting spool and replay state",
			group: "regional",
		});
		for (const backend of region.backends)
			result.push({
				id: `backend:${region.id}:${backend.id}`,
				name: `${region.flag} ${backend.label}`,
				description: `${backend.provider} physical ${backend.role} backend`,
				group: "backends",
			});
		if (region.backends.length > 1)
			result.push({
				id: `replication:${region.id}`,
				name: `${region.flag} ${region.label} Replication`,
				description: "Checkpoint freshness and replica lag",
				group: "backends",
			});
	}
	result.push({
		id: "global-s3",
		name: "Global S3 Availability",
		description: "Signed operations through every logical region",
		group: "global",
	});
	return result;
}

function publicRegionStates(
	registry: RegionConfig[],
	state: StatusState,
): unknown[] {
	return registry.map((region) => ({
		id: region.id,
		label: region.label,
		flag: region.flag,
		homeDataplane: region.id,
		activeDataplane: state.regions[region.id].activeDataplane,
		activeBackend: state.regions[region.id].activeBackend,
		phase: state.regions[region.id].phase,
		providerPhase: state.regions[region.id].providerPhase,
		writerGeneration: state.regions[region.id].writerGeneration,
		backendGeneration: state.regions[region.id].backendGeneration,
		recovery: {
			successfulChecks: state.regions[region.id].consecutiveRecoveries,
			requiredChecks: RECOVERY_THRESHOLD,
			cleanupAfter: state.regions[region.id].cleanupAfter,
		},
	}));
}
function aggregatePhase(registry: RegionConfig[], state: StatusState): string {
	const phases = registry.map((region) => state.regions[region.id].phase);
	if (phases.includes("active")) return "active";
	if (phases.includes("credential_cleanup") || phases.includes("failing_back"))
		return "recovering";
	if (phases.includes("activating")) return "ready";
	if (phases.includes("ready")) return "ready";
	if (phases.includes("blocked")) return "failed";
	if (phases.includes("investigating")) return "investigating";
	return "inactive";
}
function autoActivate(env: Env): boolean {
	return (
		env.AUTO_ACTIVATE_FAILOVER === "true" &&
		env.FAILOVER_DRILL_APPROVED === "true"
	);
}
function autoPromoteStorage(env: Env): boolean {
	return (
		env.AUTO_PROMOTE_STORAGE === "true" &&
		env.FAILOVER_DRILL_APPROVED === "true"
	);
}
function autoRedirectDashboard(env: Env): boolean {
	return (
		env.AUTO_REDIRECT_DASHBOARD === "true" &&
		env.FAILOVER_DRILL_APPROVED === "true"
	);
}

async function ensureIncident(
	env: Env,
	state: StatusState,
	message: string,
	title: string,
): Promise<void> {
	if (state.activeIncidentId) {
		await addUpdate(env, state, "investigating", message);
		return;
	}
	const id = crypto.randomUUID();
	state.activeIncidentId = id;
	await env.DB.prepare(
		"INSERT INTO incidents (id, status, title, started_at) VALUES (?, ?, ?, ?)",
	)
		.bind(id, "open", title, new Date().toISOString())
		.run();
	await addUpdate(env, state, "investigating", message);
}
async function addUpdate(
	env: Env,
	state: StatusState,
	status: string,
	message: string,
): Promise<void> {
	if (!state.activeIncidentId) return;
	await env.DB.prepare(
		"INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)",
	)
		.bind(state.activeIncidentId, status, message, new Date().toISOString())
		.run();
}
async function resolveIncident(
	env: Env,
	state: StatusState,
	message: string,
): Promise<void> {
	await addUpdate(env, state, "resolved", message);
	if (state.activeIncidentId)
		await env.DB.prepare(
			"UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?",
		)
			.bind(new Date().toISOString(), state.activeIncidentId)
			.run();
	state.activeIncidentId = undefined;
}
async function notifyMaintainers(
	env: Env,
	event: string,
	message: string,
): Promise<void> {
	if (!env.ALERT_WEBHOOK_URL) return;
	try {
		await fetch(env.ALERT_WEBHOOK_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "silo-status",
				event,
				message,
				statusUrl: "https://status.onsilo.dev",
			}),
		});
	} catch (error) {
		logError("alert_delivery_failed", error, { event });
	}
}
async function getActiveMaintenance(env: Env): Promise<unknown> {
	return env.DB.prepare(
		"SELECT id, title, message, starts_at AS startsAt, ends_at AS endsAt FROM maintenance_windows WHERE datetime(starts_at) <= datetime('now') AND datetime(ends_at) >= datetime('now') ORDER BY datetime(starts_at) ASC LIMIT 1",
	).first();
}

async function ok(url: string): Promise<boolean> {
	if (!url) return false;
	try {
		return (await fetchWithDeadline(url, { redirect: "manual" })).ok;
	} catch {
		return false;
	}
}
async function probeClickHouse(
	url: string,
	user: string,
	password: string,
): Promise<ClickHouseProbe> {
	try {
		const endpoint = new URL(url);
		if (endpoint.protocol !== "https:") throw new Error("HTTPS is required");
		endpoint.searchParams.set("database", "silo_logs");
		const response = await fetchWithDeadline(
			endpoint,
			{
				method: "POST",
				headers: {
					Authorization: `Basic ${btoa(`${user}:${password}`)}`,
					"Content-Type": "text/plain; charset=utf-8",
				},
				body: `SELECT uniqExact(request_id) AS recentRows,
					concat(toString(max(event_time), 'UTC'), 'Z') AS latestEventAt
				FROM request_logs FINAL
				WHERE event_time >= now() - INTERVAL 15 MINUTE
				FORMAT JSONEachRow`,
			},
			8_000,
		);
		if (!response.ok)
			throw new Error(`ClickHouse returned HTTP ${response.status}`);
		const row = JSON.parse((await response.text()).trim()) as {
			recentRows?: string | number;
			latestEventAt?: string;
		};
		return {
			reachable: true,
			recentRows: Number(row.recentRows || 0),
			latestEventAt: row.latestEventAt || undefined,
		};
	} catch (error) {
		return {
			reachable: false,
			recentRows: 0,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
async function fetchWithDeadline(
	input: string | URL,
	init: RequestInit = {},
	timeoutMs = CHECK_TIMEOUT_MS,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}
async function sleep(milliseconds: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function responseJsonRecord(
	response: Response,
): Promise<Record<string, unknown>> {
	const value: unknown = await response.json();
	if (!isRecord(value)) throw new Error("expected a JSON object");
	return value;
}
async function requestJsonRecord(
	request: Request,
): Promise<Record<string, unknown>> {
	try {
		const value: unknown = await request.json();
		return isRecord(value) ? value : {};
	} catch {
		return {};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value: unknown, name: string): string {
	if (typeof value !== "string" || !value.trim())
		throw new Error(`${name} must be a non-empty string`);
	return value.trim();
}
function stringField(
	value: Record<string, unknown>,
	key: string,
): string | undefined {
	return typeof value[key] === "string" ? value[key] : undefined;
}
function numberField(
	value: Record<string, unknown>,
	key: string,
): number | undefined {
	return finiteNumber(value[key]);
}
function booleanField(
	value: Record<string, unknown>,
	key: string,
): boolean | undefined {
	return typeof value[key] === "boolean" ? value[key] : undefined;
}
function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}
function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}
function stringMap(value: unknown): Record<string, string> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}
function jsonStringMap(value: string): Record<string, string> {
	const parsed: unknown = JSON.parse(value);
	return stringMap(parsed);
}
function booleanMap(value: unknown): Record<string, boolean> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, boolean] => typeof entry[1] === "boolean",
		),
	);
}
function numberMap(value: unknown): Record<string, number> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter(
			(entry): entry is [string, number] =>
				typeof entry[1] === "number" && Number.isFinite(entry[1]),
		),
	);
}
function nestedBooleanMap(
	value: unknown,
): Record<string, Record<string, boolean>> {
	if (!isRecord(value)) return {};
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, booleanMap(item)]),
	);
}
function componentMap(value: unknown): Record<string, ComponentStatus> {
	if (!isRecord(value)) return {};
	const output: Record<string, ComponentStatus> = {};
	for (const [id, status] of Object.entries(value))
		if (
			status === "operational" ||
			status === "degraded" ||
			status === "outage" ||
			status === "unknown"
		)
			output[id] = status;
	return output;
}
function regionPhase(value: unknown): RegionPhase {
	return value === "investigating" ||
		value === "ready" ||
		value === "activating" ||
		value === "active" ||
		value === "failing_back" ||
		value === "credential_cleanup" ||
		value === "blocked"
		? value
		: "normal";
}
function providerPhase(value: unknown): ProviderPhase {
	return value === "investigating" ||
		value === "ready" ||
		value === "promoting" ||
		value === "replica_active" ||
		value === "blocked"
		? value
		: "normal";
}
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "operation failed";
}
function logError(
	event: string,
	error: unknown,
	fields: Record<string, unknown> = {},
): void {
	console.error(
		JSON.stringify({ event, error: errorMessage(error), ...fields }),
	);
}

function optionalMessage(value: unknown, maxLength: number): string {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}
function requiredMessage(value: unknown, maxLength: number): string | Response {
	const message = optionalMessage(value, maxLength);
	return message ? message : json({ error: "message is required" }, 400);
}
async function secretMatches(
	request: Request,
	expected: string,
): Promise<boolean> {
	const provided = request.headers.get("authorization") || "";
	if (!expected) return false;
	const encoder = new TextEncoder();
	const [left, right] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(provided)),
		crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${expected}`)),
	]);
	const leftBytes = new Uint8Array(left),
		rightBytes = new Uint8Array(right);
	let difference = leftBytes.length ^ rightBytes.length;
	for (
		let index = 0;
		index < Math.max(leftBytes.length, rightBytes.length);
		index += 1
	)
		difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
	return difference === 0;
}
function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json",
			"cache-control": "no-store",
			"access-control-allow-origin": "*",
		},
	});
}
function adminOrigins(env: Env): string[] {
	return (env.STATUS_ADMIN_ORIGINS || "https://status.onsilo.dev")
		.split(",")
		.map((origin) => origin.trim())
		.filter(Boolean);
}
function adminOriginAllowed(request: Request, env: Env): boolean {
	const origin = request.headers.get("origin");
	return !origin || adminOrigins(env).includes(origin);
}
function adminJson(
	request: Request,
	env: Env,
	value: unknown,
	status = 200,
): Response {
	return withAdminCors(
		request,
		env,
		new Response(JSON.stringify(value), {
			status,
			headers: {
				"content-type": "application/json",
				"cache-control": "no-store",
			},
		}),
	);
}
function withAdminCors(
	request: Request,
	env: Env,
	response: Response,
): Response {
	const origin = request.headers.get("origin");
	if (!origin || !adminOrigins(env).includes(origin)) return response;
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-allow-headers", "authorization, content-type");
	headers.set(
		"access-control-allow-methods",
		"GET, POST, PATCH, DELETE, OPTIONS",
	);
	headers.set("vary", "Origin");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
function corsPreflight(request: Request, env: Env, pathname: string): Response {
	if (pathname.startsWith("/api/admin/") && !adminOriginAllowed(request, env))
		return new Response(null, { status: 403 });
	if (!pathname.startsWith("/api/admin/"))
		return new Response(null, {
			status: 204,
			headers: {
				"access-control-allow-origin": "*",
				"access-control-allow-methods": "GET, OPTIONS",
			},
		});
	return withAdminCors(request, env, new Response(null, { status: 204 }));
}
function outageFallback(request: Request): Response {
	const url = new URL(request.url);
	if (
		request.method === "GET" &&
		url.pathname === "/" &&
		request.headers.get("accept")?.includes("text/html")
	)
		return new Response(
			"<!doctype html><meta name=viewport content='width=device-width'><title>Silo is recovering</title><main><h1>Silo is recovering.</h1><p>Storage traffic is being restored safely. Retry shortly or see <a href='https://status.onsilo.dev'>status.onsilo.dev</a>.</p></main>",
			{
				status: 503,
				headers: {
					"content-type": "text/html; charset=utf-8",
					"retry-after": "60",
					"cache-control": "no-store",
				},
			},
		);
	const requestId = crypto.randomUUID();
	return new Response(
		`<?xml version="1.0" encoding="UTF-8"?><Error><Code>ServiceUnavailable</Code><Message>Please retry shortly.</Message><RequestId>${requestId}</RequestId><HostId>silo-regional-fallback</HostId></Error>`,
		{
			status: 503,
			headers: {
				"content-type": "application/xml",
				"retry-after": "60",
				"cache-control": "no-store",
				"x-silo-failover": "fallback",
				"x-amz-request-id": requestId,
			},
		},
	);
}
function dashboardStatusRedirect(): Response {
	return Response.redirect("https://status.onsilo.dev", 302);
}

// Pure state-machine helpers are exported as one deliberately narrow surface
// so failover safety contracts can be regression-tested without starting a
// Worker or exposing operational endpoints.
export const __test = {
	parseRegistry,
	parseCredentialMap,
	s3RequestUrl,
	dataplaneAvailable,
	readinessCanServe,
	chooseBackendCandidate,
	deriveComponents,
	deriveOverall,
};

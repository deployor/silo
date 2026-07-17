export interface Env {
	DB: D1Database;
	PRIMARY_HEALTH_URL: string;
	PRIMARY_READY_URL: string;
	DATAPLANE_INTERNAL_SECRET: string;
	PRIMARY_S3_CANARY_URL: string;
	PRIMARY_DASHBOARD_URL?: string;
	PRIMARY_MAINTENANCE_URL?: string;
	DASHBOARD_URL?: string;
	EMERGENCY_HEALTH_URL?: string;
	EMERGENCY_READY_URL?: string;
	EMERGENCY_S3_CANARY_URL?: string;
	CANARY_ACCESS_KEY_ID: string;
	CANARY_SECRET_ACCESS_KEY: string;
	CANARY_BUCKET: string;
	CANARY_REGION?: string;
	GITHUB_OWNER: string;
	GITHUB_REPO: string;
	GITHUB_DISPATCH_TOKEN: string;
	STATUS_CALLBACK_URL: string;
	STATUS_CALLBACK_SECRET: string;
	STATUS_ADMIN_SECRET: string;
	STATUS_INCIDENT_PASSWORD?: string;
	STATUS_BOOTSTRAP_SECRET: string;
	BOOTSTRAP_ENCRYPTION_KEY: string;
	STATUS_ADMIN_ORIGINS?: string;
	CF_DNS_TOKEN: string;
	CF_ZONE_ID: string;
	CF_S3_RECORD_ID: string;
	S3_DNS_NAME?: string;
	PRIMARY_IPV4: string;
	PRIMARY_IPV6?: string;
	CF_EMERGENCY_RECORD_ID: string;
	EMERGENCY_DNS_NAME?: string;
	CF_DASHBOARD_RECORD_ID?: string;
	DASHBOARD_DNS_NAME?: string;
	PRIMARY_DASHBOARD_IPV4?: string;
	AUTO_PROVISION_FAILOVER?: string;
	AUTO_REDIRECT_DASHBOARD?: string;
	AUTO_ACTIVATE_FAILOVER?: string;
	FAILOVER_DRILL_APPROVED?: string;
	AUTO_RECOVER?: string;
	ALERT_WEBHOOK_URL?: string;
	CLOUDFLARE_API_BASE?: string;
	GITHUB_API_BASE?: string;
}

type Component = "s3Api" | "uploads" | "downloads" | "deletes" | "authentication" | "postgres" | "redis" | "backingStorage" | "writerLease" | "dashboard" | "failover";
type ComponentStatus = "operational" | "degraded" | "outage" | "unknown";
type FailoverPhase = "inactive" | "investigating" | "provisioning" | "ready" | "active" | "recovering" | "failed";

type ReadinessChecks = {
	ok: boolean;
	postgres?: boolean;
	redis?: boolean;
	storage?: boolean;
	activeWriter?: boolean;
};

type OperationChecks = {
	authentication: boolean;
	upload: boolean;
	download: boolean;
	delete: boolean;
};

type ProbeChecks = {
	health: boolean;
	ready: boolean;
	canary: boolean;
	dashboard?: boolean;
	readiness?: ReadinessChecks;
	operations?: OperationChecks;
};

type StatusState = {
	overall: "operational" | "degraded" | "major_outage";
	components: Record<Component, ComponentStatus>;
	consecutiveFailures: number;
	consecutiveRecoveries: number;
	recoveryHealthySince?: string;
	failoverPhase: FailoverPhase;
	provisioningStep: "idle" | "checking_primary" | "server_requested" | "server_online" | "starting_dataplane" | "verifying_storage" | "verified" | "active" | "failed";
	emergencyServerId?: number;
	emergencyIp?: string;
	activeIncidentId?: string;
	manualRecoveryLock: boolean;
	destroyAfter?: string;
	productionMaintenance?: { title: string; message: string; startsAt: string; lastVerifiedAt: string };
	updatedAt: string;
};

const STATE_ID = "current";
const FAILURE_THRESHOLD = 5;
const RECOVERY_THRESHOLD = 10;
const GRACE_MS = 10 * 60 * 1000;
const CHECK_TIMEOUT_MS = 12_000;

const defaultState = (): StatusState => ({
	overall: "operational",
	components: {
		s3Api: "unknown", uploads: "unknown", downloads: "unknown", deletes: "unknown", authentication: "unknown", postgres: "unknown", redis: "unknown", backingStorage: "unknown", writerLease: "unknown", dashboard: "unknown", failover: "operational",
	},
	consecutiveFailures: 0,
	consecutiveRecoveries: 0,
	failoverPhase: "inactive",
	provisioningStep: "idle",
	manualRecoveryLock: false,
	updatedAt: new Date().toISOString(),
});

export default {
	async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		ctx.waitUntil(runMonitor(env));
	},
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.hostname === (env.S3_DNS_NAME || "onsilo.dev")) return outageFallback(request);
			if (url.hostname === (env.DASHBOARD_DNS_NAME || "dash.onsilo.dev")) return dashboardStatusRedirect();
			if (request.method === "OPTIONS") return corsPreflight(request, env, url.pathname);
			if (request.method === "GET" && url.pathname === "/api/status") return json(await publicStatus(env));
			if (request.method === "POST" && url.pathname.startsWith("/api/bootstrap/")) return bootstrap(request, env, url.pathname.slice(15));
			if (request.method === "POST" && url.pathname.startsWith("/api/callback/")) return callback(request, env, url.pathname.slice(14));
			if (url.pathname === "/api/admin/incidents" || url.pathname.startsWith("/api/admin/incidents/") || url.pathname.startsWith("/api/admin/notes/")) return incidentAdmin(request, env, url.pathname);
			if (url.pathname === "/api/admin/maintenance" || url.pathname.startsWith("/api/admin/maintenance/")) return maintenanceAdmin(request, env, url.pathname);
			if (request.method === "GET" && url.pathname === "/api/admin/operations") return operationsAdmin(request, env);
			if (request.method === "POST" && url.pathname.startsWith("/api/admin/")) return admin(request, env, url.pathname.slice(11));
			return json({ error: "not found" }, 404);
		} catch (error) {
			console.error("request failed", error);
			if (url.pathname.startsWith("/api/admin/")) {
				return adminJson(request, env, { error: error instanceof Error ? error.message : "admin action failed" }, 500);
			}
			return json({ error: "request failed" }, 500);
		}
	},
};

async function runMonitor(env: Env) {
	const state = await getState(env);
	const productionMaintenance = await checkProductionMaintenance(env);
	if (productionMaintenance) {
		const now = new Date().toISOString();
		state.productionMaintenance = {
			title: productionMaintenance.fullMaintenanceMode ? "Full application maintenance" : "S3 maintenance",
			message: productionMaintenance.fullMaintenanceMode ? "Silo is temporarily offline for planned application maintenance." : "S3 storage is temporarily unavailable for planned maintenance.",
			startsAt: state.productionMaintenance?.startsAt || now,
			lastVerifiedAt: now,
		};
	} else if (productionMaintenance === false || (state.productionMaintenance && Date.now() - Date.parse(state.productionMaintenance.lastVerifiedAt) > 3 * 60_000)) {
		state.productionMaintenance = undefined;
	}
	const previousDashboard = state.components.dashboard;
	const checks = await checkPrimary(env, state.failoverPhase === "active");
	setS3Components(state, checks);
	state.components.dashboard = checks.dashboard ? "operational" : "outage";
	if (!checks.dashboard && previousDashboard !== "outage" && autoRedirectDashboard(env)) await pointDashboardAtStatus(env);
	const primaryHealthy = checks.health && checks.ready && checks.canary;
	const plannedMaintenance = state.productionMaintenance || await getActiveMaintenance(env);
	if (plannedMaintenance && ["inactive", "investigating"].includes(state.failoverPhase)) {
		state.consecutiveFailures = 0;
		state.consecutiveRecoveries = 0;
		state.failoverPhase = "inactive";
		state.provisioningStep = "idle";
		state.overall = "degraded";
		state.components = Object.fromEntries(Object.entries(state.components).map(([component, status]) => [component, status === "outage" ? "degraded" : status])) as Record<Component, ComponentStatus>;
		state.components.failover = "operational";
		if (state.activeIncidentId) await resolveIncident(env, state, "Monitoring entered the scheduled maintenance window; emergency failover was not required.");
		state.updatedAt = new Date().toISOString();
		await recordAvailability(env, state, true);
		await putState(env, state);
		return;
	}

	if (state.failoverPhase === "recovering" && !primaryHealthy) {
		// A relapse during DNS grace is a new outage: do not delete the VM.
		if (state.emergencyIp) await activateEmergency(env, state, "The primary relapsed during DNS grace. Traffic returned to the healthy emergency server.");
		state.destroyAfter = undefined;
		state.consecutiveRecoveries = 0;
		state.recoveryHealthySince = undefined;
	}

	if (state.failoverPhase === "active" || state.failoverPhase === "recovering") {
		if (state.failoverPhase === "active") {
			const emergency = await checkEmergency(env);
			setS3Components(state, emergency);
			state.components.dashboard = "outage";
			state.components.failover = emergency.health && emergency.ready && emergency.canary ? "operational" : "outage";
			state.overall = state.components.failover === "operational" ? "degraded" : "major_outage";
		} else {
			state.components.failover = "degraded";
			state.overall = "degraded";
		}
		if (primaryHealthy) {
			state.recoveryHealthySince ||= new Date().toISOString();
			state.consecutiveRecoveries += 1;
		} else {
			state.consecutiveRecoveries = 0;
			state.recoveryHealthySince = undefined;
		}
		const primaryHealthyForTenMinutes = Boolean(state.recoveryHealthySince) && Date.now() - Date.parse(state.recoveryHealthySince!) >= 10 * 60 * 1000;
		if (state.failoverPhase === "active" && state.consecutiveRecoveries >= RECOVERY_THRESHOLD && primaryHealthyForTenMinutes && autoRecover(env, state)) {
			await activatePrimary(env);
			state.failoverPhase = "recovering";
			state.destroyAfter = new Date(Date.now() + GRACE_MS).toISOString();
			await addUpdate(env, state, "monitoring", "Primary stayed healthy for ten minutes. DNS returned to the primary; keeping the emergency server during DNS grace.");
		}
		if (state.failoverPhase === "recovering" && state.destroyAfter && Date.parse(state.destroyAfter) <= Date.now()) {
			await dispatch(env, "destroy_emergency", { server_id: state.emergencyServerId, primary_dns_confirmed: true, safe_to_delete: false, resolve_incident: true, accounting_required: true, incident_id: state.activeIncidentId });
			state.destroyAfter = undefined;
			await addUpdate(env, state, "monitoring", "Recovery grace period elapsed; requesting emergency server cleanup.");
		}
		if (state.failoverPhase === "recovering" && checks.dashboard && previousDashboard !== "operational" && autoRedirectDashboard(env)) {
			await pointDashboardAtPrimary(env);
		}
	} else if (primaryHealthy) {
		state.consecutiveFailures = 0;
		if (state.failoverPhase === "investigating") {
			state.failoverPhase = "inactive";
			state.provisioningStep = "idle";
			if (checks.dashboard) await resolveIncident(env, state, "Primary recovered before failover was required.");
			else await addUpdate(env, state, "monitoring", "S3 recovered; the dashboard remains unavailable.");
		} else if (state.failoverPhase === "failed") {
			await pointS3AtPrimary(env);
			if (checks.dashboard && autoRedirectDashboard(env)) await pointDashboardAtPrimary(env);
			state.failoverPhase = "inactive";
			state.provisioningStep = "idle";
			state.components.failover = "operational";
			await resolveIncident(env, state, "The primary recovered after emergency provisioning failed.");
		}
		if (!checks.dashboard) {
			state.overall = "degraded";
			state.components.failover = "operational";
			if (!state.activeIncidentId) {
				await openIncident(env, state, "Dashboard availability is being investigated.", "Dashboard disruption");
				await notifyMaintainers(env, "dashboard_outage", "The dashboard is unavailable; S3 remains operational.");
			}
			else if (previousDashboard !== "outage") await addUpdate(env, state, "investigating", "The dashboard is unavailable. S3 storage remains operational.");
		} else {
			state.overall = "operational";
			state.components.failover = "operational";
			if (previousDashboard !== "operational" && autoRedirectDashboard(env)) await pointDashboardAtPrimary(env);
			if (state.activeIncidentId) await resolveIncident(env, state, "The dashboard recovered. All services are operational.");
		}
	} else {
		state.consecutiveFailures += 1;
		state.consecutiveRecoveries = 0;
		if (state.consecutiveFailures === 1) {
			state.failoverPhase = "investigating";
			state.provisioningStep = "checking_primary";
			state.overall = "degraded";
			await openIncident(env, state, "S3 service availability is being investigated.");
			await notifyMaintainers(env, "investigating", "Silo failed its first complete S3 monitoring round.");
		}
		if (state.consecutiveFailures >= FAILURE_THRESHOLD && ["investigating", "inactive"].includes(state.failoverPhase)) {
			state.overall = "major_outage";
			state.components.failover = "degraded";
			if (autoProvision(env)) {
				state.failoverPhase = "provisioning";
				state.provisioningStep = "server_requested";
				if (autoRedirectDashboard(env)) await pointDashboardAtStatus(env);
				await dispatch(env, "provision_emergency", { callback_url: env.STATUS_CALLBACK_URL, incident_id: state.activeIncidentId });
				await addUpdate(env, state, "identified", "Outage confirmed after five failed checks. Requesting the emergency S3 server.");
				await notifyMaintainers(env, "major_outage", "Silo failed five consecutive checks. Hetzner provisioning has started.");
			} else if (state.consecutiveFailures === FAILURE_THRESHOLD) {
				await addUpdate(env, state, "identified", "Outage confirmed after five failed checks. Automatic Hetzner provisioning is disabled; an operator can start it from the incident desk.");
				await notifyMaintainers(env, "major_outage", "Silo failed five consecutive checks. Automatic Hetzner provisioning is disabled and operator action is required.");
			}
		}
	}

	state.updatedAt = new Date().toISOString();
	await recordAvailability(env, state);
	await putState(env, state);
}

function componentStatus(value: boolean | undefined, fallback?: boolean): ComponentStatus {
	const resolved = value ?? fallback;
	return resolved === undefined ? "unknown" : resolved ? "operational" : "outage";
}

function setS3Components(state: StatusState, checks: ProbeChecks) {
	state.components.s3Api = componentStatus(checks.health && checks.ready);
	state.components.uploads = componentStatus(checks.operations?.upload, checks.canary);
	state.components.downloads = componentStatus(checks.operations?.download, checks.canary);
	state.components.deletes = componentStatus(checks.operations?.delete, checks.canary);
	state.components.authentication = componentStatus(checks.operations?.authentication, checks.canary);
	state.components.postgres = componentStatus(checks.readiness?.postgres, checks.ready);
	state.components.redis = componentStatus(checks.readiness?.redis, checks.ready);
	state.components.backingStorage = componentStatus(checks.readiness?.storage, checks.ready);
	state.components.writerLease = componentStatus(checks.readiness?.activeWriter, checks.ready);
}

async function checkPrimary(env: Env, readOnly = false) {
	const [health, readiness, dashboard] = await Promise.all([
		ok(env.PRIMARY_HEALTH_URL), checkReadiness(env.PRIMARY_READY_URL, env.DATAPLANE_INTERNAL_SECRET), ok(env.PRIMARY_DASHBOARD_URL || env.DASHBOARD_URL || ""),
	]);
	const operations = readOnly
		? await readOnlyOperationChecks(env, env.PRIMARY_S3_CANARY_URL).catch(() => failedOperationChecks())
		: await s3CanaryChecks(env, env.PRIMARY_S3_CANARY_URL).catch(() => failedOperationChecks());
	const canary = readOnly ? operations.authentication : operationChecksPassed(operations);
	return { health, ready: readiness.ok, dashboard, canary, readiness, operations };
}

async function checkEmergency(env: Env) {
	const origin = env.EMERGENCY_S3_CANARY_URL || `https://${env.EMERGENCY_DNS_NAME || "emergency-origin.onsilo.dev"}`;
	const [health, readiness] = await Promise.all([
		ok(env.EMERGENCY_HEALTH_URL || `${origin}/health`),
		checkReadiness(env.EMERGENCY_READY_URL || `${origin}/ready`, env.DATAPLANE_INTERNAL_SECRET),
	]);
	const operations = await s3CanaryChecks(env, origin).catch(() => failedOperationChecks());
	return { health, ready: readiness.ok, canary: operationChecksPassed(operations), readiness, operations };
}

async function checkProductionMaintenance(env: Env) {
	if (!env.PRIMARY_MAINTENANCE_URL) return false;
	try {
		const response = await fetchWithDeadline(env.PRIMARY_MAINTENANCE_URL, { redirect: "manual" });
		if (!response.ok) return null;
		const value = await response.json<{ s3MaintenanceMode?: unknown; fullMaintenanceMode?: unknown }>();
		return value.s3MaintenanceMode === true || value.fullMaintenanceMode === true
			? { s3MaintenanceMode: value.s3MaintenanceMode === true, fullMaintenanceMode: value.fullMaintenanceMode === true }
			: false;
	} catch { return null; }
}

async function ok(url: string, readinessSecret?: string) {
	if (!url) return false;
	try { return (await fetchWithDeadline(url, { redirect: "manual", headers: readinessSecret ? { "x-dataplane-secret": readinessSecret } : undefined })).ok; }
	catch { return false; }
}

async function checkReadiness(url: string, readinessSecret: string): Promise<ReadinessChecks> {
	if (!url) return { ok: false };
	try {
		const response = await fetchWithDeadline(url, { redirect: "manual", headers: { "x-dataplane-secret": readinessSecret } });
		const value = await response.json<{ postgres?: unknown; redis?: unknown; storage?: unknown; activeWriter?: unknown }>().catch(() => ({}));
		return {
			ok: response.ok,
			postgres: typeof value.postgres === "boolean" ? value.postgres : undefined,
			redis: typeof value.redis === "boolean" ? value.redis : undefined,
			storage: typeof value.storage === "boolean" ? value.storage : undefined,
			activeWriter: typeof value.activeWriter === "boolean" ? value.activeWriter : undefined,
		};
	} catch {
		return { ok: false };
	}
}

async function fetchWithDeadline(input: string | URL, init: RequestInit = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
	try { return await fetch(input, { ...init, signal: controller.signal }); }
	finally { clearTimeout(timer); }
}

async function s3Canary(env: Env, target: string) {
	return operationChecksPassed(await s3CanaryChecks(env, target));
}

function failedOperationChecks(): OperationChecks {
	return { authentication: false, upload: false, download: false, delete: false };
}

function operationChecksPassed(checks: OperationChecks) {
	return checks.authentication && checks.upload && checks.download && checks.delete;
}

async function readOnlyOperationChecks(env: Env, target: string): Promise<OperationChecks> {
	if (!target || !env.CANARY_ACCESS_KEY_ID || !env.CANARY_SECRET_ACCESS_KEY || !env.CANARY_BUCKET) return failedOperationChecks();
	const authentication = (await signedFetch(env, target, "HEAD", `/${env.CANARY_BUCKET}`)).ok;
	return { authentication, upload: false, download: false, delete: false };
}

async function s3CanaryChecks(env: Env, target: string): Promise<OperationChecks> {
	if (!target || !env.CANARY_ACCESS_KEY_ID || !env.CANARY_SECRET_ACCESS_KEY || !env.CANARY_BUCKET) return failedOperationChecks();
	const authentication = (await signedFetch(env, target, "HEAD", `/${env.CANARY_BUCKET}`)).ok;
	if (!authentication) return failedOperationChecks();
	const key = `__silo_healthcheck/${crypto.randomUUID()}`;
	const body = `silo canary ${new Date().toISOString()}`;
	const put = await signedFetch(env, target, "PUT", `/${env.CANARY_BUCKET}/${key}`, body);
	if (!put.ok) return { authentication, upload: false, download: false, delete: false };
	let download = false;
	try {
		const get = await signedFetch(env, target, "GET", `/${env.CANARY_BUCKET}/${key}`);
		download = get.ok && await get.text() === body;
	} catch {
		download = false;
	}
	try {
		const deletion = await signedFetch(env, target, "DELETE", `/${env.CANARY_BUCKET}/${key}`);
		return { authentication, upload: true, download, delete: deletion.ok };
	} catch {
		return { authentication, upload: true, download, delete: false };
	}
}

async function signedFetch(env: Env, origin: string, method: string, path: string, body = "") {
	const url = new URL(path, origin);
	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const day = amzDate.slice(0, 8);
	const region = env.CANARY_REGION || "auto";
	const payloadHash = await sha256(body);
	const headers: Record<string, string> = { host: url.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
	if (body) headers["content-type"] = "text/plain";
	const signedNames = Object.keys(headers).sort();
	const canonicalHeaders = signedNames.map((name) => `${name}:${headers[name]}\n`).join("");
	const canonical = `${method}\n${url.pathname.split("/").map(encodeURIComponent).join("/")}\n${url.searchParams.toString()}\n${canonicalHeaders}\n${signedNames.join(";")}\n${payloadHash}`;
	const scope = `${day}/${region}/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonical)}`;
	const signingKey = await awsSigningKey(env.CANARY_SECRET_ACCESS_KEY, day, region);
	const signature = await hmacHex(signingKey, stringToSign);
	headers.authorization = `AWS4-HMAC-SHA256 Credential=${env.CANARY_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
	return fetchWithDeadline(url, { method, headers, body: body || undefined });
}

async function awsSigningKey(secret: string, day: string, region: string) {
	let key = await hmacBytes(`AWS4${secret}`, day);
	key = await hmacBytes(key, region); key = await hmacBytes(key, "s3"); return hmacBytes(key, "aws4_request");
}
async function hmacBytes(key: string | ArrayBuffer, value: string) { return crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", typeof key === "string" ? new TextEncoder().encode(key) : key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(value)); }
async function hmacHex(key: ArrayBuffer, value: string) { return hex(await hmacBytes(key, value)); }
async function sha256(value: string) { return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))); }
function hex(value: ArrayBuffer) { return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join(""); }

async function bootstrap(request: Request, env: Env, action: string) {
	if (action === "register") {
		if (!secretMatches(request, env.STATUS_BOOTSTRAP_SECRET)) return json({ error: "unauthorized" }, 401);
		const input = await request.json<{ runtime?: unknown; incidentId?: unknown }>().catch(() => ({}));
		if (typeof input.runtime !== "string" || !input.runtime || input.runtime.length > 32_000) return json({ error: "invalid runtime payload" }, 400);
		const token = randomToken();
		const reportToken = randomToken();
		const encrypted = await encryptBootstrap(env, JSON.stringify({ runtime: input.runtime, reportToken }));
		const now = new Date();
		const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
		await env.DB.batch([
			env.DB.prepare("INSERT INTO bootstrap_sessions (id, token_hash, report_token_hash, incident_id, ciphertext, iv, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
				.bind(crypto.randomUUID(), await sha256(token), await sha256(reportToken), String(input.incidentId || ""), encrypted.ciphertext, encrypted.iv, expiresAt, now.toISOString()),
			env.DB.prepare("DELETE FROM bootstrap_sessions WHERE datetime(expires_at) < datetime('now', '-1 day')"),
		]);
		return json({ token, expiresAt });
	}

	if (action === "exchange") {
		const token = bearerToken(request);
		if (!token) return json({ error: "unauthorized" }, 401);
		const row = await env.DB.prepare("SELECT id, ciphertext, iv, expires_at AS expiresAt, exchanged_at AS exchangedAt FROM bootstrap_sessions WHERE token_hash = ?")
			.bind(await sha256(token)).first<{ id: string; ciphertext: string; iv: string; expiresAt: string; exchangedAt: string | null }>();
		if (!row || row.exchangedAt || Date.parse(row.expiresAt) <= Date.now()) return json({ error: "bootstrap token expired or already used" }, 410);
		const claimed = await env.DB.prepare("UPDATE bootstrap_sessions SET exchanged_at = ? WHERE id = ? AND exchanged_at IS NULL AND datetime(expires_at) > datetime('now')")
			.bind(new Date().toISOString(), row.id).run();
		if (Number(claimed.meta.changes || 0) !== 1) return json({ error: "bootstrap token already used" }, 409);
		return new Response(await decryptBootstrap(env, row.ciphertext, row.iv), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
	}

	if (action === "report") {
		const token = bearerToken(request);
		if (!token) return json({ error: "unauthorized" }, 401);
		const row = await env.DB.prepare("SELECT id, incident_id AS incidentId, expires_at AS expiresAt, exchanged_at AS exchangedAt, reported_at AS reportedAt FROM bootstrap_sessions WHERE report_token_hash = ?")
			.bind(await sha256(token)).first<{ id: string; incidentId: string; expiresAt: string; exchangedAt: string | null; reportedAt: string | null }>();
		if (!row || !row.exchangedAt || row.reportedAt || Date.parse(row.expiresAt) + 30 * 60_000 <= Date.now()) return json({ error: "report token invalid or already used" }, 410);
		const input = await request.json<{ dataplane?: unknown; caddy?: unknown; valkey?: unknown }>().catch(() => ({}));
		const digest = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9./:_@-]{1,500}$/.test(value) ? value : "unavailable";
		const dataplane = digest(input.dataplane), caddy = digest(input.caddy), valkey = digest(input.valkey);
		const claimed = await env.DB.prepare("UPDATE bootstrap_sessions SET reported_at = ? WHERE id = ? AND reported_at IS NULL").bind(new Date().toISOString(), row.id).run();
		if (Number(claimed.meta.changes || 0) !== 1) return json({ error: "digest report already received" }, 409);
		if (row.incidentId) await env.DB.prepare("INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)")
			.bind(row.incidentId, "monitoring", `Emergency image digests: dataplane ${dataplane}; Caddy ${caddy}; Valkey ${valkey}.`, new Date().toISOString()).run();
		return json({ ok: true });
	}
	return json({ error: "not found" }, 404);
}

function bearerToken(request: Request) { const value = request.headers.get("authorization") || ""; return value.startsWith("Bearer ") ? value.slice(7) : ""; }
function randomToken() { return bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
async function bootstrapKey(env: Env) {
	const bytes = base64ToBytes(env.BOOTSTRAP_ENCRYPTION_KEY);
	if (bytes.byteLength !== 32) throw new Error("BOOTSTRAP_ENCRYPTION_KEY must be base64-encoded 32 bytes");
	return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptBootstrap(env: Env, plaintext: string) {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await bootstrapKey(env), new TextEncoder().encode(plaintext));
	return { ciphertext: bytesToBase64(new Uint8Array(ciphertext)), iv: bytesToBase64(iv) };
}
async function decryptBootstrap(env: Env, ciphertext: string, iv: string) {
	const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(iv) }, await bootstrapKey(env), base64ToBytes(ciphertext));
	return new TextDecoder().decode(plaintext);
}
function bytesToBase64(bytes: Uint8Array) { let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }
function base64ToBytes(value: string) { const binary = atob(value); return Uint8Array.from(binary, (character) => character.charCodeAt(0)); }

async function callback(request: Request, env: Env, action: string) {
	if (!secretMatches(request, env.STATUS_CALLBACK_SECRET)) return json({ error: "unauthorized" }, 401);
	const payload = await request.json<Record<string, unknown>>().catch(() => ({}));
	const state = await getState(env);
	const callbackIncidentId = String(payload.incident_id || "");
	if (action !== "destroyed" && callbackIncidentId && callbackIncidentId !== state.activeIncidentId) {
		const staleServerId = Number(payload.server_id);
		if (Number.isFinite(staleServerId) && staleServerId > 0) {
			await dispatch(env, "destroy_emergency", { server_id: staleServerId, safe_to_delete: true, primary_dns_confirmed: false, resolve_incident: false, accounting_required: false, incident_id: callbackIncidentId });
		}
		return json({ error: "stale incident callback" }, 409);
	}
	if (action === "destroyed" && state.activeIncidentId && callbackIncidentId !== state.activeIncidentId) return json({ error: "stale incident callback" }, 409);
	if (action === "provisioning") {
		state.emergencyServerId = Number(payload.server_id);
		state.emergencyIp = String(payload.ip || "");
		state.failoverPhase = "provisioning";
		state.provisioningStep = "server_online";
		await pointEmergencyHostnameAt(env, state.emergencyIp);
		await addUpdate(env, state, "identified", "Emergency server requested and its temporary hostname is being prepared.");
	} else if (action === "starting") {
		state.failoverPhase = "provisioning";
		state.provisioningStep = "starting_dataplane";
		await addUpdate(env, state, "identified", "Emergency server is online and starting the Silo dataplane.");
	} else if (action === "verifying") {
		state.failoverPhase = "provisioning";
		state.provisioningStep = "verifying_storage";
		await addUpdate(env, state, "monitoring", "Dataplane is ready; verifying signed storage operations.");
	} else if (action === "ready") {
		state.emergencyServerId = Number(payload.server_id || state.emergencyServerId);
		state.emergencyIp = String(payload.ip || state.emergencyIp || "");
		state.failoverPhase = "ready";
		state.provisioningStep = "verified";
		await addUpdate(env, state, "monitoring", "Emergency server passed readiness and signed S3 canaries.");
		if (autoActivate(env)) {
			const primary = await checkPrimary(env);
			if (primary.health && primary.ready && primary.canary) {
				await pointS3AtPrimary(env);
				if (primary.dashboard) await pointDashboardAtPrimary(env);
				await dispatch(env, "destroy_emergency", { server_id: state.emergencyServerId, safe_to_delete: true, primary_dns_confirmed: true, resolve_incident: false, accounting_required: false, incident_id: state.activeIncidentId });
				state.failoverPhase = "inactive";
				state.provisioningStep = "idle";
				state.components.failover = "operational";
				state.overall = primary.dashboard ? "operational" : "degraded";
				await resolveIncident(env, state, "The primary recovered while the emergency server was starting, so traffic stayed on the primary.");
			} else {
				await activateEmergency(env, state, "Automatic failover activated after readiness checks passed.");
			}
		}
	} else if (action === "failed") {
		const serverId = Number(payload.server_id || state.emergencyServerId);
		const accountingRequired = ["verifying_storage", "verified", "active"].includes(state.provisioningStep);
		if (Number.isFinite(serverId) && serverId > 0) state.emergencyServerId = serverId;
		const primary = await checkPrimary(env);
		if (primary.health && primary.ready && primary.canary) {
			await pointS3AtPrimary(env);
			if (primary.dashboard) await pointDashboardAtPrimary(env);
			state.failoverPhase = "inactive"; state.components.failover = "operational";
			state.provisioningStep = "idle";
			state.overall = primary.dashboard ? "operational" : "degraded";
			await resolveIncident(env, state, "The primary recovered while emergency provisioning was failing; traffic remained on the primary.");
		} else {
			state.failoverPhase = "failed"; state.components.failover = "outage";
			state.provisioningStep = "failed";
			await pointS3AtFallback(env);
			if (autoRedirectDashboard(env)) await pointDashboardAtStatus(env);
			await addUpdate(env, state, "identified", `Emergency provisioning failed: ${String(payload.message || "unknown error")}`);
			await notifyMaintainers(env, "failover_failed", "The emergency provisioning workflow failed; S3 is serving the safe 503 fallback.");
		}
		if (state.emergencyServerId) {
			await dispatch(env, "destroy_emergency", { server_id: state.emergencyServerId, safe_to_delete: true, primary_dns_confirmed: false, resolve_incident: false, accounting_required: accountingRequired, incident_id: state.activeIncidentId });
		}
	} else if (action === "flush-failed") {
		state.destroyAfter = undefined;
		await addUpdate(env, state, "identified", "Emergency accounting could not be flushed to Aiven. Hetzner teardown was stopped; the VM is being retained for recovery.");
		await notifyMaintainers(env, "accounting_flush_failed", "Hetzner teardown was blocked because emergency accounting could not be verified in Aiven.");
	} else if (action === "destroyed") {
		state.emergencyIp = undefined;
		state.emergencyServerId = undefined;
		state.recoveryHealthySince = undefined;
		state.destroyAfter = undefined;
		state.manualRecoveryLock = false;
		state.consecutiveFailures = 0;
		state.consecutiveRecoveries = 0;
		if (payload.resolve_incident === true) {
			state.failoverPhase = "inactive"; state.provisioningStep = "idle"; state.components.failover = "operational"; state.overall = state.components.dashboard === "operational" ? "operational" : "degraded";
			await resolveIncident(env, state, "Primary recovery completed and the emergency server was deleted.");
			await notifyMaintainers(env, "recovered", "Primary recovery completed and the temporary Hetzner server was deleted.");
		}
	}
	state.updatedAt = new Date().toISOString(); await putState(env, state); return json({ ok: true });
}

async function incidentAdmin(request: Request, env: Env, pathname: string) {
	if (!adminOriginAllowed(request, env)) return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (!secretMatches(request, env.STATUS_INCIDENT_PASSWORD || env.STATUS_ADMIN_SECRET)) return adminJson(request, env, { error: "unauthorized" }, 401);

	if (request.method === "GET" && pathname === "/api/admin/incidents") {
		const state = await getState(env);
		const incidents = await env.DB.prepare("SELECT id, status, title, started_at AS startedAt, resolved_at AS resolvedAt, acknowledged_at AS acknowledgedAt, acknowledgement_message AS acknowledgementMessage FROM incidents ORDER BY datetime(started_at) DESC LIMIT 25").all();
		const notes = await env.DB.prepare("SELECT id, incident_id AS incidentId, message, created_at AS createdAt, updated_at AS updatedAt FROM incident_notes ORDER BY datetime(created_at) DESC LIMIT 250").all();
		return adminJson(request, env, { activeIncidentId: state.activeIncidentId, incidents: incidents.results, notes: notes.results });
	}

	const incidentMatch = pathname.match(/^\/api\/admin\/incidents\/([^/]+)\/(acknowledge|notes)$/);
	if (request.method === "POST" && incidentMatch) {
		const incidentId = decodeURIComponent(incidentMatch[1]);
		const incident = await env.DB.prepare("SELECT id, status, acknowledged_at AS acknowledgedAt FROM incidents WHERE id = ?").bind(incidentId).first<{ id: string; status: string; acknowledgedAt: string | null }>();
		if (!incident) return adminJson(request, env, { error: "incident not found" }, 404);
		const input = await request.json<{ message?: unknown }>().catch(() => ({}));
		if (incidentMatch[2] === "acknowledge") {
			if (incident.status !== "open") return adminJson(request, env, { error: "only open incidents can be acknowledged" }, 409);
			if (incident.acknowledgedAt) return adminJson(request, env, { ok: true, alreadyAcknowledged: true });
			const message = optionalMessage(input.message, 500) || "The Silo team has acknowledged this incident and is investigating.";
			const now = new Date().toISOString();
			await env.DB.prepare("UPDATE incidents SET acknowledged_at = ?, acknowledgement_message = ? WHERE id = ?").bind(now, message, incidentId).run();
			await env.DB.prepare("INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)").bind(incidentId, "acknowledged", message, now).run();
			return adminJson(request, env, { ok: true, acknowledgedAt: now });
		}

		const message = requiredMessage(input.message, 2_000);
		if (message instanceof Response) return withAdminCors(request, env, message);
		const now = new Date().toISOString();
		const id = crypto.randomUUID();
		await env.DB.prepare("INSERT INTO incident_notes (id, incident_id, message, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, incidentId, message, now, now).run();
		return adminJson(request, env, { ok: true, note: { id, incidentId, message, createdAt: now, updatedAt: now } }, 201);
	}

	const noteMatch = pathname.match(/^\/api\/admin\/notes\/([^/]+)$/);
	if (noteMatch && ["PATCH", "DELETE"].includes(request.method)) {
		const noteId = decodeURIComponent(noteMatch[1]);
		const note = await env.DB.prepare("SELECT id FROM incident_notes WHERE id = ?").bind(noteId).first<{ id: string }>();
		if (!note) return adminJson(request, env, { error: "note not found" }, 404);
		if (request.method === "DELETE") {
			await env.DB.prepare("DELETE FROM incident_notes WHERE id = ?").bind(noteId).run();
			return adminJson(request, env, { ok: true });
		}
		const input = await request.json<{ message?: unknown }>().catch(() => ({}));
		const message = requiredMessage(input.message, 2_000);
		if (message instanceof Response) return withAdminCors(request, env, message);
		const updatedAt = new Date().toISOString();
		await env.DB.prepare("UPDATE incident_notes SET message = ?, updated_at = ? WHERE id = ?").bind(message, updatedAt, noteId).run();
		return adminJson(request, env, { ok: true, updatedAt });
	}

	return adminJson(request, env, { error: "not found" }, 404);
}

async function operationsAdmin(request: Request, env: Env) {
	if (!adminOriginAllowed(request, env)) return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (!secretMatches(request, env.STATUS_ADMIN_SECRET)) return adminJson(request, env, { error: "unauthorized" }, 401);
	const state = await getState(env);
	return adminJson(request, env, {
		failoverPhase: state.failoverPhase,
		provisioningStep: state.provisioningStep,
		emergencyAvailable: Boolean(state.emergencyServerId && state.emergencyIp),
		manualRecoveryLock: state.manualRecoveryLock,
		productionMaintenance: state.productionMaintenance || null,
		automation: {
			provision: autoProvision(env),
			redirectDashboard: autoRedirectDashboard(env),
			activate: autoActivate(env),
			recover: autoRecover(env, state),
		},
		destroyAfter: state.destroyAfter || null,
		updatedAt: state.updatedAt,
	});
}

async function maintenanceAdmin(request: Request, env: Env, pathname: string) {
	if (!adminOriginAllowed(request, env)) return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (!secretMatches(request, env.STATUS_ADMIN_SECRET)) return adminJson(request, env, { error: "unauthorized" }, 401);
	if (request.method === "GET" && pathname === "/api/admin/maintenance") {
		return adminJson(request, env, { maintenance: await listMaintenance(env) });
	}

	const idMatch = pathname.match(/^\/api\/admin\/maintenance\/([^/]+)$/);
	if (request.method === "DELETE" && idMatch) {
		const result = await env.DB.prepare("DELETE FROM maintenance_windows WHERE id = ?").bind(decodeURIComponent(idMatch[1])).run();
		if (Number(result.meta.changes || 0) !== 1) return adminJson(request, env, { error: "maintenance window not found" }, 404);
		return adminJson(request, env, { ok: true, maintenance: await listMaintenance(env) });
	}

	if ((request.method === "POST" && pathname === "/api/admin/maintenance") || (request.method === "PATCH" && idMatch)) {
		const input = await request.json<{ title?: unknown; message?: unknown; startsAt?: unknown; endsAt?: unknown }>().catch(() => ({}));
		const title = typeof input.title === "string" ? input.title.trim() : "";
		const message = typeof input.message === "string" ? input.message.trim() : "";
		const startsAt = typeof input.startsAt === "string" ? new Date(input.startsAt) : new Date(NaN);
		const endsAt = typeof input.endsAt === "string" ? new Date(input.endsAt) : new Date(NaN);
		if (!title || title.length > 120) return adminJson(request, env, { error: "title must be 1 to 120 characters" }, 400);
		if (!message || message.length > 1_000) return adminJson(request, env, { error: "message must be 1 to 1000 characters" }, 400);
		if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) return adminJson(request, env, { error: "valid start and end times are required" }, 400);
		if (endsAt <= startsAt) return adminJson(request, env, { error: "maintenance must end after it starts" }, 400);
		if (endsAt.getTime() - startsAt.getTime() > 7 * 24 * 60 * 60_000) return adminJson(request, env, { error: "maintenance cannot exceed seven days" }, 400);
		const id = idMatch ? decodeURIComponent(idMatch[1]) : crypto.randomUUID();
		if (idMatch) {
			const result = await env.DB.prepare("UPDATE maintenance_windows SET title = ?, message = ?, starts_at = ?, ends_at = ? WHERE id = ?").bind(title, message, startsAt.toISOString(), endsAt.toISOString(), id).run();
			if (Number(result.meta.changes || 0) !== 1) return adminJson(request, env, { error: "maintenance window not found" }, 404);
		} else {
			await env.DB.prepare("INSERT INTO maintenance_windows (id, title, message, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)").bind(id, title, message, startsAt.toISOString(), endsAt.toISOString()).run();
		}
		return adminJson(request, env, { ok: true, id, maintenance: await listMaintenance(env) }, idMatch ? 200 : 201);
	}

	return adminJson(request, env, { error: "not found" }, 404);
}

async function listMaintenance(env: Env) {
	const result = await env.DB.prepare("SELECT id, title, message, starts_at AS startsAt, ends_at AS endsAt FROM maintenance_windows WHERE datetime(ends_at) >= datetime('now') ORDER BY datetime(starts_at) ASC LIMIT 25").all();
	return result.results;
}

function optionalMessage(value: unknown, maxLength: number) {
	if (typeof value !== "string") return "";
	return value.trim().slice(0, maxLength);
}

function requiredMessage(value: unknown, maxLength: number): string | Response {
	if (typeof value !== "string" || !value.trim()) return json({ error: "message is required" }, 400);
	const message = value.trim();
	if (message.length > maxLength) return json({ error: `message must be ${maxLength} characters or fewer` }, 400);
	return message;
}

async function admin(request: Request, env: Env, action: string) {
	if (!adminOriginAllowed(request, env)) return adminJson(request, env, { error: "origin not allowed" }, 403);
	if (!secretMatches(request, env.STATUS_ADMIN_SECRET)) return adminJson(request, env, { error: "unauthorized" }, 401);
	const state = await getState(env);
	if (action === "provision") {
		if (["provisioning", "ready", "active", "recovering"].includes(state.failoverPhase)) return adminJson(request, env, { error: "an emergency recovery path already exists" }, 409);
		const incidentId = state.activeIncidentId || crypto.randomUUID();
		await dispatch(env, "provision_emergency", { callback_url: env.STATUS_CALLBACK_URL, incident_id: incidentId });
		if (!state.activeIncidentId) {
			state.activeIncidentId = incidentId;
			await env.DB.prepare("INSERT INTO incidents (id, status, title, started_at) VALUES (?, ?, ?, ?)").bind(incidentId, "open", "Emergency recovery drill", new Date().toISOString()).run();
		}
		state.failoverPhase = "provisioning";
		state.provisioningStep = "server_requested";
		state.overall = "degraded";
		await addUpdate(env, state, "monitoring", "Emergency provisioning started manually. Dashboard traffic remains on the healthy primary.");
	}
	else if (action === "activate") {
		if (state.failoverPhase !== "ready" || state.provisioningStep !== "verified") return adminJson(request, env, { error: "emergency must pass readiness and storage verification before activation" }, 409);
		if (!state.emergencyIp) return adminJson(request, env, { error: "emergency server has no IP" }, 409);
		await activateEmergency(env, state, "Emergency failover activated manually.");
	}
	else if (action === "force-failback") {
		if (state.failoverPhase !== "active") return adminJson(request, env, { error: "failback is only available while emergency traffic is active" }, 409);
		await activatePrimary(env); await pointDashboardAtPrimary(env); state.failoverPhase = "recovering"; state.destroyAfter = new Date(Date.now() + GRACE_MS).toISOString(); await addUpdate(env, state, "monitoring", "The Aiven writer lease and DNS returned to primary manually; emergency cleanup will wait ten minutes.");
	}
	else if (action === "disable-auto-recovery") {
		if (!["active", "recovering"].includes(state.failoverPhase)) return adminJson(request, env, { error: "there is no active recovery to hold" }, 409);
		state.manualRecoveryLock = true; await addUpdate(env, state, "monitoring", "Automatic recovery disabled by an administrator.");
	}
	else if (action === "abort" || action === "destroy") {
		if (!state.emergencyServerId) return adminJson(request, env, { error: "there is no emergency server to delete" }, 409);
		const accountingRequired = ["active", "recovering"].includes(state.failoverPhase); const resolving = state.failoverPhase === "recovering"; await dispatch(env, "destroy_emergency", { server_id: state.emergencyServerId, safe_to_delete: !accountingRequired, primary_dns_confirmed: resolving, resolve_incident: resolving, accounting_required: accountingRequired, incident_id: state.activeIncidentId }); await addUpdate(env, state, "monitoring", "Emergency server cleanup requested manually.");
	}
	else return adminJson(request, env, { error: "unknown action" }, 404);
	state.updatedAt = new Date().toISOString(); await putState(env, state); return adminJson(request, env, { ok: true, state });
}

async function activateEmergency(env: Env, state: StatusState, message: string) {
	if (!state.emergencyIp) throw new Error("cannot activate an emergency server without an IP");
	const emergencyReady = env.EMERGENCY_READY_URL || `https://${env.EMERGENCY_DNS_NAME || "emergency-origin.onsilo.dev"}/ready`;
	await setDrain(env, emergencyReady, false);
	await claimWriter(env, emergencyReady);
	const origin = env.EMERGENCY_S3_CANARY_URL || `https://${env.EMERGENCY_DNS_NAME || "emergency-origin.onsilo.dev"}`;
	if (!await s3Canary(env, origin).catch(() => false)) {
		await claimWriter(env, env.PRIMARY_READY_URL).catch(() => undefined);
		throw new Error("emergency write canary failed after writer lease transfer");
	}
	try {
		await pointS3AtEmergency(env, state.emergencyIp);
	} catch (error) {
		await claimWriter(env, env.PRIMARY_READY_URL).catch(() => undefined);
		throw error;
	}
	await pointDashboardAtStatus(env);
	state.failoverPhase = "active"; state.provisioningStep = "active"; state.overall = "degraded";
	setS3Components(state, { health: true, ready: true, canary: true });
	state.components.dashboard = "outage"; state.components.failover = "operational"; state.consecutiveRecoveries = 0; state.recoveryHealthySince = undefined;
	await addUpdate(env, state, "monitoring", message);
	await notifyMaintainers(env, "failover_active", "S3 traffic is now using the temporary Hetzner dataplane.");
}
async function activatePrimaryWriter(env: Env) {
	await claimWriter(env, env.PRIMARY_READY_URL);
	if (!await s3Canary(env, env.PRIMARY_S3_CANARY_URL).catch(() => false)) {
		throw new Error("primary write canary failed after writer lease transfer");
	}
}
async function activatePrimary(env: Env) {
	const emergencyReady = env.EMERGENCY_READY_URL || `https://${env.EMERGENCY_DNS_NAME || "emergency-origin.onsilo.dev"}/ready`;
	await setDrain(env, emergencyReady, true);
	try {
		await activatePrimaryWriter(env);
		await pointS3AtPrimary(env);
	} catch (error) {
		await claimWriter(env, emergencyReady).catch(() => undefined);
		await setDrain(env, emergencyReady, false).catch(() => undefined);
		throw error;
	}
}
async function claimWriter(env: Env, readinessUrl: string) {
	const url = new URL(readinessUrl);
	url.pathname = "/api/internal/writer/claim";
	url.search = "";
	const response = await fetch(url, { method: "POST", headers: { "x-dataplane-secret": env.DATAPLANE_INTERNAL_SECRET } });
	if (!response.ok) throw new Error(`writer lease transfer failed: ${response.status}`);
}
async function setDrain(env: Env, readinessUrl: string, enabled: boolean) {
	const url = new URL(readinessUrl);
	url.pathname = "/api/internal/drain";
	url.search = "";
	const response = await fetch(url, { method: "POST", headers: { "x-dataplane-secret": env.DATAPLANE_INTERNAL_SECRET, "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
	if (!response.ok) throw new Error(`dataplane drain update failed: ${response.status}`);
}
function autoActivate(env: Env) { return env.AUTO_ACTIVATE_FAILOVER === "true" && env.FAILOVER_DRILL_APPROVED === "true"; }
function autoProvision(env: Env) { return env.AUTO_PROVISION_FAILOVER === "true" && env.FAILOVER_DRILL_APPROVED === "true"; }
function autoRedirectDashboard(env: Env) { return env.AUTO_REDIRECT_DASHBOARD === "true" && env.FAILOVER_DRILL_APPROVED === "true"; }
function autoRecover(env: Env, state: StatusState) { return env.AUTO_RECOVER !== "false" && !state.manualRecoveryLock; }

async function pointS3AtEmergency(env: Env, ip: string) { await updateARecord(env, env.CF_S3_RECORD_ID, env.S3_DNS_NAME || "onsilo.dev", ip); await removePrimaryAaaa(env); }
async function pointS3AtPrimary(env: Env) { await updateARecord(env, env.CF_S3_RECORD_ID, env.S3_DNS_NAME || "onsilo.dev", env.PRIMARY_IPV4); await restorePrimaryAaaa(env); }
async function pointS3AtFallback(env: Env) { await cloudflare(env, `/zones/${env.CF_ZONE_ID}/dns_records/${env.CF_S3_RECORD_ID}`, "PUT", { type: "A", name: env.S3_DNS_NAME || "onsilo.dev", content: "192.0.2.1", ttl: 1, proxied: true }); await removePrimaryAaaa(env); }
async function pointDashboardAtStatus(env: Env) {
	if (!env.CF_DASHBOARD_RECORD_ID) return;
	await cloudflare(env, `/zones/${env.CF_ZONE_ID}/dns_records/${env.CF_DASHBOARD_RECORD_ID}`, "PUT", { type: "A", name: env.DASHBOARD_DNS_NAME || "dash.onsilo.dev", content: "192.0.2.1", ttl: 1, proxied: true });
}
async function pointDashboardAtPrimary(env: Env) {
	if (!env.CF_DASHBOARD_RECORD_ID) return;
	await cloudflare(env, `/zones/${env.CF_ZONE_ID}/dns_records/${env.CF_DASHBOARD_RECORD_ID}`, "PUT", { type: "A", name: env.DASHBOARD_DNS_NAME || "dash.onsilo.dev", content: env.PRIMARY_DASHBOARD_IPV4 || env.PRIMARY_IPV4, ttl: 60, proxied: false });
}
async function pointEmergencyHostnameAt(env: Env, ip: string) { if (ip) await updateARecord(env, env.CF_EMERGENCY_RECORD_ID, env.EMERGENCY_DNS_NAME || "emergency-origin.onsilo.dev", ip); }
async function updateARecord(env: Env, id: string, name: string, content: string) { await cloudflare(env, `/zones/${env.CF_ZONE_ID}/dns_records/${id}`, "PUT", { type: "A", name, content, ttl: 60, proxied: false }); }
async function removePrimaryAaaa(env: Env) {
	for (const record of await listDnsRecords(env, "AAAA", env.S3_DNS_NAME || "onsilo.dev")) {
		await cloudflare(env, `/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, "DELETE");
	}
}
async function restorePrimaryAaaa(env: Env) {
	if (!env.PRIMARY_IPV6) return;
	const name = env.S3_DNS_NAME || "onsilo.dev";
	const records = await listDnsRecords(env, "AAAA", name);
	if (records.some((record) => record.content === env.PRIMARY_IPV6)) return;
	for (const record of records) await cloudflare(env, `/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`, "DELETE");
	await cloudflare(env, `/zones/${env.CF_ZONE_ID}/dns_records`, "POST", { type: "AAAA", name, content: env.PRIMARY_IPV6, ttl: 60, proxied: false });
}
async function listDnsRecords(env: Env, type: string, name: string) {
	const result = await cloudflare<{ result: Array<{ id: string; content: string }> }>(env, `/zones/${env.CF_ZONE_ID}/dns_records?type=${encodeURIComponent(type)}&name=${encodeURIComponent(name)}`, "GET");
	return result.result || [];
}
async function cloudflare<T = unknown>(env: Env, path: string, method: string, body?: unknown): Promise<T> {
	const response = await fetch(`${env.CLOUDFLARE_API_BASE || "https://api.cloudflare.com/client/v4"}${path}`, { method, headers: { authorization: `Bearer ${env.CF_DNS_TOKEN}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
	if (!response.ok) throw new Error(`Cloudflare DNS update failed: ${response.status}`);
	if (response.status === 204) return {} as T;
	return response.json<T>();
}

async function dispatch(env: Env, eventType: string, clientPayload: Record<string, unknown>) {
	if (!env.GITHUB_DISPATCH_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GitHub dispatch is not configured");
	const response = await fetch(`${env.GITHUB_API_BASE || "https://api.github.com"}/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/dispatches`, { method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`, "content-type": "application/json", "user-agent": "silo-status-controller" }, body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }) });
	if (!response.ok) throw new Error(`GitHub dispatch failed: ${response.status}`);
}

async function notifyMaintainers(env: Env, event: string, message: string) {
	if (!env.ALERT_WEBHOOK_URL) return;
	try {
		await fetch(env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: "silo-status", event, message, statusUrl: "https://status.onsilo.dev" }) });
	} catch {
		// Alerting must never prevent failover state or DNS changes from progressing.
	}
}

async function recordAvailability(env: Env, state: StatusState, plannedMaintenance = false) {
	const s3Operational = plannedMaintenance || [state.components.s3Api, state.components.uploads, state.components.downloads, state.components.authentication].every((value) => value === "operational") ? 1 : 0;
	const dashboardOperational = plannedMaintenance || state.components.dashboard === "operational" ? 1 : 0;
	await env.DB.batch([
		env.DB.prepare("INSERT INTO uptime_checks (s3_operational, dashboard_operational, recorded_at) VALUES (?, ?, ?)").bind(s3Operational, dashboardOperational, state.updatedAt),
		env.DB.prepare("DELETE FROM uptime_checks WHERE datetime(recorded_at) < datetime('now', '-91 days')"),
	]);
}

async function getActiveMaintenance(env: Env) {
	return env.DB.prepare("SELECT id, title, message, starts_at AS startsAt, ends_at AS endsAt FROM maintenance_windows WHERE datetime(starts_at) <= datetime('now') AND datetime(ends_at) >= datetime('now') ORDER BY datetime(starts_at) ASC LIMIT 1").first<{ id: string; title: string; message: string; startsAt: string; endsAt: string }>();
}

async function getState(env: Env): Promise<StatusState> { const row = await env.DB.prepare("SELECT value FROM status_state WHERE id = ?").bind(STATE_ID).first<{ value: string }>(); return row ? { ...defaultState(), ...JSON.parse(row.value) } : defaultState(); }
async function putState(env: Env, state: StatusState) { await env.DB.prepare("INSERT INTO status_state (id, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(STATE_ID, JSON.stringify(state), state.updatedAt).run(); }
async function openIncident(env: Env, state: StatusState, message: string, title = "S3 service disruption") { if (state.activeIncidentId) { await addUpdate(env, state, "investigating", message); return; } const id = crypto.randomUUID(); state.activeIncidentId = id; await env.DB.prepare("INSERT INTO incidents (id, status, title, started_at) VALUES (?, ?, ?, ?)").bind(id, "open", title, new Date().toISOString()).run(); await addUpdate(env, state, "investigating", message); }
async function addUpdate(env: Env, state: StatusState, status: string, message: string) { if (!state.activeIncidentId) return; await env.DB.prepare("INSERT INTO incident_updates (incident_id, status, message, created_at) VALUES (?, ?, ?, ?)").bind(state.activeIncidentId, status, message, new Date().toISOString()).run(); }
async function resolveIncident(env: Env, state: StatusState, message: string) { await addUpdate(env, state, "resolved", message); if (state.activeIncidentId) await env.DB.prepare("UPDATE incidents SET status = 'resolved', resolved_at = ? WHERE id = ?").bind(new Date().toISOString(), state.activeIncidentId).run(); state.activeIncidentId = undefined; }
async function publicStatus(env: Env) {
	const state = await getState(env);
	const incidents = await env.DB.prepare("SELECT id, status, title, started_at AS startedAt, resolved_at AS resolvedAt, acknowledged_at AS acknowledgedAt, acknowledgement_message AS acknowledgementMessage FROM incidents ORDER BY datetime(started_at) DESC LIMIT 10").all();
	const updates = state.activeIncidentId ? await env.DB.prepare("SELECT status, message, created_at as createdAt FROM incident_updates WHERE incident_id = ? ORDER BY id DESC LIMIT 20").bind(state.activeIncidentId).all() : { results: [] };
	const notes = await env.DB.prepare("SELECT id, incident_id AS incidentId, message, created_at AS createdAt, updated_at AS updatedAt FROM incident_notes ORDER BY datetime(created_at) DESC LIMIT 100").all();
	const uptime = await env.DB.prepare("SELECT COUNT(*) AS samples, COALESCE(SUM(s3_operational), 0) AS s3Ok, COALESCE(SUM(dashboard_operational), 0) AS dashboardOk, MIN(recorded_at) AS firstAt FROM uptime_checks WHERE datetime(recorded_at) >= datetime('now', '-90 days')").first<{ samples: number; s3Ok: number; dashboardOk: number; firstAt: string | null }>();
	const uptimeHistory = await env.DB.prepare("SELECT substr(recorded_at, 1, 10) AS day, COUNT(*) AS samples, SUM(s3_operational) AS s3Ok, SUM(dashboard_operational) AS dashboardOk FROM uptime_checks WHERE datetime(recorded_at) >= datetime('now', '-90 days') GROUP BY substr(recorded_at, 1, 10) ORDER BY day ASC").all<{ day: string; samples: number; s3Ok: number; dashboardOk: number }>();
	const maintenance = await env.DB.prepare("SELECT id, title, message, starts_at AS startsAt, ends_at AS endsAt FROM maintenance_windows WHERE datetime(ends_at) >= datetime('now') ORDER BY datetime(starts_at) ASC LIMIT 10").all();
	const productionMaintenance = state.productionMaintenance ? { id: "production-maintenance", title: state.productionMaintenance.title, message: state.productionMaintenance.message, startsAt: state.productionMaintenance.startsAt, endsAt: null } : null;
	const activeMaintenance = productionMaintenance || (maintenance.results as Array<{ startsAt: string; endsAt: string }>).find((window) => Date.parse(window.startsAt) <= Date.now() && Date.parse(window.endsAt) >= Date.now()) || null;
	const publishedMaintenance = productionMaintenance ? [productionMaintenance, ...maintenance.results] : maintenance.results;
	const healthyMinutes = state.recoveryHealthySince ? Math.max(0, Math.floor((Date.now() - Date.parse(state.recoveryHealthySince)) / 60_000)) : 0;
	const uptimeSamples = Number(uptime?.samples || 0);
	const uptimeStart = uptime?.firstAt ? Math.max(Date.parse(uptime.firstAt), Date.now() - 90 * 24 * 60 * 60 * 1000) : Date.now();
	const expectedSamples = uptimeSamples ? Math.max(uptimeSamples, Math.floor((Date.now() - uptimeStart) / 60_000) + 1) : 0;
	const uptimePercent = (successful: number) => expectedSamples ? Math.round((100_000 * Number(successful || 0)) / expectedSamples) / 1000 : null;
	const history = (uptimeHistory.results || []).map((row) => ({
		day: row.day,
		samples: Number(row.samples || 0),
		s3: Number(row.samples) ? Math.round((10_000 * Number(row.s3Ok || 0)) / Number(row.samples)) / 100 : null,
		dashboard: Number(row.samples) ? Math.round((10_000 * Number(row.dashboardOk || 0)) / Number(row.samples)) / 100 : null,
	}));
	const components = { ...defaultState().components, ...state.components };
	return { overall: state.overall, components, failoverPhase: state.failoverPhase, provisioningStep: state.provisioningStep, activeIncidentId: state.activeIncidentId, updatedAt: state.updatedAt, activeMaintenance, recovery: { successfulChecks: Math.min(state.consecutiveRecoveries, RECOVERY_THRESHOLD), requiredChecks: RECOVERY_THRESHOLD, healthyMinutes: Math.min(healthyMinutes, 10), requiredHealthyMinutes: 10, cleanupAfter: state.destroyAfter }, uptime: { windowDays: 90, samples: uptimeSamples, expectedSamples, s3: uptimePercent(uptime?.s3Ok || 0), dashboard: uptimePercent(uptime?.dashboardOk || 0), history }, maintenance: publishedMaintenance, incidents: incidents.results, updates: updates.results, notes: notes.results };
}
function secretMatches(request: Request, expected: string) { return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`; }
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "access-control-allow-origin": "*" } }); }
function adminOrigins(env: Env) { return (env.STATUS_ADMIN_ORIGINS || "https://status.onsilo.dev").split(",").map((origin) => origin.trim()).filter(Boolean); }
function adminOriginAllowed(request: Request, env: Env) { const origin = request.headers.get("origin"); return !origin || adminOrigins(env).includes(origin); }
function adminJson(request: Request, env: Env, value: unknown, status = 200) { return withAdminCors(request, env, new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })); }
function withAdminCors(request: Request, env: Env, response: Response) {
	const origin = request.headers.get("origin");
	if (!origin || !adminOrigins(env).includes(origin)) return response;
	const headers = new Headers(response.headers);
	headers.set("access-control-allow-origin", origin);
	headers.set("access-control-allow-headers", "authorization, content-type");
	headers.set("access-control-allow-methods", "GET, POST, PATCH, DELETE, OPTIONS");
	headers.set("vary", "Origin");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
function corsPreflight(request: Request, env: Env, pathname: string) {
	if (pathname.startsWith("/api/admin/") && !adminOriginAllowed(request, env)) return new Response(null, { status: 403 });
	if (!pathname.startsWith("/api/admin/")) return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" } });
	return withAdminCors(request, env, new Response(null, { status: 204 }));
}
function outageFallback(request: Request) {
	const url = new URL(request.url);
	const acceptsHtml = request.method === "GET" && url.pathname === "/" && request.headers.get("accept")?.includes("text/html");
	if (acceptsHtml) return new Response("<!doctype html><meta name=\"viewport\" content=\"width=device-width\"><title>Silo is recovering</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#101217;color:#e0e6ed;font:16px system-ui,sans-serif}main{max-width:42rem;padding:2rem;border-left:5px solid #ec3750}h1{font:700 italic clamp(2.7rem,10vw,6rem)/.9 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:-.08em;margin:0;color:#fff}p{line-height:1.6}a{color:#ff5d79;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style><main><h1>Silo is recovering.</h1><p>We are restoring storage service. Your client can retry shortly.</p><p><a href=\"https://status.onsilo.dev\">See live status →</a></p></main>", { status: 503, headers: { "content-type": "text/html; charset=utf-8", "retry-after": "60", "cache-control": "no-store" } });
	const requestId = crypto.randomUUID();
	return new Response(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>ServiceUnavailable</Code><Message>Please reduce your request rate.</Message><RequestId>${requestId}</RequestId><HostId>silo-emergency-fallback</HostId></Error>`, { status: 503, headers: { "content-type": "application/xml", "retry-after": "60", "cache-control": "no-store", "x-silo-failover": "fallback", "x-amz-request-id": requestId } });
}
function dashboardStatusRedirect() {
	return Response.redirect("https://status.onsilo.dev", 302);
}

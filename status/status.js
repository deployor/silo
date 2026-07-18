const API = "https://status-api.onsilo.dev/api/status";

let topologyAnimationFrame = 0;
let topologyResizeObserver;

const escapeHtml = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character],
	);

const label = (value) =>
	String(value || "unknown")
		.replaceAll("_", " ")
		.replaceAll("-", " ")
		.replace(/\b\w/g, (character) => character.toUpperCase());

function statusText(status) {
	return (
		{
			operational: "Operational",
			degraded: "Degraded",
			outage: "Outage",
			unknown: "Checking",
		}[status] || "Checking"
	);
}

function safeStatus(status) {
	return ["operational", "degraded", "outage"].includes(status)
		? status
		: "unknown";
}

function formatTime(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Just now";
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(value) {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "Unknown date";
	return date.toLocaleDateString([], {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

function formatDuration(start, end) {
	const milliseconds = Math.max(
		0,
		Date.parse(end || new Date().toISOString()) - Date.parse(start),
	);
	const minutes = Math.max(1, Math.round(milliseconds / 60_000));
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	const remaining = minutes % 60;
	return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
}

function regions(data) {
	return Array.isArray(data.regions) ? data.regions : [];
}

function affectedRegion(data) {
	return (
		regions(data).find(
			(region) =>
				region.phase !== "normal" && region.phase !== "credential_cleanup",
		) ||
		regions(data).find((region) => region.phase === "credential_cleanup") ||
		regions(data).find((region) => region.providerPhase !== "normal") ||
		null
	);
}

function regionName(region) {
	return region ? region.label || region.id : "The affected region";
}

function heroContent(data) {
	if (data.activeMaintenance) {
		return {
			state: "maintenance",
			kicker: "Planned maintenance",
			headline: "Silo is in maintenance.",
			summary: data.activeMaintenance.message,
		};
	}

	if (data.overall === "operational") {
		return {
			state: "operational",
			kicker: "All systems operational",
			headline: "We're all good.",
			summary:
				"The global control plane and both regional storage paths are working normally.",
		};
	}

	const region = affectedRegion(data);
	let summary = "One or more Silo components are not responding normally.";
	if (region?.phase === "active") {
		summary = `${regionName(region)} is securely running on ${label(region.activeDataplane)} while its home dataplane recovers.`;
	} else if (["failing_back", "credential_cleanup"].includes(region?.phase)) {
		summary = `${regionName(region)} has returned home and is completing its DNS and credential safety window.`;
	} else if (["investigating", "ready", "activating"].includes(region?.phase)) {
		summary = `${regionName(region)} is being verified before any regional traffic transition.`;
	} else if (region?.phase === "blocked") {
		summary = `${regionName(region)} could not pass a required failover safety gate. The team is investigating.`;
	} else if (region?.providerPhase === "replica_active") {
		summary = `${regionName(region)} is safely using physical backend ${region.activeBackend}; provider redundancy is being restored.`;
	} else if (
		["investigating", "ready", "promoting", "blocked"].includes(
			region?.providerPhase,
		)
	) {
		summary = `${regionName(region)} has a physical storage-provider issue. Replication and promotion safety checks are in progress.`;
	}

	return data.overall === "major_outage"
		? {
				state: "outage",
				kicker: "Service outage",
				headline: "We're having issues.",
				summary,
			}
		: {
				state: "degraded",
				kicker: "Degraded service",
				headline: "We're having some issues.",
				summary,
			};
}

function renderHero(data) {
	const content = heroContent(data);
	const hero = document.getElementById("hero");
	hero.dataset.state = content.state;
	document.getElementById("hero-label").textContent = content.kicker;
	document.getElementById("headline").textContent = content.headline;
	document.getElementById("summary").textContent = content.summary;

	const activeIncident = (data.incidents || []).find(
		(incident) => incident.id === data.activeIncidentId,
	);
	document.getElementById("hero-acknowledged").hidden =
		!activeIncident?.acknowledgedAt;
}

function recoveryDetails(data) {
	if (data.activeMaintenance) {
		return {
			kicker: "Planned maintenance",
			title: data.activeMaintenance.title || "Scheduled maintenance",
			copy: data.activeMaintenance.message,
			state: "Planned",
			steps: false,
		};
	}

	const region = affectedRegion(data);
	const name = regionName(region);
	if (!region) {
		return {
			kicker: "Service issue",
			title: "Some checks are failing.",
			copy: "The affected component is being investigated. No unsafe traffic or storage transition will be attempted.",
			state: "Degraded",
			steps: false,
		};
	}

	const providerDetails = {
		investigating: {
			kicker: `${name} provider check`,
			title: "The active physical backend is being verified.",
			copy: "Five failed direct canaries are required before a caught-up, explicitly authorized replica can be considered.",
			state: "Checking",
			steps: true,
			provider: true,
		},
		ready: {
			kicker: `${name} provider recovery`,
			title: "A safe physical replica is ready.",
			copy: "The candidate passed direct canaries, replication checkpoint, freshness, and explicit authorization gates.",
			state: "Ready",
			steps: true,
			provider: true,
		},
		promoting: {
			kicker: `${name} provider recovery`,
			title: "The active physical backend is changing.",
			copy: "Writer ownership and backend generation are being fenced before a logical write canary.",
			state: "Promoting",
			steps: true,
			provider: true,
		},
		replica_active: {
			kicker: `${name} provider recovery`,
			title: `Storage is running on ${region.activeBackend}.`,
			copy: "The logical region and endpoint are unchanged. Reverse replication is rebuilding provider redundancy.",
			state: "Replica active",
			steps: false,
			provider: true,
		},
		blocked: {
			kicker: `${name} provider recovery`,
			title: "Provider promotion is safely blocked.",
			copy: "No physical replica proved every health, replication, freshness, and authorization requirement.",
			state: "Blocked",
			steps: true,
			provider: true,
			critical: true,
		},
	};

	if (region.providerPhase !== "normal" && region.phase === "normal") {
		return (
			providerDetails[region.providerPhase] || providerDetails.investigating
		);
	}

	const regionalDetails = {
		investigating: {
			kicker: `${name} regional check`,
			title: "We're confirming the dataplane issue.",
			copy: "Traffic has not moved. Five failed checks are required before a healthy permanent peer can be activated.",
			state: "Checking",
			steps: true,
		},
		ready: {
			kicker: `${name} regional recovery`,
			title: "A permanent peer is available.",
			copy: "Temporary provider authorization, writer fencing, signed canaries, and DNS ordering still have to pass.",
			state: "Ready",
			steps: true,
		},
		activating: {
			kicker: `${name} regional recovery`,
			title: "The surviving dataplane is taking over.",
			copy: "Credentials, accounting, writer generation, and a signed logical canary are being verified before DNS moves.",
			state: "Activating",
			steps: true,
		},
		active: {
			kicker: `${name} regional failover`,
			title: `Traffic is running through ${label(region.activeDataplane)}.`,
			copy: "The logical region and active physical backend are unchanged while the home dataplane is monitored for recovery.",
			state: "Peer active",
			steps: true,
		},
		failing_back: {
			kicker: `${name} regional recovery`,
			title: "The logical region is returning home.",
			copy: "Remote mutations are draining before the home writer generation and signed canary are confirmed.",
			state: "Failing back",
			steps: true,
			recovering: true,
		},
		credential_cleanup: {
			kicker: `${name} regional recovery`,
			title: "Traffic is home; cleanup remains.",
			copy: region.recovery?.cleanupAfter
				? `Remote credentials remain until ${formatTime(region.recovery.cleanupAfter)} while stale DNS settles.`
				: "Remote credentials remain through the DNS safety window and will then be revoked.",
			state: "DNS grace",
			steps: true,
			recovering: true,
		},
		blocked: {
			kicker: `${name} regional recovery`,
			title: "Regional failover is safely blocked.",
			copy: "No surviving dataplane proved all authorization, provider, database, writer, and signed-canary requirements.",
			state: "Blocked",
			steps: true,
			critical: true,
		},
	};

	return (
		regionalDetails[region.phase] ||
		providerDetails[region.providerPhase] ||
		regionalDetails.investigating
	);
}

function transitionSteps(data, details) {
	const region = affectedRegion(data);
	if (details.provider) {
		const steps = [
			"Confirming direct provider outage",
			"Verifying replica checkpoint",
			"Checking one-shot authorization",
			"Fencing writer and backend generation",
			"Promoting the physical bucket",
			"Testing the logical S3 path",
		];
		const rank =
			{
				investigating: 0,
				ready: 3,
				promoting: 4,
				replica_active: 6,
				blocked: 2,
			}[region?.providerPhase] ?? 0;
		return steps.map((text, index) => ({
			text,
			state:
				region?.providerPhase === "blocked" && index === rank
					? "failed"
					: index < rank
						? "complete"
						: index === rank
							? "active"
							: "pending",
		}));
	}

	if (details.recovering) {
		const steps = [
			"Proving stable home readiness",
			"Draining the remote writer",
			"Flushing regional accounting",
			"Claiming the home generation",
			"Testing signed S3 operations",
			"Returning regional DNS",
			"Revoking remote credentials",
		];
		const rank = region?.phase === "credential_cleanup" ? 6 : 2;
		return steps.map((text, index) => ({
			text,
			state: index < rank ? "complete" : index === rank ? "active" : "pending",
		}));
	}

	const steps = [
		"Confirming five failed checks",
		"Authorizing the permanent peer",
		"Proving protected readiness",
		"Draining and flushing the old writer",
		"Claiming a new writer generation",
		"Testing signed S3 operations",
		"Routing the regional endpoints",
	];
	const rank =
		{ investigating: 0, ready: 1, activating: 3, active: 7, blocked: 1 }[
			region?.phase
		] ?? 0;
	return steps.map((text, index) => ({
		text,
		state:
			region?.phase === "blocked" && index === rank
				? "failed"
				: index < rank
					? "complete"
					: index === rank
						? "active"
						: "pending",
	}));
}

function stepIcon(state) {
	if (state === "complete")
		return '<span class="step-icon"><svg aria-hidden="true"><use href="#icon-check"></use></svg></span>';
	if (state === "failed")
		return '<span class="step-icon"><svg aria-hidden="true"><use href="#icon-close"></use></svg></span>';
	if (state === "active")
		return '<span class="step-icon"><i class="step-spinner" aria-hidden="true"></i></span>';
	return '<span class="step-icon" aria-hidden="true"></span>';
}

function renderRecovery(data) {
	const panel = document.getElementById("recovery-panel");
	panel.hidden = data.overall === "operational" && !data.activeMaintenance;
	if (panel.hidden) return;

	const details = recoveryDetails(data);
	panel.classList.toggle(
		"is-critical",
		Boolean(details.critical || data.overall === "major_outage"),
	);
	document.getElementById("recovery-kicker").textContent = details.kicker;
	document.getElementById("recovery-title").textContent = details.title;
	document.getElementById("recovery-copy").textContent = details.copy;
	document.getElementById("recovery-state").textContent = details.state;

	const steps = document.getElementById("failover-steps");
	steps.hidden = !details.steps;
	steps.innerHTML = details.steps
		? transitionSteps(data, details)
				.map(
					(step) =>
						`<li class="${step.state}">${stepIcon(step.state)}<span>${escapeHtml(step.text)}</span></li>`,
				)
				.join("")
		: "";
}

function fallbackDefinitions(data) {
	const definitions = [
		{
			id: "global-s3",
			name: "Global S3 Availability",
			description: "Signed operations through every logical region",
			group: "global",
		},
		{
			id: "control-plane",
			name: "Silo Dashboard and Control Plane",
			description: "Global Bun control plane",
			group: "global",
		},
		{
			id: "postgresql-ha",
			name: "PostgreSQL HA",
			description: "Authoritative metadata with cross-region failover",
			group: "global",
		},
	];
	for (const region of regions(data)) {
		definitions.push(
			{
				id: `storage:${region.id}`,
				name: `${regionName(region)} Storage`,
				description: "Logical storage region",
				group: "regional",
			},
			{
				id: `dataplane:${region.id}`,
				name: `${regionName(region)} Dataplane`,
				description: "Preferred regional ingress",
				group: "regional",
			},
		);
	}
	return definitions;
}

function phaseStatus(region) {
	if (region.phase === "blocked") return "outage";
	if (region.phase !== "normal" || region.providerPhase !== "normal")
		return "degraded";
	return "operational";
}

function cleanComponentName(value) {
	return String(value || "Unnamed check").replace(/^[^\p{L}\p{N}]+/u, "");
}

function regionCode(id) {
	if (id === "eu-central") return "DE";
	if (id === "us-east") return "US";
	return String(id || "RG")
		.slice(0, 2)
		.toUpperCase();
}

function componentStatus(data, id) {
	return data.components?.[id] || "unknown";
}

function definitionMap(data) {
	const definitions =
		Array.isArray(data.componentDefinitions) && data.componentDefinitions.length
			? data.componentDefinitions
			: fallbackDefinitions(data);
	const map = new Map(definitions.map((item) => [item.id, item]));
	const legacy = {
		dashboard: ["Dashboard", "Derived from the global Bun control-plane check"],
		database: ["Database", "Derived from the PostgreSQL HA check"],
		storage: ["Storage", "Derived from the global signed S3 canary"],
		s3Api: ["S3 API", "Derived from the global signed S3 canary"],
		uploads: ["Uploads", "Legacy aggregate of regional PUT canaries"],
		downloads: ["Downloads", "Legacy aggregate of regional GET canaries"],
		authentication: [
			"Authentication",
			"Legacy aggregate of regional SigV4 canaries",
		],
	};
	for (const id of Object.keys(data.components || {})) {
		if (!map.has(id)) {
			const details = legacy[id];
			map.set(id, {
				id,
				name: details?.[0] || label(id),
				description: details?.[1] || "Live monitor",
				group: "additional",
			});
		}
	}
	return [...map.values()];
}

function infrastructureGraph(data) {
	const allRegions = regions(data);
	const narrow = window.matchMedia("(max-width: 620px)").matches;
	const width = narrow ? 520 : 1180;
	const columns = narrow ? 1 : Math.min(2, Math.max(allRegions.length, 1));
	const rows = Math.max(1, Math.ceil(allRegions.length / columns));
	const regionTop = 158;
	const regionHeight = 390;
	const regionGap = 14;
	const height = regionTop + rows * regionHeight + (rows - 1) * regionGap + 12;
	const regionWidth = (width - 24 - (columns - 1) * regionGap) / columns;
	const nodes = [];
	const links = [];
	const journeys = [];
	const zones = [];
	const definitions = new Map(
		definitionMap(data).map((definition) => [definition.id, definition]),
	);
	const rank = { operational: 0, unknown: 1, degraded: 2, outage: 3 };
	const worstStatus = (...statuses) =>
		statuses
			.map(safeStatus)
			.reduce(
				(worst, status) =>
					(rank[status] ?? 1) > (rank[worst] ?? 1) ? status : worst,
				"operational",
			);
	const addNode = (node) => {
		const definition = definitions.get(node.componentId);
		const item = {
			width: narrow ? 138 : 146,
			height: narrow ? 48 : 46,
			kind: "service",
			location: "Global",
			detail:
				definition?.description || "Independent live infrastructure check.",
			...node,
			status: node.status || componentStatus(data, node.componentId),
		};
		nodes.push(item);
		return item;
	};
	const addLink = (source, target, channel, options = {}) => {
		const link = {
			id: options.id || `${source}:${target}:${links.length}`,
			source,
			target,
			channel,
			active: options.active !== false,
			curve: options.curve || 0,
			label: options.label || "",
			status: safeStatus(options.status || "operational"),
		};
		links.push(link);
		return link.id;
	};
	const addJourney = (type, edgeIds, options = {}) => {
		journeys.push({
			type,
			edgeIds,
			count: options.count || 3,
			speed: options.speed || 0.8,
			delay: options.delay || 0,
			cycle: options.cycle || 900,
			spacing: options.spacing || 13,
		});
	};
	const canFlow = (...ids) =>
		ids.every((id) => {
			const status = nodes.find((node) => node.id === id)?.status;
			return status === "operational" || status === "degraded";
		});

	const topStatus = worstStatus(
		componentStatus(data, "global-s3"),
		componentStatus(data, "control-plane"),
		componentStatus(data, "database-ha-controller"),
	);
	zones.push({
		id: "global",
		code: "00",
		label: "GLOBAL ROUTING + CONTROL",
		x: 12,
		y: 12,
		width: width - 24,
		height: 130,
		status: topStatus,
	});
	addNode({
		id: "edge",
		label: "PUBLIC S3 ENDPOINTS",
		meta: "signed end-to-end checks",
		componentId: "global-s3",
		x: narrow ? 92 : 180,
		y: 80,
		kind: "edge",
		location: "Cloudflare global network",
		detail:
			"End-to-end public DNS, TLS, routing, authentication, and storage availability measured by signed regional S3 canaries.",
		width: narrow ? 138 : 160,
	});
	addNode({
		id: "control",
		label: "BUN CONTROL PLANE",
		meta: "global · Germany",
		componentId: "control-plane",
		x: narrow ? 260 : 590,
		y: 80,
		kind: "control",
		location: "Germany",
		width: narrow ? 148 : 164,
	});
	addNode({
		id: "controller",
		label: "STATUS + HA WORKER",
		meta: "independent witness",
		componentId: "database-ha-controller",
		x: narrow ? 430 : 1000,
		y: 80,
		kind: "controller",
		location: "Cloudflare Workers",
		width: narrow ? 148 : 164,
	});

	const regionLayouts = new Map();
	for (const [index, region] of allRegions.entries()) {
		const column = index % columns;
		const row = Math.floor(index / columns);
		const x = 12 + column * (regionWidth + regionGap);
		const y = regionTop + row * (regionHeight + regionGap);
		const left = x + regionWidth * 0.18;
		const center = x + regionWidth * 0.5;
		const right = x + regionWidth * 0.82;
		const backendDefinitions = [...definitions.values()].filter((definition) =>
			definition.id.startsWith(`backend:${region.id}:`),
		);
		if (backendDefinitions.length === 0) {
			backendDefinitions.push({
				id: `backend:${region.id}:${region.activeBackend || "primary"}`,
				name: label(region.activeBackend || "S3 backend"),
				description: "Active physical S3 backend",
			});
		}
		const backendStatuses = backendDefinitions.map((definition) => ({
			id: definition.id.slice(`backend:${region.id}:`.length),
			status: componentStatus(data, definition.id),
		}));
		const criticalStatuses = [
			phaseStatus(region),
			componentStatus(data, `dataplane:${region.id}`),
			componentStatus(data, `pgdog:${region.id}`),
			backendStatuses.find((backend) => backend.id === region.activeBackend)
				?.status || "unknown",
		];
		const optionalStatuses = [
			componentStatus(data, `cache:${region.id}`),
			componentStatus(data, `disk-cache:${region.id}`),
			componentStatus(data, `clickhouse:${region.id}`),
			...backendStatuses
				.filter((backend) => backend.id !== region.activeBackend)
				.map((backend) => backend.status),
		];
		if (data.databaseHa?.activeRegion === region.id)
			criticalStatuses.push(componentStatus(data, `postgresql:${region.id}`));
		else
			optionalStatuses.push(componentStatus(data, `postgresql:${region.id}`));
		const criticalStatus = worstStatus(...criticalStatuses);
		const optionalStatus = worstStatus(...optionalStatuses);
		const zoneStatus =
			criticalStatus === "outage"
				? "outage"
				: criticalStatus === "degraded" ||
						optionalStatus === "degraded" ||
						optionalStatus === "outage"
					? "degraded"
					: criticalStatus === "unknown" || optionalStatus === "unknown"
						? "unknown"
						: "operational";
		zones.push({
			id: region.id,
			code: regionCode(region.id),
			label:
				regionName(region).toUpperCase() +
				(region.activeDataplane !== region.homeDataplane
					? ` · TRAFFIC ON ${regionCode(region.activeDataplane)}`
					: " · LOCAL TRAFFIC"),
			x,
			y,
			width: regionWidth,
			height: regionHeight,
			status: zoneStatus,
		});
		const dataplane = addNode({
			id: `dp:${region.id}`,
			label: "RUST DATAPLANE",
			meta:
				regionCode(region.id) +
				(region.activeDataplane === region.id ? " · serving" : " · standby") +
				(region.writerGeneration ? ` · g${region.writerGeneration}` : ""),
			componentId: `dataplane:${region.id}`,
			x: center,
			y: y + 68,
			kind: "dataplane",
			location: regionName(region),
			width: 158,
			detail:
				"Regional Rust S3 service. Accounting safety is " +
				statusText(
					componentStatus(data, `accounting:${region.id}`),
				).toLowerCase() +
				".",
		});
		const redis = addNode({
			id: `redis:${region.id}`,
			label: "DRAGONFLY",
			meta: "memory cache",
			componentId: `cache:${region.id}`,
			x: left,
			y: y + 150,
			kind: "cache",
			location: regionName(region),
		});
		const disk = addNode({
			id: `disk:${region.id}`,
			label: "DISK CACHE",
			meta: "persistent local volume",
			componentId: `disk-cache:${region.id}`,
			x: center,
			y: y + 150,
			kind: "cache",
			location: regionName(region),
			width: 154,
		});
		const pgdog = addNode({
			id: `pgdog:${region.id}`,
			label: "SQL / PGDOG PATH",
			meta: "local pooled DB route",
			componentId: `pgdog:${region.id}`,
			x: right,
			y: y + 150,
			kind: "database",
			location: regionName(region),
			width: 154,
		});
		const backendNodes = backendDefinitions.map((definition, backendIndex) => {
			const backendId = definition.id.slice(`backend:${region.id}:`.length);
			const provider =
				definition.description?.split(/\s+physical\s+/i)[0] ||
				cleanComponentName(definition.name);
			const role = /\breplica\b/i.test(definition.description || "")
				? "replica"
				: "primary";
			return addNode({
				id: `storage:${region.id}:${backendId}`,
				label: `${String(provider || "S3")
					.slice(0, 17)
					.toUpperCase()} S3`,
				meta:
					(role === "replica" ? "replica" : "primary") +
					(backendId === region.activeBackend
						? " · active" +
							(region.backendGeneration
								? ` · g${region.backendGeneration}`
								: "")
						: ""),
				componentId: definition.id,
				x:
					x +
					(regionWidth * (backendIndex + 1)) / (backendDefinitions.length + 1),
				y: y + 238,
				kind: "backend",
				location: regionName(region),
				detail: definition.description,
				width: backendDefinitions.length > 2 ? 138 : 154,
				backendId,
				role,
			});
		});
		const clickhouse = addNode({
			id: `ch:${region.id}`,
			label: "CLICKHOUSE",
			meta: "request logs",
			componentId: `clickhouse:${region.id}`,
			x: x + regionWidth * 0.26,
			y: y + 334,
			kind: "logs",
			location: regionName(region),
		});
		const postgres = addNode({
			id: `pg:${region.id}`,
			label: "POSTGRESQL",
			meta:
				(data.databaseHa?.activeRegion === region.id
					? "primary"
					: "hot standby") +
				" · " +
				regionCode(region.id) +
				(data.databaseHa?.generation
					? ` · g${data.databaseHa.generation}`
					: ""),
			componentId: `postgresql:${region.id}`,
			x: x + regionWidth * 0.74,
			y: y + 334,
			kind: "database",
			location: regionName(region),
			width: 154,
		});
		regionLayouts.set(region.id, {
			region,
			dataplane,
			redis,
			disk,
			pgdog,
			postgres,
			clickhouse,
			backendNodes,
		});
	}

	for (const [index, region] of allRegions.entries()) {
		const logical = regionLayouts.get(region.id);
		const serving = regionLayouts.get(region.activeDataplane) || logical;
		if (!logical || !serving) continue;
		const routeEdge = addLink("edge", serving.dataplane.id, "request", {
			id: `route:${region.id}`,
			label: `${regionCode(region.id)} TRAFFIC`,
			curve: (index - (allRegions.length - 1) / 2) * 36,
			status: phaseStatus(region),
		});
		if (canFlow("edge", serving.dataplane.id))
			addJourney("request", [routeEdge], {
				count: 4,
				speed: 0.36,
				delay: index * 340,
				spacing: 8,
			});
		const activeBackend =
			logical.backendNodes.find(
				(node) => node.backendId === region.activeBackend,
			) || logical.backendNodes[0];
		if (activeBackend) {
			const storageEdge = addLink(
				serving.dataplane.id,
				activeBackend.id,
				"body",
				{
					id: `serving-storage:${region.id}`,
					label:
						regionCode(region.id) +
						(region.activeDataplane === region.id ? " OBJECTS" : " FAILOVER"),
					curve: region.activeDataplane === region.id ? 0 : index ? 62 : -62,
					status: componentStatus(data, `storage:${region.id}`),
				},
			);
			const storageResponse = addLink(
				activeBackend.id,
				serving.dataplane.id,
				"response",
				{
					label: "OBJECT BODY",
					curve: region.activeDataplane === region.id ? -18 : index ? -78 : 78,
					status: componentStatus(data, `storage:${region.id}`),
				},
			);
			if (canFlow(serving.dataplane.id, activeBackend.id))
				addJourney("body", [storageEdge], {
					count: 6,
					speed: 0.4,
					delay: 700 + index * 340,
					spacing: 8,
				});
			if (canFlow(activeBackend.id, serving.dataplane.id))
				addJourney("response", [storageResponse], {
					count: 4,
					speed: 0.44,
					delay: 1080 + index * 340,
					spacing: 8,
				});
		}
		const replicas = logical.backendNodes.filter(
			(node) => node !== activeBackend,
		);
		for (const [replicaIndex, replica] of replicas.entries()) {
			const replicaEdge = addLink(activeBackend.id, replica.id, "replication", {
				label: "REPLICATE",
				curve: replicaIndex % 2 ? 24 : -24,
				status: componentStatus(data, `replication:${region.id}`),
			});
			if (
				componentStatus(data, `replication:${region.id}`) !== "outage" &&
				canFlow(activeBackend.id, replica.id)
			)
				addJourney("replication", [replicaEdge], {
					count: 3,
					speed: 0.32,
					delay: 1900 + index * 300,
					spacing: 8,
				});
		}
	}

	for (const [index, layout] of [...regionLayouts.values()].entries()) {
		const cacheEdge = addLink(
			layout.dataplane.id,
			layout.redis.id,
			"metadata",
			{
				label: "LOOKUP",
				curve: -10,
				status: componentStatus(data, `cache:${layout.region.id}`),
			},
		);
		const cacheReturn = addLink(
			layout.redis.id,
			layout.dataplane.id,
			"response",
			{
				label: "HIT",
				curve: 12,
				status: componentStatus(data, `cache:${layout.region.id}`),
			},
		);
		const diskEdge = addLink(layout.dataplane.id, layout.disk.id, "body", {
			label: "READ / WRITE",
			curve: -8,
			status: componentStatus(data, `disk-cache:${layout.region.id}`),
		});
		const diskReturn = addLink(
			layout.disk.id,
			layout.dataplane.id,
			"response",
			{
				label: "HOT BODY",
				curve: 10,
				status: componentStatus(data, `disk-cache:${layout.region.id}`),
			},
		);
		const sqlEdge = addLink(layout.dataplane.id, layout.pgdog.id, "database", {
			label: "QUERY",
			curve: 10,
			status: componentStatus(data, `pgdog:${layout.region.id}`),
		});
		const sqlReturn = addLink(
			layout.pgdog.id,
			layout.dataplane.id,
			"response",
			{
				label: "RESULT",
				curve: -12,
				status: componentStatus(data, `pgdog:${layout.region.id}`),
			},
		);
		const activeDatabase =
			regionLayouts.get(data.databaseHa?.activeRegion)?.postgres ||
			layout.postgres;
		const activeDatabaseRegion =
			data.databaseHa?.activeRegion || layout.region.id;
		const poolEdge = addLink(layout.pgdog.id, activeDatabase.id, "database", {
			label: "ACTIVE DB",
			curve: activeDatabase === layout.postgres ? 0 : index ? 58 : -58,
			status: componentStatus(data, `postgresql:${activeDatabaseRegion}`),
		});
		const databaseReturn = addLink(
			activeDatabase.id,
			layout.pgdog.id,
			"response",
			{
				label: "ROW SET",
				curve: activeDatabase === layout.postgres ? -18 : index ? -72 : 72,
				status: componentStatus(data, `postgresql:${activeDatabaseRegion}`),
			},
		);
		if (canFlow(layout.dataplane.id, layout.redis.id))
			addJourney("metadata", [cacheEdge], {
				count: 3,
				speed: 0.32,
				delay: 1150 + index * 300,
				spacing: 8,
			});
		if (canFlow(layout.redis.id, layout.dataplane.id))
			addJourney("response", [cacheReturn], {
				count: 2,
				speed: 0.36,
				delay: 1280 + index * 300,
				spacing: 8,
			});
		if (canFlow(layout.dataplane.id, layout.disk.id))
			addJourney("body", [diskEdge], {
				count: 5,
				speed: 0.36,
				delay: 1550 + index * 300,
				spacing: 8,
			});
		if (canFlow(layout.disk.id, layout.dataplane.id))
			addJourney("response", [diskReturn], {
				count: 3,
				speed: 0.4,
				delay: 1680 + index * 300,
				spacing: 8,
			});
		if (canFlow(layout.dataplane.id, layout.pgdog.id, activeDatabase.id))
			addJourney("database", [sqlEdge, poolEdge], {
				count: 3,
				speed: 0.34,
				delay: 2100 + index * 300,
				spacing: 8,
			});
		if (canFlow(activeDatabase.id, layout.pgdog.id, layout.dataplane.id))
			addJourney("response", [databaseReturn, sqlReturn], {
				count: 3,
				speed: 0.38,
				delay: 2310 + index * 300,
				spacing: 8,
			});
		for (const [logIndex, target] of [...regionLayouts.values()].entries()) {
			const logEdge = addLink(
				layout.dataplane.id,
				target.clickhouse.id,
				"logs",
				{
					label: logIndex === index ? "LOCAL LOG" : "REMOTE LOG",
					curve: logIndex === index ? -12 : index ? 74 : -74,
					status:
						logIndex === index
							? componentStatus(data, `clickhouse:${target.region.id}`)
							: componentStatus(data, "clickhouse-log-redundancy"),
				},
			);
			if (canFlow(layout.dataplane.id, target.clickhouse.id))
				addJourney("logs", [logEdge], {
					count: 2,
					speed: logIndex === index ? 0.3 : 0.26,
					delay: 2800 + index * 300 + logIndex * 120,
					spacing: 8,
				});
		}
	}

	const activeDatabaseLayout = regionLayouts.get(data.databaseHa?.activeRegion);
	const standbyDatabaseLayout = [...regionLayouts.values()].find(
		(layout) => layout !== activeDatabaseLayout,
	);
	if (activeDatabaseLayout && standbyDatabaseLayout) {
		const walEdge = addLink(
			activeDatabaseLayout.postgres.id,
			standbyDatabaseLayout.postgres.id,
			"database",
			{
				label: data.databaseHa?.synchronousConfirmed ? "SYNC WAL" : "WAL",
				curve: narrow ? 30 : -22,
				status: componentStatus(data, "postgresql-replication"),
			},
		);
		if (
			canFlow(
				activeDatabaseLayout.postgres.id,
				standbyDatabaseLayout.postgres.id,
			)
		)
			addJourney("database", [walEdge], {
				count: 3,
				speed: 0.3,
				delay: 3300,
				spacing: 8,
			});
	}
	const controlHome =
		regionLayouts.get("eu-central") || regionLayouts.values().next().value;
	if (controlHome) {
		const controlSqlEdge = addLink(
			"control",
			controlHome.pgdog.id,
			"metadata",
			{
				label: "CONTROL DATA",
				curve: narrow ? 48 : 24,
			},
		);
		if (canFlow("control", controlHome.pgdog.id))
			addJourney("metadata", [controlSqlEdge], {
				count: 2,
				speed: 0.3,
				delay: 900,
				spacing: 8,
			});
	}

	return { width, height, nodes, links, zones, journeys, allRegions };
}

function renderTopology(data) {
	const stage = document.getElementById("topology-stage");
	if (!stage) return;
	const d3 = globalThis.d3;
	if (!d3) {
		stage.innerHTML =
			'<p class="diagram-unavailable">The interactive topology could not be loaded. Live telemetry remains available below.</p>';
		return;
	}
	const draw = () => {
		cancelAnimationFrame(topologyAnimationFrame);
		stage.replaceChildren();
		const graph = infrastructureGraph(data);
		const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
		const linkById = new Map(graph.links.map((link) => [link.id, link]));
		const svg = d3
			.select(stage)
			.append("svg")
			.attr("class", "topology-svg")
			.attr("viewBox", `0 0 ${graph.width} ${graph.height}`)
			.style("aspect-ratio", `${graph.width} / ${graph.height}`)
			.attr("role", "group")
			.attr("aria-roledescription", "live infrastructure diagram")
			.attr(
				"aria-label",
				"Interactive live topology of Silo infrastructure in " +
					graph.allRegions.map(regionName).join(" and "),
			);
		const scene = svg.append("g").attr("class", "topology-scene");
		const defs = svg.append("defs");
		for (const channel of [
			"request",
			"body",
			"metadata",
			"response",
			"database",
			"logs",
			"replication",
		]) {
			defs
				.append("marker")
				.attr("id", `arrow-${channel}`)
				.attr("viewBox", "0 -4 8 8")
				.attr("refX", 7)
				.attr("markerWidth", 7)
				.attr("markerHeight", 7)
				.attr("orient", "auto")
				.append("path")
				.attr("d", "M0,-3L8,0L0,3Z")
				.attr("class", `arrow-head ${channel}`);
		}
		for (const state of ["degraded", "outage", "unknown"]) {
			defs
				.append("marker")
				.attr("id", `arrow-${state}`)
				.attr("viewBox", "0 -4 8 8")
				.attr("refX", 7)
				.attr("markerWidth", 7)
				.attr("markerHeight", 7)
				.attr("orient", "auto")
				.append("path")
				.attr("d", "M0,-3L8,0L0,3Z")
				.attr("class", `arrow-head ${state}`);
		}

		const zone = scene
			.append("g")
			.attr("class", "topology-zones")
			.selectAll("g")
			.data(graph.zones)
			.join("g")
			.attr("class", (item) => `topology-zone ${safeStatus(item.status)}`);
		zone
			.append("rect")
			.attr("x", (item) => item.x)
			.attr("y", (item) => item.y)
			.attr("width", (item) => item.width)
			.attr("height", (item) => item.height)
			.attr("rx", 12);
		zone
			.append("text")
			.attr("x", (item) => item.x + 12)
			.attr("y", (item) => item.y + 18)
			.attr("class", "zone-code")
			.text((item) => item.code);
		zone
			.append("text")
			.attr("x", (item) => item.x + 34)
			.attr("y", (item) => item.y + 18)
			.attr("class", "zone-label")
			.text((item) => item.label);

		const pathFor = (link) => {
			const source = nodeById.get(link.source);
			const target = nodeById.get(link.target);
			if (!source || !target) return "";
			const dx = target.x - source.x;
			const dy = target.y - source.y;
			const clipToNode = (node, towardX, towardY) => {
				const directionX = towardX - node.x;
				const directionY = towardY - node.y;
				const scale =
					1 /
					Math.max(
						Math.abs(directionX) / Math.max(node.width / 2, 1),
						Math.abs(directionY) / Math.max(node.height / 2, 1),
						1,
					);
				return {
					x: node.x + directionX * scale,
					y: node.y + directionY * scale,
				};
			};
			if (!link.curve) {
				const start = clipToNode(source, target.x, target.y);
				const end = clipToNode(target, source.x, source.y);
				return `M${start.x},${start.y}L${end.x},${end.y}`;
			}
			const length = Math.max(Math.hypot(dx, dy), 1);
			const middleX = (source.x + target.x) / 2;
			const middleY = (source.y + target.y) / 2;
			const controlX = middleX - (dy / length) * link.curve;
			const controlY = middleY + (dx / length) * link.curve;
			const start = clipToNode(source, controlX, controlY);
			const end = clipToNode(target, controlX, controlY);
			return (
				"M" +
				start.x +
				"," +
				start.y +
				"Q" +
				controlX +
				"," +
				controlY +
				" " +
				end.x +
				"," +
				end.y
			);
		};

		const edges = scene
			.append("g")
			.attr("class", "topology-links")
			.selectAll("path")
			.data(graph.links)
			.join("path")
			.attr("class", (link) => {
				const source = nodeById.get(link.source);
				const target = nodeById.get(link.target);
				const unhealthy =
					source?.status === "outage" ||
					target?.status === "outage" ||
					link.status === "outage";
				return (
					"topology-link " +
					link.channel +
					" link-" +
					link.status +
					(link.active ? " active" : " standby") +
					(unhealthy ? " unhealthy" : "")
				);
			})
			.attr("d", pathFor)
			.attr("marker-end", (link) => {
				if (!link.active || link.channel === "standby") return null;
				const source = nodeById.get(link.source);
				const target = nodeById.get(link.target);
				const state =
					source?.status === "outage" || target?.status === "outage"
						? "outage"
						: link.status;
				return `url(#arrow-${state === "operational" ? link.channel : state})`;
			});
		const edgeNodes = new Map();
		edges.each(function mapEdge(link) {
			edgeNodes.set(link.id, this);
		});

		scene
			.append("g")
			.attr("class", "topology-link-labels")
			.selectAll("text")
			.data(graph.links.filter((link) => link.label))
			.join("text")
			.attr("class", (link) => `link-label ${link.channel} link-${link.status}`)
			.attr("x", (link) => {
				const path = edgeNodes.get(link.id);
				return path?.getPointAtLength(path.getTotalLength() * 0.5).x || 0;
			})
			.attr("y", (link) => {
				const path = edgeNodes.get(link.id);
				return (path?.getPointAtLength(path.getTotalLength() * 0.5).y || 0) - 5;
			})
			.text((link) => link.label);

		const nodeSelection = scene
			.append("g")
			.attr("class", "topology-nodes")
			.selectAll("g")
			.data(graph.nodes)
			.join("g")
			.attr(
				"class",
				(node) => `topology-node ${node.kind} ${safeStatus(node.status)}`,
			)
			.attr("transform", (node) => `translate(${node.x},${node.y})`)
			.attr("aria-hidden", "true");
		nodeSelection
			.append("rect")
			.attr("x", (node) => -node.width / 2)
			.attr("y", (node) => -node.height / 2)
			.attr("width", (node) => node.width)
			.attr("height", (node) => node.height)
			.attr("rx", 8);
		nodeSelection
			.append("circle")
			.attr("class", "node-state")
			.attr("cx", (node) => -node.width / 2 + 12)
			.attr("cy", 0)
			.attr("r", 3);
		nodeSelection
			.append("text")
			.attr("class", "node-health")
			.attr("x", (node) => node.width / 2 - 8)
			.attr("y", (node) => -node.height / 2 + 11)
			.text(
				(node) =>
					({
						operational: "LIVE",
						degraded: "DEGRADED",
						outage: "DOWN",
						unknown: "CHECKING",
					})[safeStatus(node.status)] || "CHECKING",
			);
		nodeSelection
			.append("text")
			.attr("class", "node-label")
			.attr("x", (node) => -node.width / 2 + 22)
			.attr("y", -2)
			.text((node) => node.label);
		nodeSelection
			.append("text")
			.attr("class", "node-meta")
			.attr("x", (node) => -node.width / 2 + 22)
			.attr("y", 11)
			.text((node) => node.meta);

		const reducedMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches;
		const symbolTypes = {
			request: d3.symbolCircle,
			body: d3.symbolSquare,
			metadata: d3.symbolDiamond,
			response: d3.symbolCircle,
			database: d3.symbolSquare,
			logs: d3.symbolTriangle,
			replication: d3.symbolDiamond,
		};
		const symbolSizes = {
			request: 18,
			body: 24,
			metadata: 20,
			response: 20,
			database: 16,
			logs: 14,
			replication: 17,
		};
		const particles = [];
		for (const journey of graph.journeys) {
			if (
				journey.edgeIds.some((edgeId) => {
					const status = linkById.get(edgeId)?.status;
					return status === "outage" || status === "unknown";
				})
			)
				continue;
			const segments = journey.edgeIds
				.map((edgeId) => {
					const path = edgeNodes.get(edgeId);
					return path ? { edgeId, path, length: path.getTotalLength() } : null;
				})
				.filter(Boolean);
			const totalLength = segments.reduce(
				(total, segment) => total + segment.length,
				0,
			);
			if (!totalLength) continue;
			for (let index = 0; index < journey.count; index += 1) {
				const sizeScale = [0.46, 0.66, 0.84, 1.08, 1.42, 1.78][
					Math.floor(index + journey.delay / 100) % 6
				];
				particles.push({
					type: journey.type,
					segments,
					totalLength,
					index,
					count: journey.count,
					speed: journey.speed,
					delay: journey.delay,
					cycle: journey.cycle,
					offset: index * journey.spacing,
					sizeScale,
				});
			}
		}
		const particleSelection = scene
			.append("g")
			.attr("class", "topology-particles")
			.selectAll("path")
			.data(particles)
			.join("path")
			.attr("d", (particle) =>
				d3
					.symbol()
					.type(symbolTypes[particle.type] || d3.symbolCircle)
					.size((symbolSizes[particle.type] || 16) * particle.sizeScale)(),
			)
			.attr("class", (particle) => `flow-particle ${particle.type}`);
		const locateParticle = (particle, time) => {
			let distance;
			let visible;
			if (reducedMotion) {
				distance = particle.totalLength * 0.55;
				visible = particle.index === 0;
			} else {
				const travelTime = particle.totalLength / particle.speed;
				const launchInterval = Math.max(
					26,
					Math.min(92, travelTime / Math.max(particle.count * 0.56, 1)),
				);
				const loopDuration = travelTime + launchInterval * particle.count;
				const elapsed =
					((time - particle.delay - particle.index * launchInterval) %
						loopDuration) +
					loopDuration;
				const packetTime = elapsed % loopDuration;
				visible = packetTime <= travelTime;
				distance = Math.min(packetTime * particle.speed, particle.totalLength);
			}
			let segment = particle.segments[particle.segments.length - 1];
			for (const candidate of particle.segments) {
				if (distance <= candidate.length) {
					segment = candidate;
					break;
				}
				distance -= candidate.length;
			}
			const point = segment.path.getPointAtLength(distance);
			const before = segment.path.getPointAtLength(Math.max(0, distance - 1));
			const after = segment.path.getPointAtLength(
				Math.min(segment.length, distance + 1),
			);
			const angle =
				(Math.atan2(after.y - before.y, after.x - before.x) * 180) / Math.PI;
			return {
				transform: `translate(${point.x},${point.y}) rotate(${angle})`,
				visible,
			};
		};
		const positionParticles = (time) => {
			particleSelection.each(function positionParticle(particle) {
				const state = locateParticle(particle, time);
				d3.select(this)
					.attr("transform", state.transform)
					.attr(
						"opacity",
						state.visible
							? 0.64 + 0.36 * (1 - particle.index / particle.count)
							: 0,
					);
			});
		};
		positionParticles(0);
		if (!reducedMotion) {
			let lastParticleFrame = 0;
			const animate = (time) => {
				if (time - lastParticleFrame >= 42) {
					positionParticles(time);
					lastParticleFrame = time;
				}
				topologyAnimationFrame = requestAnimationFrame(animate);
			};
			topologyAnimationFrame = requestAnimationFrame(animate);
		}
	};

	draw();
	topologyResizeObserver?.disconnect();
	if (globalThis.ResizeObserver) {
		let narrowLayout = window.matchMedia("(max-width: 620px)").matches;
		topologyResizeObserver = new ResizeObserver(() => {
			const nextNarrowLayout = window.matchMedia("(max-width: 620px)").matches;
			if (nextNarrowLayout !== narrowLayout) {
				narrowLayout = nextNarrowLayout;
				draw();
			}
		});
		topologyResizeObserver.observe(stage);
	}
}

function renderComponents(data) {
	const html =
		'<div class="topology-shell"><div id="topology-stage" class="topology-stage"></div></div>';
	document.getElementById("status-groups").innerHTML = html;
	renderTopology(data);
}

function renderActiveIncident(data) {
	const incident = (data.incidents || []).find(
		(item) => item.id === data.activeIncidentId,
	);
	const section = document.getElementById("active-incident");
	section.hidden = !incident;
	if (!incident) return;

	document.getElementById("incident-title").textContent = incident.title;
	document.getElementById("incident-status").textContent =
		incident.acknowledgedAt
			? "Acknowledged"
			: label(data.failoverPhase || "investigating");

	const acknowledgement = document.getElementById("incident-acknowledgement");
	acknowledgement.hidden = !incident.acknowledgedAt;
	acknowledgement.innerHTML = incident.acknowledgedAt
		? `<strong>Acknowledged by the Silo team</strong>${escapeHtml(incident.acknowledgementMessage || "The team is working on this incident.")}`
		: "";

	const notes = (data.notes || [])
		.filter((note) => note.incidentId === incident.id)
		.map((note) => ({ ...note, teamNote: true }));
	const timeline = [...(data.updates || []), ...notes].sort(
		(left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt),
	);
	document.getElementById("incident-timeline").innerHTML = timeline.length
		? timeline
				.map(
					(item) =>
						`<li class="${item.teamNote ? "team-note" : ""}"><time datetime="${escapeHtml(item.createdAt)}">${formatTime(item.createdAt)}</time><div>${item.teamNote ? '<span class="timeline-label">Team update</span>' : ""}<p>${escapeHtml(item.message)}</p></div></li>`,
				)
				.join("")
		: "<li><time>Now</time><div><p>We are investigating this incident.</p></div></li>";
}

function renderMaintenance(data) {
	const items = data.maintenance || [];
	const section = document.getElementById("maintenance-section");
	section.hidden = items.length === 0;
	document.getElementById("maintenance").innerHTML = items
		.map(
			(item) =>
				`<article class="maintenance-item"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p></div><time datetime="${escapeHtml(item.startsAt)}">${formatDate(item.startsAt)}<br>${formatTime(item.startsAt)}</time></article>`,
		)
		.join("");
}

function renderHistory(data) {
	const incidents = (data.incidents || []).filter(
		(incident) => incident.id !== data.activeIncidentId,
	);
	const notes = data.notes || [];
	const container = document.getElementById("incidents");

	if (!incidents.length) {
		container.innerHTML =
			'<div class="history-empty">No incidents have been recorded.</div>';
		return;
	}

	container.innerHTML = incidents
		.map((incident) => {
			const latestNote = notes.find((note) => note.incidentId === incident.id);
			const resolved = incident.status === "resolved";
			return `<article class="history-item"><div class="history-main"><div class="history-title-row"><strong>${escapeHtml(incident.title)}</strong><span class="history-pill">${resolved ? "Resolved" : escapeHtml(label(incident.status))}</span>${incident.acknowledgedAt ? '<span class="history-pill acknowledged">Acknowledged</span>' : ""}</div>${latestNote ? `<p>${escapeHtml(latestNote.message)}</p>` : ""}</div><div class="history-meta">${formatDate(incident.startedAt)}<br>${resolved ? formatDuration(incident.startedAt, incident.resolvedAt) : "Ongoing"}</div></article>`;
		})
		.join("");
}

function percentage(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return "—";
	if (number >= 99.995) return "100%";
	return `${number.toFixed(3)}%`;
}

function utcDay(date) {
	return date.toISOString().slice(0, 10);
}

function barStatus(value) {
	if (!Number.isFinite(value)) return "unknown";
	if (value >= 99.5) return "operational";
	if (value >= 95) return "degraded";
	return "outage";
}

function renderUptimeBars(id, history, property) {
	const byDay = new Map(history.map((item) => [item.day, item]));
	const today = new Date();
	today.setUTCHours(0, 0, 0, 0);
	const bars = [];

	for (let offset = 89; offset >= 0; offset -= 1) {
		const date = new Date(today);
		date.setUTCDate(today.getUTCDate() - offset);
		const day = utcDay(date);
		const item = byDay.get(day);
		const value = item ? Number(item[property]) : Number.NaN;
		const state = barStatus(value);
		const title = item
			? `${formatDate(`${day}T00:00:00Z`)} · ${Number.isFinite(value) ? `${value.toFixed(2)}%` : "No data"} · ${item.samples} checks`
			: `${formatDate(`${day}T00:00:00Z`)} · No data`;
		bars.push(
			`<span class="uptime-bar ${state}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`,
		);
	}
	document.getElementById(id).innerHTML = bars.join("");
}

function renderUptime(data) {
	const uptime = data.uptime || {};
	document.getElementById("uptime-s3").textContent = percentage(uptime.s3);
	document.getElementById("uptime-dashboard").textContent = percentage(
		uptime.dashboard,
	);
	document.getElementById("uptime-samples").textContent = uptime.samples
		? `${Number(uptime.samples).toLocaleString()} checks recorded`
		: "Collecting data";
	const history = Array.isArray(uptime.history) ? uptime.history : [];
	renderUptimeBars("uptime-s3-bars", history, "s3");
	renderUptimeBars("uptime-dashboard-bars", history, "dashboard");
}

function render(data) {
	renderHero(data);
	renderRecovery(data);
	renderComponents(data);
	renderActiveIncident(data);
	renderMaintenance(data);
	renderHistory(data);
	renderUptime(data);
	const updated = document.getElementById("updated");
	updated.textContent = `Updated ${formatTime(data.updatedAt)}`;
	updated.title = new Date(data.updatedAt).toLocaleString();
}

function renderUnavailable() {
	cancelAnimationFrame(topologyAnimationFrame);
	topologyResizeObserver?.disconnect();
	const hero = document.getElementById("hero");
	hero.dataset.state = "unreachable";
	document.getElementById("hero-label").textContent = "Status check failed";
	document.getElementById("headline").textContent =
		"We can't reach the monitor.";
	document.getElementById("summary").textContent =
		"This does not necessarily mean Silo is down. Please try again in a moment.";
	document.getElementById("hero-acknowledged").hidden = true;
	document.getElementById("recovery-panel").hidden = true;
	document.getElementById("updated").textContent = "Monitor unreachable";
}

async function refresh() {
	const button = document.getElementById("refresh");
	button.classList.add("loading");
	button.disabled = true;
	try {
		const response = await fetch(API, { cache: "no-store" });
		if (!response.ok) throw new Error(`Status API returned ${response.status}`);
		render(await response.json());
	} catch {
		renderUnavailable();
	} finally {
		button.classList.remove("loading");
		button.disabled = false;
	}
}

document.getElementById("refresh").addEventListener("click", refresh);
refresh();
setInterval(refresh, 60_000);

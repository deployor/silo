const API = "https://status-api.onsilo.dev/api/status";

let renderedComponentIds = [];

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

function statusBadge(status, text = statusText(status)) {
	return `<span class="status-value ${safeStatus(status)}"><i aria-hidden="true"></i>${escapeHtml(text)}</span>`;
}

function setComponent(id, status = "unknown", text = statusText(status)) {
	const node = document.getElementById(`status-${id}`);
	if (!node) return;
	node.className = `status-value ${safeStatus(status)}`;
	node.innerHTML = `<i aria-hidden="true"></i>${escapeHtml(text)}`;
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
	return region
		? `${region.flag || ""} ${region.label || region.id}`.trim()
		: "The affected region";
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
			id: "aiven-postgresql",
			name: "Aiven PostgreSQL",
			description: "Authoritative global metadata and coordination",
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

function availabilityText(data, id) {
	const value = data.componentAvailability?.[id]?.availability;
	return typeof value === "number" && Number.isFinite(value)
		? ` · 90d ${value.toFixed(3)}%`
		: "";
}

function componentRow(data, definition, region) {
	const activeBackend =
		region && definition.id === `backend:${region.id}:${region.activeBackend}`;
	const suffix = activeBackend ? " · Active physical backend" : "";
	return `<div class="status-row"><div><strong>${escapeHtml(definition.name)}</strong><small>${escapeHtml(definition.description || "Live independent check")}${escapeHtml(suffix)}${escapeHtml(availabilityText(data, definition.id))}</small></div><span id="status-${escapeHtml(definition.id)}" class="status-value unknown"><i></i>Checking</span></div>`;
}

function phaseStatus(region) {
	if (region.phase === "blocked") return "outage";
	if (region.phase !== "normal" || region.providerPhase !== "normal")
		return "degraded";
	return "operational";
}

function renderComponents(data) {
	const definitions =
		Array.isArray(data.componentDefinitions) && data.componentDefinitions.length
			? data.componentDefinitions
			: fallbackDefinitions(data);
	renderedComponentIds = definitions.map((definition) => definition.id);

	const globalDefinitions = definitions.filter(
		(definition) => definition.group === "global",
	);
	const cards = [
		`<article class="status-group"><header><span>Global services</span><small>Control and storage authority</small></header>${globalDefinitions.map((definition) => componentRow(data, definition)).join("")}</article>`,
	];

	for (const region of regions(data)) {
		const coreIds = [
			`storage:${region.id}`,
			`dataplane:${region.id}`,
			`replication:${region.id}`,
		];
		const core = coreIds
			.map((id) => definitions.find((definition) => definition.id === id))
			.filter(Boolean);
		const backends = definitions.filter((definition) =>
			definition.id.startsWith(`backend:${region.id}:`),
		);
		const generation = [
			Number.isFinite(Number(region.writerGeneration))
				? `writer ${region.writerGeneration}`
				: null,
			Number.isFinite(Number(region.backendGeneration))
				? `backend ${region.backendGeneration}`
				: null,
		]
			.filter(Boolean)
			.join(" · ");
		const pathText =
			region.activeDataplane === region.homeDataplane
				? "Home"
				: `Via ${label(region.activeDataplane)}`;
		const pathDescription = `Active backend ${region.activeBackend || "unknown"}${generation ? ` · ${generation}` : ""}`;
		cards.push(
			`<article class="status-group"><header><span>${escapeHtml(regionName(region))}</span><small>${escapeHtml(region.id)}</small></header>${core.map((definition) => componentRow(data, definition, region)).join("")}${backends.map((definition) => componentRow(data, definition, region)).join("")}<div class="status-row"><div><strong>Active serving path</strong><small>${escapeHtml(pathDescription)}</small></div>${statusBadge(phaseStatus(region), pathText)}</div></article>`,
		);
	}

	document.getElementById("status-groups").innerHTML = cards.join("");
	for (const definition of definitions) {
		setComponent(definition.id, data.components?.[definition.id] || "unknown");
	}
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
	const hero = document.getElementById("hero");
	hero.dataset.state = "unreachable";
	document.getElementById("hero-label").textContent = "Status check failed";
	document.getElementById("headline").textContent =
		"We can't reach the monitor.";
	document.getElementById("summary").textContent =
		"This does not necessarily mean Silo is down. Please try again in a moment.";
	document.getElementById("hero-acknowledged").hidden = true;
	document.getElementById("recovery-panel").hidden = true;
	renderedComponentIds.forEach((id) => {
		setComponent(id, "unknown");
	});
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

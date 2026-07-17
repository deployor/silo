const API = "https://status-api.onsilo.dev/api/status";

const COMPONENTS = [
  "s3Api",
  "authentication",
  "uploads",
  "downloads",
  "deletes",
  "dashboard",
  "postgres",
  "redis",
  "backingStorage",
  "writerLease",
];

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[character]);

const label = (value) => String(value || "unknown")
  .replaceAll("_", " ")
  .replace(/\b\w/g, (character) => character.toUpperCase());

function statusText(status) {
  return ({ operational: "Operational", degraded: "Degraded", outage: "Outage", unknown: "Checking" })[status] || "Checking";
}

function setComponent(name, status = "unknown", text = statusText(status)) {
  const node = document.getElementById(`status-${name}`);
  if (!node) return;
  const safeStatus = ["operational", "degraded", "outage"].includes(status) ? status : "unknown";
  node.className = `status-value ${safeStatus}`;
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
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function formatDuration(start, end) {
  const milliseconds = Math.max(0, Date.parse(end || new Date().toISOString()) - Date.parse(start));
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining ? `${hours}h ${remaining}m` : `${hours}h`;
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
      summary: "Uploads, downloads, authentication, and the dashboard are working normally.",
    };
  }

  const phaseSummary = {
    investigating: "Some checks are failing. We're confirming the problem before moving traffic.",
    provisioning: "The outage is confirmed. Backup systems are provisioning now.",
    ready: "Backup systems passed their checks and are ready to receive traffic.",
    active: "S3 traffic is running on the temporary backup system while the primary recovers.",
    recovering: "Traffic is back on the primary. The backup system is staying online through the safety window.",
    failed: "The backup system did not start correctly. The team is investigating the recovery path.",
    inactive: "One or more Silo services are not responding normally.",
  };

  if (data.overall === "major_outage") {
    return {
      state: "outage",
      kicker: "Service outage",
      headline: "We're having issues.",
      summary: phaseSummary[data.failoverPhase] || phaseSummary.inactive,
    };
  }

  return {
    state: "degraded",
    kicker: "Degraded performance",
    headline: "We're having some issues.",
    summary: phaseSummary[data.failoverPhase] || phaseSummary.inactive,
  };
}

function renderHero(data) {
  const content = heroContent(data);
  const hero = document.getElementById("hero");
  hero.dataset.state = content.state;
  document.getElementById("hero-label").textContent = content.kicker;
  document.getElementById("headline").textContent = content.headline;
  document.getElementById("summary").textContent = content.summary;

  const activeIncident = (data.incidents || []).find((incident) => incident.id === data.activeIncidentId);
  document.getElementById("hero-acknowledged").hidden = !activeIncident?.acknowledgedAt;
}

function recoveryDetails(data) {
  const dashboardOnly = !data.activeMaintenance
    && data.failoverPhase === "inactive"
    && data.components?.dashboard === "outage"
    && ["s3Api", "uploads", "downloads", "authentication"].every((name) => data.components?.[name] === "operational");

  if (data.activeMaintenance) return {
    kicker: "Planned maintenance",
    title: data.activeMaintenance.title || "Scheduled maintenance",
    copy: data.activeMaintenance.message,
    state: "Planned",
    steps: false,
  };
  if (dashboardOnly) return {
    kicker: "Dashboard issue",
    title: "Storage is still working.",
    copy: "The dashboard is unavailable, but S3 uploads, downloads, and authentication are operational.",
    state: "Investigating",
    steps: false,
  };

  const details = {
    investigating: {
      kicker: "Checking the primary",
      title: "We're confirming the issue.",
      copy: "Traffic has not moved. Five failed checks are required before automatic recovery can begin.",
      state: "Checking",
      steps: true,
    },
    provisioning: {
      kicker: "Recovery in progress",
      title: "Backup systems are provisioning.",
      copy: "A temporary Hetzner server is being created and tested before any S3 traffic moves.",
      state: "Provisioning",
      steps: true,
    },
    ready: {
      kicker: "Backup system ready",
      title: "Storage checks passed.",
      copy: "The emergency dataplane is healthy and waiting for traffic activation.",
      state: "Ready",
      steps: true,
    },
    active: {
      kicker: "Emergency service active",
      title: "Traffic is running on backup systems.",
      copy: "The temporary Hetzner dataplane is serving S3 requests while the primary is monitored for recovery.",
      state: "In use",
      steps: true,
    },
    recovering: {
      kicker: "Primary recovered",
      title: "Traffic is back on the primary.",
      copy: data.recovery?.cleanupAfter
        ? `The backup stays online until ${formatTime(data.recovery.cleanupAfter)} while DNS settles and usage accounting is flushed.`
        : "The backup stays online through the DNS safety window before it is removed.",
      state: "Stabilizing",
      steps: false,
    },
    failed: {
      kicker: "Recovery problem",
      title: "The backup system did not start.",
      copy: "The safe fallback is active while the team investigates the failed recovery workflow.",
      state: "Failed",
      steps: true,
      critical: true,
    },
    inactive: {
      kicker: "Service issue",
      title: "Some checks are failing.",
      copy: "The affected service is being investigated.",
      state: "Degraded",
      steps: false,
    },
  };
  return details[data.failoverPhase] || details.inactive;
}

function failoverSteps(data) {
  const steps = [
    "Confirming the outage",
    "Requesting Hetzner server",
    "Emergency server online",
    "Starting Rust dataplane",
    "Testing S3 operations",
    "Backup system ready",
    "Rerouting S3 traffic",
  ];
  const ranks = {
    idle: 0,
    checking_primary: 0,
    server_requested: 1,
    server_online: 2,
    starting_dataplane: 3,
    verifying_storage: 4,
    verified: 5,
    active: 6,
    failed: 0,
  };
  const current = ranks[data.provisioningStep] ?? 0;
  return steps.map((text, index) => {
    let state = index < current ? "complete" : index === current ? "active" : "pending";
    if (data.failoverPhase === "failed" && index === current) state = "failed";
    if (data.failoverPhase === "active" && index === steps.length - 1) state = "complete";
    return { text, state };
  });
}

function stepIcon(state) {
  if (state === "complete") return '<span class="step-icon"><svg aria-hidden="true"><use href="#icon-check"></use></svg></span>';
  if (state === "failed") return '<span class="step-icon"><svg aria-hidden="true"><use href="#icon-close"></use></svg></span>';
  if (state === "active") return '<span class="step-icon"><i class="step-spinner" aria-hidden="true"></i></span>';
  return '<span class="step-icon" aria-hidden="true"></span>';
}

function renderRecovery(data) {
  const panel = document.getElementById("recovery-panel");
  panel.hidden = data.overall === "operational" && !data.activeMaintenance;
  if (panel.hidden) return;

  const details = recoveryDetails(data);
  panel.classList.toggle("is-critical", Boolean(details.critical || data.overall === "major_outage"));
  document.getElementById("recovery-kicker").textContent = details.kicker;
  document.getElementById("recovery-title").textContent = details.title;
  document.getElementById("recovery-copy").textContent = details.copy;
  document.getElementById("recovery-state").textContent = details.state;

  const steps = document.getElementById("failover-steps");
  steps.hidden = !details.steps;
  steps.innerHTML = details.steps
    ? failoverSteps(data).map((step) => `<li class="${step.state}">${stepIcon(step.state)}<span>${escapeHtml(step.text)}</span></li>`).join("")
    : "";
}

function renderComponents(data) {
  COMPONENTS.forEach((name) => setComponent(name, data.components?.[name] || "unknown"));

  const phase = data.failoverPhase || "inactive";
  const phaseMap = {
    inactive: { status: "operational", text: "Standby" },
    investigating: { status: "degraded", text: "Checking" },
    provisioning: { status: "degraded", text: "Provisioning" },
    ready: { status: "operational", text: "Ready" },
    active: { status: "operational", text: "In use" },
    recovering: { status: "degraded", text: "Stabilizing" },
    failed: { status: "outage", text: "Failed" },
  };
  const failover = phaseMap[phase] || { status: data.components?.failover || "unknown", text: label(phase) };
  setComponent("failover", failover.status, failover.text);
}

function renderActiveIncident(data) {
  const incident = (data.incidents || []).find((item) => item.id === data.activeIncidentId);
  const section = document.getElementById("active-incident");
  section.hidden = !incident;
  if (!incident) return;

  document.getElementById("incident-title").textContent = incident.title;
  document.getElementById("incident-status").textContent = incident.acknowledgedAt ? "Acknowledged" : label(data.failoverPhase || "investigating");

  const acknowledgement = document.getElementById("incident-acknowledgement");
  acknowledgement.hidden = !incident.acknowledgedAt;
  acknowledgement.innerHTML = incident.acknowledgedAt
    ? `<strong>Acknowledged by the Silo team</strong>${escapeHtml(incident.acknowledgementMessage || "The team is working on this incident.")}`
    : "";

  const notes = (data.notes || [])
    .filter((note) => note.incidentId === incident.id)
    .map((note) => ({ ...note, teamNote: true }));
  const timeline = [...(data.updates || []), ...notes]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  document.getElementById("incident-timeline").innerHTML = timeline.length
    ? timeline.map((item) => `<li class="${item.teamNote ? "team-note" : ""}"><time datetime="${escapeHtml(item.createdAt)}">${formatTime(item.createdAt)}</time><div>${item.teamNote ? '<span class="timeline-label">Team update</span>' : ""}<p>${escapeHtml(item.message)}</p></div></li>`).join("")
    : '<li><time>Now</time><div><p>We are investigating this incident.</p></div></li>';
}

function renderMaintenance(data) {
  const items = data.maintenance || [];
  const section = document.getElementById("maintenance-section");
  section.hidden = items.length === 0;
  document.getElementById("maintenance").innerHTML = items.map((item) => `<article class="maintenance-item"><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.message)}</p></div><time datetime="${escapeHtml(item.startsAt)}">${formatDate(item.startsAt)}<br>${formatTime(item.startsAt)}</time></article>`).join("");
}

function renderHistory(data) {
  const incidents = (data.incidents || []).filter((incident) => incident.id !== data.activeIncidentId);
  const notes = data.notes || [];
  const container = document.getElementById("incidents");

  if (!incidents.length) {
    container.innerHTML = '<div class="history-empty">No incidents have been recorded.</div>';
    return;
  }

  container.innerHTML = incidents.map((incident) => {
    const latestNote = notes.find((note) => note.incidentId === incident.id);
    const resolved = incident.status === "resolved";
    return `<article class="history-item"><div class="history-main"><div class="history-title-row"><strong>${escapeHtml(incident.title)}</strong><span class="history-pill">${resolved ? "Resolved" : escapeHtml(label(incident.status))}</span>${incident.acknowledgedAt ? '<span class="history-pill acknowledged">Acknowledged</span>' : ""}</div>${latestNote ? `<p>${escapeHtml(latestNote.message)}</p>` : ""}</div><div class="history-meta">${formatDate(incident.startedAt)}<br>${resolved ? formatDuration(incident.startedAt, incident.resolvedAt) : "Ongoing"}</div></article>`;
  }).join("");
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
    bars.push(`<span class="uptime-bar ${state}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"></span>`);
  }
  document.getElementById(id).innerHTML = bars.join("");
}

function renderUptime(data) {
  const uptime = data.uptime || {};
  document.getElementById("uptime-s3").textContent = percentage(uptime.s3);
  document.getElementById("uptime-dashboard").textContent = percentage(uptime.dashboard);
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
  document.getElementById("headline").textContent = "We can't reach the monitor.";
  document.getElementById("summary").textContent = "This does not necessarily mean Silo is down. Please try again in a moment.";
  document.getElementById("hero-acknowledged").hidden = true;
  document.getElementById("recovery-panel").hidden = true;
  COMPONENTS.forEach((name) => setComponent(name, "unknown"));
  setComponent("failover", "unknown");
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

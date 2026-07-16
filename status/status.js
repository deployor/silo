// The Pages project is public. The controller is a separate Worker so a
// status deployment can never share Silo's production origin.
const API = "https://status-api.onsilo.dev/api/status";
const label = (value) => value.replaceAll("_", " ").replace(/\b\w/g, (x) => x.toUpperCase());
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]);
function set(id, value) { const node = document.getElementById(id); node.textContent = label(value); node.className = value; }
function worstStatus(values) { return values.includes("outage") ? "outage" : values.includes("degraded") ? "degraded" : values.every((value) => value === "operational") ? "operational" : "unknown"; }
function phaseCopy(phase) { return ({ inactive:"A small temporary S3 server is only created if Silo needs it.", investigating:"We are checking whether this is a real outage.", provisioning:"An emergency server is being created. Traffic has not moved yet.", ready:"The emergency server is healthy and ready to receive traffic.", active:"S3 traffic is using a temporary emergency server.", recovering:"Traffic is back on the primary while the emergency server waits through DNS grace.", failed:"The emergency path could not start. We are investigating." })[phase] || "Checking the recovery path."; }
function failoverSteps(data) {
  const step = data.provisioningStep || "idle";
  const ranks = { idle:0, checking_primary:0, server_requested:1, server_online:2, starting_dataplane:3, verifying_storage:4, verified:5, active:6, failed:0 };
  const current = ranks[step] ?? 0;
  const labels = ["Outage confirmed", "Emergency infrastructure requested", "Emergency server online", "Starting Silo dataplane", "Verifying storage operations", "Rerouting traffic"];
  return labels.map((label, index) => ({ label, state: index < current ? "complete" : index === current && data.failoverPhase !== "failed" ? "active" : "" }));
}
function renderOutage(data) {
  const panel = document.getElementById("outage-panel");
  const isOutage = data.overall !== "operational";
  panel.hidden = !isOutage;
  if (!isOutage) return;
  const isMajor = data.overall === "major_outage";
  const scheduled = Boolean(data.activeMaintenance);
  const dashboardOnly = !scheduled && data.failoverPhase === "inactive" && data.components.dashboard === "outage";
  const recovering = data.failoverPhase === "recovering";
  document.getElementById("outage-title").textContent = scheduled ? "SCHEDULED MAINTENANCE" : dashboardOnly ? "DASHBOARD UNAVAILABLE" : recovering ? "RECOVERY IN PROGRESS" : isMajor ? "MAJOR OUTAGE" : "DEGRADED PERFORMANCE";
  document.getElementById("outage-copy").textContent = scheduled ? data.activeMaintenance.message : dashboardOnly ? "The dashboard is unavailable. S3 uploads, downloads, and authentication remain operational." : recovering ? "Traffic is back on the primary. The temporary server stays online through DNS grace and will be deleted only after accounting is safely flushed." : data.failoverPhase === "active" ? "S3 storage is running on the emergency server. The dashboard now sends visitors here until the primary recovers." : data.failoverPhase === "ready" ? "The emergency S3 server passed checks and is waiting for traffic activation." : data.failoverPhase === "failed" ? "The emergency server did not start successfully. Silo is serving the safe fallback while we investigate." : data.failoverPhase === "investigating" ? "The independent monitor saw a failed check and is confirming whether this is a real outage. Traffic has not moved." : "The outage is confirmed and the emergency S3 server is being prepared. Traffic has not moved yet.";
  const steps = document.getElementById("failover-steps");
  steps.hidden = dashboardOnly || scheduled || recovering;
  steps.innerHTML = dashboardOnly || scheduled || recovering ? "" : failoverSteps(data).map((item) => `<li class="${item.state}">${item.label}</li>`).join("");
}
function monitorLoading(loading) {
  const light = document.getElementById("monitor-light");
  const orb = document.getElementById("orb");
  light.className = loading ? "spinner" : "";
  orb.className = loading ? "orb spinner" : "orb";
}
async function refresh() {
  monitorLoading(true);
  try {
    const response = await fetch(API, { cache:"no-store" });
    if (!response.ok) throw new Error(`status API returned ${response.status}`);
    const data = await response.json();
    set("s3Storage", worstStatus([data.components.s3Api, data.components.uploads, data.components.downloads, data.components.authentication]));
    set("dashboard", data.components.dashboard);
    const dashboardOnly = !data.activeMaintenance && data.failoverPhase === "inactive" && data.components.dashboard === "outage";
    const headline = data.activeMaintenance ? "Scheduled maintenance." : data.overall === "operational" ? "All clear." : dashboardOnly ? "Dashboard unavailable." : data.failoverPhase === "active" ? "Degraded performance." : data.overall === "degraded" ? "Checking Silo." : "Major outage.";
    document.getElementById("headline").textContent = headline;
    document.getElementById("summary").textContent = data.activeMaintenance ? data.activeMaintenance.message : data.failoverPhase === "active" ? "S3 requests are being served by the temporary emergency path. The dashboard remains unavailable." : data.overall === "operational" ? "Everything that matters for storing and fetching your files is working normally." : "We’re on it. This page will show the latest useful update, without the noise.";
    document.getElementById("orb").style.background = data.overall === "operational" ? "var(--green)" : data.overall === "degraded" ? "var(--yellow)" : "var(--red)";
    set("phase", data.failoverPhase);
    const recovery = data.recovery;
    document.getElementById("phase-copy").textContent = data.failoverPhase === "active" && recovery?.successfulChecks ? `Primary recovery check ${recovery.successfulChecks}/${recovery.requiredChecks}; ${recovery.healthyMinutes}/${recovery.requiredHealthyMinutes} stable minutes.` : data.failoverPhase === "recovering" && recovery?.cleanupAfter ? `Traffic is back on the primary. The emergency server is retained until ${new Date(recovery.cleanupAfter).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}.` : phaseCopy(data.failoverPhase);
    renderOutage(data);
    const activeIncident = data.incidents.find((incident) => incident.id === data.activeIncidentId);
    document.getElementById("incident-kicker").textContent = activeIncident ? "CURRENT INCIDENT" : "LATEST UPDATE";
    document.getElementById("incident-title").textContent = activeIncident?.title || "Nothing needs your attention.";
    const acknowledged = document.getElementById("incident-acknowledged");
    acknowledged.hidden = !activeIncident?.acknowledgedAt;
    acknowledged.textContent = "✓ ACKNOWLEDGED BY THE SILO TEAM";
    document.getElementById("updated").textContent = `UPDATED ${new Date(data.updatedAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`;
    const activeNotes = (data.notes || []).filter((note) => note.incidentId === data.activeIncidentId).map((note) => ({ ...note, teamNote:true }));
    const timeline = [...(data.updates || []), ...activeNotes].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const updates = document.getElementById("updates"); updates.innerHTML = (timeline.length ? timeline : [{message:"All clear. Silo is operating normally."}]).map((item) => `<li class="${item.teamNote ? "team-note" : ""}">${item.teamNote ? "<b>TEAM NOTE</b>" : ""}${escapeHtml(item.message)}${item.teamNote && item.updatedAt !== item.createdAt ? " <small>(edited)</small>" : ""}</li>`).join("");
    const incidents = document.getElementById("incidents"); incidents.innerHTML = data.incidents.length ? data.incidents.map((i) => { const latestNote = (data.notes || []).find((note) => note.incidentId === i.id); return `<div class="incident"><div><span>${escapeHtml(i.title)} · ${escapeHtml(label(i.status))}</span>${latestNote ? `<small>${escapeHtml(latestNote.message)}</small>` : ""}</div><time>${new Date(i.startedAt).toLocaleDateString()}</time></div>`; }).join("") : "<p>No recent incidents.</p>";
    const uptime = data.uptime;
    document.getElementById("uptime").textContent = uptime?.samples ? `90-DAY UPTIME · S3 ${Number(uptime.s3).toFixed(3)}% · DASH ${Number(uptime.dashboard).toFixed(3)}%` : "90-DAY UPTIME · COLLECTING DATA";
    const maintenanceSection = document.getElementById("maintenance-section");
    maintenanceSection.hidden = !data.maintenance?.length;
    document.getElementById("maintenance").innerHTML = (data.maintenance || []).map((item) => `<div class="incident"><span>${escapeHtml(item.title)}</span><time>${new Date(item.startsAt).toLocaleString()}</time></div>`).join("");
    monitorLoading(false);
  } catch { document.getElementById("headline").textContent = "Status is temporarily unavailable."; document.getElementById("summary").textContent = "The status monitor could not be reached. Please try again shortly."; document.getElementById("updated").textContent = "MONITOR UNREACHABLE"; document.getElementById("monitor-light").className = "failed"; document.getElementById("orb").className = "orb failed"; }
}
refresh(); setInterval(refresh, 60_000);

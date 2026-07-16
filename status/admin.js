const API = "https://status-api.onsilo.dev";
const PASSWORD_KEY = "silo-incident-password";
const OPS_KEY = "silo-operations-secret";
let password = sessionStorage.getItem(PASSWORD_KEY) || "";
let opsSecret = sessionStorage.getItem(OPS_KEY) || "";
let data = { activeIncidentId:null, incidents:[], notes:[] };
let ops = null;
let maintenance = [];
let selectedIncidentId = null;
let toastTimer;

const login = document.getElementById("login");
const desk = document.getElementById("desk");
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]);

document.getElementById("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  password = new FormData(event.currentTarget).get("password").toString();
  document.getElementById("login-error").textContent = "";
  try { await load(); sessionStorage.setItem(PASSWORD_KEY, password); showDesk(); }
  catch (error) { document.getElementById("login-error").textContent = error.message === "unauthorized" ? "That password didn’t work." : error.message; }
});

document.getElementById("lock").addEventListener("click", lock);
document.getElementById("refresh").addEventListener("click", () => load().catch(showError));
document.getElementById("ops-login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  opsSecret = new FormData(event.currentTarget).get("password").toString();
  document.getElementById("ops-login-error").textContent = "";
  try { await loadOps(); sessionStorage.setItem(OPS_KEY, opsSecret); renderOps(); }
  catch (error) { lockOps(); document.getElementById("ops-login-error").textContent = error.message === "unauthorized" ? "That admin secret didn’t work." : error.message; }
});
document.getElementById("ops-lock").addEventListener("click", lockOps);
document.getElementById("maintenance-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const startsAt = new Date(form.get("startsAt").toString());
  const endsAt = new Date(form.get("endsAt").toString());
  const button = event.currentTarget.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await requestOps("/api/admin/maintenance", { method:"POST", body:JSON.stringify({ title:form.get("title"), message:form.get("message"), startsAt:startsAt.toISOString(), endsAt:endsAt.toISOString() }) });
    await loadOps();
    showToast("Maintenance window published. Silo service remains online.");
  } catch (error) {
    if (error.message === "unauthorized") lockOps();
    showError(error);
  } finally { button.disabled = false; }
});
document.getElementById("maintenance-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-maintenance-id]");
  if (!button || !confirm("End or remove this status maintenance window? This does not change Silo service settings.")) return;
  button.disabled = true;
  try {
    await requestOps(`/api/admin/maintenance/${encodeURIComponent(button.dataset.maintenanceId)}`, { method:"DELETE" });
    await loadOps();
    showToast("Maintenance window removed.");
  } catch (error) {
    if (error.message === "unauthorized") lockOps();
    showError(error);
  }
});
document.querySelector(".ops-actions").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-ops-action]");
  if (!button || button.disabled) return;
  if (!confirm(button.dataset.confirm)) return;
  await mutateOps(button.dataset.opsAction, button);
});
document.getElementById("note-message").addEventListener("input", (event) => { document.getElementById("note-count").textContent = `${event.target.value.length} / 2000`; });
document.getElementById("ack-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = document.getElementById("ack-message").value;
  await mutate(`/api/admin/incidents/${encodeURIComponent(selectedIncidentId)}/acknowledge`, { method:"POST", body:JSON.stringify({ message }) }, "Incident acknowledged.");
});
document.getElementById("note-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = document.getElementById("note-message");
  const published = await mutate(`/api/admin/incidents/${encodeURIComponent(selectedIncidentId)}/notes`, { method:"POST", body:JSON.stringify({ message:input.value }) }, "Public note published.");
  if (published) { input.value = ""; document.getElementById("note-count").textContent = "0 / 2000"; }
});

document.getElementById("incident-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-incident-id]");
  if (!button) return;
  selectedIncidentId = button.dataset.incidentId;
  render();
});

document.getElementById("notes-list").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  const card = button.closest(".note-card");
  const id = card.dataset.noteId;
  if (button.dataset.action === "edit") card.querySelector(".edit-form").hidden = false;
  if (button.dataset.action === "cancel") card.querySelector(".edit-form").hidden = true;
  if (button.dataset.action === "delete" && confirm("Delete this public note?")) await mutate(`/api/admin/notes/${encodeURIComponent(id)}`, { method:"DELETE" }, "Note deleted.");
});

document.getElementById("notes-list").addEventListener("submit", async (event) => {
  if (!event.target.matches(".edit-form")) return;
  event.preventDefault();
  const card = event.target.closest(".note-card");
  const message = new FormData(event.target).get("message").toString();
  await mutate(`/api/admin/notes/${encodeURIComponent(card.dataset.noteId)}`, { method:"PATCH", body:JSON.stringify({ message }) }, "Note updated.");
});

async function request(path, options = {}) {
  setSync(true);
  try {
    const response = await fetch(`${API}${path}`, { ...options, cache:"no-store", headers:{ authorization:`Bearer ${password}`, "content-type":"application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) { sessionStorage.removeItem(PASSWORD_KEY); throw new Error("unauthorized"); }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  } finally { setSync(false); }
}

async function requestOps(path, options = {}) {
  setSync(true);
  try {
    const response = await fetch(`${API}${path}`, { ...options, cache:"no-store", headers:{ authorization:`Bearer ${opsSecret}`, "content-type":"application/json", ...(options.headers || {}) } });
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) throw new Error("unauthorized");
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  } finally { setSync(false); }
}

async function loadOps() {
  const [state, windows] = await Promise.all([requestOps("/api/admin/operations"), requestOps("/api/admin/maintenance")]);
  ops = state;
  maintenance = windows.maintenance || [];
  renderOps();
}

async function mutateOps(action, button) {
  const original = button.firstChild.textContent;
  button.disabled = true;
  button.firstChild.textContent = "WORKING…";
  document.getElementById("ops-error").textContent = "";
  try {
    await requestOps(`/api/admin/${action}`, { method:"POST" });
    await Promise.all([loadOps(), load()]);
    showToast(`Manual action completed: ${original.trim()}.`);
  } catch (error) {
    if (error.message === "unauthorized") lockOps();
    document.getElementById("ops-error").textContent = error.message;
    showError(error);
  } finally {
    button.firstChild.textContent = original;
    renderOps();
  }
}

async function load() {
  data = await request("/api/admin/incidents");
  if (!selectedIncidentId || !data.incidents.some((incident) => incident.id === selectedIncidentId)) selectedIncidentId = data.activeIncidentId || data.incidents[0]?.id || null;
  render();
}

async function mutate(path, options, success) {
  try { await request(path, options); await load(); showToast(success); return true; }
  catch (error) { if (error.message === "unauthorized") lock(); else showError(error); return false; }
}

function showDesk() { login.hidden = true; desk.hidden = false; render(); if (opsSecret) loadOps().catch(lockOps); else renderOps(); }
function lock() { password = ""; sessionStorage.removeItem(PASSWORD_KEY); lockOps(); desk.hidden = true; login.hidden = false; document.getElementById("password").value = ""; document.getElementById("password").focus(); }
function lockOps() { opsSecret = ""; ops = null; maintenance = []; sessionStorage.removeItem(OPS_KEY); document.getElementById("ops-password").value = ""; renderOps(); }
function setSync(syncing) { const node = document.getElementById("sync-state"); node.innerHTML = syncing ? '<i class="spinner"></i>SYNCING' : "LIVE"; }

function renderOps() {
  const unlocked = Boolean(opsSecret && ops);
  document.getElementById("ops-login-form").hidden = unlocked;
  document.getElementById("ops-panel").hidden = !unlocked;
  const lockState = document.getElementById("ops-lock-state");
  lockState.textContent = unlocked ? "UNLOCKED / MANUAL" : "LOCKED / SAFE";
  lockState.className = `ops-lock-state${unlocked ? " live" : ""}`;
  if (!unlocked) { document.getElementById("maintenance-list").innerHTML = ""; return; }
  document.getElementById("ops-phase").textContent = ops.failoverPhase.replaceAll("_", " ").toUpperCase();
  document.getElementById("ops-step").textContent = ops.provisioningStep.replaceAll("_", " ").toUpperCase();
  const automated = ops.automation ? Object.values(ops.automation).filter(Boolean).length : 0;
  document.getElementById("ops-auto").textContent = ops.manualRecoveryLock ? "HELD BY OPERATOR" : automated === 4 ? "FULLY ENABLED" : automated ? "PARTIALLY ENABLED" : "MANUAL ONLY";
  const phase = ops.failoverPhase;
  for (const button of document.querySelectorAll("[data-ops-action]")) {
    const action = button.dataset.opsAction;
    button.disabled = action === "provision" ? ["provisioning","ready","active","recovering"].includes(phase)
      : action === "activate" ? phase !== "ready"
      : action === "force-failback" ? phase !== "active"
      : action === "disable-auto-recovery" ? !["active","recovering"].includes(phase) || ops.manualRecoveryLock
      : action === "destroy" ? !ops.emergencyAvailable
      : true;
  }
  renderMaintenance();
}

function renderMaintenance() {
  setMaintenanceDefaults();
  const production = ops.productionMaintenance ? `<div class="maintenance-row"><div><strong>${escapeHtml(ops.productionMaintenance.title)} · PRODUCTION CONTROL</strong><small>${escapeHtml(ops.productionMaintenance.message)}</small></div><time>ACTIVE SINCE ${formatDateTime(ops.productionMaintenance.startsAt)}</time><span class="eyebrow">SYNCED</span></div>` : "";
  const scheduled = maintenance.map((window) => `<div class="maintenance-row"><div><strong>${escapeHtml(window.title)}</strong><small>${escapeHtml(window.message)}</small></div><time>${formatDateTime(window.startsAt)} — ${formatDateTime(window.endsAt)}</time><button type="button" data-maintenance-id="${escapeHtml(window.id)}">END / REMOVE</button></div>`).join("");
  document.getElementById("maintenance-list").innerHTML = production || scheduled ? production + scheduled : '<p class="eyebrow">NO STATUS MAINTENANCE SCHEDULED</p>';
}

function setMaintenanceDefaults() {
  const start = document.getElementById("maintenance-start");
  const end = document.getElementById("maintenance-end");
  if (!start.value) start.value = localInputValue(new Date());
  if (!end.value) end.value = localInputValue(new Date(Date.now() + 60 * 60_000));
}

function localInputValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function render() {
  document.getElementById("incident-list").innerHTML = data.incidents.length ? data.incidents.map((incident) => `<button class="incident-option ${incident.id === selectedIncidentId ? "selected" : ""}" data-incident-id="${escapeHtml(incident.id)}"><strong>${escapeHtml(incident.title)}</strong><span><b class="${incident.status}">${escapeHtml(incident.status.toUpperCase())}</b><time>${formatDate(incident.startedAt)}</time></span></button>`).join("") : '<p class="eyebrow">NO INCIDENTS YET</p>';
  const incident = data.incidents.find((item) => item.id === selectedIncidentId);
  document.getElementById("empty-state").hidden = Boolean(incident);
  document.getElementById("incident-editor").hidden = !incident;
  if (!incident) return;
  document.getElementById("incident-status").textContent = `${incident.status.toUpperCase()} / ${incident.id.slice(0, 8)}`;
  document.getElementById("incident-name").textContent = incident.title;
  document.getElementById("incident-time").textContent = formatDateTime(incident.startedAt);
  const ackForm = document.getElementById("ack-form");
  const ackBlock = document.getElementById("acknowledged-block");
  ackForm.hidden = incident.status !== "open" || Boolean(incident.acknowledgedAt);
  ackBlock.hidden = !incident.acknowledgedAt;
  document.getElementById("acknowledgement-copy").textContent = incident.acknowledgementMessage || "The Silo team is investigating.";
  const notes = data.notes.filter((note) => note.incidentId === incident.id).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  document.getElementById("notes-count").textContent = `${notes.length} ${notes.length === 1 ? "NOTE" : "NOTES"}`;
  document.getElementById("notes-list").innerHTML = notes.length ? notes.map(noteHtml).join("") : '<div class="empty-state">No team notes for this incident.</div>';
}

function noteHtml(note) {
  const edited = note.updatedAt !== note.createdAt;
  return `<article class="note-card" data-note-id="${escapeHtml(note.id)}"><div class="note-meta"><span>TEAM NOTE${edited ? " · EDITED" : ""}</span><time>${formatDateTime(note.createdAt)}</time></div><p>${escapeHtml(note.message)}</p><div class="note-actions"><button type="button" data-action="edit">EDIT</button><button type="button" class="delete" data-action="delete">DELETE</button></div><form class="edit-form" hidden><textarea name="message" maxlength="2000" required>${escapeHtml(note.message)}</textarea><div><button type="button" data-action="cancel">CANCEL</button><button type="submit">SAVE CHANGE</button></div></form></article>`;
}

function formatDate(value) { return new Date(value).toLocaleDateString([], { month:"short", day:"numeric" }).toUpperCase(); }
function formatDateTime(value) { return new Date(value).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }).toUpperCase(); }
function showToast(message, error = false) { const toast = document.getElementById("toast"); toast.textContent = message; toast.className = `toast visible${error ? " error" : ""}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.className = "toast"; }, 2800); }
function showError(error) { showToast(error.message || "Something went wrong.", true); }

if (password) load().then(showDesk).catch(() => lock());

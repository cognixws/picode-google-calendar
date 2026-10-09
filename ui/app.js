// The extension's page: connection state and actions. Secrets, tokens and
// Google calls stay in the process; the page talks to it through the host
// bridge and opens the Google sign-in through the links door.
(async function () {
  const root = document.getElementById("root");
  const processDoor = await picode.use("process"), events = await picode.use("events"), links = await picode.use("links");
  let state = null, busy = "", error = "", confirmDisconnect = false, poll = 0;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const button = (label, action, cls = "") => `<button type="button" class="${cls}" data-action="${action}" ${busy ? "disabled" : ""}>${label}</button>`;
  const ago = (iso) => {
    if (!iso) return "not yet";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return new Date(iso).toLocaleString();
  };
  async function request(path, method = "GET") {
    if (!processDoor) throw new Error("The extension is off or its process is not running.");
    const r = await processDoor.request(path, { method, body: method === "POST" ? {} : undefined });
    let d; try { d = JSON.parse(r.body); } catch { throw new Error("The extension returned an unreadable answer."); }
    if (r.status >= 400) throw new Error(d.error || "That did not work.");
    return d;
  }
  async function load() {
    try { state = await request("/state"); error = ""; } catch (e) { error = e.message; }
    root.setAttribute("aria-busy", "false");
    render();
    clearTimeout(poll);
    if (state?.signingIn) poll = setTimeout(load, 3000); // the sign-in finishes in the browser
  }
  function body() {
    if (!state) return error ? `<div class="notice error" role="alert"><span>${esc(error)}</span>${button("Try again", "reload")}</div>` : "";
    if (!state.configured) return `<div class="notice"><span>Add your Google OAuth client (Desktop app) to connect.</span>${button("Open settings", "settings", "primary")}</div>`;
    // A finished connection wins over the "connecting" flag the click set.
    if (state.signingIn || (busy === "connect" && !state.connected)) return `<div class="notice is-busy" role="status"><span>Finish signing in to Google in your browser…</span>${button("Open the sign-in again", "connect")}</div>`;
    if (state.needsReconnect) return `<div class="notice warn" role="alert"><span>Google no longer accepts this connection.</span>${button("Connect again", "connect", "primary")}</div>`;
    if (!state.connected) return `<div class="notice"><span>Connect your Google account to sync your calendar.</span>${button("Connect Google account", "connect", "primary")}</div>`;
    const recentError = state.lastError && state.lastErrorAt && Date.now() - Date.parse(state.lastErrorAt) < 3600e3;
    return `<section class="panel" aria-label="Connection">
      <p class="ok">Connected${state.email ? " as " + esc(state.email) : ""}</p>
      <dl class="facts">
        <dt>Calendar</dt><dd>${esc(state.calendar === "primary" ? "Primary" : state.calendar)}</dd>
        <dt>From Google</dt><dd>${busy === "sync" ? "Syncing…" : esc(ago(state.lastPull))}</dd>
        <dt>To Google</dt><dd>${esc(ago(state.lastPush))}</dd>
        <dt>Synced events</dt><dd>${Number(state.synced || 0)}</dd>
      </dl>
      ${recentError ? `<div class="notice warn" role="status"><span>${esc(state.lastError)}</span></div>` : ""}
      <div class="row">${button(busy === "sync" ? "Syncing…" : "Sync now", "sync", "primary")}${confirmDisconnect ? `<span>Stop syncing? Events already here stay.</span>${button("Disconnect", "disconnect-yes", "danger")}${button("Cancel", "disconnect-no")}` : button("Disconnect", "disconnect")}</div>
      <p class="muted">Events you made in COGNIX[WS] before connecting stay here; new ones and changes go to Google.</p>
    </section>`;
  }
  function render() {
    root.innerHTML = `<header><h1>Google Calendar</h1><p class="muted">Your Agenda and your Google calendar, in step.</p></header>${body()}${error && state ? `<p class="notice error" role="alert">${esc(error)}</p>` : ""}`;
  }
  async function act(name) {
    error = "";
    try {
      if (name === "reload") return load();
      if (name === "settings") return links.open(new URL("/#/extensions/google-calendar", location.href).href);
      if (name === "disconnect") { confirmDisconnect = true; return render(); }
      if (name === "disconnect-no") { confirmDisconnect = false; return render(); }
      busy = name; render();
      // Opening the browser is fire-and-forget: the host may never answer
      // that call, and the sign-in finishes there anyway; /state polling
      // (signingIn) is what follows it.
      if (name === "connect") { const r = await request("/connect", "POST"); void Promise.resolve(links.open(r.url)).catch(() => {}); }
      else if (name === "sync") await request("/sync", "POST");
      else if (name === "disconnect-yes") { confirmDisconnect = false; await request("/disconnect", "POST"); }
    } catch (e) { error = e.message; }
    busy = "";
    await load();
  }
  root.addEventListener("click", (e) => { const b = e.target.closest("button[data-action]"); if (b) { e.preventDefault(); void act(b.dataset.action); } });
  if (events) events.onChange(() => void load());
  await load();
})().catch(() => { const root = document.getElementById("root"); root.setAttribute("aria-busy", "false"); root.textContent = "The extension could not start. Reopen its page from Extensions."; });

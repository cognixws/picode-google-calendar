// The extension's process: the page's relay (proxy secret), the Google
// sign-in on a loopback redirect, and the two sync loops.
import http from "node:http";
import https from "node:https";
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { Google, GoogleError, authRequest } from "./google.mjs";
import { Picode } from "./picode.mjs";
import { Store } from "./store.mjs";
import { Sync } from "./sync.mjs";

const env = process.env;
const base = new URL(env.PICODE_URL);
if (!["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw new Error("PiCode Host API must use loopback.");
const ME = "google-calendar";

// The Host API over loopback with PiCode's own certificate (never disable
// verification process-wide: Google uses the normal TLS verifier).
function hostRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(path, base);
    const client = target.protocol === "https:" ? https : http;
    const req = client.request(target, { method, rejectUnauthorized: false, headers: { "X-PiCode-Extension-Token": env.PICODE_EXT_TOKEN, "Content-Type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (b) => chunks.push(b));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString();
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { error: "unreadable answer" }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(60_000, () => req.destroy(new Error("Host API timeout")));
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const picode = new Picode(hostRequest);
const store = new Store(new DatabaseSync(env.PICODE_EXT_DB));
const log = (m) => console.error("[google-calendar]", m);

async function configuration() {
  const r = await picode.settings();
  return { id: r.values?.client_id || "", secret: r.secrets?.client_secret || "", calendar: (r.values?.calendar_id || "").trim() };
}

let sync = null;
async function engine() {
  const c = await configuration();
  if (!c.id || !c.secret) return null;
  const google = new Google({ client: { id: c.id, secret: c.secret }, tokens: store.tokens() });
  if (!sync || sync.google.client.id !== c.id || sync.google.client.secret !== c.secret || sync.calendarId !== c.calendar) {
    sync = new Sync({ store, google, picode, me: ME, calendarId: c.calendar, log });
  }
  return sync;
}

const announce = () => picode.publish("state", {}).catch(() => {});

// ---- Google sign-in on a loopback redirect ----
let pending = null; // { server, state, verifier, redirect, timer }
async function connect() {
  const s = await engine();
  if (!s) throw Object.assign(new Error("Add the OAuth client ID and secret in the extension's settings first."), { status: 409 });
  if (pending) closePending();
  const server = http.createServer();
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  const req = authRequest(s.google.client.id, redirect);
  pending = { server, state: req.state, verifier: req.verifier, redirect, timer: setTimeout(closePending, 10 * 60e3) };
  server.on("request", async (rq, rs) => {
    const u = new URL(rq.url, redirect);
    const page = (title, line) => { rs.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); rs.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:3rem;max-width:36rem"><h1 style="font-size:1.4rem">${title}</h1><p>${line}</p></body>`); };
    if (u.pathname !== "/callback") { rs.writeHead(404); rs.end(); return; }
    if (u.searchParams.get("state") !== pending?.state) { page("Sign-in expired", "Start again from COGNIX[WS] → Google Calendar."); return; }
    if (u.searchParams.get("error")) { page("Not connected", "Google did not grant access. You can close this tab."); closePending(); return; }
    try {
      const t = await s.google.exchange(u.searchParams.get("code"), pending.verifier, pending.redirect);
      store.saveAccount({ refresh: t.refresh, access: t.access, expiresAt: t.expiresAt, scope: t.scope });
      const info = await s.google.calendarInfo(s.calendarId || "primary").catch(() => ({}));
      store.saveAccount({ email: info.id || "", refresh: t.refresh, access: t.access, expiresAt: t.expiresAt, scope: t.scope });
      if (info.timeZone) store.set("calendar_tz", info.timeZone);
      store.clear("needs_reconnect");
      await s.seed();
      page("Connected to Google Calendar", "You can close this tab and go back to COGNIX[WS]. The first sync starts now.");
      closePending();
      announce();
      void pullNow();
    } catch (e) {
      page("Not connected", String(e.message || e));
      closePending();
    }
  });
  return { url: req.url };
}
function closePending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.server.close();
  pending = null;
}

// ---- the loops ----
let closing = false, pulling = null;
async function pullNow() {
  if (pulling) return pulling;
  pulling = (async () => {
    try { const s = await engine(); if (s?.connected()) await s.pull(); }
    catch (e) { sync?.fail("Sync from Google", e); if (e instanceof GoogleError && e.reason === "invalid-grant") store.set("needs_reconnect", "1"); }
    finally { pulling = null; announce(); }
  })();
  return pulling;
}
async function pushLoop() {
  while (!closing) {
    try {
      const s = await engine();
      if (!s?.connected()) { await sleep(5000); continue; }
      const r = await s.pushOnce(25);
      if (r.pushed) announce();
    } catch (e) {
      sync?.fail("Sync to Google", e);
      await sleep(10_000);
    }
  }
}
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const pullTimer = setInterval(() => void pullNow(), 60_000);

// ---- the page's relay ----
const equal = (a, b) => { const x = Buffer.from(a || ""), y = Buffer.from(b || ""); return x.length === y.length && timingSafeEqual(x, y); };
const server = http.createServer(async (req, res) => {
  const send = (status, value) => { res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(value)); };
  if (!equal(req.headers["x-picode-proxy-secret"], env.PICODE_EXT_PROXY_SECRET)) { send(403, { error: "Use the PiCode process relay." }); return; }
  const path = new URL(req.url, "http://localhost").pathname;
  try {
    if (req.method === "GET" && path === "/state") {
      const c = await configuration();
      const s = await engine();
      return send(200, { configured: !!(c.id && c.secret), signingIn: !!pending, needsReconnect: store.get("needs_reconnect") === "1", ...(s ? s.state() : { connected: false }) });
    }
    if (req.method === "POST" && path === "/connect") return send(200, await connect());
    if (req.method === "POST" && path === "/sync") { await pullNow(); return send(200, (await engine())?.state() || {}); }
    if (req.method === "POST" && path === "/disconnect") { closePending(); store.forgetAccount(); announce(); return send(200, { connected: false }); }
    send(404, { error: "This action is unavailable." });
  } catch (e) {
    send(e.status && e.status < 600 ? e.status : 500, { error: e.message || "The extension could not complete the request." });
  }
});
server.listen(Number(env.PICODE_EXT_PORT), "127.0.0.1", () => { void pullNow(); void pushLoop(); });

function shutdown() { closing = true; clearInterval(pullTimer); closePending(); server.close(); }
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

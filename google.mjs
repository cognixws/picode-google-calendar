// Google's OAuth (installed app: loopback redirect + PKCE) and the Calendar
// API calls the sync needs. fetch is injected so tests run without network.
import { createHash, randomBytes } from "node:crypto";

export const SCOPE = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/calendar/v3";

export class GoogleError extends Error {
  constructor(message, status = 502, reason = "") { super(message); this.status = status; this.reason = reason; }
}

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A sign-in attempt: the URL to open and what the redirect must carry back.
export function authRequest(clientId, redirectUri) {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const state = b64url(randomBytes(16));
  const url = new URL(AUTH);
  url.search = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
    code_challenge: challenge, code_challenge_method: "S256", access_type: "offline", prompt: "consent", state,
  }).toString();
  return { url: url.toString(), verifier, state };
}

export class Google {
  // client: { id, secret }; tokens: { get(), save({access, expiresAt, refresh?}) }
  constructor({ client, tokens, fetch = globalThis.fetch, now = () => Date.now() }) {
    this.client = client; this.tokens = tokens; this.fetch = fetch; this.now = now;
  }

  async exchange(code, verifier, redirectUri) {
    const r = await this.form(TOKEN, { code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: "authorization_code", client_id: this.client.id, client_secret: this.client.secret });
    if (!r.refresh_token) throw new GoogleError("Google did not return a refresh token. Remove COGNIX[WS] from your Google account's third-party access and connect again.", 400);
    return { refresh: r.refresh_token, access: r.access_token, expiresAt: this.now() + (r.expires_in || 3600) * 1000, scope: r.scope || "" };
  }

  async accessToken() {
    const t = this.tokens.get();
    if (!t) throw new GoogleError("Connect your Google account first.", 409, "not-connected");
    if (t.access && t.expiresAt > this.now() + 60_000) return t.access;
    const r = await this.form(TOKEN, { refresh_token: t.refresh, grant_type: "refresh_token", client_id: this.client.id, client_secret: this.client.secret });
    const next = { access: r.access_token, expiresAt: this.now() + (r.expires_in || 3600) * 1000 };
    this.tokens.save(next);
    return next.access;
  }

  async form(url, fields) {
    const res = await this.fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (body.error === "invalid_grant") throw new GoogleError("Google no longer accepts this connection (it was revoked or expired). Connect again.", 401, "invalid-grant");
      if (body.error === "invalid_client") throw new GoogleError("Google refused the OAuth client. Check the client ID and secret in the extension's settings.", 401, "invalid-client");
      throw new GoogleError(body.error_description || body.error || `Google answered ${res.status}.`, res.status);
    }
    return body;
  }

  async api(method, path, { query, body, retry = true } = {}) {
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const res = await this.fetch(url.toString(), { method, headers: { Authorization: "Bearer " + await this.accessToken(), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 && retry) {
      const t = this.tokens.get();
      if (t) this.tokens.save({ access: "", expiresAt: 0 });
      return this.api(method, path, { query, body, retry: false });
    }
    if (res.status === 204) return {};
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const reason = data.error?.errors?.[0]?.reason || "";
      throw new GoogleError(data.error?.message || `Google Calendar answered ${res.status}.`, res.status, reason);
    }
    return data;
  }

  calendar(id) { return "/calendars/" + encodeURIComponent(id || "primary"); }

  async calendarInfo(id) { return this.api("GET", this.calendar(id)); }

  // One page of changes: with a sync token, what changed since; without one,
  // every event (a full sync). 410 means the token expired: sync fully.
  async listEvents(id, { syncToken, pageToken } = {}) {
    return this.api("GET", this.calendar(id) + "/events", { query: { syncToken, pageToken, showDeleted: "true", singleEvents: "false", maxResults: 250 } });
  }

  async instances(id, eventId, timeMin, timeMax) {
    const out = [];
    let pageToken;
    do {
      const r = await this.api("GET", this.calendar(id) + "/events/" + encodeURIComponent(eventId) + "/instances", { query: { timeMin, timeMax, pageToken, maxResults: 250 } });
      out.push(...(r.items || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  }

  insert(id, body) { return this.api("POST", this.calendar(id) + "/events", { body }); }
  patch(id, eventId, body) { return this.api("PATCH", this.calendar(id) + "/events/" + encodeURIComponent(eventId), { body }); }
  async remove(id, eventId) {
    try { return await this.api("DELETE", this.calendar(id) + "/events/" + encodeURIComponent(eventId)); }
    catch (e) { if (e.status === 410 || e.status === 404) return {}; throw e; }
  }
}

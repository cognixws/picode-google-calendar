// In-memory stand-ins for Google Calendar and the COGNIX[WS] calendar door,
// with the behaviour the sync relies on.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { Store } from "../store.mjs";
import { PicodeError } from "../picode.mjs";

export function memoryStore() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/001_sync.sql", import.meta.url), "utf8"));
  const s = new Store(db);
  s.saveAccount({ email: "me@example.com", refresh: "r", access: "a", expiresAt: Date.now() + 3600e3 });
  return s;
}

// COGNIX[WS]: events by id, a feed of changes, the door's rules.
export class FakePicode {
  constructor(me) { this.me = me; this.events = new Map(); this.feed = []; this.n = 0; this.supported = (r) => !/BYSETPOS|HOURLY/.test(r || ""); }
  emit(change) { this.feed.push({ seq: ++this.n, change }); }
  async list() { return { events: [...this.events.values()], cursor: this.n }; }
  async changes(since) { const out = this.feed.filter((f) => f.seq > since); return { changes: out.map((f) => f.change), cursor: this.n }; }
  write(e, via) { e.viaExtension = via; this.events.set(e.id, e); this.emit({ ...e }); return { ...e }; }
  // The owner's own actions, as the Agenda does them.
  ownerCreate(input) { const e = { id: "p" + (++this.n), status: "active", origin: "", externalId: "", ...input }; return this.write(e, ""); }
  ownerUpdate(id, patch) { return this.write({ ...this.events.get(id), ...patch }, ""); }
  ownerDelete(id) { const e = this.events.get(id); this.events.delete(id); this.emit({ id, deleted: true, origin: e.origin, externalId: e.externalId, viaExtension: "" }); }
  async upsert(b) {
    if (b.rrule && !this.supported(b.rrule)) throw new PicodeError("repeat is not offered", 400);
    const cur = [...this.events.values()].find((e) => e.origin === this.me && e.externalId === b.externalId);
    const { externalEtag, readOnly, ...input } = b;
    const e = cur ? { ...cur, ...input, readOnly: !!readOnly } : { id: "p" + (++this.n), status: "active", origin: this.me, ...input, readOnly: !!readOnly };
    return this.write(e, this.me);
  }
  async update(id, b, { scope = "", at = "" } = {}) {
    const cur = this.events.get(id);
    if (!cur) throw new PicodeError("not found", 404);
    if (scope === "this") {
      const ov = { id: "p" + (++this.n), status: "active", origin: cur.origin, externalId: b.externalId || "", seriesId: id, recurrenceId: at, title: b.title, start: b.start, end: b.end, tz: b.tz, allDay: b.allDay };
      return this.write(ov, this.me);
    }
    const next = { ...cur, ...b };
    if (b.externalId && (cur.origin === "" || (cur.origin === this.me && !cur.externalId))) { next.origin = this.me; next.externalId = b.externalId; }
    else next.externalId = cur.externalId;
    delete next.externalEtag;
    return this.write(next, this.me);
  }
  async remove(id, { scope = "", at = "" } = {}) {
    const cur = this.events.get(id);
    if (!cur) throw new PicodeError("not found", 404);
    if (scope === "this") { cur.exdates = [...(cur.exdates || []), at]; return this.write(cur, this.me); }
    this.events.delete(id);
    this.emit({ id, deleted: true, origin: cur.origin, externalId: cur.externalId, viaExtension: this.me });
    return {};
  }
}

// Google: events by id, a change log the sync token indexes.
export class FakeGoogle {
  constructor() { this.events = new Map(); this.log = []; this.n = 0; this.calls = []; }
  put(e) { const v = { ...e, etag: '"' + (++this.n) + '"', updated: new Date(1e12 + this.n).toISOString() }; this.events.set(e.id, v); this.log.push(v); return v; }
  async listEvents(_cal, { syncToken } = {}) {
    const since = Number(syncToken || 0);
    const items = syncToken ? this.log.slice(since) : [...this.events.values()];
    return { items, nextSyncToken: String(this.log.length), timeZone: "UTC" };
  }
  async instances(_cal, id) { return this.instanceList?.[id] || []; }
  async insert(_cal, body) { this.calls.push(["insert", body]); return this.put({ id: "g" + (this.n + 1), status: "confirmed", ...body }); }
  async patch(_cal, id, body) { this.calls.push(["patch", id, body]); return this.put({ ...(this.events.get(id) || { id }), ...body, status: "confirmed" }); }
  async remove(_cal, id) { this.calls.push(["remove", id]); const e = this.events.get(id); if (e) this.put({ ...e, status: "cancelled" }); return {}; }
}

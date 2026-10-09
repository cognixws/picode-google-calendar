// Two-way sync between one Google calendar and the COGNIX[WS] Agenda
// (ADR-0230/0276 amendments, 2026-10-09).
//   Google → COGNIX[WS]: events.list with a sync token (only what changed),
//     written through the calendar door by Google's id; an exception of a
//     series becomes a changed occurrence; a rule COGNIX[WS] cannot expand
//     comes in as read-only instances.
//   COGNIX[WS] → Google: the door's change feed; the owner's new events are
//     inserted at Google and claimed (their Google id recorded); changes to
//     synced ones are patched; a changed occurrence patches Google's
//     instance; deletes delete.
// Writes this extension made come back on the feed marked viaExtension and
// are skipped, so nothing loops. On the first connection the cursor starts
// at "now": events made in COGNIX[WS] before connecting stay local.
import { instanceId, occurrenceKey, toGoogle, toPicode } from "./convert.mjs";
import { PicodeError } from "./picode.mjs";

const DAY = 24 * 3600e3;
// A full sync brings past one-off events back this far, not further.
export const PAST_WINDOW = 30 * DAY;
// Read-only instances of a rule COGNIX[WS] cannot expand cover this window.
export const READONLY_AHEAD = 180 * DAY;

const inputOf = (e) => ({ title: e.title, notes: e.notes || "", allDay: !!e.allDay, start: e.start, end: e.end, tz: e.tz || "", rrule: e.rrule || "" });

export class Sync {
  constructor({ store, google, picode, me, calendarId = "", now = () => Date.now(), log = () => {} }) {
    Object.assign(this, { store, google, picode, me, calendarId, now, log });
  }

  connected() { return !!this.store.account(); }

  // Start following COGNIX[WS] from now (first connection, or after a reset).
  async seed() {
    const r = await this.picode.list();
    this.store.set("cursor", r.cursor ?? 0);
  }

  // ---- Google → COGNIX[WS] ----

  async pull() {
    if (!this.connected()) return { pulled: 0 };
    const calendar = this.calendarId || "primary";
    let syncToken = this.store.get("google_sync_token");
    const full = !syncToken;
    let pageToken, pulled = 0, tz = this.store.get("calendar_tz") || "UTC";
    for (;;) {
      let page;
      try { page = await this.google.listEvents(calendar, { syncToken: syncToken || undefined, pageToken }); }
      catch (e) {
        if (e.status === 410 && syncToken) { this.store.clear("google_sync_token"); syncToken = ""; pageToken = undefined; continue; }
        throw e;
      }
      if (page.timeZone) { tz = page.timeZone; this.store.set("calendar_tz", tz); }
      for (const item of page.items || []) {
        try { if (await this.applyGoogle(item, tz, full)) pulled++; }
        catch (e) { this.fail(`"${item.summary || item.id}" from Google`, e); }
      }
      pageToken = page.nextPageToken;
      if (!pageToken) {
        if (page.nextSyncToken) this.store.set("google_sync_token", page.nextSyncToken);
        break;
      }
    }
    this.store.set("last_pull", new Date(this.now()).toISOString());
    return { pulled };
  }

  async applyGoogle(item, tz, full) {
    const link = this.store.link(item.id);
    if (link && link.etag && link.etag === item.etag) return false;
    if (item.recurringEventId) return this.applyException(item, tz);
    if (item.status === "cancelled") {
      if (!link) return false;
      await this.removeLinked(link);
      return true;
    }
    if (full && !link && !item.recurrence && this.ended(item)) return false;
    const input = toPicode(item, tz);
    try {
      const e = await this.picode.upsert({ ...input, externalId: item.id, externalEtag: item.etag || "" });
      // A rule that used to be read-only and now fits: its instances go.
      for (const old of this.store.linksOfMaster(item.id)) if (old.kind === "readonly") await this.dropReadonly(old);
      this.store.putLink({ googleId: item.id, picodeId: e.id, kind: "event", etag: item.etag, updated: item.updated });
      return true;
    } catch (e) {
      if (!(e instanceof PicodeError) || e.status !== 400 || !input.rrule) throw e;
      return this.importReadonly(item, tz);
    }
  }

  ended(item) {
    const end = item.end?.dateTime || (item.end?.date ? item.end.date + "T00:00:00Z" : "");
    return end && Date.parse(end) < this.now() - PAST_WINDOW;
  }

  // A series whose rule COGNIX[WS] cannot expand: its instances, read-only.
  async importReadonly(item, tz) {
    const calendar = this.calendarId || "primary";
    const from = new Date(this.now() - PAST_WINDOW).toISOString(), to = new Date(this.now() + READONLY_AHEAD).toISOString();
    const keep = new Set();
    for (const inst of await this.google.instances(calendar, item.id, from, to)) {
      if (inst.status === "cancelled") continue;
      const key = item.id + "@" + occurrenceKey(inst.originalStartTime || inst.start, tz);
      const { rrule, ...input } = toPicode({ ...inst, recurrence: undefined }, tz);
      const e = await this.picode.upsert({ ...input, externalId: key, externalEtag: inst.etag || "", readOnly: true });
      this.store.putLink({ googleId: key, picodeId: e.id, kind: "readonly", master: item.id, etag: inst.etag, updated: inst.updated });
      keep.add(key);
    }
    for (const old of this.store.linksOfMaster(item.id)) if (old.kind === "readonly" && !keep.has(old.google_id)) await this.dropReadonly(old);
    // Remember the master's version so an unchanged one is not refetched.
    this.store.putLink({ googleId: item.id, picodeId: "", kind: "readonly", etag: item.etag, updated: item.updated });
    return true;
  }

  async dropReadonly(link) {
    if (link.picode_id) await this.picode.remove(link.picode_id).catch((e) => { if (e.status !== 404) throw e; });
    this.store.dropLink(link.google_id);
  }

  async removeLinked(link) {
    if (link.kind === "readonly") {
      for (const inst of this.store.linksOfMaster(link.google_id)) await this.dropReadonly(inst);
      this.store.dropLink(link.google_id);
      return;
    }
    const scope = link.kind === "event" ? "all" : "";
    await this.picode.remove(link.picode_id, scope ? { scope } : {}).catch(async (e) => {
      // A one-off refuses a scope; try without, and a gone row is fine.
      if (e.status === 400 && scope) return this.picode.remove(link.picode_id).catch((x) => { if (x.status !== 404) throw x; });
      if (e.status !== 404) throw e;
    });
    this.store.dropLink(link.google_id);
  }

  // A changed or cancelled occurrence of a Google series.
  async applyException(item, tz) {
    const master = this.store.link(item.recurringEventId);
    if (!master) return false;
    if (master.kind === "readonly") return this.importReadonly({ id: master.google_id, etag: master.etag, updated: master.google_updated }, tz);
    const at = occurrenceKey(item.originalStartTime, tz);
    if (item.status === "cancelled") {
      await this.picode.remove(master.picode_id, { scope: "this", at }).catch((e) => { if (![400, 404].includes(e.status)) throw e; });
      this.store.dropLink(item.id);
      return true;
    }
    const { rrule, ...input } = toPicode({ ...item, recurrence: undefined }, tz);
    const e = await this.picode.update(master.picode_id, { ...input, externalId: item.id, externalEtag: item.etag || "" }, { scope: "this", at });
    this.store.putLink({ googleId: item.id, picodeId: e.id, kind: "override", master: master.google_id, etag: item.etag, updated: item.updated });
    return true;
  }

  // ---- COGNIX[WS] → Google ----

  // One round of the door's change feed (waits up to wait seconds).
  async pushOnce(wait = 25) {
    if (!this.connected()) return { pushed: 0 };
    const since = Number(this.store.get("cursor") || 0);
    const r = await this.picode.changes(since, wait);
    let pushed = 0;
    for (const c of r.changes || []) {
      try { if (await this.applyPicode(c)) pushed++; }
      catch (e) { this.fail(`"${c.title || c.id}" to Google`, e); }
    }
    this.store.set("cursor", r.cursor ?? since);
    if (pushed) this.store.set("last_push", new Date(this.now()).toISOString());
    return { pushed, reset: !!r.reset };
  }

  async applyPicode(c) {
    if (c.viaExtension === this.me) return false; // our own write, back on the feed
    const calendar = this.calendarId || "primary";
    if (c.deleted) {
      if (c.origin !== this.me || !c.externalId || c.externalId.includes("@")) return false;
      await this.google.remove(calendar, c.externalId);
      this.store.dropLink(c.externalId);
      return true;
    }
    if (c.readOnly || (c.origin && c.origin !== this.me) || (c.status && c.status !== "active")) return false;
    if (c.seriesId) return this.pushOccurrence(c, calendar);
    if (!c.origin || !c.externalId) {
      const g = await this.google.insert(calendar, toGoogle(c));
      await this.picode.update(c.id, { ...inputOf(c), externalId: g.id, externalEtag: g.etag || "" }, c.rrule ? { scope: "all" } : {});
      this.store.putLink({ googleId: g.id, picodeId: c.id, kind: "event", etag: g.etag, updated: g.updated });
      return true;
    }
    const g = await this.google.patch(calendar, c.externalId, toGoogle(c));
    this.store.putLink({ googleId: c.externalId, picodeId: c.id, kind: "event", etag: g.etag, updated: g.updated });
    return true;
  }

  // An occurrence changed here: Google's instance of the master is patched.
  async pushOccurrence(c, calendar) {
    const master = this.store.linkByPicode(c.seriesId);
    if (!master || master.kind !== "event") return false;
    const id = c.externalId || instanceId(master.google_id, c.recurrenceId, c.tz, c.allDay);
    const { recurrence, ...body } = toGoogle({ ...c, rrule: undefined });
    const g = await this.google.patch(calendar, id, body);
    if (!c.externalId) await this.picode.update(c.id, { ...inputOf(c), rrule: "", externalId: id, externalEtag: g.etag || "" });
    this.store.putLink({ googleId: id, picodeId: c.id, kind: "override", master: master.google_id, etag: g.etag, updated: g.updated });
    return true;
  }

  fail(what, e) {
    const msg = `${what}: ${e.message || e}`;
    this.store.set("last_error", msg);
    this.store.set("last_error_at", new Date(this.now()).toISOString());
    this.log(msg);
  }

  state() {
    const a = this.store.account();
    return {
      connected: !!a, email: a?.email || "", connectedAt: a?.connected_at || "",
      calendar: this.calendarId || "primary",
      lastPull: this.store.get("last_pull"), lastPush: this.store.get("last_push"),
      lastError: this.store.get("last_error"), lastErrorAt: this.store.get("last_error_at"),
      synced: this.store.linkCount(),
    };
  }
}

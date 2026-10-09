import { test } from "node:test";
import assert from "node:assert/strict";
import { Sync } from "../sync.mjs";
import { FakeGoogle, FakePicode, memoryStore } from "./fakes.mjs";

const ME = "google-calendar";
const NOW = Date.parse("2026-10-09T12:00:00Z");
function rig() {
  const google = new FakeGoogle(), picode = new FakePicode(ME), store = memoryStore();
  const sync = new Sync({ store, google, picode, me: ME, now: () => NOW });
  return { google, picode, store, sync };
}
const timed = (id, summary, start, end, extra = {}) => ({ id, status: "confirmed", summary, start: { dateTime: start + ":00Z" }, end: { dateTime: end + ":00Z" }, ...extra });

test("Google → COGNIX: created once, updated in place, deleted", async () => {
  const { google, picode, sync } = rig();
  await sync.seed();
  google.put(timed("g1", "Dentist", "2026-10-12T14:00", "2026-10-12T15:00"));
  await sync.pull();
  let mine = [...picode.events.values()];
  assert.equal(mine.length, 1);
  assert.equal(mine[0].externalId, "g1");
  assert.equal(mine[0].start, "2026-10-12T14:00");
  google.put(timed("g1", "Dentist (moved)", "2026-10-12T16:00", "2026-10-12T17:00"));
  await sync.pull();
  mine = [...picode.events.values()];
  assert.equal(mine.length, 1);
  assert.equal(mine[0].title, "Dentist (moved)");
  google.put({ ...google.events.get("g1"), status: "cancelled" });
  await sync.pull();
  assert.equal(picode.events.size, 0);
});

test("an unchanged Google event is not written again", async () => {
  const { google, picode, sync } = rig();
  google.put(timed("g1", "Call", "2026-10-12T14:00", "2026-10-12T15:00"));
  await sync.pull();
  const writes = picode.feed.length;
  await sync.pull(); // full list again would include it; the etag stops it
  assert.equal(picode.feed.length, writes);
});

test("a full sync skips old one-off events", async () => {
  const { google, picode, sync } = rig();
  google.put(timed("old", "Long ago", "2026-07-01T14:00", "2026-07-01T15:00"));
  google.put(timed("new", "Soon", "2026-10-20T14:00", "2026-10-20T15:00"));
  await sync.pull();
  assert.deepEqual([...picode.events.values()].map((e) => e.externalId), ["new"]);
});

test("a rule COGNIX cannot expand comes in read-only", async () => {
  const { google, picode, sync } = rig();
  google.instanceList = { s1: [timed("s1_a", "Odd", "2026-10-10T09:00", "2026-10-10T10:00", { originalStartTime: { dateTime: "2026-10-10T09:00:00Z" } }), timed("s1_b", "Odd", "2026-11-14T09:00", "2026-11-14T10:00", { originalStartTime: { dateTime: "2026-11-14T09:00:00Z" } })] };
  google.put(timed("s1", "Odd", "2026-10-10T09:00", "2026-10-10T10:00", { recurrence: ["RRULE:FREQ=MONTHLY;BYDAY=SA;BYSETPOS=2"] }));
  await sync.pull();
  const rows = [...picode.events.values()];
  assert.equal(rows.length, 2);
  assert.ok(rows.every((e) => e.readOnly && e.externalId.startsWith("s1@")));
});

test("a changed and a cancelled occurrence of a Google series", async () => {
  const { google, picode, sync } = rig();
  google.put(timed("s", "Standup", "2026-10-12T09:00", "2026-10-12T09:15", { recurrence: ["RRULE:FREQ=DAILY"] }));
  await sync.pull();
  const series = [...picode.events.values()][0];
  google.put(timed("s_20261013T090000Z", "Standup (late)", "2026-10-13T10:00", "2026-10-13T10:15", { recurringEventId: "s", originalStartTime: { dateTime: "2026-10-13T09:00:00Z" } }));
  google.put({ id: "s_20261014T090000Z", status: "cancelled", recurringEventId: "s", originalStartTime: { dateTime: "2026-10-14T09:00:00Z" } });
  await sync.pull();
  const ov = [...picode.events.values()].find((e) => e.seriesId === series.id);
  assert.equal(ov.title, "Standup (late)");
  assert.equal(ov.recurrenceId, "2026-10-13T09:00");
  assert.deepEqual(picode.events.get(series.id).exdates, ["2026-10-14T09:00"]);
});

test("COGNIX → Google: the owner's new event is inserted and claimed; changes patch; deletes delete", async () => {
  const { google, picode, store, sync } = rig();
  await sync.seed();
  const mine = picode.ownerCreate({ title: "Review", allDay: false, start: "2026-10-12T14:00", end: "2026-10-12T15:00", tz: "UTC" });
  await sync.pushOnce(0);
  assert.equal(google.calls[0][0], "insert");
  const claimed = picode.events.get(mine.id);
  assert.equal(claimed.origin, ME);
  assert.ok(claimed.externalId);
  // Our own claim comes back on the feed and is skipped.
  const before = google.calls.length;
  await sync.pushOnce(0);
  assert.equal(google.calls.length, before);
  picode.ownerUpdate(mine.id, { title: "Review PR 412" });
  await sync.pushOnce(0);
  assert.equal(google.calls.at(-1)[0], "patch");
  assert.equal(google.calls.at(-1)[2].summary, "Review PR 412");
  picode.ownerDelete(mine.id);
  await sync.pushOnce(0);
  assert.deepEqual(google.calls.at(-1), ["remove", claimed.externalId]);
  assert.equal(store.link(claimed.externalId), null);
});

test("an occurrence changed in COGNIX patches Google's instance", async () => {
  const { google, picode, sync } = rig();
  google.put(timed("s", "Standup", "2026-10-12T09:00", "2026-10-12T09:15", { recurrence: ["RRULE:FREQ=DAILY"] }));
  await sync.pull();
  await sync.seed();
  const series = [...picode.events.values()][0];
  const ov = picode.write({ id: "pov", status: "active", origin: ME, externalId: "", seriesId: series.id, recurrenceId: "2026-10-13T09:00", title: "Standup (late)", allDay: false, start: "2026-10-13T10:00", end: "2026-10-13T10:15", tz: "UTC" }, "");
  await sync.pushOnce(0);
  assert.deepEqual(google.calls.at(-1).slice(0, 2), ["patch", "s_20261013T090000Z"]);
  assert.equal(picode.events.get(ov.id).externalId, "s_20261013T090000Z");
});

test("another extension's events and read-only rows are left alone", async () => {
  const { google, picode, sync } = rig();
  await sync.seed();
  picode.write({ id: "o1", status: "active", origin: "outlook", externalId: "x", title: "Theirs", allDay: false, start: "2026-10-12T14:00", end: "2026-10-12T15:00", tz: "UTC" }, "");
  picode.write({ id: "r1", status: "active", origin: ME, externalId: "s1@2026-10-10T09:00", readOnly: true, title: "Odd", allDay: false, start: "2026-10-10T09:00", end: "2026-10-10T10:00", tz: "UTC" }, "");
  await sync.pushOnce(0);
  assert.equal(google.calls.length, 0);
});

test("state says what the page shows", async () => {
  const { sync } = rig();
  const s = sync.state();
  assert.equal(s.connected, true);
  assert.equal(s.email, "me@example.com");
  assert.equal(s.calendar, "primary");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { instanceId, occurrenceKey, ruleFrom, toGoogle, toPicode, utcOf, wallIn } from "../convert.mjs";

test("a timed Google event keeps its wall clock and zone", () => {
  const p = toPicode({ summary: "Call", description: "Deck", start: { dateTime: "2026-10-09T15:00:00-03:00", timeZone: "America/Sao_Paulo" }, end: { dateTime: "2026-10-09T16:00:00-03:00", timeZone: "America/Sao_Paulo" } });
  assert.deepEqual(p, { title: "Call", notes: "Deck", allDay: false, tz: "America/Sao_Paulo", start: "2026-10-09T15:00", end: "2026-10-09T16:00" });
});

test("an event without its own zone takes the calendar's", () => {
  const p = toPicode({ summary: "x", start: { dateTime: "2026-10-09T18:00:00Z" }, end: { dateTime: "2026-10-09T19:00:00Z" } }, "America/Sao_Paulo");
  assert.equal(p.start, "2026-10-09T15:00");
  assert.equal(p.tz, "America/Sao_Paulo");
});

test("all-day events keep dates, end exclusive; empty titles get one", () => {
  const p = toPicode({ start: { date: "2026-10-12" }, end: { date: "2026-10-13" } });
  assert.deepEqual(p, { title: "(No title)", notes: "", allDay: true, start: "2026-10-12", end: "2026-10-13" });
});

test("a zero-length event gets fifteen minutes", () => {
  const p = toPicode({ summary: "Ping", start: { dateTime: "2026-10-09T15:00:00Z" }, end: { dateTime: "2026-10-09T15:00:00Z" } }, "UTC");
  assert.equal(p.end, "2026-10-09T15:15");
});

test("Google rules are cleaned for the subset", () => {
  assert.equal(ruleFrom(["RRULE:FREQ=WEEKLY;BYDAY=MO;WKST=SU"]), "FREQ=WEEKLY;BYDAY=MO");
  assert.equal(ruleFrom(["RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU"]), "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO;WKST=SU");
  assert.equal(ruleFrom(["EXDATE;TZID=UTC:20261012T090000", "RRULE:FREQ=DAILY;COUNT=5"]), "FREQ=DAILY;COUNT=5");
  assert.equal(ruleFrom([]), "");
});

test("COGNIX events become Google bodies, with exceptions", () => {
  assert.deepEqual(toGoogle({ title: "Standup", notes: "", allDay: false, start: "2026-10-05T09:00", end: "2026-10-05T09:15", tz: "America/Sao_Paulo", rrule: "FREQ=DAILY", exdates: ["2026-10-07T09:00"] }), {
    summary: "Standup", description: "",
    start: { dateTime: "2026-10-05T09:00:00", timeZone: "America/Sao_Paulo" }, end: { dateTime: "2026-10-05T09:15:00", timeZone: "America/Sao_Paulo" },
    recurrence: ["RRULE:FREQ=DAILY", "EXDATE;TZID=America/Sao_Paulo:20261007T090000"],
  });
  const day = toGoogle({ title: "Trip", allDay: true, start: "2026-10-12", end: "2026-10-14", rrule: "FREQ=YEARLY", exdates: ["2027-10-12"] });
  assert.deepEqual(day.start, { date: "2026-10-12" });
  assert.deepEqual(day.recurrence, ["RRULE:FREQ=YEARLY", "EXDATE;VALUE=DATE:20271012"]);
});

test("occurrence keys and Google instance ids", () => {
  assert.equal(occurrenceKey({ dateTime: "2026-10-07T12:00:00Z", timeZone: "America/Sao_Paulo" }), "2026-10-07T09:00");
  assert.equal(occurrenceKey({ date: "2026-10-12" }), "2026-10-12");
  assert.equal(utcOf("2026-10-07T09:00", "America/Sao_Paulo"), "2026-10-07T12:00:00");
  assert.equal(instanceId("abc", "2026-10-07T09:00", "America/Sao_Paulo", false), "abc_20261007T120000Z");
  assert.equal(instanceId("abc", "2026-10-12", "", true), "abc_20261012");
  assert.equal(wallIn("2027-03-14T07:30:00Z", "America/New_York"), "2027-03-14T03:30");
});

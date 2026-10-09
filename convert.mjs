// Google Calendar events ↔ COGNIX[WS] calendar events. Pure: no network,
// no database. COGNIX[WS] keeps a timed event's wall clock and IANA zone
// ("2026-10-09T15:00" in America/Sao_Paulo) and an all-day event's dates
// (end exclusive), the same shape Google's start.date/end.date has.

const pad = (n) => String(n).padStart(2, "0");

// The wall clock of an instant in a zone, "YYYY-MM-DDTHH:MM".
export function wallIn(iso, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-CA", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

// The RRULE line of a Google recurrence, cleaned for COGNIX[WS]'s subset:
// WKST only matters to weekly rules with an interval, and Google writes
// WKST=SU on many rules that do not need it.
export function ruleFrom(recurrence) {
  const line = (recurrence || []).find((l) => /^RRULE:/i.test(l));
  if (!line) return "";
  const parts = line.replace(/^RRULE:/i, "").split(";").filter(Boolean);
  const freq = (parts.find((p) => /^FREQ=/i.test(p)) || "").toUpperCase();
  const interval = Number((parts.find((p) => /^INTERVAL=/i.test(p)) || "INTERVAL=1").split("=")[1]);
  const keepWkst = freq === "FREQ=WEEKLY" && interval > 1;
  return parts.filter((p) => keepWkst || !/^WKST=/i.test(p)).join(";");
}

// A Google event → the COGNIX[WS] input the calendar door takes.
// calendarTz is the calendar's zone, used when the event names none.
export function toPicode(g, calendarTz = "UTC") {
  const input = { title: (g.summary || "").trim() || "(No title)", notes: (g.description || "").slice(0, 4000) };
  if (g.start?.date) {
    input.allDay = true;
    input.start = g.start.date;
    input.end = g.end?.date || g.start.date;
  } else {
    const tz = g.start?.timeZone || calendarTz || "UTC";
    input.allDay = false;
    input.tz = tz;
    input.start = wallIn(g.start.dateTime, tz);
    input.end = wallIn(g.end?.dateTime || g.start.dateTime, tz);
  }
  if (input.end <= input.start && !input.allDay) {
    // Google allows a zero-length event; COGNIX[WS] needs an end after the start.
    const d = new Date(new Date(g.start.dateTime).getTime() + 15 * 60e3).toISOString();
    input.end = wallIn(d, input.tz);
  }
  if (input.allDay && input.end <= input.start) {
    const d = new Date(input.start + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1);
    input.end = d.toISOString().slice(0, 10);
  }
  const rule = ruleFrom(g.recurrence);
  if (rule) input.rrule = rule;
  return input;
}

// The key COGNIX[WS] gives an occurrence (its original start): wall clock in
// the series' zone, or the date.
export function occurrenceKey(original, seriesTz) {
  if (original?.date) return original.date;
  return wallIn(original.dateTime, original.timeZone || seriesTz || "UTC");
}

const basic = (s) => s.replace(/[-:]/g, "");

// A COGNIX[WS] event → the Google event body (insert or patch).
export function toGoogle(e) {
  const body = { summary: e.title || "", description: e.notes || "" };
  if (e.allDay) {
    body.start = { date: e.start };
    body.end = { date: e.end };
  } else {
    body.start = { dateTime: e.start + ":00", timeZone: e.tz || "UTC" };
    body.end = { dateTime: e.end + ":00", timeZone: e.tz || "UTC" };
  }
  if (e.rrule) {
    const lines = ["RRULE:" + e.rrule];
    for (const x of e.exdates || []) {
      lines.push(e.allDay ? "EXDATE;VALUE=DATE:" + basic(x) : `EXDATE;TZID=${e.tz || "UTC"}:${basic(x)}00`);
    }
    body.recurrence = lines;
  } else if (e.rrule === "") {
    body.recurrence = [];
  }
  return body;
}

// Google's id for one instance of a recurring event: the master's id and
// the original start in UTC (timed) or the date (all day).
export function instanceId(masterId, recurrenceKey, tz, allDay) {
  if (allDay) return `${masterId}_${basic(recurrenceKey)}`;
  return `${masterId}_${basic(utcOf(recurrenceKey, tz)).slice(0, 15)}Z`;
}

// The UTC instant of a wall clock in a zone, "YYYY-MM-DDTHH:MM:SS".
export function utcOf(wall, tz) {
  // Guess, then correct by the zone's offset at that instant (twice covers DST edges).
  let t = Date.parse(wall + ":00Z");
  for (let i = 0; i < 2; i++) {
    const seen = Date.parse(wallIn(new Date(t).toISOString(), tz) + ":00Z");
    t -= seen - Date.parse(wall + ":00Z");
  }
  return new Date(t).toISOString().slice(0, 19);
}

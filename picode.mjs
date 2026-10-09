// The COGNIX[WS] side: the calendar door of the Host API (ADR-0230
// amendment, 2026-10-09). request is injected so tests run without a daemon.
export class PicodeError extends Error {
  constructor(message, status = 500) { super(message); this.status = status; }
}

export class Picode {
  constructor(request) { this.request = request; }
  async call(method, path, body) {
    const r = await this.request(method, "/api/ext/v1" + path, body);
    if (r.status >= 400) throw new PicodeError(r.body?.error || `COGNIX[WS] answered ${r.status}.`, r.status);
    return r.body;
  }
  settings() { return this.call("GET", "/settings"); }
  list() { return this.call("GET", "/calendar/events"); }
  changes(since, wait = 25) { return this.call("GET", `/calendar/changes?since=${since}&wait=${wait}`); }
  upsert(input) { return this.call("POST", "/calendar/events", input); }
  update(id, input, { scope = "", at = "" } = {}) {
    const q = scope ? `?scope=${scope}&at=${encodeURIComponent(at)}` : "";
    return this.call("PATCH", "/calendar/events/" + encodeURIComponent(id) + q, input);
  }
  remove(id, { scope = "", at = "" } = {}) {
    const q = scope ? `?scope=${scope}&at=${encodeURIComponent(at)}` : "";
    return this.call("DELETE", "/calendar/events/" + encodeURIComponent(id) + q);
  }
  publish(name, data) { return this.call("POST", "/events", { name, data }); }
}

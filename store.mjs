// The extension's own database (node:sqlite): the account, the links
// between Google and COGNIX[WS] events, and where each sync stands.
export class Store {
  constructor(db) { this.db = db; }
  get(key) { return this.db.prepare("SELECT value FROM state WHERE key = ?").get(key)?.value ?? ""; }
  set(key, value) { this.db.prepare("INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value)); }
  clear(...keys) { for (const k of keys) this.db.prepare("DELETE FROM state WHERE key = ?").run(k); }

  account() { return this.db.prepare("SELECT * FROM account WHERE id = 1").get() || null; }
  saveAccount({ email = "", refresh, access = "", expiresAt = 0, scope = "" }) {
    this.db.prepare(`INSERT INTO account(id, email, refresh_token, access_token, access_expires_at, scope, connected_at) VALUES(1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET email = excluded.email, refresh_token = excluded.refresh_token, access_token = excluded.access_token, access_expires_at = excluded.access_expires_at, scope = excluded.scope, connected_at = excluded.connected_at`)
      .run(email, refresh, access, expiresAt, scope, new Date().toISOString());
  }
  forgetAccount() { this.db.exec("DELETE FROM account; DELETE FROM links; DELETE FROM state;"); }
  tokens() {
    return {
      get: () => { const a = this.account(); return a ? { refresh: a.refresh_token, access: a.access_token, expiresAt: a.access_expires_at } : null; },
      save: ({ access, expiresAt }) => this.db.prepare("UPDATE account SET access_token = ?, access_expires_at = ? WHERE id = 1").run(access, expiresAt),
    };
  }

  link(googleId) { return this.db.prepare("SELECT * FROM links WHERE google_id = ?").get(googleId) || null; }
  linkByPicode(picodeId) { return this.db.prepare("SELECT * FROM links WHERE picode_id = ? AND kind != 'readonly' ORDER BY kind LIMIT 1").get(picodeId) || null; }
  linksOfMaster(masterId) { return this.db.prepare("SELECT * FROM links WHERE master_google_id = ?").all(masterId); }
  putLink({ googleId, picodeId, kind, master = "", etag = "", updated = "" }) {
    this.db.prepare(`INSERT INTO links(google_id, picode_id, kind, master_google_id, etag, google_updated, synced_at) VALUES(?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(google_id) DO UPDATE SET picode_id = excluded.picode_id, kind = excluded.kind, master_google_id = excluded.master_google_id, etag = excluded.etag, google_updated = excluded.google_updated, synced_at = excluded.synced_at`)
      .run(googleId, picodeId, kind, master, etag, updated, new Date().toISOString());
  }
  dropLink(googleId) { this.db.prepare("DELETE FROM links WHERE google_id = ?").run(googleId); }
  linkCount() { return this.db.prepare("SELECT COUNT(*) AS n FROM links WHERE kind != 'readonly' OR picode_id != ''").get().n; }
}

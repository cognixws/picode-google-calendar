-- The Google account this extension syncs (one), its tokens, and where each
-- sync stands. Tokens live here, in the extension's own database (0600, in
-- its data folder); the OAuth client is in COGNIX[WS]'s encrypted settings.
CREATE TABLE account (
 id INTEGER PRIMARY KEY CHECK (id = 1),
 email TEXT NOT NULL DEFAULT '',
 refresh_token TEXT NOT NULL,
 access_token TEXT NOT NULL DEFAULT '',
 access_expires_at INTEGER NOT NULL DEFAULT 0,
 scope TEXT NOT NULL DEFAULT '',
 connected_at TEXT NOT NULL
);
-- One row per Google event (or instance) that has a COGNIX[WS] counterpart.
-- kind: event (one-off or series), override (a changed occurrence of a
-- series), readonly (an instance of a Google rule COGNIX[WS] cannot expand).
CREATE TABLE links (
 google_id TEXT PRIMARY KEY,
 picode_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('event','override','readonly')),
 master_google_id TEXT NOT NULL DEFAULT '',
 etag TEXT NOT NULL DEFAULT '',
 google_updated TEXT NOT NULL DEFAULT '',
 synced_at TEXT NOT NULL
);
CREATE INDEX links_picode ON links(picode_id);
CREATE TABLE state (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);

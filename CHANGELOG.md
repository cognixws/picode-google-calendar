# Changelog

## 0.1.1 — 2026-10-09

- The page no longer stays on "Finish signing in…" after Google connects:
  opening the browser is no longer awaited (the host may never answer that
  call), and a finished connection wins over the "connecting" flag.

## 0.1.0 — 2026-10-09

- First version: connect one Google calendar (OAuth on a loopback redirect
  with PKCE), two-way sync through COGNIX[WS]'s calendar door, read-only
  occurrences for repeat rules COGNIX[WS] cannot expand, changed and cancelled
  occurrences both ways, a page with the connection state, Sync now and
  Disconnect.

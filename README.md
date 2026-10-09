# Google Calendar extension

A [COGNIX[WS] / PiCode](https://github.com/cognixws/picode) extension that keeps
your Agenda in step with one Google calendar, both ways:

- Your Google events appear in the Agenda, with your COGNIX[WS] alerts and in
  the free/busy agents read (never their titles).
- What you add or change in the Agenda goes to Google; changing one occurrence
  of a repeating event changes that occurrence at Google.
- A Google repeat rule COGNIX[WS] cannot expand comes in as read-only
  occurrences ("Change it in Google Calendar").

Requires a COGNIX[WS] build with the calendar door (ADR-0230 amendment of
2026-10-09) and Node.js 24 (built-in SQLite). No npm install or build runs at
install time; the extension has no runtime dependencies.

## Set up

1. **A Google Cloud project with an OAuth client** (free, about 10 minutes):
   1. Open <https://console.cloud.google.com/>, create a project (any name).
   2. **APIs & Services → Library**: enable **Google Calendar API**.
   3. **APIs & Services → OAuth consent screen**: user type **External**; app
      name and your email; add yourself as a test user.
   4. **Publishing status**: in *Testing*, Google ends the sign-in every 7 days
      and you connect again. Choose **Publish app** to keep it: Google shows an
      "unverified app" screen when you sign in (you continue past it), and up
      to 100 people can use your client. Verification is only needed to share
      it widely.
   5. **APIs & Services → Credentials → Create credentials → OAuth client ID**,
      type **Desktop app**. Copy the client ID and secret.
2. In COGNIX[WS]: **Extensions → Install extension**, paste
   `https://github.com/cognixws/picode-google-calendar`, review the access it
   asks for (read and change your calendar events) and install.
3. Open the extension's **Configuration**, paste the client ID and secret, and
   save. Leave *Calendar* empty for your primary calendar.
4. Open **Google Calendar** (the extension's page) and choose **Connect Google
   account**. Your browser opens Google's sign-in; when it says *Connected*,
   close the tab. The first sync starts at once.

## How it syncs

- **From Google**, every minute: only what changed (Google's sync token). A
  full sync brings past one-off events back 30 days.
- **To Google**, as you change things: COGNIX[WS]'s change feed. Events you
  made in COGNIX[WS] *before* connecting stay local; new ones and changes go.
- **Conflicts**: the later change wins. Google's own reminders are not
  imported; your COGNIX[WS] alerts work on synced events.
- **Disconnect** stops syncing and forgets the Google tokens; events already in
  the Agenda stay. **Removing the extension** asks whether its events stay.

Your OAuth client lives in COGNIX[WS]'s encrypted settings; the Google tokens
in the extension's own database, in its data folder. The page has no network
access and never sees a secret.

## Development

```sh
npm test
```

Tests run against in-memory stand-ins for Google and COGNIX[WS]; no account
or daemon is needed.

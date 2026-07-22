# Wine Circle App

Event-management app for the Stanford GSB Wine Circle: lottery-based event
signups, attendance tracking, and flake-fee enforcement.

**Live at:** https://wine-circle-app.onrender.com

This started as a Google Apps Script + Sheets prototype, then moved through
Replit, before landing on its current architecture: a standalone
Node/Express + Postgres application, deployed on Render. That's the only
version of the app in this repo now — see below.

For a deeper technical reference (full data model, route inventory, core
workflows, security posture) — the kind of detail you'd want before making a
non-trivial change — see [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Architecture

- **`server/`** — Express API.
  - `index.js` — app setup, security middleware, route mounting, cron jobs.
  - `routes/` — one file per resource (`auth`, `members`, `events`, `signups`,
    `fees`, `email`, `settings`, `audit`, `analytics`, `dev`).
  - `services/` — shared business logic (`email.js`, `fees.js`,
    `signupLogic.js`, `audit.js`, `analytics.js`) used across routes.
  - `middleware/auth.js` — session resolution (`requireAuth` /
    `requireAdmin`), token hashing.
  - `db.js` — Postgres connection pool (`pg`).
  - `schema.sql` — table definitions; every change is a guarded
    `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` so re-running it
    against an existing database is always safe. This is the source of truth
    for the schema — there is no separate migration tool, so after pulling a
    change that touches `schema.sql` you must re-run it by hand against both
    your local database and (separately) production.
  - `seed.sql` — default `settings` rows; also safe to re-run
    (`ON CONFLICT DO NOTHING`, plus explicit `UPDATE`s for the handful of
    defaults that changed after first being seeded).
- **`public/`** — static frontend, plain HTML/CSS/JS (no build step, no
  framework):
  - `index.html` — member portal (login, open events, invitations,
    calendar, history, fee banner).
  - `admin.html` — admin/exec dashboard.
  - `decline.html` — public, token-based page for declining an invitation
    (linked from invitation emails, no login required).
- **Database:** Postgres. Production runs on Neon (serverless, free tier
  persists indefinitely); local dev typically uses a local Postgres instance.
- **Email:** sent via the **Gmail REST API over HTTPS (OAuth2)** —
  deliberately not SMTP, since Render's free tier (and many other hosts)
  blocks outbound SMTP entirely. See `.env.example` for the OAuth setup
  steps. With no Gmail credentials configured, sends fall back to logging
  the message to the console instead of silently pretending to succeed —
  useful for local dev.
- **Deployment:** Render (single web service serves both the API and the
  static frontend) + Neon Postgres. Config in `render.yaml`; secrets
  (`DATABASE_URL`, `GMAIL_*`, `EMAIL_FROM`, `ALLOWED_ORIGINS`) are set
  directly in the Render dashboard, not committed.

## Roles

Three privilege levels, all on the `members` table:

- **Member** — the default. Can log in, see open events (and any event an
  admin has flagged as visible before signups open), sign up, see their own
  invitations/history/fee status, and decline invitations.
- **Admin** (`is_admin`) — everything above, plus the full admin dashboard:
  managing events and members, running lotteries, marking attendance,
  finalizing events, recording fee payments, reading the audit/email logs.
- **Exec Team** (`is_exec_team`) — the highest tier, layered on top of admin.
  Additionally required for: bulk-deleting members, deleting events, viewing
  or editing exec-only member notes, granting/revoking `is_admin` /
  `is_exec_team` on other members, and the Analytics and Settings pages.

## Core workflows

**Signup lifecycle:** a signup moves through
`Pending → Invited/Waitlist → Attended/Flaked/Lost/Dropped` as an admin
opens signups, runs the lottery, marks attendance, and finalizes the event.
`server/services/signupLogic.js` has the pure classification logic shared
between the finalize route and its tests.

**Signup window automation:** `signup_opens_at` / `signup_closes_at` on an
event are optional. If set, a cron job in `server/index.js` (runs every
minute) auto-transitions `Draft → Open` and `Open → Closed` at those
timestamps; either or both can be left blank for a fully manual workflow via
the admin Open/Close buttons.

**Event visibility before signups open:** events are normally invisible to
members until `Open`. The per-event `visible_before_open` toggle (defaults
on for new events) lets members see a future event on the portal — read-only,
with signups disabled — while it's still in `Draft`.

**Member-visible status:** members never read a signup's internal `status`
directly. `member_visible_status` is a separate column that only changes
when an admin explicitly clicks "Push Portal Updates" on an event — this
keeps behind-the-scenes attendance corrections from flashing intermediate
states at members before an admin is ready to communicate them.

**Flake workflow:** finalizing an event does not send any email by itself.
A separate "Send Flake Emails" action sends one batch email per event — the
only visible recipients are a leadership address list (configurable via the
`flake_batch_to_emails` setting), with every flaked member bcc'd on the same
message. Each flaked member also gets a row in `email_log` for searchability,
even though only one real message is sent. Re-clicking after a correction
only notifies newly-flaked members, tracked via the nullable
`flake_notice_sent_at` timestamp.

**Exec-only member notes:** `members.exec_notes` is readable/writable only
by Exec Team — stripped out of API responses entirely for everyone else,
not just hidden in the UI.

## Local development

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL at minimum
psql "$DATABASE_URL" -f server/schema.sql
psql "$DATABASE_URL" -f server/seed.sql
npm start
```

The app serves at `http://localhost:5000` (or `$PORT`) — API under `/api/*`,
member portal at `/`, admin portal at `/admin`, decline page at `/decline`.

Without Gmail credentials set, emails log to the console instead of sending
— sufficient for local testing of every flow except actually receiving mail.

### Test data (`dev_mode_enabled`)

`server/routes/dev.js` exposes seed/reset helpers (create test members with
plus-addressed emails, bulk-simulate signups against an event, wipe test
data, log in as a test member without a code) — all gated behind
`dev_mode_enabled = TRUE` in `settings` **and** `NODE_ENV !== 'production'`
(the production check is structural, not just a settings flag, so it can't
be flipped on by mistake on the live deployment). Set `dev_mode_enabled`
back to `FALSE` when done; every dev action is still recorded in `audit_log`
with `admin_email = 'dev'` so test activity is easy to distinguish from real
use.

### Tests

```bash
npm test
```

Runs the Jest suite in `server/__tests__` — currently covers the pure
business-logic functions in `signupLogic.js` (lottery assignment, finalize
classification).

## Deploying changes

Push to `main`; Render redeploys automatically. If the change touches
`server/schema.sql` or `server/seed.sql`, also apply it by hand against the
production database (`psql "$PROD_DATABASE_URL" -f server/schema.sql`,
same for `seed.sql`) — there is no automatic migration step, and forgetting
this is the most common cause of a working-locally-but-broken-in-production
bug (a route selecting a column that doesn't exist yet in prod).

## Legacy artifacts

The original Google Apps Script + Sheets prototype's files have been removed
from the repo entirely — see git history before this note if you need to
look at that approach for reference. `.replit`, `replit.nix`, and
`replit.md` are leftover config from a later, separate legacy hosting
step (this Node app briefly ran on Replit before moving to Render) — not
deployed, not maintained. Use the Local development section above for the
current setup regardless of what those files describe.

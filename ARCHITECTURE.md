# Wine Circle App — Architecture & Current State

This is the deep technical reference for this codebase: what exists, how it
fits together, and why it's built the way it is. It's written for whoever
(human or AI) picks this up next and needs to make changes without
re-deriving everything from scratch. `README.md` is the shorter,
task-oriented "how do I run/deploy this" doc — read this one when you need to
understand *how the system actually works* before changing it.

If anything here disagrees with the actual code, trust the code and update
this doc — it's a snapshot, not a spec.

## 1. What this is

Stanford GSB Wine Circle's event-management system: members enter a lottery
to sign up for wine tasting events, admins run the lottery and take
attendance, and members who no-show or decline too late ("flake") get a $30
fee that blocks them from future signups until a leader clears it.

Live at **https://wine-circle-app.onrender.com**.

## 2. Tech stack

- **Backend:** Node.js + Express 5, `pg` for raw parameterized SQL (no ORM,
  no query builder).
- **Database:** PostgreSQL. Production is Neon (serverless, free tier).
  Local dev is typically a local Postgres instance.
- **Frontend:** plain HTML/CSS/vanilla JS, no build step, no framework, no
  bundler. Three static pages served directly by Express.
- **Email:** Gmail REST API over HTTPS (OAuth2) — not SMTP. Render's free
  tier (and most PaaS free tiers) block outbound SMTP entirely, so this is a
  hard requirement, not a style choice.
- **Auth:** passwordless — 6-digit email codes, bearer session tokens
  (opaque random tokens, SHA-256 hashed at rest, never JWTs).
- **Scheduling:** `node-cron`, in-process (no external job queue).
- **Excel export:** `exceljs` (Analytics page export only).
- **Testing:** Jest, currently covering pure business-logic functions only
  (no integration/route tests, no frontend tests).
- **Hosting:** Render (single web service, serves API + static frontend) +
  Neon Postgres. Config in `render.yaml`; secrets set directly in Render's
  dashboard (never committed).

## 3. Repository layout

```
server/
  index.js               — app bootstrap, middleware stack, route mounting, cron jobs
  db.js                  — pg Pool (single shared pool, max 20 connections)
  schema.sql             — full schema; every statement is idempotent (see §4)
  seed.sql               — default settings rows; also idempotent
  middleware/auth.js      — session resolution + requireAuth/requireAdmin/requireExecTeam
  routes/
    auth.js               — login codes, sessions
    members.js            — member CRUD, bulk import, partner linking, deactivation
    events.js              — event CRUD + full lifecycle (open/close/lottery/finalize/etc.)
    signups.js             — signup lifecycle (enter, decline, attendance, promote/demote)
    fees.js                 — fee ledger reads, payments, waivers
    email.js                — lottery-lost batch send, email log
    settings.js              — key/value settings CRUD (Exec Team gated) + 2 public/limited reads
    audit.js                  — read-only audit log
    analytics.js               — member×event matrix + Excel export (Exec Team only)
    dev.js                      — test-data helpers, gated behind dev_mode_enabled
  services/
    email.js               — all outbound email (templates + Gmail API transport)
    fees.js                 — recomputeBalance, promoteNextWaitlist (shared across routes)
    audit.js                 — audit() — writes one row to audit_log, never throws
    signupLogic.js            — pure functions: lottery assignment, decline/finalize
                                 classification, balance computation — no DB/IO,
                                 shared between routes and Jest tests
    analytics.js               — pure pivot logic for the analytics matrix
  __tests__/businessLogic.test.js — Jest coverage of signupLogic.js
public/
  index.html              — member portal (login, events, invitations, calendar, history, fees)
  admin.html              — admin/Exec Team dashboard (single-page, client-side "nav")
  decline.html            — public, token-authenticated decline page (linked from emails)
scripts/
  get-gmail-refresh-token.js — one-time local helper to mint GMAIL_REFRESH_TOKEN
  post-merge.sh
task-plans/               — historical per-feature planning docs (changelog/backlog, not always accurate — see §12)
AUDIT.md                  — security/usability audit findings log (living doc)
README.md                 — setup/deploy quick-start
render.yaml                — Render Blueprint config
.env.example                — documents every env var
```

Legacy: this app was originally a Google Apps Script + Sheets prototype, then
briefly hosted on Replit before moving to Render. Those artifacts have been
removed from the repo (see git history before this doc was added if you need
to look at the old approach) — there is nothing legacy left to route around.

## 4. Data model

`server/schema.sql` is the single source of truth and the *only* migration
mechanism — there is no migration tool/framework. Every statement is written
to be safely re-runnable: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`, guarded `DO $$ ... $$` blocks for renames. **When you add or change
a column, you must manually re-run `schema.sql` against every environment
that needs it** — local dev, and separately, production (`psql
"$PROD_DATABASE_URL" -f server/schema.sql`). Forgetting the production side
is the single most common way to ship a "works locally, 500s in prod" bug
(a route selects a column that doesn't exist yet on Neon) — this has
happened at least once already.

### `members`

| Column | Notes |
|---|---|
| `member_id` | PK, `m_<uuid-no-dashes>` |
| `email` | unique, case-insensitively indexed (`LOWER(email)`) |
| `is_admin` | admin dashboard access |
| `is_exec_team` | highest tier — see §5 |
| `fee_balance` | denormalized cache, recomputed from `fee_ledger` via `recomputeBalance()` — never hand-edit this without also going through the ledger |
| `status` | `Active` \| `Inactive` \| `Blocked`. `Blocked` is set automatically when `fee_balance > 0`; `Inactive` is a manual admin action and is never overwritten by the automatic Active/Blocked toggle (`CASE WHEN status='Inactive' THEN status ELSE ... END` shows up everywhere balance is recomputed) |
| `notes` | free-text, visible to any admin |
| `exec_notes` | visible/editable by Exec Team only — **enforced server-side** (stripped from API responses for non-exec, not just hidden in the UI) |
| `partner_member_id` | self-referential FK, mutual link (see `link-partner`/`unlink-partner`) |
| `school_year` | e.g. `"2026-27"`; membership is tracked per academic year, used for analytics filtering and bulk-import defaults |

### `events`

| Column | Notes |
|---|---|
| `event_id` | PK, `e_<uuid>` |
| `status` | `Draft → Open → Closed → Lotteried → Completed`, or `Cancelled` at any point. Draft→Open and Open→Closed can be automatic (see §4a) or manual. Lottery only runs from `Closed` or `Open`. Finalize only runs when not already `Completed`. |
| `signup_opens_at` / `signup_closes_at` | optional; drive the auto-open/close cron (§4a) |
| `auto_invite_enabled` | if true, a decline/drop from a member who was `Invited` immediately promotes the next waitlister |
| `send_lottery_lost_emails` | gates `POST /api/email/send-lottery-lost` |
| `dollar_value` / `show_dollar_value` | per-member value of attending (for analytics $ totals); `show_dollar_value` controls member-portal visibility, defaults **on** for new events |
| `visible_before_open` | if true, members can see this event on the portal (read-only, no signup) while it's still `Draft`; defaults **on** for new events |
| `finalized_at` / `rolled_back_at` | finalize/unfinalize bookkeeping — see §6 |

### `signups`

One row per (event, member) pair — `UNIQUE (event_id, member_id)`. Both FKs
`ON DELETE CASCADE` (deleting a member or event wipes their signups).

| Column | Notes |
|---|---|
| `status` | `Pending → (Invited \| Waitlist) → (Attended \| Flaked \| Dropped \| Lost)`. This is the **internal/admin-facing** truth. |
| `member_visible_status` | what the member's portal actually reads — see §6c. Defaults to `Pending`, only changes on member-caused transitions (signup, decline) or an explicit admin "Push Portal Updates" click. |
| `lottery_rank` | assigned at lottery time, used to order waitlist promotion |
| `decline_token` | unique, powers the token-based public decline link in invitation emails; re-issued on every promotion |
| `finalized_from` | set only on signups a finalize run touched (`'Invited'` or `'Waitlist'`), lets `unfinalize` restore *exactly* what that run changed, nothing more |
| `pre_attendance_status` | the status just before an admin checked "Attended", so **unchecking** restores it correctly instead of defaulting to `Invited` regardless of prior state |
| `flake_notice_sent_at` | nullable timestamp; gates the batch flake email so re-sending after a correction only reaches newly-flaked members |

### `fee_ledger`

Append-only. `type` is `Charge` \| `Payment` \| `Waiver`. Balance is always
*derived* by summing this table (`computeBalance()` in `signupLogic.js`),
never stored as the source of truth — `members.fee_balance` is a cache kept
in sync by `recomputeBalance()`. `member_id` cascades on member delete;
`event_id` is a plain text column (**not** an FK) so ledger history survives
event deletion.

### `email_log`

One row per send attempt (`status`: `sent` \| `error` \| `skipped`), used
purely for the admin Email Log page's searchability. The flake-batch email
is one real message but logs one row per bcc'd recipient (see §7) — don't
assume row count == messages sent.

### `auth_codes` / `auth_sessions`

6-digit codes (SHA-256 hashed, 15-min default TTL) and session tokens
(SHA-256 hashed, 14-day default TTL). Pruned daily by cron. Never store a
raw code or token — only their hashes.

### `settings`

Plain key/value + description, no schema per key. Read via
`getSettings()` (`server/services/email.js`) which returns the whole table
as a flat object — cheap enough at this table size to just always read it
all. See `server/seed.sql` for the full current list of keys and their
defaults/descriptions — that file is the authoritative list, don't
duplicate it here (it will drift).

### `audit_log`

Every mutating admin action writes one row via `audit()` — fire-and-forget,
wrapped so a logging failure never fails the actual operation. `before_state`
/`after_state` are JSONB, often partial (whatever the caller thought was
worth recording, not a full row diff).

### 4a. Signup window automation

A cron job in `server/index.js` runs every minute:
```sql
UPDATE events SET status='Open'   WHERE status='Draft' AND signup_opens_at  <= NOW();
UPDATE events SET status='Closed' WHERE status='Open'  AND signup_closes_at <= NOW();
```
Either timestamp can be left blank for a fully manual workflow via the admin
Open/Close buttons — the cron only acts on events where the relevant field is
actually set, and only ever moves `Draft→Open` or `Open→Closed` (never
touches `Lotteried`/`Completed`/`Cancelled`, and never re-opens something an
admin manually `Closed`). `POST /api/signups` also independently rejects a
signup past `signup_closes_at` even if the event row hasn't been flipped to
`Closed` yet — belt-and-suspenders against the up-to-59-second gap between
cron ticks.

## 5. Roles & permission model

Three tiers, all columns on `members`:

1. **Member** (default) — `requireAuth` only. Sees open events, any event an
   admin flagged `visible_before_open`, their own invitations/history/fees.
2. **Admin** (`is_admin`) — `requireAdmin`. Full event/member/fee management,
   audit log, email log.
3. **Exec Team** (`is_exec_team`) — layered on top of admin, checked with an
   *additional* inline `if (!req.member.is_exec_team)` in the specific routes
   that need it (there is a `requireExecTeam` middleware in
   `middleware/auth.js` used by some routes, and an equivalent local helper
   redefined in `analytics.js`/`settings.js` — both check the same field, use
   either consistently with the surrounding file's existing style rather than
   introducing a third pattern).

Exec-Team-gated surface, exhaustively: bulk-delete members, delete an event,
grant/revoke `is_admin`/`is_exec_team` on another member, read/write
`exec_notes`, record fee payments/waivers, the Analytics page and its
`/api/analytics/*` routes, the Settings page and its `/api/settings`
(root)/`PATCH` routes.

**Important asymmetry:** `GET /api/settings/current-school-year` is
deliberately `requireAdmin` only (not exec-gated) — non-exec admins still
need it to populate the school-year default when creating/importing members.
If you add more settings-derived UI for non-exec admins, follow this same
pattern (a narrow, purpose-built endpoint) rather than loosening the main
`GET /api/settings` gate.

## 6. Core workflows

### 6a. Signup → lottery → attendance → finalize

```
Pending --[run-lottery]--> Invited | Waitlist
Invited --[decline / late decline]--> Dropped | Flaked
Invited --[finalize, still Invited]--> Flaked (+ $ charge)
Waitlist --[promote]--> Invited
Waitlist --[finalize, still Waitlist]--> Lost
(Invited|Waitlist) --[mark attended]--> Attended
```
`assignLotteryResults()` and `classifyFinalizeSignups()`
(`server/services/signupLogic.js`) are the pure functions driving lottery
assignment and finalize classification — covered by Jest tests. If you touch
finalize/lottery logic, add a test there rather than only exercising it
through the route.

### 6b. Decline / flake determination

`determineDeclineOutcome()` (pure, `signupLogic.js`): if the signup was
`Invited` and the decline lands within `decline_grace_window_hours` of
`event_date`, it's a `Flaked` decline (charges `flake_fee_amount`);
otherwise it's a clean `Dropped`. This same function backs both the
authenticated decline route (`POST /api/signups/:id/decline`) and the public
token-based one (`POST /api/signups/decline-by-token`) — keep them in sync
if you change the rule.

### 6c. `member_visible_status` — the deliberate lag

Members never read `signups.status` directly on any member-facing route —
every member-facing query aliases `member_visible_status AS status` instead.
Admin-driven transitions (lottery, promote/demote, mark attendance, finalize)
change `status` but leave `member_visible_status` untouched until an admin
explicitly clicks **"Push Portal Updates"** on the event
(`POST /api/events/:id/push-updates`, syncs any row where they differ).
Member-*caused* transitions (signup, decline) update both columns in
lockstep — there's nothing to hide from a member about their own action.

**Why this exists:** it lets an admin correct an attendance-taking mistake
(mark someone attended by accident, catch it, fix it, re-finalize) without a
member ever seeing the wrong intermediate state flash on their portal. If you
add a new admin-side status mutation, decide deliberately whether it should
auto-push or wait for an explicit push — don't default to auto-syncing
`member_visible_status` without thinking about it, that's the bug this
column exists to prevent.

### 6d. Attendance checkbox — `pre_attendance_status`

Checking "Attended" stores whatever the signup's status was right before
(`Invited` or `Waitlist`) into `pre_attendance_status`. Unchecking restores
that value rather than hardcoding a fallback — a Waitlist walk-in who gets
checked in and then unchecked must go back to `Waitlist`, not incorrectly to
`Invited` (which would wrongly expose them to a flake fee on finalize; see
§6a — finalize only flakes `Invited` signups).

### 6e. Finalize / unfinalize

Finalize is idempotent-ish: it only classifies signups still in `Invited`/
`Waitlist` (i.e., untouched since the last lottery), so calling it twice in a
row without an unfinalize in between is a no-op the second time. Unfinalize
uses `finalized_from` to restore *only* what the last finalize actually
touched — it does not touch late self-declines that separately became
`Flaked` outside the finalize run. Re-finalizing after a correction detects
it via `event.rolled_back_at` and computes `correctedSignups` (informational
only, shown to the admin) — **finalize itself never sends email**, regardless
of whether it's a first run or a correction re-run.

### 6f. Flake batch email

Sending flake notices is a fully separate, manual step from finalizing
(`POST /api/events/:id/send-flake-emails`) — this was a deliberate change
from an earlier version that auto-emailed on finalize. One real email per
event send: visible `To` is a configurable leadership list
(`settings.flake_batch_to_emails`, editable on the Settings page, falls back
to a hardcoded default if unset), every flaked member is bcc'd on that same
message so no one sees the rest of the list. `flake_notice_sent_at` gates the
query so re-clicking after a correction only reaches newly-flaked members.
`email_log` still gets one row per bcc'd member (in addition to the row for
the real `To` line) purely so the Email Log page's per-recipient search still
works — don't read `email_log` row count as "number of emails sent" for this
type.

### 6g. Waitlist promotion

`promoteNextWaitlist()` (`server/services/fees.js`) picks the lowest
`lottery_rank` on `Waitlist`, flips them to `Invited`, issues a **fresh**
`decline_token` (the old one, if any, is stale/unusable). Triggered from:
auto-promote on decline (if `event.auto_invite_enabled`), manual "Promote" in
admin, and demoting someone else out of `Invited` (with that signup itself
excluded via `excludeSignupId`, or a lone waitlister would immediately
re-promote themselves).

## 7. Email

`server/services/email.js` is the only place that talks to Gmail. All
templates live here as small functions (`emailMagicLink`, `emailInvitation`,
`emailLotteryLost`, `emailWaitlistPromotion`, `emailFlakeNotice`,
`emailFlakeBatch`, `emailAttendanceCorrected`, `emailFeePaidConfirm`) built
on a shared `sendEmail()` core that: sends via the Gmail API if
`GMAIL_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` are configured, otherwise **logs
the full message to console instead of pretending to succeed** (status
`skipped`, not `sent` — a misconfigured prod deployment must be loud about
it, not silently no-op while `email_log` claims success). Every send is
logged to `email_log` regardless of outcome.

`buildRawMessage()` hand-builds the RFC 2822 message (base64url-encoded, as
Gmail's API requires) — supports plain text, or `multipart/alternative`
(text + HTML) when an `html` body is passed, used by the flake batch email
for its hyperlinked payment link. Non-ASCII subject lines get RFC 2047
encoded-word wrapping (`encodeHeader()`) so mail clients don't mis-decode an
em dash into mojibake.

**Never send email synchronously inside the critical path of a user-facing
request that must succeed regardless of email health** — see
`send-code`/`verify-code` in `auth.js`: the login code is persisted to the DB
*before* the email is fired, and the email call is fire-and-forget
(`.catch(console.error)`, not awaited) so a slow/down mail provider can never
block or fail a login attempt.

## 8. Frontend

No build step anywhere — every page is a single `.html` file with inline
`<style>` and `<script>`. Keep it that way unless you have a strong reason to
introduce tooling; the whole app's simplicity depends on "edit the file, it's
live" with zero compile step.

Shared conventions across all three pages:
- `esc()` — HTML-escapes user-controlled strings before any `innerHTML`
  interpolation. **Every** dynamic string going into `innerHTML` must go
  through this. See §9 (XSS note) for the one sharp edge this doesn't cover.
- Session token stored in `localStorage` (`admin_token` for admin.html,
  `wc_session_v1` for index.html), sent as `Authorization: Bearer <token>` or
  `X-Session-Token` (either header works, `middleware/auth.js` checks both).
- `apiFetch()`/`api()` helpers wrap `fetch()`, JSON-encode the body, throw on
  non-OK responses with the server's `{error}` message.

### `public/index.html` — member portal

Single-page, view-switching via `setView()`. Key sections: login (email →
6-digit code), home (fee-blocked banner, event-status summary table, open
events list, invitations, calendar, history), event detail overlay (opened
from a calendar day click or a history card click). `goToAdmin()` reuses the
same session token for the admin portal so an admin doesn't have to log in
twice — the backend re-validates the token against `members.is_admin` on
every request regardless of which portal it came from, so this is not a
trust boundary, just a UX convenience.

The events list applies a client-side filter on top of what the backend
already scoped (`e.status === 'Open' || e.signup_status || e.visible_before_open`,
excluding `Completed`/`Cancelled`) — if you change what the backend returns
for `GET /api/events`, check this filter still matches, or a visible/invisible
mismatch will reappear.

### `public/admin.html` — admin/Exec Team dashboard

Single-page with a sidebar `nav()` function toggling `.page` divs by id (see
the page-id list in §3's file tree — `page-events`, `page-event-detail`,
`page-members`, `page-fees`, `page-analytics`, `page-audit`,
`page-email-log`, `page-settings`). `nav-analytics` and `nav-settings` sidebar
items are hidden via `style.display` for non-Exec-Team members
(`showApp()`); the actual enforcement is server-side (§5) — the frontend hide
is UX only, never rely on it as the security boundary.

The event detail page's **Actions** bar (`#event-action-bar`) is visually
segmented into labeled groups (Signup Window / Lottery & Invites / Attendance
& Flakes / Manage / a divider-separated but unlabeled danger-zone group for
Cancel/Delete) via `.action-group` wrapper divs — every button is always
rendered regardless of event status; there is no per-status show/hide logic
for these buttons currently (a future improvement, not yet built).

Member History (inside the Analytics page) uses a search-to-select pattern —
text input + absolutely-positioned results dropdown + hidden input holding
the actual selected `member_id` (`.search-select-wrap`/`.search-select-results`/
`.search-select-item` CSS classes) — reuse this pattern rather than a
`<select>` if you add another large-list picker.

The Analytics table splits fetch (`loadAnalytics()`) from render
(`renderAnalyticsTable()`) so client-side sort clicks re-render from a cached
response instead of re-fetching.

### `public/decline.html`

Fully public (no auth), reached via `?token=` from an invitation email.
Fetches invite details, shows a late-decline warning if within the flake
grace window, submits to `POST /api/signups/decline-by-token`. Deliberately
its own tiny standalone page (own `<style>` block, own `esc()`/`fmtDate()`)
rather than a mode of `index.html`, since it must work for someone with zero
Wine Circle login/session at all.

## 9. Security posture

`AUDIT.md` is the living audit log — read it before assuming something is or
isn't a known issue; it tracks severity/status/fix per finding, not just a
changelog. Headline points worth knowing without opening that file:

- **CSP** (`server/index.js`, `helmet`) allows `'unsafe-inline'` for scripts
  and `script-src-attr` specifically — required because every page uses
  inline `onclick="..."` handlers throughout. This is a known, accepted
  tradeoff (removing it is a large refactor), not an oversight.
- **XSS discipline:** `esc()` before every `innerHTML` write — but inline
  `onclick="fn('${esc(value)}')"` string-building has a real, fixed-once
  sharp edge: `esc()` doesn't escape `'`, and HTML-entity-encoding `'` isn't
  actually a fix either (the browser decodes entities in attribute values
  *before* the JS parser ever sees them, so `&#39;` still closes the string).
  The established fix, already applied everywhere this pattern is used, is
  `data-*` attributes read via `this.dataset` inside the handler instead of
  string-interpolating into the handler itself. Follow that pattern for any
  new inline handler that needs to carry a value that might contain a quote
  (member names, notes, anything user-editable) — see `AUDIT.md`'s first
  finding for the full incident writeup.
- **Rate limiting:** a strict limiter on `send-code`/`verify-code` (the only
  real abuse surface — guessing codes / spamming sends), a looser general
  limiter on everything else under `/api`, keyed by session token when
  present (falls back to IP) so one busy shared-NAT network can't throttle
  everyone behind it.
- **Dev endpoints:** `server/routes/dev.js` is double-gated —
  `NODE_ENV === 'production'` hard-disables it structurally (not just a
  settings flag), and even outside production it requires
  `dev_mode_enabled = TRUE` in `settings`. Always leave `dev_mode_enabled`
  `FALSE` outside an active testing session.
- **Session tokens** live in `localStorage`, not httpOnly cookies — this was
  a deliberate tradeoff (simplifies the admin/member portal token-sharing in
  `goToAdmin()`/`goToMember()`), which is exactly why the XSS discipline
  above matters as much as it does: any script-injection bug here is a
  direct session-token theft, not just a defaced page.

## 10. Local development

```bash
npm install
cp .env.example .env      # fill in DATABASE_URL at minimum
psql "$DATABASE_URL" -f server/schema.sql
psql "$DATABASE_URL" -f server/seed.sql
npm start                  # or: npm run dev (identical script)
npm test                   # Jest — server/__tests__ only
```
No Gmail credentials configured → emails log to console instead of sending,
which is sufficient for testing every flow except actually receiving mail.
`server/routes/dev.js` (behind `dev_mode_enabled=TRUE`) gives you seed
members / simulated signups / a no-code test login / a full reset — see its
file header for the exact request shapes, there's no separate doc for it.

## 11. Deployment

Push to `main` → Render auto-redeploys (`render.yaml`: `npm install` build,
`npm start` run). Env vars (`DATABASE_URL`, `GMAIL_*`, `EMAIL_FROM`,
`ALLOWED_ORIGINS`) are set directly in the Render dashboard — never
committed, and not recoverable from this repo if lost; get them from
whoever has Render dashboard access. A GitHub Actions workflow
(`.github/workflows/keep-warm.yml`) pings `/api/health` every 10 minutes to
prevent Render's free-tier cold-start/spin-down.

**Whenever a change touches `schema.sql` or `seed.sql`, apply it to
production by hand** (`psql "$PROD_DATABASE_URL" -f server/schema.sql`, same
for `seed.sql`) — there is no CI step or auto-migration that does this for
you.

## 12. Historical context / where to look for "why"

- `task-plans/*.md` — one doc per feature/epic as it was originally planned,
  each with a Status field (`Merged`/`Proposed`/`Cancelled`). Useful as a
  changelog and for the *original* reasoning behind a feature, but **verify
  against actual code before trusting a "Done"/"Merged" claim** — at least
  one has been found stale (claimed an email provider was integrated that
  the code didn't actually use yet).
- `AUDIT.md` — security/usability findings, living document, keep it current
  if you touch anything it discusses (auth, XSS-sensitive rendering, route
  authorization, rate limiting, secrets handling).
- Git history — since there's no separate design-doc trail beyond
  `task-plans/`, commit messages and diffs are often the best record of *why*
  a particular column or check exists. Several of the subtler invariants
  described in §6 above (e.g. `pre_attendance_status`, `finalized_from`,
  `flake_notice_sent_at`) were each added to fix a specific reported bug —
  the code comments at each column's definition in `schema.sql` summarize
  the reasoning, but the commit that introduced it has the full incident.

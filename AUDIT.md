# Wine Circle App — Pre-Deployment Audit

Living document, kept current across sessions. Each finding has a severity,
status, and a concrete fix.

**Severities:** 🔴 Critical (blocks deployment) · 🟠 High (fix before real use) ·
🟡 Medium (fix soon) · 🔵 Low / usability polish

**Statuses:** `OPEN` · `FIXED` · `WONTFIX (reason)`

## Audit progress checklist — COMPLETE

- [x] Auth flow (send-code / verify-code / sessions / logout)
- [x] Authorization on every API route (admin vs exec vs member vs public)
- [x] XSS review of admin.html rendering paths
- [x] XSS review of index.html + decline.html rendering paths
- [x] Injection review (SQL parameterization, header injection)
- [x] Business logic (lottery, decline/flake, finalize/rollback, fees) — code-level race review; see caveat below
- [x] Bulk operations (import, delete) edge cases
- [x] Rate limiting and abuse resistance
- [x] Secrets/config hygiene (.env, repo history, CORS, helmet)
- [x] Dev/test endpoints in production
- [x] Live prod spot-checks (read-only)
- [x] Usability walkthrough notes

## Findings

### 🔴 CRITICAL — Stored XSS via member name → admin session takeover — **FIXED**

**Where:** `public/admin.html`, three button templates (Members table's
"Pay"/"Deactivate" buttons, Fees → Outstanding page's "Record Payment" button).

**The bug:** these buttons were built like
`onclick="openPayment('${m.member_id}', '${esc(m.full_name)}', ${m.fee_balance})"`.
`esc()` HTML-escapes `&`/`<`/`>`/`"` but **not `'`**. A member's `full_name` is
admin-editable (Add/Edit Member form) and also settable via **Bulk Import**
from a pasted/uploaded spreadsheet — which can originate from a Google Form
that any GSB member fills out themselves. A name/first-name/last-name
containing a single quote (a real name like `O'Brien`, or a deliberately
crafted payload) breaks out of the JS string literal inside the `onclick`
attribute.

**Why HTML-escaping `'` wouldn't have been enough either:** the natural-looking
fix — adding `'` → `&#39;` to `esc()` — does **not** actually close this hole.
Inline event-handler attributes (`onclick="..."`) are HTML-entity-decoded by
the browser's HTML parser *first*, and only *then* compiled as JavaScript
source. So `&#39;` gets turned back into a raw `'` before the JS parser ever
sees it, and the breakout still happens. The only real fix is to never
interpolate untrusted text into an inline-handler string in the first place.

**Impact:** the admin session token is kept in `localStorage` (`admin_token`),
not an httpOnly cookie — so any script injection here is directly readable by
JS and means **full admin account takeover**, not just a defaced page.

**Fix applied:** switched all three call sites to the `data-*` attribute
pattern already used safely elsewhere in this codebase (e.g.
`public/index.html`'s decline button) — values go in `data-*` attributes
(safe: plain DOM string reads, never re-parsed as code) and are read via
`this.dataset` inside the handler:
```html
<button data-member-id="${esc(m.member_id)}" data-full-name="${esc(m.full_name)}"
        onclick="deactivateMember(this.dataset.memberId, this.dataset.fullName)">
```
Confirmed via a full grep sweep of all three HTML files that no other
`onclick="...('${esc(...)}')"` call sites remain with attacker-reachable
values — the only other matches use server-generated UUIDs or fixed,
code-defined settings keys.

### 🟠 HIGH — `dev-login` mints a session for any email with zero verification — **FIXED**

**Where:** `server/routes/dev.js`, `POST /dev-login` (and every other
`/api/dev/*` route).

Given any email on the roster, returned a live, full-duration session token —
no password, no 6-digit code. Was only gated by `devGuard` checking
`dev_mode_enabled = 'TRUE'` in the `settings` table — one settings-table row
away from a total auth bypass for every member, including admins.

**Fix applied:** `devGuard` now checks `process.env.NODE_ENV === 'production'`
first and 403s unconditionally, before even querying the settings table —
structurally unreachable in production regardless of what's in the database.
Confirmed prod's `dev_mode_enabled` is `FALSE` (see live spot-check below)
independent of this fix.

### 🟡 MEDIUM — Content-Security-Policy fully disabled — **FIXED**

**Where:** `server/index.js`, was `helmet({ contentSecurityPolicy: false })`.

**Fix applied:** enabled a real CSP — `default-src 'self'`, script/style
`'self' 'unsafe-inline'` (the inline `onclick=`/`<script>`/`<style>` blocks
throughout `admin.html`/`index.html` need this; a full refactor to external
files + nonces is a much larger follow-up, not done here), fonts scoped to
`fonts.googleapis.com`/`fonts.gstatic.com` (Caprasimo/Figtree), `object-src
'none'`, `frame-ancestors 'self'`.

**Bug caught by live verification, not by code review alone:** the first
version set only `scriptSrc: ["'self'", "'unsafe-inline'"]`, which per naive
expectation should cascade to inline event-handler attributes too. It doesn't
— tested by loading the actual pages in a browser with a
`securitypolicyviolation` listener attached, and every single `onclick="..."`
was silently blocked (`violatedDirective: "script-src-attr"`), including the
Edit Member modal never opening. Fixed by adding `scriptSrcAttr:
["'unsafe-inline'"]` explicitly. Re-verified after the fix: zero violations,
modal opens correctly, confirmed on both `admin.html` and `index.html` with
no console errors either. This is exactly the kind of bug that "looks correct
in code review" but silently breaks the app — recorded here so the specific
`scriptSrcAttr` requirement isn't lost if the CSP is ever touched again.

### 🟡 MEDIUM — CORS allows all origins when `ALLOWED_ORIGINS` unset — **FIXED (code) + confirmed exploitable in prod before the fix**

**Where:** `server/index.js`, `cors({ origin: process.env.ALLOWED_ORIGINS ? ... : true })`.

**Confirmed live, not just theoretical:** `curl -H "Origin:
https://evil-attacker.example.com" https://wine-circle-app.onrender.com/api/health`
returned `access-control-allow-origin: https://evil-attacker.example.com` and
`access-control-allow-credentials: true` — the production deployment was
reflecting back *any* origin with credentials allowed, because
`ALLOWED_ORIGINS` was never set in Render's environment. Confirmed no
cookie-based auth exists (bearer-header only), which limits real exploitability
today, but this is still the well-known "wildcard-CORS-plus-credentials"
anti-pattern and widens the blast radius of any future change that adds
cookie-based state.

**Fix applied:** changed the fallback so that when `ALLOWED_ORIGINS` isn't
set, production now defaults to `origin: false` (closed) instead of `true`
(open) — dev keeps the permissive default for convenience. This is safe
because the app's actual frontend is always same-origin (public/*.html
served by this same Express app); same-origin `fetch()` calls are governed by
the browser's Same-Origin Policy directly and are never subject to CORS
restrictions regardless of these response headers, so this change doesn't
affect normal app usage at all, only genuine cross-origin requests. **Still
recommend also setting `ALLOWED_ORIGINS=https://wine-circle-app.onrender.com`
explicitly in Render's env vars** once this fix is deployed, as
defense-in-depth on top of the code-level default (a config change I can't
make myself — no access to the Render dashboard).

### 🔵 LOW — `esc()` doesn't escape single quotes (context-dependent) — WONTFIX (not a bug on its own)

Covered under the Critical finding above. Not changing `esc()` itself, since
(a) it wouldn't have fixed the actual bug (HTML-entity-decoding happens
before JS parsing of inline handlers, so escaping `'` is not sufficient
there) and (b) `esc()` is correctly used in dozens of places as plain HTML
text/attribute content, where escaping `'` isn't needed. **Convention going
forward:** never interpolate `esc(...)` output (or any user-controlled value)
directly inside a single-quoted argument list within an inline `onclick="..."`
attribute — always use `data-*` attributes + `this.dataset.x` instead.

## Confirmed-safe (checked, no action needed)

- **SQL injection:** every query in `server/routes/*.js` and
  `server/services/*.js` uses parameterized `$1`/`$2`/... placeholders.
- **Secrets hygiene:** `.env`/`.env.local` gitignored and confirmed not
  tracked. No hardcoded API keys or connection strings in tracked source.
- **CSRF:** no cookie-based auth exists anywhere server-side — session token
  travels only via an explicit `x-session-token` header a third-party page
  can't make the browser attach automatically.
- **Auth code brute-force:** 6-digit codes (1,000,000 possibilities), rate
  limited to 30 attempts/15min, expire in 15 minutes, single-use —
  infeasible to brute force.
- **Membership enumeration:** `send-code` always returns `{ok:true}`
  regardless of roster membership, with a timing-mitigation delay.
- **Privilege escalation via member edit:** `is_admin`/`is_exec_team`
  change-gating correctly compares against the *existing* value (a non-Exec
  admin resubmitting an unchanged form isn't blocked; an actual privilege
  change attempt is rejected).
- **Self-deletion guard:** bulk-delete-members rejects a request that
  includes the caller's own `member_id`.
- **Authorization matrix:** every route in `server/routes/*.js` reviewed —
  member-only endpoints use `requireAuth`; admin-panel endpoints use
  `requireAdmin`; the four highest-privilege actions (fee payment/waiver,
  member bulk-delete, event delete, analytics matrix/export) additionally
  check `is_exec_team`.
- **Business-logic concurrency (code-level review):** `unfinalize`,
  `finalize`, and the new auto-open/close cron all acquire `SELECT ... FOR
  UPDATE` row locks on the event (and, for unfinalize, the affected signups)
  inside a transaction before mutating — a concurrent finalize/unfinalize
  pair on the same event serializes correctly on that lock rather than
  corrupting state. The unfinalize fee-reversal logic (`ORDER BY occurred_at
  DESC LIMIT 1` when looking up the charge to waive) is correct across
  repeated finalize→unfinalize→finalize cycles on the same member+event,
  since each cycle's charge/waiver pair is self-contained.
  **Caveat:** this is code-level reasoning, not a live concurrent-load test
  (the earlier session's 500-concurrent-user test covered the core signup
  flow, not these newer routes specifically) — worth an actual concurrency
  test before a real high-traffic lottery run if there's appetite for it.
- **Live prod spot-checks:** `dev_mode_enabled = FALSE` and
  `web_app_url` correctly set in the production `settings` table (confirmed
  via direct `psql` against the Neon prod DB). 404s and malformed-JSON
  requests return generic errors (`{"error":"..."}`), no stack traces or
  framework internals leak. Helmet's other security headers (HSTS,
  X-Content-Type-Options, X-Frame-Options, etc.) are present and correctly
  configured on live responses.
- **Usability/mobile:** the admin panel's sidebar (`.sidebar { width: 220px;
  position: fixed }`) doesn't collapse at mobile widths — confirmed this is a
  **pre-existing, admin-panel-wide** characteristic (checked the Events page
  too, not just the new Analytics page) rather than something introduced this
  session. The admin panel has never been responsive-designed; it's a
  reasonable product assumption that admin/Exec Team tooling is used on
  desktop. Not fixed — flagging as a known, intentional-scope limitation
  rather than a bug, distinct from the member portal (`index.html`), which
  *was* explicitly made mobile-responsive earlier this session.

## Outstanding (needs a decision from you, not something I can finish alone)

- **Set `ALLOWED_ORIGINS` in Render's environment variables** to
  `https://wine-circle-app.onrender.com` (plus any custom domain) — the code
  fix above makes this safe-by-default even if it's never set, but explicit
  is still better than implicit for this one.
- **Live concurrency test of the newer routes** (unfinalize, bulk-delete,
  cron auto-open/close) under real simultaneous load, if/when there's a
  high-stakes event to justify the test — the code-level locking review gives
  good confidence but hasn't been load-tested the way the original signup
  flow was earlier this session.

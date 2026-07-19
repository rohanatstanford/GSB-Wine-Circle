# Task 5 — Connect a real email provider

**Status:** Merged  
**Category:** next_steps

## What & Why
Without a real email provider, login codes and invitation emails only log to the console — members can never actually receive them.

## Done
Three passes, in order:
1. Gmail via the Replit Connectors SDK (OAuth proxy) — only worked inside Replit's infrastructure; sent nothing once deployed elsewhere.
2. Gmail **SMTP** via Nodemailer, using an App Password — worked locally, but on Render (and likely other free-tier PaaS hosts) outbound SMTP is blocked entirely for anti-abuse reasons. Confirmed live: every send failed at the TCP-connect stage (`ENETUNREACH` on Gmail's IPv6 address, then `Connection timeout` even after forcing IPv4) — a network-layer block, not fixable in application code.
3. **Gmail REST API over HTTPS (OAuth2)** — the current implementation. A plain HTTPS POST to `gmail.googleapis.com`, which is never port-blocked. Uses `google-auth-library`'s `OAuth2Client` with a refresh token to mint access tokens.

Falls back to console logging when Gmail OAuth2 credentials aren't set (safe for local dev). All outbound emails logged to `email_log` regardless of send status.

## Configuration
One-time setup (see `scripts/get-gmail-refresh-token.js` header comment for exact steps):
1. Create a Google Cloud project, enable the Gmail API, add the sending Gmail account as an OAuth consent screen test user.
2. Create an OAuth 2.0 Client ID of type "Desktop app" — gives you `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET`.
3. Run `GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/get-gmail-refresh-token.js` locally, approve access in the browser, copy the printed `GMAIL_REFRESH_TOKEN`.

Environment variables:
- `GMAIL_USER` — the sending Gmail address
- `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` — from the OAuth Client ID
- `GMAIL_REFRESH_TOKEN` — from the one-time helper script above
- `EMAIL_FROM` — optional; e.g. `Wine Circle <winecircle@gmail.com>`, defaults to `GMAIL_USER`

## Relevant files
- `server/services/email.js`
- `scripts/get-gmail-refresh-token.js`

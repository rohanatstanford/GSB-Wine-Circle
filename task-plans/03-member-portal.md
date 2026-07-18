# Task 3 — Build the member-facing web portal

**Status:** Merged  
**Category:** next_steps

## What & Why
Members needed a proper standalone web UI to replace the Google Apps Script embedded page.

## Done
- `public/index.html` — member SPA (vanilla HTML/CSS/JS, no build step)
  - Login: email → 6-digit code → logged in; org name loaded from database
  - Home: open events with status pills (Signed up / Invited / Waitlisted), Enter lottery button
  - Fee banner: shown when balance > 0, lists which event(s) caused it, ePay link, leadership contact
  - Invitations section: Invited/Waitlisted events with Decline button
  - Late declines (within 24h of event) auto-trigger flake fee and warn the member
  - Waitlist auto-promotion on decline
  - Admin link in header (visible only to admins)
- `public/decline.html` — handles emailed decline token links
- New API endpoints added:
  - `GET /api/settings/public` — no auth, returns org name / ePay URL / leadership contact
  - `GET /api/signups/invitations` — member's active Invited/Waitlist signups
  - `GET /api/signups/my` — member's full signup history
  - `GET /api/fees/my` — member's fee balance and charge breakdown
  - `POST /api/signups/:id/decline` — authenticated decline from member portal
- `scripts/post-merge.sh` — post-merge setup script (npm install + schema + seed)

## Relevant files
- `public/index.html`
- `public/decline.html`
- `server/routes/signups.js`
- `server/routes/fees.js`
- `server/routes/settings.js`
- `scripts/post-merge.sh`

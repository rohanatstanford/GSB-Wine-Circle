# Task 12 — Set the app URL in Settings so decline links in invitation emails work

**Status:** Proposed

## What & Why
Decline links in invitation emails are built from the `web_app_url` setting in the database, which is currently blank. Every invitation email sent contains a broken/placeholder decline link until this is set.

## Done looks like
- Admin Settings page (or section) in the admin portal lets admins view and update key settings including `web_app_url`
- After setting `web_app_url` to the deployed app URL, invitation emails generate correct decline links (e.g. `https://your-app.replit.app/decline?token=...`)
- Ideally auto-populated from the deployment URL on first setup

## Relevant files
- `public/admin.html` — add a Settings page/section
- `server/routes/settings.js` — PATCH /api/settings/:key (already exists, admin-only)
- `server/services/email.js` — where decline URL is constructed
- `server/seed.sql` — web_app_url default is blank

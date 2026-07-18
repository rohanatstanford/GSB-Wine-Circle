# Task 11 — Let admins preview invitation and lottery-lost email content before sending

**Status:** Proposed

## What & Why
Admins currently send invitation and lottery-lost emails blind — they can't see what the email will look like until after it's been sent to real members. A preview step reduces the risk of sending emails with wrong event details, broken links, or stale copy.

## Done looks like
- "Preview" button in the event detail page (admin portal) shows a rendered sample of the invitation email and/or lottery-lost email for that event
- Preview uses real event data and settings (org name, ePay URL, grace window, etc.) but a placeholder member name
- No email is sent during preview

## Relevant files
- `public/admin.html` — event detail page
- `server/services/email.js` — email template functions to expose a preview mode
- `server/routes/email.js` — add a GET /api/email/preview/:eventId endpoint

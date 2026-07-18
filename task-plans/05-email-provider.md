# Task 5 — Connect a real email provider

**Status:** Merged  
**Category:** next_steps

## What & Why
Without a real email provider, login codes and invitation emails only log to the console — members can never actually receive them.

## Done
- First pass integrated Gmail via the Replit Connectors SDK (OAuth proxy), then a later pass (2026-07) replaced that with **Gmail SMTP via Nodemailer**, since the Replit connector only works when the app is actually running inside Replit's infrastructure — it silently sent nothing once deployed elsewhere (e.g. Render).
- Sends through a Gmail account using an [App Password](https://myaccount.google.com/apppasswords), configured via `GMAIL_USER` / `GMAIL_APP_PASSWORD` environment variables
- `EMAIL_FROM` environment variable controls the sender address shown to recipients (defaults to `GMAIL_USER` if unset)
- Falls back to console logging when `GMAIL_USER` / `GMAIL_APP_PASSWORD` are not set (safe for local dev)
- All outbound emails logged to `email_log` table regardless of send status

## Configuration
Set these environment secrets:
- `GMAIL_USER` — the sending Gmail address (2-Step Verification must be enabled on the account)
- `GMAIL_APP_PASSWORD` — a 16-character App Password generated for that account
- `EMAIL_FROM` — optional; e.g. `Wine Circle <winecircle@gmail.com>`

## Relevant files
- `server/services/email.js`

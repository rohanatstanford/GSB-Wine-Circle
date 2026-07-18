# Task 2 — Build the backend API and database

**Status:** Merged  
**Category:** next_steps

## What & Why
Foundation for the entire conversion. Replaces Google Sheets with a real PostgreSQL database and builds a REST API covering every operation the original Apps Script handled.

## Done
- PostgreSQL schema for: members, events, signups, fee_ledger, email_log, auth_codes, auth_sessions, settings, audit_log
- Express API endpoints:
  - Auth: send magic-link code, verify code, get session, logout
  - Members: list, create, update, deactivate, outstanding charges
  - Events: list, create, update, open/close/cancel, run lottery, finalize
  - Signups: enter lottery, decline by token, mark attendance, promote from waitlist
  - Fees: list outstanding, record payment, record waiver
  - Email: send invitation batch, send lottery-lost batch
  - Settings: read/update (admin-only) + public subset
  - Audit log: paginated read
  - Dev helpers: seed members, simulate signups
- Session middleware (token hash lookup, expiry check)
- Fee-block enforcement on signup
- Flake detection on finalize (24-hour window)
- Auto-waitlist-promotion on decline
- Email sending via Resend (logs to console if key not set)
- Audit log on every admin action
- Scheduled job: prune expired auth codes/sessions daily

## Relevant files
- `server/index.js` — Express app entry point
- `server/db.js` — PostgreSQL connection pool
- `server/schema.sql` — full database schema
- `server/seed.sql` — default settings
- `server/middleware/auth.js` — session resolution, requireAuth, requireAdmin
- `server/routes/` — all route files
- `server/services/email.js` — email templates and sending
- `server/services/audit.js` — audit log helper

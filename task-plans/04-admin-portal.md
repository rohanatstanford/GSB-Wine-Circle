# Task 4 — Build the admin / leadership web portal

**Status:** Merged  
**Category:** next_steps

## What & Why
Leadership previously managed everything via a Google Sheets custom menu. This task built a proper admin UI for all leadership operations.

## Done
- `public/admin.html` — admin SPA
  - Admin login (same magic-link flow, gated to `is_admin = true`)
  - Members table: list, search/filter, add, edit, deactivate, record payment
  - Events dashboard: list all events with status badges; per-event detail page
  - Per-event actions: open/close signups, run lottery, send invitation emails, send lottery-lost emails, mark attendance (checklist), finalize event, toggle auto-promote
  - Fee ledger: outstanding fees per member, record payment/waiver
  - Audit log viewer: paginated table of all admin actions
  - Email log viewer: history of every outbound email with status

## Relevant files
- `public/admin.html`
- `server/routes/events.js`
- `server/routes/members.js`
- `server/routes/fees.js`
- `server/routes/audit.js`

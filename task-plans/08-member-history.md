# Task 8 — Let members see their past events and signup history

**Status:** Merged  
**Category:** next_steps

## What & Why
Members had no way to see which events they'd signed up for, whether they attended, or when they accrued fees. Deferred from Phase 1 in the original design.

## Done
- "My history" section added to member portal (`public/index.html`)
- Lists past signups with: event name, date, status (Attended / Dropped / Flaked / etc.)
- Outstanding fees shown with the event that caused them and the ePay link
- Uses existing `GET /api/signups/my` and `GET /api/fees/my` endpoints

## Relevant files
- `public/index.html`
- `server/routes/signups.js` — GET /api/signups/my
- `server/routes/fees.js` — GET /api/fees/my

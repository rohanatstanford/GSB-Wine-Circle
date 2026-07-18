# Task 13 — Prevent fee balance bugs caused by duplicated fee-calculation logic

**Status:** Proposed

## What & Why
Fee balance is computed in two places: once in `server/routes/fees.js` (the `recomputeBalance` helper) and again inline in `server/routes/signups.js` (the decline/flake path). If these diverge, a member's displayed balance can differ from their actual balance, leading to members being incorrectly blocked or unblocked.

## Done looks like
- Single canonical `recomputeBalance(client, memberId)` function, shared from one module (e.g. `server/services/fees.js`)
- All fee mutations (charge, payment, waiver) call this one function after writing to fee_ledger
- No inline balance arithmetic scattered across route files

## Relevant files
- `server/routes/fees.js` — recomputeBalance defined here
- `server/routes/signups.js` — inline balance update in flake path
- `server/routes/events.js` — inline balance update in finalize path

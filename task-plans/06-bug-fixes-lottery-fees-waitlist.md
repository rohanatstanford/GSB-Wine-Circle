# Task 6 — Catch lottery, flake-fee, and waitlist bugs before they affect real members

**Status:** Merged  
**Category:** test_gaps / bug fixes

## What & Why
The lottery, flake-fee, and waitlist-promotion logic are the most financially consequential parts of the system. Bugs here directly affect members (wrong fees, missed promotions, incorrect lottery results).

## Done
- Reviewed and fixed edge cases in:
  - Lottery: Fisher-Yates shuffle correctness, capacity boundary conditions
  - Flake detection: grace window calculation using event_date timezone handling
  - Waitlist auto-promotion: correct ordering by lottery_rank, proper token generation
  - Fee ledger: balance recomputation after payments/waivers

## Relevant files
- `server/routes/events.js` — run-lottery, finalize
- `server/routes/signups.js` — decline, promote
- `server/routes/fees.js` — payment, waiver, recompute balance

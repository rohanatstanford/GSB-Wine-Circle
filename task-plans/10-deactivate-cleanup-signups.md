# Task 10 — Prevent deactivating a member from leaving their pending signups in limbo

**Status:** Proposed

## What & Why
When an admin deactivates a member, any Pending or Invited signups they have remain in the database unchanged. This means deactivated members stay in lottery pools and invitation lists, distorting counts and potentially sending emails to people who should no longer receive them.

## Done looks like
- Deactivating a member automatically cancels their open signups (Pending → Cancelled, Invited → Dropped with waitlist promotion if applicable)
- Admin sees a confirmation warning listing how many open signups will be affected before confirming
- Audit log records the cascade

## Relevant files
- `server/routes/members.js` — POST /:id/deactivate
- `server/routes/signups.js` — waitlist promotion logic to reuse

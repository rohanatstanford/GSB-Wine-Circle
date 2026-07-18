# Task 14 — Make sure lottery winners and waitlisted members are notified automatically after the lottery runs

**Status:** Proposed

## What & Why
Running the lottery assigns Invited/Waitlist statuses but does not send any emails automatically. Admins must separately click "Send Invitation Emails" and optionally "Send Lottery-Lost Emails." If an admin forgets, members are never told the outcome.

## Done looks like
- Option on the "Run Lottery" confirmation dialog: "Also send invitation emails now" (checked by default)
- Option: "Also send lottery-lost emails now" (respects the per-event `send_lottery_lost_emails` setting)
- If checked, emails are sent as part of the same operation and the result shows counts (e.g. "Lottery run: 40 invited, 20 waitlisted. 40 invitation emails sent.")
- Still possible to send emails separately for cases where the admin wants to review first

## Relevant files
- `server/routes/events.js` — POST /:id/run-lottery
- `server/routes/email.js` — send-invites and send-lost-emails endpoints
- `public/admin.html` — lottery confirmation dialog

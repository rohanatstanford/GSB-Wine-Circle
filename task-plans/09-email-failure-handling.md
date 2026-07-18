# Task 9 — Prevent members from being locked out when the login code email silently fails

**Status:** Cancelled

## What & Why
If the email provider rejects the magic-link code email (bad API key, rate limit, invalid address), the server currently returns `ok: true` to avoid leaking membership — but the member never receives their code and has no way to log in or know what happened.

## Planned scope
- Surface a non-leaking error state to the login form when email delivery definitively fails
- Add admin visibility into recent failed email sends (already partially available in email_log)
- Consider a retry mechanism for transient failures

## Why cancelled
Task was cancelled by the user before implementation.

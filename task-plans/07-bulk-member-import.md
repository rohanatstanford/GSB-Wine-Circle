# Task 7 — Let admins import existing members from a spreadsheet

**Status:** Cancelled

## What & Why
Without a bulk-import path, an admin must create each member individually — tedious for any roster larger than a handful. A CSV import would let leadership migrate in seconds.

## Planned scope
- `POST /api/members/import` accepting CSV or JSON array
- Columns: email, full_name, affiliation, is_admin, can_clear_fees
- Duplicate emails skipped (idempotent)
- Returns summary: created, skipped, errors
- "Import members" file-upload button in the admin Members page

## Why cancelled
Task was cancelled by the user before implementation.

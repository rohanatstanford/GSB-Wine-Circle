# Wine Circle App

A Google Apps Script event management system for a university wine circle. Members can sign up for event lotteries, and leadership can manage events, run lotteries, track attendance, and enforce flake fees.

## Current state

The project was imported as Apps Script source files (`.gs` + `.html`). The goal is to **convert this into a standalone full-stack web app** — no Google Sheets dependency — retaining all existing functionality.

## Existing functionality (to be preserved)

**Member portal**
- Magic-link / 6-digit code login (email-based, no passwords)
- View open events with signup status
- Enter lottery for an event (blocked if outstanding fee)
- View invitations and decline them via unique link
- Outstanding fee banner with ePay link and leadership contact

**Admin / leadership portal** (currently a Google Sheets custom menu)
- Create events (generates per-event signup sheet today)
- Open / close signups for an event
- Run lottery (random rank assignment → top N get invited)
- Send invitation emails (batch)
- Mark attendance
- Finalize event (auto-charge flakers)
- Mark fees paid (requires `can_clear_fees` permission)
- Send "lottery lost" emails (optional per event)
- Auto-promote from waitlist on drop (toggleable per event)

**System behavior**
- Fee validation on signup (blocks members with outstanding balance)
- Unique decline tokens in invitation emails
- Auto-waitlist promotion on decline
- $30 flake fee for late declines (within 24 h of event)
- Email log and audit log for every action
- Dev/test helpers: seed members, simulate signups, log in as a test member

## Source files (Apps Script)

| File | Purpose |
|---|---|
| `00_Constants.gs` | Schema definitions, tab names, column lists |
| `01_Bootstrap.gs` | One-time sheet setup |
| `02_Lib.gs` | Low-level sheet helpers |
| `03_Auth.gs` | Magic-link auth, sessions |
| `04_Members.gs` | Member CRUD |
| `05_Events.gs` | Event CRUD, open/close, lottery |
| `06_Signups.gs` | Signup lifecycle, waitlist promotion |
| `07_Fees.gs` | Fee ledger, flake detection |
| `08_Email.gs` | All outbound email templates |
| `09_Web.gs` | Web entry point + RPC handlers |
| `10_Menu.gs` | Admin menu actions |
| `app.html` | Member SPA shell |
| `attendance.html` | Attendance marking UI |
| `decline.html` | Decline-by-token landing page |
| `_Stylesheet.html` | Shared CSS |
| `appsscript.json` | Apps Script manifest |

## User preferences

- Keep the existing feature set intact during conversion — no scope cuts unless discussed.
- Replace Google Sheets with a real database.
- Build a proper web app with separate member and admin UIs.

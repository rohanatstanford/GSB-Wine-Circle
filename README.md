# Wine Circle App — Phase 1 (MVP)

Working code for the Apps Script + Google Sheets system per the design sketch.

## What's in Phase 1

**Members can:** log in via 6-digit email code, see open events, sign up for events, see their invitations, and decline invitations. Members with an outstanding flake fee see a banner that lists which event(s) the fee is from, the ASSU ePay link to pay, and the leadership email for questions/appeals.

**Admins can (via a custom menu in the Sheet):** create events, open/close signups, run lotteries, send invitation emails, mark attendance, finalize events (auto-flake), and (for those with `can_clear_fees=TRUE`) mark fees paid.

**The system automatically:** validates fee status on signup, emails invitees with unique decline links, auto-promotes from waitlist on drops (toggleable per event), charges $30 to flakers, blocks members with outstanding fees from signing up, and logs every email sent and every admin action.

**What's NOT in Phase 1** (deferred to Phase 2): admin web UI for non-technical actions, member history view in the web app, web-based audit log explorer. All of these are accessible directly in the Sheet.

## Data layout

The **master spreadsheet** contains: Members, Events, FeeLedger, EmailLog, AuthCodes, AuthSessions, Settings, AuditLog. There is no master Signups tab.

Each **event has its own spreadsheet**, automatically created on event creation. Per-event spreadsheets are named `MM-DD Event Name` and live in a `YYYY Events` subfolder of the master spreadsheet's parent folder. Each one contains:

- An **About** tab with the event metadata (name, date, location, capacity, event ID, link back to master).
- A **Signups** tab with one row per signup, including denormalized `Member Name` / `Member Email` / `Event Name` so leaders running the event don't have to cross-reference the master.

Attendance is recorded in the per-event spreadsheet (the source of truth). Anything that needs to query signups across all events — a member's invitations, finalize/lottery counts, the eventual admin dashboard — walks the per-event spreadsheets via the helpers in `06_Signups.gs`.

Sheet column headers are Title Case display labels (e.g. `Member ID`, `Signed Up At`). Code keys remain snake_case via `SCHEMA[tabName]`, so renaming a sheet header by hand won't break anything; re-running `bootstrapSheet` resets headers to the canonical labels.

---

## Setup (one-time, ~20 minutes)

### 1. Create the master Sheet

- Sign in to drive.google.com under your **Wine Circle org account** (not personal).
- New → Google Sheet. Title it: `Wine Circle Master`.

### 2. Open the Apps Script editor

In the new Sheet: Extensions → Apps Script. Delete the default contents of `Code.gs` — we'll replace everything.

### 3. Create the project files

For each `.gs` file in this `Wine Circle App` folder:

- In the editor: File → New → Script. Name it the same as the file (the numeric prefix like `00_` is just for ordering in the editor sidebar — keep it or drop it, doesn't matter).
- Paste the file's contents.

For each `.html` file:

- In the editor: File → New → HTML. Name it the same as the file (without `.html` — Apps Script adds it).
- Paste the contents.

For `appsscript.json` (the manifest):

- In the editor: Project Settings (gear icon, left sidebar). Check **"Show 'appsscript.json' manifest file in editor"**.
- Open the manifest tab in the editor and replace its contents with `appsscript.json` from this folder.

### 4. Run the bootstrap

- In the editor's function dropdown (top toolbar), select `bootstrapSheet`.
- Click Run. Authorize when prompted (this grants the script permission to manage the Sheet, create per-event spreadsheets in Drive, and send mail on behalf of the org account).
- Wait ~10 seconds. You'll see master tabs created/updated with Title Case headers, and an alert when complete. Per-event spreadsheets are created on-demand the first time you create an event, not at bootstrap time.

Re-running `bootstrapSheet` after a code update is safe — it refreshes header labels and seeds any newly-introduced default settings without overwriting your existing values.

### 5. Add your members

Open the Members tab in the Sheet. Paste your roster. Required columns at minimum: `email`, `full_name`, `affiliation`. Leave `member_id` blank — the script fills these in automatically.

For the 12 leaders: set `is_admin` to `TRUE`.
For the 4 fee-clearing roles (CFO, COO, two Co-Presidents): also set `can_clear_fees` to `TRUE`.

Set `status` to `Active` for everyone, and `fee_balance` to `0`.

### 6. Deploy the web app

- In the editor: Deploy → New deployment.
- Type: **Web app**.
- Description: `Wine Circle v1`.
- Execute as: **Me** (the org account).
- Who has access: **Anyone** — required so partners without Google accounts can use the app. Security is handled by our magic-link auth.
- Click Deploy. Authorize again if prompted.
- Copy the resulting `/exec` URL.

Back in the Sheet's Settings tab, find the row with key `web_app_url` and paste the URL into the `value` column. (Decline links in invitation emails won't work until this is set.)

### 7. Test it

- Open the web app URL in an incognito window.
- Enter your roster email. Check Gmail for a 6-digit code.
- Enter the code. You should land on the home page.
- Try creating a draft event from the Sheet menu, opening signups, signing yourself up from the web app.

---

## Daily / per-event use

In the Sheet, you'll see a custom menu: **Wine Circle**. Items:

- **New Event…** — prompts for name, date, capacity, etc. Creates a Draft event.
- **Open Signups for selected event** — Draft → Open. Pick this after selecting any cell in the event's row in the Events tab.
- **Close Signups for selected event** — Open → Closed. No new signups accepted.
- **Run Lottery for selected event** — randomizes signups, assigns Invited / Waitlist / Lost.
- **Send Invitations for selected event** — emails everyone per their lottery result.
- **Mark Attendance for selected event** — opens a side panel of invitees with checkboxes.
- **Finalize Event for selected event** — auto-flakes any Invited member not marked Attended, charges $30 fees, blocks those members. Sets status → Completed.
- **Mark Fee Paid for selected member** — only for `can_clear_fees=TRUE` admins. Records a payment in the FeeLedger, decrements balance, unblocks if balance hits zero, sends confirmation email. Prompts for the ASSU ePay reference.

To use any "selected event" item, click any cell in that event's row first. Same for "selected member."

## Adjusting settings

The Settings tab has all configurable values. Edit the `value` column directly; changes take effect on the next script run.

Notable settings:

- `flake_fee_amount` — currently $30
- `decline_grace_window_hours` — currently 24
- `default_capacity`, `default_auto_invite_enabled`, `default_send_lottery_lost_emails` — applied to new events
- `assu_epay_url` — payment portal link used in flake notices and the member-facing blocked banner
- `leadership_email` — contact shown to blocked members for questions/appeals (defaults to `gsb_winecircle-leadership@lists.stanford.edu`)
- `events_drive_folder_id` — optional override for where per-event spreadsheets live; if blank, they're created beside the master spreadsheet in `YYYY Events` subfolders
- `web_app_url` — the deployed URL (paste after first deploy)

## Inspecting data

Open the master Sheet for cross-event records (members, fees, audit log, emails). Open the per-event spreadsheet (in the relevant `YYYY Events` folder, or via the link recorded on the event row's `Event Spreadsheet ID`) for that event's signups and attendance.

Useful pivots:

- Within a per-event spreadsheet, group Signups by `Status` → per-event fill and flake rates.
- Filter Members by `Fee Balance > 0` → currently blocked members.
- Group FeeLedger by `Event Name` → flake fees by event.
- Group FeeLedger by month → fee revenue over time.

Phase 2's admin web UI will provide cross-event roll-ups (per-member flake/attend rates, dashboard metrics) so you don't have to walk per-event spreadsheets manually.

## Troubleshooting

If a script run fails: check Apps Script's Executions tab (left sidebar in the editor) for the error message. The AuditLog tab in the Sheet shows what actions completed before the failure.

If members aren't getting emails: check the EmailLog tab. Every send attempt is recorded with status (`Sent` / `Failed`) and error message. Common causes are typos in the email address or hitting Gmail's daily quota (1,500/day on a Workspace account, plenty for our scale).

If you need to test as a member without giving someone a real account: add a row to Members with a test email you control, and use that to log in from incognito.

## Testing with sample data

The dev helpers in `90_Dev.gs` let you run end-to-end lottery scenarios without spamming real members. Every helper refuses to run unless `dev_mode_enabled = TRUE` in the Settings tab.

**One-time setup**

1. In the Settings tab, set `dev_mode_enabled` to `TRUE`.
2. Reload the Sheet — a new "Dev (testing only)" submenu appears under "Wine Circle".

**Recommended walk-through**

1. **Seed test members.** Wine Circle → Dev → "Seed test members…". Pick a count (start with 10) and a base email (defaults to your own). Test users are named "Test User 01" … "Test User 10" with plus-addressed aliases (`you+wctest01@stanford.edu`, etc.) so all their mail still routes to your real inbox. Each is tagged `TEST` in the notes column.
2. **Create an event** from the normal "New Event…" menu. A per-event spreadsheet appears in the relevant `YYYY Events` folder.
3. **Open Signups** for that event from the menu.
4. **Simulate signups.** Wine Circle → Dev → "Simulate signups for selected event…". Pick a count above the event's capacity (e.g., 60 signups against capacity 40) so you exercise the waitlist path. This bulk-inserts Pending rows directly into the per-event Signups tab — no mailbox traffic.
5. **Run the lottery and send invitations** as normal. Invitation emails will all land in your inbox (because of plus-addressing). Open one, click the decline link, watch the auto-promotion happen on the per-event sheet, mark some attendance from the sidebar, finalize the event. Check that flakers get charged and blocked.
6. **Drive the member-facing app from a test user's perspective.** Wine Circle → Dev → "Log in as test member…". Enter a test user's email. The dialog shows a one-line `localStorage.setItem(...)` snippet — paste it into the deployed web app's DevTools console and reload. You're now signed in as that test member without the magic-link round-trip.
7. **Reset and re-run.** Wine Circle → Dev → "Reset selected event" sends every signup back to Pending, clears the lottery state, and undoes any flake charges from this event so balances don't accumulate across runs. Useful for re-testing the same scenario repeatedly.
8. **Clean up.** Wine Circle → Dev → "Wipe ALL test data" removes every TEST-flagged member, their signups across all per-event spreadsheets, and any FeeLedger rows tied to them. Real members are untouched.
9. **Set `dev_mode_enabled` back to FALSE before going live.** The Dev submenu disappears on the next Sheet reload, and the helpers all start refusing to run.

Every dev action is recorded in the AuditLog with `admin_email = 'dev'` so you can spot test runs vs. real activity at a glance.

## Re-deploying after code changes

After editing any `.gs` or `.html` file: Deploy → Manage deployments → pencil icon on the active deployment → Version: New version → Deploy. The URL stays the same.

## Upgrading from an earlier version

If you had a pre-per-event-spreadsheets version of this script deployed:

1. Replace the contents of every file in the editor with the new versions in this folder, including `appsscript.json`. The manifest's OAuth scopes have widened — full `spreadsheets` (not just `currentonly`) and `drive` are now required because the script creates per-event spreadsheets and folders.
2. Run `bootstrapSheet` once. It will refresh master headers to Title Case, seed any new default settings (like `leadership_email`), and rename a stale master `Signups` tab to `Signups (legacy ...)` so you don't lose data accidentally.
3. Re-authorize when prompted — the new Drive scope will trigger a fresh consent screen.
4. Deploy → Manage deployments → New version. Members may need to log in again if their session-cookie domain shifts; usually it does not.
5. If you have existing events without a per-event spreadsheet attached, run `provisionMissingEventSpreadsheets` from the editor's function dropdown.

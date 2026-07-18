// =============================================================================
// Bootstrap.gs — one-time setup. Run bootstrapSheet() once after pasting all
// files into the Apps Script editor and replacing the manifest. It's also
// idempotent — safe to re-run after a code update to refresh headers and seed
// any new default settings.
// =============================================================================

function bootstrapSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create or update each master tab with its display-label header row.
  Object.keys(MASTER_SCHEMA).forEach(function(tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) sheet = ss.insertSheet(tabName);
    var labels = headerLabelsFor_(tabName);
    sheet.getRange(1, 1, 1, labels.length).setValues([labels]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, labels.length).setFontWeight('bold').setBackground('#fef7f4');
    sheet.autoResizeColumns(1, labels.length);
    if (sheet.getMaxColumns() > labels.length) {
      sheet.deleteColumns(labels.length + 1, sheet.getMaxColumns() - labels.length);
    }
  });

  // Signups now lives in per-event spreadsheets — remove any stale master tab.
  var staleSignups = ss.getSheetByName(TAB.SIGNUPS);
  if (staleSignups) {
    if (staleSignups.getLastRow() > 1) {
      staleSignups.setName('Signups (legacy ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmm') + ')');
    } else {
      ss.deleteSheet(staleSignups);
    }
  }

  // Drop the default Sheet1 if it's still around and empty.
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(sheet1);
  }

  // Seed any missing default settings (idempotent: never overwrites edits).
  seedDefaultSettings_();

  // Seed example admin row hint in Members if it's empty.
  var membersSheet = ss.getSheetByName(TAB.MEMBERS);
  if (membersSheet.getLastRow() < 2) {
    var hintRow = ['', 'replace.with.your.email@stanford.edu', 'Your Name', 'MBA2', true, true, 0, MEMBER_STATUS.ACTIVE, new Date(), 'Replace this row with your actual roster.'];
    membersSheet.getRange(2, 1, 1, hintRow.length).setValues([hintRow]);
    membersSheet.getRange(2, 1, 1, hintRow.length).setBackground('#fff8dc');
  }

  SpreadsheetApp.flush();
  SpreadsheetApp.getUi().alert(
    'Wine Circle bootstrap complete.\n\n' +
    'Master tabs are up to date with Title Case headers.\n' +
    'Signups now live in per-event spreadsheets — a new spreadsheet is\n' +
    'created automatically for each event in a "YYYY Events" folder beside\n' +
    'this master sheet.\n\n' +
    'Next steps (first-time setup only):\n' +
    '  1. Replace the placeholder row in Members with your real roster.\n' +
    '  2. Reload the Sheet so the Wine Circle menu appears.\n' +
    '  3. Deploy → New deployment as a Web app (see README).\n' +
    '  4. Paste the deployed URL into Settings → web_app_url.'
  );
}

// Adds any DEFAULT_SETTINGS rows that aren't already in the Settings tab.
// Doesn't touch existing values. Useful when new settings are introduced via
// a code update.
function seedDefaultSettings_() {
  var existing = readAll_(TAB.SETTINGS);
  var have = {};
  existing.forEach(function(r) { if (r.key) have[r.key] = true; });
  DEFAULT_SETTINGS.forEach(function(row) {
    if (!have[row[0]]) {
      append_(TAB.SETTINGS, { key: row[0], value: row[1], description: row[2] });
    }
  });
}

// Idempotent: fills missing member_ids in the Members tab.
// Run on demand if you bulk-paste new members without IDs.
function backfillMemberIds() {
  withLock_(function() {
    var members = readAll_(TAB.MEMBERS);
    members.forEach(function(m) {
      if (!m.member_id) {
        var email = normalizeEmail_(m.email);
        if (email) {
          updateRow_(TAB.MEMBERS, m._rowIndex, { member_id: uid_('m_') });
        }
      }
    });
  });
  SpreadsheetApp.getActive().toast('Member IDs backfilled.');
}

// Re-bootstrap the per-event spreadsheets for any event that's missing one.
// Useful if you upgraded mid-cycle or deleted a per-event sheet by accident.
function provisionMissingEventSpreadsheets() {
  withLock_(function() {
    var events = readAll_(TAB.EVENTS);
    var fixed = 0;
    events.forEach(function(ev) {
      if (!ev.event_id) return;
      if (ev.event_spreadsheet_id) {
        try { openSpreadsheetById_(ev.event_spreadsheet_id); return; }
        catch (err) { /* spreadsheet missing — recreate */ }
      }
      provisionEventSpreadsheet_(ev);
      fixed++;
    });
    SpreadsheetApp.getActive().toast('Provisioned ' + fixed + ' event spreadsheet(s).');
  });
}

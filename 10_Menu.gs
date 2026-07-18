// =============================================================================
// Menu.gs — custom Sheet menu for admins.
// Phase 1 admin actions live here; in Phase 2 these will move to the web app.
// =============================================================================

function onOpen() {
  var ui = SpreadsheetApp.getUi();
  var menu = ui.createMenu('Wine Circle')
    .addItem('New Event…', 'menuNewEvent')
    .addSeparator()
    .addItem('Open Signups for selected event', 'menuOpenSignups')
    .addItem('Close Signups for selected event', 'menuCloseSignups')
    .addItem('Run Lottery for selected event', 'menuRunLottery')
    .addItem('Send Invitations for selected event', 'menuSendInvitations')
    .addSeparator()
    .addItem('Mark Attendance for selected event', 'menuMarkAttendance')
    .addItem('Finalize Event for selected event', 'menuFinalize')
    .addSeparator()
    .addItem('Mark Fee Paid for selected member', 'menuMarkFeePaid')
    .addItem('Waive Fee for selected member', 'menuWaiveFee')
    .addSeparator()
    .addItem('Backfill member IDs', 'backfillMemberIds')
    .addItem('Prune expired auth codes/sessions', 'pruneExpiredAuth');

  // Show the Dev submenu only when dev_mode_enabled is TRUE in Settings.
  // getSetting_ tolerates a missing/empty Settings tab during first bootstrap.
  var devOn = false;
  try { devOn = getSettingBool_('dev_mode_enabled', false); } catch (err) { devOn = false; }
  if (devOn) {
    var devMenu = ui.createMenu('Dev (testing only)')
      .addItem('Seed test members…', 'menuDevSeedTestMembers')
      .addItem('Simulate signups for selected event…', 'menuDevSimulateSignups')
      .addItem('Log in as test member…',           'menuDevLoginAs')
      .addSeparator()
      .addItem('Reset selected event (re-runnable lottery)', 'menuDevResetEvent')
      .addItem('Wipe ALL test data', 'menuDevWipeTestData');
    menu = menu.addSeparator().addSubMenu(devMenu);
  }
  menu.addToUi();
}

// ---- Event menu actions ----------------------------------------------------

function menuNewEvent() {
  requireAdmin_();
  var ui = SpreadsheetApp.getUi();
  var name = promptText_(ui, 'Event name', '');
  if (name === null) return;
  var dateStr = promptText_(ui, 'Event date & time (e.g., 2026-09-15 18:30)', '');
  if (dateStr === null) return;
  var location = promptText_(ui, 'Location', '');
  if (location === null) return;
  var capStr = promptText_(ui, 'Capacity (default ' + getSettingNum_('default_capacity', 60) + ')', '');
  if (capStr === null) return;
  var description = promptText_(ui, 'Short description (shown to members)', '');
  if (description === null) return;
  var closesStr = promptText_(ui, 'Signup closes at (e.g., 2026-09-13 23:59), blank = no auto-close', '');
  if (closesStr === null) return;

  var ev = createEvent_({
    name: name,
    event_date: dateStr ? new Date(dateStr) : '',
    location: location,
    capacity: capStr,
    description: description,
    signup_closes_at: closesStr ? new Date(closesStr) : ''
  }, currentAdminEmail_());

  ui.alert('Created event "' + ev.name + '" as Draft.\n\n' +
           'Click any cell in its row in the Events tab, then choose "Open Signups for selected event" when ready.');
}

function menuOpenSignups()    { transitionSelectedEvent_(EVENT_STATUS.OPEN,   'Signups opened.'); }
function menuCloseSignups()   { transitionSelectedEvent_(EVENT_STATUS.CLOSED, 'Signups closed.'); }

function menuRunLottery() {
  requireAdmin_();
  var ev = selectedEventOrThrow_();
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Run lottery for "' + ev.name + '"?\nCapacity: ' + ev.capacity, ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  var result = runLottery_(ev.event_id, currentAdminEmail_());
  ui.alert('Lottery complete.\n\nInvited: ' + result.invited + '\nWaitlist: ' + result.waitlist + '\nTotal signups: ' + result.total +
           '\n\nNext: "Send Invitations for selected event".');
}

function menuSendInvitations() {
  requireAdmin_();
  var ev = selectedEventOrThrow_();
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert('Send invitation emails for "' + ev.name + '"?', ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  var result = sendInvitations_(ev.event_id, currentAdminEmail_());
  ui.alert('Emails sent.\n\nInvited: ' + result.invited + '\nWaitlist: ' + result.waitlist + '\nErrors: ' + result.errors +
           (result.errors > 0 ? '\n\nCheck the EmailLog tab for failed sends.' : ''));
}

function menuMarkAttendance() {
  requireAdmin_();
  var ev = selectedEventOrThrow_();
  var html = HtmlService.createTemplateFromFile('attendance');
  html.eventId = ev.event_id;
  html.eventName = ev.name;
  SpreadsheetApp.getUi().showSidebar(
    html.evaluate().setTitle('Attendance — ' + ev.name).setWidth(420)
  );
}

function menuFinalize() {
  requireAdmin_();
  var ev = selectedEventOrThrow_();
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Finalize "' + ev.name + '"?\n\n' +
    'This will:\n' +
    ' • Auto-flake any Invited member not marked Attended\n' +
    ' • Charge $' + getSettingNum_('flake_fee_amount', 30) + ' to each flake\n' +
    ' • Block those members until the fee is paid\n' +
    ' • Mark the event as Completed',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  var result = finalizeEvent_(ev.event_id, currentAdminEmail_());
  ui.alert('Event finalized.\n\nFlaked: ' + result.flaked + '\nWaitlist losers: ' + result.lost);
}

// ---- Fee menu actions ------------------------------------------------------

function menuMarkFeePaid() {
  requireFeeClearer_();
  var ui = SpreadsheetApp.getUi();
  var member = selectedMemberOrThrow_();
  var bal = Number(member.fee_balance) || 0;
  if (bal <= 0) { ui.alert(member.full_name + ' has no outstanding balance.'); return; }
  var amtStr = promptText_(ui, 'Amount paid for ' + member.full_name + ' (current balance $' + bal + ')', String(bal));
  if (amtStr === null) return;
  var ref = promptText_(ui, 'ASSU ePay confirmation reference (paste from ePay)', '');
  if (ref === null) return;
  var notes = promptText_(ui, 'Notes (optional)', '');
  if (notes === null) return;
  var result = recordPayment_(member.member_id, amtStr, ref, currentAdminEmail_(), notes);
  ui.alert('Payment recorded.\n\nNew balance: $' + result.balance + (result.balance <= 0 ? '\nMember unblocked.' : ''));
}

function menuWaiveFee() {
  requireFeeClearer_();
  var ui = SpreadsheetApp.getUi();
  var member = selectedMemberOrThrow_();
  var bal = Number(member.fee_balance) || 0;
  if (bal <= 0) { ui.alert(member.full_name + ' has no outstanding balance.'); return; }
  var amtStr = promptText_(ui, 'Amount to waive (current balance $' + bal + ')', String(bal));
  if (amtStr === null) return;
  var reason = promptText_(ui, 'Reason for waiver', '');
  if (reason === null) return;
  var result = recordWaiver_(member.member_id, amtStr, reason, currentAdminEmail_());
  SpreadsheetApp.getUi().alert('Waiver recorded.\n\nNew balance: $' + result.balance);
}

// ---- Helpers ---------------------------------------------------------------

function transitionSelectedEvent_(toStatus, successMsg) {
  requireAdmin_();
  var ev = selectedEventOrThrow_();
  setEventStatus_(ev.event_id, toStatus, currentAdminEmail_());
  SpreadsheetApp.getActive().toast('"' + ev.name + '": ' + successMsg);
}

function currentAdminEmail_() {
  return Session.getActiveUser().getEmail();
}

function requireAdmin_() {
  var email = currentAdminEmail_();
  var m = memberByEmail_(email);
  if (!m || !parseBool_(m.is_admin)) {
    throw new Error('Only admins can run this. Your email (' + email + ') is not flagged is_admin=TRUE in the Members tab.');
  }
}

function requireFeeClearer_() {
  var email = currentAdminEmail_();
  var m = memberByEmail_(email);
  if (!m || !parseBool_(m.can_clear_fees)) {
    throw new Error('Only the CFO, COO, or Co-Presidents can clear fees. Your email (' + email + ') is not flagged can_clear_fees=TRUE.');
  }
}

function selectedEventOrThrow_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== TAB.EVENTS) {
    throw new Error('First click any cell in an event\'s row in the Events tab, then run this menu item.');
  }
  var row = sheet.getActiveCell().getRow();
  if (row < 2) throw new Error('Select a data row in the Events tab (not the header).');
  var headers = SCHEMA[TAB.EVENTS];
  var values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  var obj = {};
  headers.forEach(function(h, i) { obj[h] = values[i]; });
  if (!obj.event_id) throw new Error('Selected row has no event_id.');
  return obj;
}

function selectedMemberOrThrow_() {
  var sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== TAB.MEMBERS) {
    throw new Error('First click any cell in a member\'s row in the Members tab, then run this menu item.');
  }
  var row = sheet.getActiveCell().getRow();
  if (row < 2) throw new Error('Select a data row in the Members tab (not the header).');
  var headers = SCHEMA[TAB.MEMBERS];
  var values = sheet.getRange(row, 1, 1, headers.length).getValues()[0];
  var obj = {};
  headers.forEach(function(h, i) { obj[h] = values[i]; });
  if (!obj.member_id) throw new Error('Selected row has no member_id. Run "Backfill member IDs" first.');
  return obj;
}

function promptText_(ui, label, defaultVal) {
  var resp = ui.prompt(label + (defaultVal ? '\n(default: ' + defaultVal + ')' : ''), ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return null;
  var v = resp.getResponseText();
  return (v === '' && defaultVal !== '') ? defaultVal : v;
}

// ---- Attendance sidebar RPC (called from attendance.html) ------------------

function attendanceList(eventId) {
  requireAdmin_();
  var rows = findAllSignups_(eventId, function(r) {
    return r.status === SIGNUP_STATUS.INVITED || r.status === SIGNUP_STATUS.ATTENDED;
  });
  return rows.map(function(s) {
    var m = memberById_(s.member_id);
    return {
      signup_id: s.signup_id,
      member_id: s.member_id,
      name: m ? m.full_name : (s.member_name || '(unknown)'),
      email: m ? m.email : (s.member_email || ''),
      status: s.status
    };
  }).sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });
}

function attendanceMark(signupId, attended) {
  requireAdmin_();
  markAttendance_(signupId, attended, currentAdminEmail_());
  return { ok: true };
}

// ---- Dev submenu handlers (visible only when dev_mode_enabled = TRUE) ------

function menuDevSeedTestMembers() {
  requireAdmin_();
  var ui = SpreadsheetApp.getUi();
  var nStr = promptText_(ui, 'How many test members should I seed? (default 10)', '10');
  if (nStr === null) return;
  var baseEmail = promptText_(ui, 'Base email for plus-addressing (default: your account)', currentAdminEmail_());
  if (baseEmail === null) return;
  var res = devSeedTestMembers(Number(nStr) || 10, baseEmail);
  ui.alert('Seeded ' + res.created + ' new test member(s).\n\nTotal test members now: ' + res.total_test_members);
}

function menuDevSimulateSignups() {
  requireAdmin_();
  var ev = selectedEventOrThrow_();
  var ui = SpreadsheetApp.getUi();
  var nStr = promptText_(ui, 'How many Pending signups to simulate for "' + ev.name + '"? (default 50)', '50');
  if (nStr === null) return;
  var res = devSimulateSignups(ev.event_id, Number(nStr) || 50);
  ui.alert('Created ' + res.created + ' Pending signup(s).\n\nNow run "Run Lottery for selected event" to test the lottery.');
}

function menuDevLoginAs() {
  requireAdmin_();
  var ui = SpreadsheetApp.getUi();
  var key = promptText_(ui, 'Member email or member_id to log in as', '');
  if (key === null || !key) return;
  var res = devLoginAs(key);
  ui.alert(
    'Token minted for ' + (res.full_name || res.email) + '.\n\n' +
    'Open the deployed web app, then in your browser DevTools console run:\n\n' +
    '  localStorage.setItem("wc_session_v1", "' + res.token + '");\n' +
    '  location.reload();\n\n' +
    '(Token also written to the script execution log.)'
  );
}

function menuDevResetEvent() {
  requireAdmin_();
  var ev = selectedEventOrThrow_();
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Reset "' + ev.name + '" for another lottery run?\n\n' +
    'This will:\n' +
    ' • Set every signup back to Pending\n' +
    ' • Clear lottery rank, decline tokens, sent-at timestamps\n' +
    ' • Set the event status back to Open\n' +
    ' • Delete every flake-fee charge that came from this event\n' +
    ' • Recompute affected balances and unblock if zero',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  var res = devResetEvent(ev.event_id);
  ui.alert('Reset ' + res.reset_signups + ' signup(s) and deleted ' + res.deleted_charges + ' charge(s).');
}

function menuDevWipeTestData() {
  requireAdmin_();
  var ui = SpreadsheetApp.getUi();
  var resp = ui.alert(
    'Wipe ALL test data?\n\n' +
    'This deletes every member tagged TEST in their notes, every signup\n' +
    'belonging to those members, and every FeeLedger row pointing at them.\n\n' +
    'Real (non-TEST) members are not touched. Continue?',
    ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  var res = devWipeTestData();
  ui.alert(
    'Wipe complete.\n\n' +
    'Members: '  + res.members_deleted + '\n' +
    'Signups: '  + res.signups_deleted + '\n' +
    'Ledger:  '  + res.ledger_deleted  + '\n' +
    'Sessions: ' + res.sessions_deleted
  );
}

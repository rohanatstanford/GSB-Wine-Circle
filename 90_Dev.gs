// =============================================================================
// Dev.gs — TESTING / DEVELOPMENT HELPERS. NOT FOR PRODUCTION USE.
//
// Every function here checks `dev_mode_enabled` in the Settings tab and
// refuses to run unless it's TRUE. Flip dev mode OFF before going live.
//
// Recommended flow for testing the lottery end-to-end without spamming real
// emails:
//
//   1. In Settings, set dev_mode_enabled = TRUE.
//   2. Reload the Sheet — a "Dev (testing only)" submenu appears under
//      "Wine Circle".
//   3. Run "Seed test members" — creates N members named "Test User NN" with
//      plus-addressed emails (rdighe+wctest01@stanford.edu, etc.) routed to
//      your real inbox so you can still receive magic-link codes.
//   4. Create an event from the normal "New Event…" menu and Open Signups.
//   5. Run "Simulate signups for selected event" — bulk-creates N Pending
//      signup rows attached to test members. No mailbox traffic.
//   6. Run the lottery, send invitations, etc. as normal — invitation emails
//      land in your inbox (because of plus-addressing) so you can verify
//      templates and the decline-link flow.
//   7. Use "Log in as test user…" if you need to drive the member-facing app
//      from a test member's perspective without typing magic-link codes.
//   8. "Reset event for selected event" wipes the lottery state so you can
//      re-run the same scenario.
//   9. When done testing, "Wipe all test data" removes every TEST-flagged
//      member and their signups/charges. Then set dev_mode_enabled = FALSE.
//
// All test members are tagged with `TEST` in the notes column so the wipe is
// surgical and won't touch real members.
// =============================================================================

const DEV_TEST_NOTE_TAG = 'TEST';
const DEV_DEFAULT_BATCH = 10;

// ---- Guard ------------------------------------------------------------------

function devGuard_() {
  if (!getSettingBool_('dev_mode_enabled', false)) {
    throw new Error('Dev helpers are disabled. Set Settings.dev_mode_enabled = TRUE to use them, and remember to flip it back to FALSE before going live.');
  }
}

function isTestMember_(member) {
  if (!member) return false;
  return String(member.notes || '').indexOf(DEV_TEST_NOTE_TAG) >= 0;
}

// Compute the plus-addressed alias for the Nth test member.
// "rdighe@stanford.edu" + 3 → "rdighe+wctest03@stanford.edu"
function devAliasEmail_(baseEmail, n) {
  var at = baseEmail.indexOf('@');
  if (at < 1) throw new Error('Invalid base email: ' + baseEmail);
  var local = baseEmail.slice(0, at);
  var domain = baseEmail.slice(at);
  var pad = (n < 10 ? '0' : '') + n;
  return local + '+wctest' + pad + domain;
}

// ---- Seed members ----------------------------------------------------------

// Creates `n` test members. Idempotent: if a member with the same alias email
// already exists, it's reused. Returns the array of all test members after the
// seed.
function devSeedTestMembers(n, baseEmail) {
  devGuard_();
  n = Number(n) || DEV_DEFAULT_BATCH;
  baseEmail = (baseEmail || Session.getActiveUser().getEmail() || '').trim();
  if (!baseEmail) throw new Error('No base email — pass one explicitly: devSeedTestMembers(10, "you@stanford.edu")');

  var created = 0;
  withLock_(function() {
    for (var i = 1; i <= n; i++) {
      var email = devAliasEmail_(baseEmail, i);
      var existing = memberByEmail_(email);
      if (existing) continue;
      var pad = (i < 10 ? '0' : '') + i;
      append_(TAB.MEMBERS, {
        member_id:      uid_('m_'),
        email:          email,
        full_name:      'Test User ' + pad,
        affiliation:    'TestCohort',
        is_admin:       false,
        can_clear_fees: false,
        fee_balance:    0,
        status:         MEMBER_STATUS.ACTIVE,
        date_joined:    new Date(),
        notes:          DEV_TEST_NOTE_TAG + ' — seeded ' + nowIso_()
      });
      created++;
    }
  });
  audit_('dev', 'DevSeedTestMembers', TAB.MEMBERS, '', null, { requested: n, created: created, baseEmail: baseEmail });
  Logger.log('devSeedTestMembers: ' + created + ' new test members (n=' + n + ', base=' + baseEmail + ')');
  return { created: created, total_test_members: devListTestMembers_().length };
}

function devListTestMembers_() {
  return findAll_(TAB.MEMBERS, isTestMember_);
}

// ---- Simulate signups ------------------------------------------------------

// Creates up to `n` Pending signup rows for the given event, attached to test
// members. If fewer than `n` test members exist, seeds more first. Returns
// counts.
function devSimulateSignups(eventId, n) {
  devGuard_();
  n = Number(n) || DEV_DEFAULT_BATCH;
  var ev = eventById_(eventId);
  if (!ev) throw new Error('Event not found: ' + eventId);

  // Self-heal: provision a per-event spreadsheet if missing.
  if (!ev.event_spreadsheet_id) {
    provisionEventSpreadsheet_(ev);
    ev = eventById_(eventId);
  }
  // Auto-open signups if the event is still a draft.
  if (ev.status === EVENT_STATUS.DRAFT) {
    setEventStatus_(eventId, EVENT_STATUS.OPEN, 'dev');
    ev = eventById_(eventId);
  }

  // Make sure we have at least n test members.
  var testMembers = devListTestMembers_();
  if (testMembers.length < n) {
    devSeedTestMembers(n);
    testMembers = devListTestMembers_();
  }

  // Skip members who already have a signup for this event.
  var existing = readSignups_(ev);
  var alreadySignedUp = {};
  existing.forEach(function(s) { alreadySignedUp[s.member_id] = true; });
  var pool = testMembers.filter(function(m) { return !alreadySignedUp[m.member_id]; });

  var created = 0;
  withLock_(function() {
    pool.slice(0, n).forEach(function(m) {
      appendSignup_(ev, {
        signup_id:        uid_('s_'),
        event_id:         ev.event_id,
        event_name:       ev.name || '',
        member_id:        m.member_id,
        member_name:      m.full_name || '',
        member_email:     m.email || '',
        email_at_signup:  m.email,
        signed_up_at:     nowIso_(),
        lottery_rank:     '',
        status:           SIGNUP_STATUS.PENDING,
        invite_sent_at:   '',
        decline_token:    '',
        declined_at:      '',
        attended_marked_at:'',
        marked_by:        '',
        notes:            DEV_TEST_NOTE_TAG
      });
      created++;
    });
  });
  audit_('dev', 'DevSimulateSignups', TAB.EVENTS, eventId, null, { created: created, requested: n });
  Logger.log('devSimulateSignups: created ' + created + ' Pending signup(s) for event "' + ev.name + '"');
  return { created: created, total_signups_now: existing.length + created };
}

// ---- Login-as -------------------------------------------------------------

// Mints a session token for an arbitrary member without the magic-link
// round-trip. Pass either a member_id or an email. Use only with
// dev_mode_enabled = TRUE; this completely bypasses auth.
//
// To use the token in the web app:
//   1. Open the deployed /exec URL.
//   2. DevTools console → run:
//        localStorage.setItem('wc_session_v1', '<TOKEN>'); location.reload();
function devLoginAs(memberIdOrEmail) {
  devGuard_();
  var key = String(memberIdOrEmail || '').trim();
  if (!key) throw new Error('Pass a member_id or email.');

  var member = key.indexOf('@') >= 0 ? memberByEmail_(key) : memberById_(key);
  if (!member) throw new Error('No member matches: ' + key);

  var token = uid_('') + uid_('');
  var ttlDays = getSettingNum_('session_ttl_days', 14);
  withLock_(function() {
    append_(TAB.SESSIONS, {
      token_hash:  hash_(token),
      member_id:   member.member_id,
      email:       member.email,
      created_at:  nowIso_(),
      expires_at:  addDays_(new Date(), ttlDays).toISOString()
    });
  });
  audit_('dev', 'DevLoginAs', TAB.SESSIONS, member.member_id, null, { email: member.email });
  Logger.log('devLoginAs(' + member.email + '): token=' + token);
  Logger.log('Paste in browser DevTools console:');
  Logger.log('  localStorage.setItem("wc_session_v1", "' + token + '"); location.reload();');
  return { token: token, member_id: member.member_id, email: member.email, full_name: member.full_name };
}

// ---- Reset event ----------------------------------------------------------

// Resets every signup for the event back to Pending and clears all lottery
// state. Also undoes any FeeLedger Charge rows that came from this event so
// balances and blocked-status don't accumulate across runs.
function devResetEvent(eventId) {
  devGuard_();
  var ev = eventById_(eventId);
  if (!ev) throw new Error('Event not found: ' + eventId);

  var resetSignups = 0;
  var deletedCharges = 0;
  var affectedMembers = {};

  withLock_(function() {
    // 1. Reset every signup row in the per-event spreadsheet.
    var signups = readSignups_(ev);
    signups.forEach(function(s) {
      updateSignupRow_(ev, s._rowIndex, {
        status:             SIGNUP_STATUS.PENDING,
        lottery_rank:       '',
        decline_token:      '',
        invite_sent_at:     '',
        declined_at:        '',
        attended_marked_at: '',
        marked_by:          ''
      });
      affectedMembers[s.member_id] = true;
      resetSignups++;
    });

    // 2. Reset the event row itself.
    updateRow_(TAB.EVENTS, ev._rowIndex, {
      status:         EVENT_STATUS.OPEN,
      lottery_run_at: ''
    });

    // 3. Delete FeeLedger Charge rows tied to this event. Walk bottom-up so
    //    row indices stay stable as we delete.
    var ledger = readAll_(TAB.FEE_LEDGER);
    ledger.slice().reverse().forEach(function(e) {
      if (e.event_id === eventId && String(e.type || '').toLowerCase() === 'charge') {
        affectedMembers[e.member_id] = true;
        deleteRow_(TAB.FEE_LEDGER, e._rowIndex);
        deletedCharges++;
      }
    });

    // 4. Recompute balances and unblock anyone whose only debt was this event.
    Object.keys(affectedMembers).forEach(function(mid) {
      var bal = recomputeBalance_(mid);
      if (bal <= 0) unblockMember_(mid, 'dev');
    });
  });

  audit_('dev', 'DevResetEvent', TAB.EVENTS, eventId, null,
         { reset_signups: resetSignups, deleted_charges: deletedCharges, members_touched: Object.keys(affectedMembers).length });
  Logger.log('devResetEvent: reset ' + resetSignups + ' signup(s), deleted ' + deletedCharges + ' charge(s) for "' + ev.name + '"');
  return { reset_signups: resetSignups, deleted_charges: deletedCharges };
}

// ---- Wipe test data -------------------------------------------------------

// Aggressive cleanup: deletes every TEST-flagged member, every signup
// belonging to those members across all per-event spreadsheets, and every
// FeeLedger row pointing at them. Use before going live.
function devWipeTestData() {
  devGuard_();

  var testMembers = devListTestMembers_();
  if (testMembers.length === 0) {
    Logger.log('devWipeTestData: no TEST-flagged members found.');
    return { members_deleted: 0, signups_deleted: 0, ledger_deleted: 0 };
  }
  var testIds = {};
  testMembers.forEach(function(m) { testIds[m.member_id] = true; });

  var signupsDeleted = 0;
  var ledgerDeleted = 0;
  var membersDeleted = 0;
  var sessionsDeleted = 0;

  withLock_(function() {
    // 1. Per-event signups for test members.
    var events = readAll_(TAB.EVENTS);
    events.forEach(function(ev) {
      if (!ev.event_spreadsheet_id) return;
      try {
        var ss = openSpreadsheetById_(ev.event_spreadsheet_id);
        var rows = readAll_(TAB.SIGNUPS, ss);
        rows.slice().reverse().forEach(function(s) {
          if (testIds[s.member_id]) {
            deleteRow_(TAB.SIGNUPS, s._rowIndex, ss);
            signupsDeleted++;
          }
        });
      } catch (err) { /* skip inaccessible event spreadsheets */ }
    });

    // 2. FeeLedger rows for test members.
    var ledger = readAll_(TAB.FEE_LEDGER);
    ledger.slice().reverse().forEach(function(e) {
      if (testIds[e.member_id]) {
        deleteRow_(TAB.FEE_LEDGER, e._rowIndex);
        ledgerDeleted++;
      }
    });

    // 3. Sessions for test members (so leftover dev tokens stop working).
    var sessions = readAll_(TAB.SESSIONS);
    sessions.slice().reverse().forEach(function(r) {
      if (testIds[r.member_id]) {
        deleteRow_(TAB.SESSIONS, r._rowIndex);
        sessionsDeleted++;
      }
    });

    // 4. Member rows themselves.
    var members = readAll_(TAB.MEMBERS);
    members.slice().reverse().forEach(function(m) {
      if (testIds[m.member_id]) {
        deleteRow_(TAB.MEMBERS, m._rowIndex);
        membersDeleted++;
      }
    });
  });

  audit_('dev', 'DevWipeTestData', '', '', null,
         { members: membersDeleted, signups: signupsDeleted, ledger: ledgerDeleted, sessions: sessionsDeleted });
  Logger.log('devWipeTestData: deleted ' + membersDeleted + ' member(s), ' + signupsDeleted + ' signup(s), ' + ledgerDeleted + ' ledger row(s), ' + sessionsDeleted + ' session(s).');
  return { members_deleted: membersDeleted, signups_deleted: signupsDeleted, ledger_deleted: ledgerDeleted, sessions_deleted: sessionsDeleted };
}

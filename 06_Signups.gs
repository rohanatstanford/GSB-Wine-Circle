// =============================================================================
// Signups.gs — the workhorse: signup creation, lottery, invitations, decline,
// auto-promotion, and event finalization.
//
// All signup data lives in per-event spreadsheets (one per event). We open the
// right spreadsheet via eventSpreadsheet_(eventOrId) and hand it to the Lib
// helpers as the optional `ss` argument. The master spreadsheet does NOT have
// a Signups tab.
// =============================================================================

// ---- Per-event signup helpers ----------------------------------------------

function readSignups_(eventOrId) {
  var ev = (typeof eventOrId === 'string') ? eventById_(eventOrId) : eventOrId;
  if (!ev) return [];
  if (!ev.event_spreadsheet_id) return [];
  try {
    return readAll_(TAB.SIGNUPS, openSpreadsheetById_(ev.event_spreadsheet_id));
  } catch (err) { return []; }
}

function findSignup_(eventOrId, predicate) {
  var rows = readSignups_(eventOrId);
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) return rows[i];
  return null;
}

function findAllSignups_(eventOrId, predicate) {
  return readSignups_(eventOrId).filter(predicate);
}

function appendSignup_(event, obj) {
  var ss = eventSpreadsheet_(event);
  obj.event_id   = obj.event_id   || event.event_id;
  obj.event_name = obj.event_name || event.name || '';
  return append_(TAB.SIGNUPS, obj, ss);
}

function updateSignupRow_(event, rowIndex, updates) {
  var ss = eventSpreadsheet_(event);
  return updateRow_(TAB.SIGNUPS, rowIndex, updates, ss);
}

// All signup rows for a given member, across every event spreadsheet. Each
// row gets a synthetic `_event` field for convenience.
function findSignupsByMember_(memberId) {
  var events = readAll_(TAB.EVENTS);
  var out = [];
  events.forEach(function(ev) {
    if (!ev.event_spreadsheet_id) return;
    try {
      var sigs = findAll_(TAB.SIGNUPS, function(r) { return r.member_id === memberId; },
                          openSpreadsheetById_(ev.event_spreadsheet_id));
      sigs.forEach(function(s) { s._event = ev; out.push(s); });
    } catch (err) { /* skip inaccessible event spreadsheets */ }
  });
  return out;
}

// Find a signup by signup_id without knowing which event it belongs to.
// Used by the decline-by-token flow which only carries a token.
function findSignupAnywhere_(predicate) {
  var events = readAll_(TAB.EVENTS);
  for (var i = 0; i < events.length; i++) {
    var ev = events[i];
    if (!ev.event_spreadsheet_id) continue;
    try {
      var ss = openSpreadsheetById_(ev.event_spreadsheet_id);
      var match = findRow_(TAB.SIGNUPS, predicate, ss);
      if (match) { match._event = ev; return match; }
    } catch (err) { /* skip */ }
  }
  return null;
}

// ---- Member-facing: create a signup ----------------------------------------

function createSignup_(memberId, eventId) {
  return withLock_(function() {
    var member = memberById_(memberId);
    if (!member) throw new Error('Member not found');
    if (isBlocked_(member)) {
      throw new Error('You have an outstanding $' + getSettingNum_('flake_fee_amount', 30) +
                      ' flake fee. Pay at ' + getSetting_('assu_epay_url', '') +
                      ' and a leader will unblock you.');
    }
    var ev = eventById_(eventId);
    if (!ev) throw new Error('Event not found');
    if (ev.status !== EVENT_STATUS.OPEN) throw new Error('Signups are not open for this event.');
    if (!ev.event_spreadsheet_id) {
      // Self-heal: provision the per-event spreadsheet if missing.
      provisionEventSpreadsheet_(ev);
      ev = eventById_(eventId);
    }

    // Already signed up?
    var existing = findSignup_(ev, function(r) { return r.member_id === memberId; });
    if (existing) return existing;

    var row = {
      signup_id:        uid_('s_'),
      event_id:         eventId,
      event_name:       ev.name || '',
      member_id:        memberId,
      member_name:      member.full_name || '',
      member_email:     member.email || '',
      email_at_signup:  member.email,
      signed_up_at:     nowIso_(),
      lottery_rank:     '',
      status:           SIGNUP_STATUS.PENDING,
      invite_sent_at:   '',
      decline_token:    '',
      declined_at:      '',
      attended_marked_at:'',
      marked_by:        '',
      notes:            ''
    };
    appendSignup_(ev, row);
    audit_(member.email, 'CreateSignup', TAB.SIGNUPS, row.signup_id, null, { event_id: eventId });
    return row;
  });
}

// ---- Lottery ----------------------------------------------------------------

function runLottery_(eventId, byEmail) {
  return withLock_(function() {
    var ev = eventById_(eventId);
    if (!ev) throw new Error('Event not found');
    if (ev.status !== EVENT_STATUS.OPEN && ev.status !== EVENT_STATUS.CLOSED) {
      throw new Error('Event must be Open or Closed to run lottery (current status: ' + ev.status + ')');
    }

    var signups = findAllSignups_(ev, function(r) { return r.status === SIGNUP_STATUS.PENDING; });
    if (signups.length === 0) throw new Error('No pending signups to run lottery on.');

    var capacity = Number(ev.capacity) || 0;
    var ordered = shuffle_(signups);

    ordered.forEach(function(s, idx) {
      var rank = idx + 1;
      var status;
      if (rank <= capacity) status = SIGNUP_STATUS.INVITED;
      else                  status = SIGNUP_STATUS.WAITLIST;
      updateSignupRow_(ev, s._rowIndex, {
        lottery_rank: rank,
        status:       status,
        decline_token: status === SIGNUP_STATUS.INVITED ? uid_('d_') + uid_('') : ''
      });
    });

    setEventStatus_(eventId, EVENT_STATUS.LOTTERIED, byEmail);
    updateRow_(TAB.EVENTS, ev._rowIndex, { lottery_run_at: nowIso_() });
    audit_(byEmail, 'RunLottery', TAB.EVENTS, eventId, null, { signups: ordered.length, capacity: capacity });

    return { invited: Math.min(capacity, ordered.length), waitlist: Math.max(0, ordered.length - capacity), total: ordered.length };
  });
}

// ---- Send invitations -------------------------------------------------------

function sendInvitations_(eventId, byEmail) {
  var ev = eventById_(eventId);
  if (!ev) throw new Error('Event not found');
  if (ev.status !== EVENT_STATUS.LOTTERIED) {
    throw new Error('Run the lottery first (current status: ' + ev.status + ')');
  }

  var signups = findAllSignups_(ev, function() { return true; });
  var sent = { invited: 0, waitlist: 0, lost: 0, errors: 0 };

  signups.forEach(function(s) {
    try {
      var member = memberById_(s.member_id);
      if (!member) return;
      if (s.status === SIGNUP_STATUS.INVITED && !s.invite_sent_at) {
        emailLotteryWon(member, ev, s);
        updateSignupRow_(ev, s._rowIndex, { invite_sent_at: nowIso_() });
        sent.invited++;
      } else if (s.status === SIGNUP_STATUS.WAITLIST && !s.invite_sent_at) {
        emailWaitlisted(member, ev);
        updateSignupRow_(ev, s._rowIndex, { invite_sent_at: nowIso_() });
        sent.waitlist++;
      } else if (s.status === SIGNUP_STATUS.PENDING) {
        // shouldn't happen post-lottery; skip
      }
    } catch (err) { sent.errors++; }
  });

  // Lost emails for non-Lotteried-but-not-Invited/Waitlist? Lost status is set
  // via finalizeEvent_ for those who were on the waitlist and didn't get
  // promoted. We don't currently mark anyone as Lost in runLottery_ — capacity
  // overflows go to Waitlist. So no Lost emails here.
  // (If you ever want a hard Lost cap, add it to runLottery_ and email here.)

  audit_(byEmail, 'SendInvitations', TAB.EVENTS, eventId, null, sent);
  return sent;
}

// ---- Decline (member-facing) ------------------------------------------------

function declineByToken_(token) {
  return withLock_(function() {
    var s = findSignupAnywhere_(function(r) {
      return r.decline_token && r.decline_token === token;
    });
    if (!s) throw new Error('Invalid or expired decline link.');
    if (s.status !== SIGNUP_STATUS.INVITED) {
      return { ok: true, alreadyHandled: true, status: s.status };
    }
    var ev = s._event || eventById_(s.event_id);
    if (!ev) throw new Error('Event not found.');

    var member = memberById_(s.member_id);
    var hoursUntil = ev.event_date ? (new Date(ev.event_date) - new Date()) / 3600000 : 999;
    var grace = getSettingNum_('decline_grace_window_hours', 24);
    var status = (hoursUntil >= grace) ? SIGNUP_STATUS.DROPPED : SIGNUP_STATUS.FLAKED;

    updateSignupRow_(ev, s._rowIndex, {
      status:       status,
      declined_at:  nowIso_(),
      decline_token: '' // burn the token
    });
    audit_(member ? member.email : '', 'DeclineByToken', TAB.SIGNUPS, s.signup_id,
           { status: SIGNUP_STATUS.INVITED },
           { status: status, hours_until_event: hoursUntil });

    if (status === SIGNUP_STATUS.FLAKED) {
      chargeFlakeFee_(member, ev, s);
    } else if (parseBool_(ev.auto_invite_enabled)) {
      promoteWaitlist_(ev.event_id);
    }
    return { ok: true, status: status, eventName: ev.name };
  });
}

// Member declines from the web app (logged-in flow).
function declineSignupByMember_(memberId, signupId) {
  return withLock_(function() {
    var s = findSignupAnywhere_(function(r) { return r.signup_id === signupId; });
    if (!s) throw new Error('Signup not found.');
    if (s.member_id !== memberId) throw new Error('Not your signup.');
    if (s.status !== SIGNUP_STATUS.INVITED) {
      return { ok: true, alreadyHandled: true, status: s.status };
    }
    return declineByToken_(s.decline_token);  // reuse logic via token
  });
}

// ---- Auto-promote -----------------------------------------------------------

function promoteWaitlist_(eventId) {
  var ev = eventById_(eventId);
  if (!ev) return;
  var capacity = Number(ev.capacity) || 0;
  var signups = findAllSignups_(ev, function() { return true; });
  var inviteCount = signups.filter(function(s) { return s.status === SIGNUP_STATUS.INVITED; }).length;
  if (inviteCount >= capacity) return;

  var openSlots = capacity - inviteCount;
  var nextWaitlist = signups
    .filter(function(s) { return s.status === SIGNUP_STATUS.WAITLIST; })
    .sort(function(a, b) { return (Number(a.lottery_rank) || 9999) - (Number(b.lottery_rank) || 9999); })
    .slice(0, openSlots);

  nextWaitlist.forEach(function(s) {
    var member = memberById_(s.member_id);
    if (!member || isBlocked_(member)) return;  // skip blocked; their slot stays open until next promote
    updateSignupRow_(ev, s._rowIndex, {
      status: SIGNUP_STATUS.INVITED,
      decline_token: uid_('d_') + uid_(''),
      invite_sent_at: nowIso_()
    });
    try {
      var fresh = findSignup_(ev, function(r) { return r.signup_id === s.signup_id; });
      emailPromotedFromWaitlist(member, ev, fresh || s);
    } catch (err) { /* continue */ }
    audit_('system', 'PromoteWaitlist', TAB.SIGNUPS, s.signup_id, { status: SIGNUP_STATUS.WAITLIST }, { status: SIGNUP_STATUS.INVITED });
  });
}

// ---- Mark attendance --------------------------------------------------------

function markAttendance_(signupId, attended, byEmail) {
  return withLock_(function() {
    var s = findSignupAnywhere_(function(r) { return r.signup_id === signupId; });
    if (!s) throw new Error('Signup not found.');
    var ev = s._event || eventById_(s.event_id);
    var newStatus = attended ? SIGNUP_STATUS.ATTENDED : s.status;
    updateSignupRow_(ev, s._rowIndex, {
      status:             newStatus,
      attended_marked_at: nowIso_(),
      marked_by:          byEmail || ''
    });
    audit_(byEmail, attended ? 'MarkAttended' : 'UnmarkAttended', TAB.SIGNUPS, signupId, { status: s.status }, { status: newStatus });
  });
}

// ---- Finalize event ---------------------------------------------------------

function finalizeEvent_(eventId, byEmail) {
  return withLock_(function() {
    var ev = eventById_(eventId);
    if (!ev) throw new Error('Event not found.');
    if (ev.status === EVENT_STATUS.COMPLETED) throw new Error('Event already finalized.');

    var signups = findAllSignups_(ev, function() { return true; });
    var flaked = 0;
    var unpromotedWaitlist = 0;

    signups.forEach(function(s) {
      // Anyone still Invited at finalize time who wasn't marked Attended → Flaked.
      if (s.status === SIGNUP_STATUS.INVITED) {
        updateSignupRow_(ev, s._rowIndex, { status: SIGNUP_STATUS.FLAKED });
        var m = memberById_(s.member_id);
        if (m) chargeFlakeFee_(m, ev, s);
        flaked++;
      }
      // Waitlist that never got promoted → Lost.
      if (s.status === SIGNUP_STATUS.WAITLIST) {
        updateSignupRow_(ev, s._rowIndex, { status: SIGNUP_STATUS.LOST });
        unpromotedWaitlist++;
      }
    });

    setEventStatus_(eventId, EVENT_STATUS.COMPLETED, byEmail);
    audit_(byEmail, 'FinalizeEvent', TAB.EVENTS, eventId, null, { flaked: flaked, lost_from_waitlist: unpromotedWaitlist });
    return { flaked: flaked, lost: unpromotedWaitlist };
  });
}

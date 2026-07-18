// =============================================================================
// Auth.gs — magic-link login + session management.
// Members enter their roster email, receive a 6-digit code, exchange it for a
// session token. The token is opaque to the client; we store only its hash.
// =============================================================================

// Sends a 6-digit code to the given email, *if* it matches a Member row.
// Always returns ok: true so we don't leak which emails are on the roster.
function authSendCode(emailRaw) {
  var email = normalizeEmail_(emailRaw);
  if (!email || email.indexOf('@') < 1) throw new Error('Invalid email');

  var member = findRow_(TAB.MEMBERS, function(r) {
    return normalizeEmail_(r.email) === email;
  });
  if (!member) {
    Utilities.sleep(400);  // tiny delay so timing isn't a tell
    return { ok: true };
  }

  // Backfill member_id if missing so future operations work.
  if (!member.member_id) {
    var newId = uid_('m_');
    updateRow_(TAB.MEMBERS, member._rowIndex, { member_id: newId });
    member.member_id = newId;
  }

  var code = String(Math.floor(100000 + Math.random() * 900000));
  var ttlMin = getSettingNum_('magic_link_ttl_minutes', 15);

  withLock_(function() {
    append_(TAB.AUTH_CODES, {
      email:      email,
      code_hash:  hash_(code),
      expires_at: addMinutes_(new Date(), ttlMin).toISOString(),
      used:       false,
      created_at: nowIso_()
    });
  });

  emailMagicLinkCode(member, code, ttlMin);
  return { ok: true };
}

// Verifies a code; on success, creates a session and returns the token.
function authVerifyCode(emailRaw, codeRaw) {
  var email = normalizeEmail_(emailRaw);
  var code  = String(codeRaw || '').trim();
  if (!email || !code) throw new Error('Email and code required');

  var codeHash = hash_(code);
  var now = new Date();

  return withLock_(function() {
    var row = findRow_(TAB.AUTH_CODES, function(r) {
      return normalizeEmail_(r.email) === email
          && r.code_hash === codeHash
          && r.used !== true && String(r.used).toUpperCase() !== 'TRUE'
          && new Date(r.expires_at) > now;
    });
    if (!row) throw new Error('Invalid or expired code. Try again or request a new one.');

    updateRow_(TAB.AUTH_CODES, row._rowIndex, { used: true });

    var member = findRow_(TAB.MEMBERS, function(r) {
      return normalizeEmail_(r.email) === email;
    });
    if (!member) throw new Error('Member not found.');

    var token = uid_('') + uid_('');
    var ttlDays = getSettingNum_('session_ttl_days', 14);
    append_(TAB.SESSIONS, {
      token_hash:  hash_(token),
      member_id:   member.member_id,
      email:       email,
      created_at:  nowIso_(),
      expires_at:  addDays_(new Date(), ttlDays).toISOString()
    });

    return { ok: true, token: token, member: publicMember_(member) };
  });
}

function authGetMember(token) {
  var member = sessionMember_(token);
  return member ? { ok: true, member: publicMember_(member) } : { ok: false };
}

function authLogout(token) {
  if (!token) return { ok: true };
  withLock_(function() {
    var row = findRow_(TAB.SESSIONS, function(r) { return r.token_hash === hash_(token); });
    if (row) deleteRow_(TAB.SESSIONS, row._rowIndex);
  });
  return { ok: true };
}

// Internal: returns the Member row backing this session token, or null.
function sessionMember_(token) {
  if (!token) return null;
  var row = findRow_(TAB.SESSIONS, function(r) { return r.token_hash === hash_(token); });
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) return null;
  var member = findRow_(TAB.MEMBERS, function(r) { return r.member_id === row.member_id; });
  return member;
}

// Public projection of a Member row — never expose internal fields like notes.
function publicMember_(m) {
  return {
    member_id:      m.member_id,
    email:          m.email,
    full_name:      m.full_name,
    affiliation:    m.affiliation,
    is_admin:       parseBool_(m.is_admin),
    can_clear_fees: parseBool_(m.can_clear_fees),
    fee_balance:    Number(m.fee_balance) || 0,
    status:         m.status || MEMBER_STATUS.ACTIVE
  };
}

function parseBool_(v) {
  if (v === true) return true;
  if (v === false || v === '' || v == null) return false;
  return String(v).toUpperCase() === 'TRUE';
}

// Periodic cleanup of expired auth codes / sessions.
// Wire to a time-based trigger (e.g., daily) once you're comfortable with the system.
function pruneExpiredAuth() {
  var now = new Date();
  withLock_(function() {
    var sheet = getSheet_(TAB.AUTH_CODES);
    var rows = readAll_(TAB.AUTH_CODES);
    // delete from bottom up to keep indices stable
    rows.slice().reverse().forEach(function(r) {
      if (new Date(r.expires_at) < now || parseBool_(r.used)) sheet.deleteRow(r._rowIndex);
    });
    var sessSheet = getSheet_(TAB.SESSIONS);
    var sessions = readAll_(TAB.SESSIONS);
    sessions.slice().reverse().forEach(function(r) {
      if (new Date(r.expires_at) < now) sessSheet.deleteRow(r._rowIndex);
    });
  });
}

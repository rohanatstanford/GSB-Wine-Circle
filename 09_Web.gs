// =============================================================================
// Web.gs — web app entry point + RPC handlers called from the client.
// All client→server traffic goes through google.script.run; we never trust
// the client and always re-resolve the session on each call.
// =============================================================================

function doGet(e) {
  // Decline-by-token flow (clicked from invitation email).
  if (e && e.parameter && e.parameter.decline) {
    var tpl = HtmlService.createTemplateFromFile('decline');
    tpl.token = e.parameter.decline;
    tpl.orgName = orgName_();
    return tpl.evaluate()
      .setTitle(orgName_() + ' — Decline')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  // Default: the SPA shell.
  var tpl = HtmlService.createTemplateFromFile('app');
  tpl.orgName = orgName_();
  tpl.epayUrl = getSetting_('assu_epay_url', '');
  tpl.leadershipEmail = getSetting_('leadership_email', '');
  return tpl.evaluate()
    .setTitle(orgName_())
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// -- RPC: auth ---------------------------------------------------------------
function rpcSendCode(email)            { return authSendCode(email); }
function rpcVerifyCode(email, code)    { return authVerifyCode(email, code); }
function rpcLogout(token)              { return authLogout(token); }
function rpcMe(token) {
  var m = sessionMember_(token);
  if (!m) return { ok: false };
  return { ok: true, member: publicMember_(m) };
}

// -- RPC: events & signups ---------------------------------------------------
function rpcOpenEvents(token) {
  var member = requireMember_(token);
  var events = openEvents_().map(publicEvent_);

  // Annotate each event with whether the current member has already signed up.
  // Walks per-event spreadsheets — bounded by the number of currently open
  // events (small).
  var byEvent = {};
  events.forEach(function(ev) {
    var s = findSignup_(ev.event_id, function(r) { return r.member_id === member.member_id; });
    byEvent[ev.event_id] = s;
  });
  events.forEach(function(ev) {
    var s = byEvent[ev.event_id];
    ev.my_signup_status = s ? s.status : null;
  });

  // Outstanding fee detail — what specific events the fee(s) are from, plus
  // contact info for appeals.
  var outstanding = outstandingChargesForMember_(member.member_id);
  var outstandingTotal = outstanding.reduce(function(s, c) { return s + (c.remaining || 0); }, 0);

  return {
    ok: true,
    member: publicMember_(member),
    events: events,
    fee_amount: getSettingNum_('flake_fee_amount', 30),
    epay_url: getSetting_('assu_epay_url', ''),
    leadership_email: getSetting_('leadership_email', ''),
    outstanding_charges: outstanding,
    outstanding_total: outstandingTotal
  };
}

function rpcSignUp(token, eventId) {
  var member = requireMember_(token);
  var s = createSignup_(member.member_id, eventId);
  return { ok: true, signup_status: s.status };
}

function rpcMyInvitations(token) {
  var member = requireMember_(token);
  var rows = findSignupsByMember_(member.member_id).filter(function(r) {
    return r.status === SIGNUP_STATUS.INVITED || r.status === SIGNUP_STATUS.WAITLIST;
  });
  var out = rows.map(function(s) {
    var ev = s._event || eventById_(s.event_id);
    return ev ? {
      signup_id: s.signup_id,
      status:    s.status,
      event:     publicEvent_(ev)
    } : null;
  }).filter(Boolean);
  // Show upcoming events first.
  out.sort(function(a, b) { return new Date(a.event.event_date) - new Date(b.event.event_date); });
  return { ok: true, invitations: out };
}

function rpcDecline(token, signupId) {
  var member = requireMember_(token);
  return declineSignupByMember_(member.member_id, signupId);
}

// Decline-by-token from email link (no session required — possession of the
// token IS authorization).
function rpcDeclineByToken(declineToken) {
  return declineByToken_(declineToken);
}

// -- helpers -----------------------------------------------------------------
function requireMember_(token) {
  var m = sessionMember_(token);
  if (!m) throw new Error('Not logged in. Please log in again.');
  return m;
}

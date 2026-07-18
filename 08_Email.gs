// =============================================================================
// Email.gs — outgoing email templates + send/log wrapper.
// All sends go through sendEmail_ so EmailLog has a complete record.
// =============================================================================

function sendEmail_(opts) {
  var eventName = opts.eventName || '';
  if (!eventName && opts.eventId) {
    var ev = eventById_(opts.eventId);
    if (ev) eventName = ev.name || '';
  }
  var log = {
    log_id:     uid_('em_'),
    sent_at:    nowIso_(),
    to_email:   opts.to,
    subject:    opts.subject,
    type:       opts.type,
    event_id:   opts.eventId  || '',
    event_name: eventName,
    signup_id:  opts.signupId || '',
    status:     'Pending',
    error:      ''
  };
  try {
    var sendOpts = { name: getSetting_('org_name', 'Wine Circle') };
    if (opts.html) sendOpts.htmlBody = opts.html;
    GmailApp.sendEmail(opts.to, opts.subject, opts.body, sendOpts);
    log.status = 'Sent';
  } catch (err) {
    log.status = 'Failed';
    log.error  = String(err);
  }
  append_(TAB.EMAIL_LOG, log);
  if (log.status === 'Failed') Logger.log('Email failed: ' + log.error);
}

function sigBlock_() { return '\n\n' + getSetting_('org_email_signature', '— The Wine Circle Team'); }
function orgName_()  { return getSetting_('org_name', 'Stanford GSB Wine Circle'); }

// -- Template: magic link login code -----------------------------------------
function emailMagicLinkCode(member, code, ttlMin) {
  sendEmail_({
    to: member.email,
    type: 'MagicLinkCode',
    subject: orgName_() + ' — login code: ' + code,
    body: 'Hi ' + (member.full_name || '') + ',\n\n' +
          'Your login code is: ' + code + '\n\n' +
          'It expires in ' + ttlMin + ' minutes. If you didn\'t request this, ignore this email.' +
          sigBlock_()
  });
}

// -- Template: lottery won ----------------------------------------------------
function emailLotteryWon(member, event, signup) {
  var declineUrl = makeDeclineUrl_(signup.decline_token);
  var grace = getSettingNum_('decline_grace_window_hours', 24);
  sendEmail_({
    to: member.email,
    type: 'LotteryWon',
    eventId: event.event_id,
    eventName: event.name,
    signupId: signup.signup_id,
    subject: orgName_() + " — you're in for " + event.name,
    body: 'Hi ' + (member.full_name || '') + ',\n\n' +
          "Good news — you won the lottery for " + event.name + '!\n\n' +
          'When: ' + formatDate_(event.event_date) + '\n' +
          (event.location ? 'Where: ' + event.location + '\n' : '') +
          (event.description ? '\n' + event.description + '\n' : '') +
          '\nIf you can\'t make it, please decline as soon as possible so we can offer your spot to someone on the waitlist:\n' +
          declineUrl + '\n\n' +
          'Heads up: declining within ' + grace + ' hours of the event counts as a flake and triggers a $' +
          getSettingNum_('flake_fee_amount', 30) + ' fee.' + sigBlock_()
  });
}

// -- Template: lottery lost (terminal — no waitlist) -------------------------
// Not currently used (overflow goes to waitlist). Kept for completeness.
function emailLotteryLost(member, event) {
  sendEmail_({
    to: member.email,
    type: 'LotteryLost',
    eventId: event.event_id,
    eventName: event.name,
    subject: orgName_() + ' — ' + event.name + ' lottery results',
    body: 'Hi ' + (member.full_name || '') + ',\n\n' +
          "Unfortunately, you weren't selected for " + event.name +
          '. We hope to see you at the next event.' + sigBlock_()
  });
}

// -- Template: waitlisted -----------------------------------------------------
function emailWaitlisted(member, event) {
  sendEmail_({
    to: member.email,
    type: 'Waitlisted',
    eventId: event.event_id,
    eventName: event.name,
    subject: orgName_() + ' — waitlisted for ' + event.name,
    body: 'Hi ' + (member.full_name || '') + ',\n\n' +
          "You're on the waitlist for " + event.name + '. We\'ll email you if a spot opens up.' +
          sigBlock_()
  });
}

// -- Template: promoted off waitlist -----------------------------------------
function emailPromotedFromWaitlist(member, event, signup) {
  var declineUrl = makeDeclineUrl_(signup.decline_token);
  var grace = getSettingNum_('decline_grace_window_hours', 24);
  sendEmail_({
    to: member.email,
    type: 'PromotedFromWaitlist',
    eventId: event.event_id,
    eventName: event.name,
    signupId: signup.signup_id,
    subject: orgName_() + ' — a spot opened for you at ' + event.name,
    body: 'Hi ' + (member.full_name || '') + ',\n\n' +
          'A spot opened up — you\'re now in for ' + event.name + '.\n\n' +
          'When: ' + formatDate_(event.event_date) + '\n' +
          (event.location ? 'Where: ' + event.location + '\n' : '') +
          '\nIf you can\'t make it, decline here so we can offer your spot to the next person on the waitlist:\n' +
          declineUrl + '\n\n' +
          'Declining within ' + grace + ' hours of the event counts as a flake and triggers a $' +
          getSettingNum_('flake_fee_amount', 30) + ' fee.' + sigBlock_()
  });
}

// -- Template: flake notice ---------------------------------------------------
function emailFlakeNotice(member, event, amount) {
  var pay = getSetting_('assu_epay_url', '');
  var contact = getSetting_('leadership_email', '');
  sendEmail_({
    to: member.email,
    type: 'FlakeNotice',
    eventId: event ? event.event_id : '',
    eventName: event ? event.name : '',
    subject: orgName_() + ' — $' + amount + ' fee for ' + (event ? event.name : 'event'),
    body: 'Hi ' + (member.full_name || '') + ',\n\n' +
          'We didn\'t see you at ' + (event ? event.name : 'the event') +
          ', and didn\'t receive a notice >' + getSettingNum_('decline_grace_window_hours', 24) +
          ' hours before the event. A $' + amount + ' flake fee has been added to your account.\n\n' +
          'Pay via ASSU ePay: ' + pay + '\n\n' +
          'Once a leader confirms your payment, you\'ll be unblocked and can sign up for events again. ' +
          'Questions or appeals: ' + (contact || 'reply to this email') + '.' + sigBlock_()
  });
}

// -- Template: fee paid confirmation -----------------------------------------
function emailFeePaidConfirm(member, amount) {
  sendEmail_({
    to: member.email,
    type: 'FeePaidConfirm',
    subject: orgName_() + ' — fee cleared, you\'re unblocked',
    body: 'Hi ' + (member.full_name || '') + ',\n\n' +
          'Thanks — we\'ve recorded your $' + amount + ' payment and your account is unblocked. ' +
          'You can sign up for events again.' + sigBlock_()
  });
}

// -- Decline URL --------------------------------------------------------------
function makeDeclineUrl_(token) {
  var base = getSetting_('web_app_url', '');
  if (!base) return '[web_app_url not set in Settings — paste the deployed /exec URL]';
  var sep = base.indexOf('?') >= 0 ? '&' : '?';
  return base + sep + 'decline=' + encodeURIComponent(token);
}

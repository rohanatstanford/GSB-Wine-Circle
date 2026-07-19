// Email service — sends via the Gmail API over HTTPS (OAuth2) or logs to console as fallback.
//
// This deliberately does NOT use SMTP: many PaaS hosts (Render's free tier
// included) block outbound SMTP ports entirely for anti-abuse reasons, which
// makes Gmail SMTP unusable there regardless of credentials. The Gmail REST
// API is a plain HTTPS call, which is never port-blocked.
const db = require('../db');
const { OAuth2Client } = require('google-auth-library');

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '';
const GMAIL_REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN || '';
const EMAIL_FROM = process.env.EMAIL_FROM || GMAIL_USER;

let oauth2Client = null;
if (GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REFRESH_TOKEN) {
  oauth2Client = new OAuth2Client(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
}

/**
 * Build a minimal RFC 2822 message string and base64url-encode it for Gmail's API.
 */
function buildRawMessage({ from, to, subject, text }) {
  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    text,
  ];
  const raw = lines.join('\r\n');
  return Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendViaGmailApi({ to, subject, body }) {
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Gmail access token — check GMAIL_REFRESH_TOKEN is still valid.');

  const raw = buildRawMessage({ from: EMAIL_FROM, to, subject, text: body });
  const resp = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gmail API error ${resp.status}: ${errText}`);
  }
}

/**
 * Send a transactional email and log it to email_log.
 * @param {object} opts
 * @param {string}  opts.to
 * @param {string}  opts.subject
 * @param {string}  opts.body      — plain text body
 * @param {string}  opts.type      — e.g. 'MagicLink', 'Invitation', 'FlakeNotice'
 * @param {string}  [opts.eventId]
 * @param {string}  [opts.signupId]
 * @param {string}  [opts.eventName]
 */
async function sendEmail(opts) {
  const { to, subject, body, type, eventId, signupId, eventName } = opts;
  let status = 'sent';
  let errorMsg = null;

  if (oauth2Client) {
    try {
      await sendViaGmailApi({ to, subject, body });
    } catch (err) {
      status = 'error';
      errorMsg = err.message;
      console.error('Gmail API send error:', err.message);
    }
  } else {
    // Dev fallback: log to console
    console.log('=== EMAIL (Gmail API credentials not configured) ===');
    console.log(`To: ${to}`);
    console.log(`Subject: ${subject}`);
    console.log(`Body:\n${body}`);
    console.log('======================================================');
  }

  // Always log the attempt.
  try {
    await db.query(
      `INSERT INTO email_log (to_email, subject, type, event_id, signup_id, event_name, status, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [to, subject, type || 'Generic', eventId || null, signupId || null, eventName || null, status, errorMsg]
    );
  } catch (logErr) {
    console.error('Email log write error:', logErr.message);
  }

  return { ok: status === 'sent', error: errorMsg };
}

// ── Template helpers ──────────────────────────────────────────────────────────

function sigBlock(settings) {
  const sig = settings.org_email_signature || '— The Wine Circle Team';
  return `\n\n${sig}`;
}

function orgName(settings) {
  return settings.org_name || 'Wine Circle';
}

async function getSettings(clientOrPool = db) {
  const { rows } = await clientOrPool.query('SELECT key, value FROM settings');
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return s;
}

/**
 * Send a magic-link / 6-digit auth code.
 */
async function emailMagicLink(member, code, ttlMin) {
  const settings = await getSettings(db);
  const name = member.full_name || member.email;
  const org = orgName(settings);
  await sendEmail({
    to: member.email,
    subject: `${org} — your login code`,
    body:
      `Hi ${name},\n\n` +
      `Your login code is: ${code}\n\n` +
      `This code expires in ${ttlMin} minutes. Enter it on the login page to sign in.` +
      sigBlock(settings),
    type: 'MagicLink',
  });
}

/**
 * Send an event invitation to a member.
 */
async function emailInvitation(member, event, declineToken, settings) {
  if (!settings) settings = await getSettings(db);
  const grace = Number(settings.decline_grace_window_hours) || 24;
  const fee = Number(settings.flake_fee_amount) || 30;
  const baseUrl = settings.web_app_url || '';
  const declineUrl = baseUrl
    ? `${baseUrl}/decline?token=${encodeURIComponent(declineToken)}`
    : `[web_app_url not configured — set it in Settings]`;

  await sendEmail({
    to: member.email,
    subject: `${orgName(settings)} — You're in for ${event.name}!`,
    body:
      `Hi ${member.full_name || member.email},\n\n` +
      `Great news — you've been selected for ${event.name}!\n\n` +
      `When: ${event.event_date ? new Date(event.event_date).toLocaleDateString() : 'TBD'}\n` +
      (event.location ? `Where: ${event.location}\n` : '') +
      (event.description ? `\n${event.description}\n` : '') +
      `\nIf you can't make it, please decline here so we can offer your spot to the next person:\n${declineUrl}\n\n` +
      `Declining within ${grace} hours of the event counts as a flake and triggers a $${fee} fee.` +
      sigBlock(settings),
    type: 'Invitation',
    eventId: event.event_id,
    eventName: event.name,
  });
}

/**
 * Send a "lottery lost" email.
 */
async function emailLotteryLost(member, event, settings) {
  if (!settings) settings = await getSettings(db);
  await sendEmail({
    to: member.email,
    subject: `${orgName(settings)} — ${event.name} update`,
    body:
      `Hi ${member.full_name || member.email},\n\n` +
      `Unfortunately, you weren't selected in the lottery for ${event.name}. ` +
      `You are on the waitlist — we'll contact you right away if a spot opens up.` +
      sigBlock(settings),
    type: 'LotteryLost',
    eventId: event.event_id,
    eventName: event.name,
  });
}

/**
 * Send a waitlist-promotion email.
 */
async function emailWaitlistPromotion(member, event, declineToken, settings) {
  if (!settings) settings = await getSettings(db);
  const grace = Number(settings.decline_grace_window_hours) || 24;
  const fee = Number(settings.flake_fee_amount) || 30;
  const baseUrl = settings.web_app_url || '';
  const declineUrl = baseUrl
    ? `${baseUrl}/decline?token=${encodeURIComponent(declineToken)}`
    : `[web_app_url not configured]`;

  await sendEmail({
    to: member.email,
    subject: `${orgName(settings)} — A spot opened up for ${event.name}!`,
    body:
      `Hi ${member.full_name || member.email},\n\n` +
      `A spot opened up — you're now in for ${event.name}.\n\n` +
      `When: ${event.event_date ? new Date(event.event_date).toLocaleDateString() : 'TBD'}\n` +
      (event.location ? `Where: ${event.location}\n` : '') +
      `\nIf you can't make it, decline here so we can offer your spot to the next person:\n${declineUrl}\n\n` +
      `Declining within ${grace} hours counts as a flake ($${fee} fee).` +
      sigBlock(settings),
    type: 'WaitlistPromotion',
    eventId: event.event_id,
    eventName: event.name,
  });
}

/**
 * Send a flake fee notice.
 */
async function emailFlakeNotice(member, event, amount, settings) {
  if (!settings) settings = await getSettings(db);
  const pay = settings.assu_epay_url || '';
  const contact = settings.leadership_email || '';
  const grace = Number(settings.decline_grace_window_hours) || 24;

  await sendEmail({
    to: member.email,
    subject: `${orgName(settings)} — $${amount} fee for ${event ? event.name : 'event'}`,
    body:
      `Hi ${member.full_name || member.email},\n\n` +
      `We didn't see you at ${event ? event.name : 'the event'}, and didn't receive a notice ` +
      `>${grace} hours before the event. A $${amount} flake fee has been added to your account.\n\n` +
      (pay ? `Pay via ASSU ePay: ${pay}\n\n` : '') +
      `Once a leader confirms your payment, you'll be unblocked and can sign up for events again. ` +
      `Questions or appeals: ${contact || 'reply to this email'}.` +
      sigBlock(settings),
    type: 'FlakeNotice',
    eventId: event ? event.event_id : null,
    eventName: event ? event.name : null,
  });
}

/**
 * Send a fee-paid confirmation.
 */
async function emailFeePaidConfirm(member, amount, settings) {
  if (!settings) settings = await getSettings(db);
  await sendEmail({
    to: member.email,
    subject: `${orgName(settings)} — fee cleared, you're unblocked`,
    body:
      `Hi ${member.full_name || member.email},\n\n` +
      `Thanks — we've recorded your $${amount} payment and your account is unblocked. ` +
      `You can sign up for events again.` +
      sigBlock(settings),
    type: 'FeePaidConfirm',
  });
}

module.exports = {
  sendEmail,
  emailMagicLink,
  emailInvitation,
  emailLotteryLost,
  emailWaitlistPromotion,
  emailFlakeNotice,
  emailFeePaidConfirm,
  getSettings,
};

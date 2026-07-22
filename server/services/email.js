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

// RFC 2822 headers are ASCII-only; non-ASCII values (e.g. an em dash in the
// subject) must be RFC 2047 encoded-words, or mail clients mis-decode them
// using the wrong charset (the classic "Ã¢Â€Â”" mojibake for "—").
function encodeHeader(str) {
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return `=?UTF-8?B?${Buffer.from(str, 'utf8').toString('base64')}?=`;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Build a minimal RFC 2822 message string and base64url-encode it for Gmail's API.
 * When `html` is given, builds a multipart/alternative message (plain-text
 * fallback + HTML) instead of a plain text/plain one — needed for the flake
 * batch notice's hyperlinked payment link.
 */
function buildRawMessage({ from, to, bcc, subject, text, html }) {
  const headers = [`From: ${from}`, `To: ${to}`];
  if (bcc) headers.push(`Bcc: ${bcc}`);
  headers.push(`Subject: ${encodeHeader(subject)}`, 'MIME-Version: 1.0');

  let bodyLines;
  if (html) {
    const boundary = `WineCircle_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const textB64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const htmlB64 = Buffer.from(html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    bodyLines = [
      '', `--${boundary}`,
      'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      textB64,
      `--${boundary}`,
      'Content-Type: text/html; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '',
      htmlB64,
      `--${boundary}--`,
    ];
  } else {
    const bodyB64 = Buffer.from(text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    headers.push('Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64');
    bodyLines = ['', bodyB64];
  }

  const raw = [...headers, ...bodyLines].join('\r\n');
  return Buffer.from(raw, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendViaGmailApi({ to, bcc, subject, body, html }) {
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error('Failed to obtain a Gmail access token — check GMAIL_REFRESH_TOKEN is still valid.');

  const raw = buildRawMessage({ from: EMAIL_FROM, to, bcc, subject, text: body, html });
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
 * @param {string}  [opts.bcc]
 * @param {string}  opts.subject
 * @param {string}  opts.body      — plain text body
 * @param {string}  [opts.html]    — optional HTML body (sent as multipart/alternative)
 * @param {string}  opts.type      — e.g. 'MagicLink', 'Invitation', 'FlakeNotice'
 * @param {string}  [opts.eventId]
 * @param {string}  [opts.signupId]
 * @param {string}  [opts.eventName]
 */
async function sendEmail(opts) {
  const { to, bcc, subject, body, html, type, eventId, signupId, eventName } = opts;
  let status;
  let errorMsg = null;

  if (oauth2Client) {
    try {
      await sendViaGmailApi({ to, bcc, subject, body, html });
      status = 'sent';
    } catch (err) {
      status = 'error';
      errorMsg = err.message;
      console.error('Gmail API send error:', err.message);
    }
  } else {
    // Dev fallback: log to console. This is NOT a successful send — record
    // it as such, or a misconfigured GMAIL_* env var in production would
    // silently no-op while email_log still claimed "sent".
    status = 'skipped';
    errorMsg = 'Gmail API credentials not configured — logged to console only';
    console.log('=== EMAIL (Gmail API credentials not configured) ===');
    console.log(`To: ${to}`);
    if (bcc) console.log(`Bcc: ${bcc}`);
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

// Fallback if the 'flake_batch_to_emails' setting has never been configured.
const FLAKE_BATCH_TO_DEFAULT = 'gsb_winecircle-leadership@lists.stanford.edu, lforstho@stanford.edu';

/**
 * Send a single flake-fee notice covering every member in `flakedMembers`,
 * all bcc'd on one message — never one email per member. Visible "To" is
 * the configurable leadership address list (Settings: flake_batch_to_emails);
 * recipients only see themselves, not the rest of the bcc list.
 * @param {Array<{email: string}>} flakedMembers
 */
async function emailFlakeBatch(flakedMembers, event, settings) {
  if (!settings) settings = await getSettings(db);
  const payUrl = settings.assu_epay_url || '';
  const toLine = settings.flake_batch_to_emails || FLAKE_BATCH_TO_DEFAULT;
  const bcc = flakedMembers.map(m => m.email).join(', ');

  const plainBody =
    `Hi all (bcc'd),\n\n` +
    `You are receiving this notice because our records show that you either (1) failed to attend or (2) came >20 mins late (per policy) to the ${event.name} event on Thursday, and as a result, your Wine Circle membership is temporarily on pause. (Note, per the policy, declining the calendar invite does not count as notice, and you must email the organizer >24 hours before the event that you have to miss in order to avoid the flake fee).\n\n` +
    `If you're hoping to attend upcoming events, please complete the $30 fee${payUrl ? ` (${payUrl})` : ''}, upload a screenshot of your payment confirmation here, and shoot a quick note to Luke Forsthoefel to ensure you get back on the list.\n\n` +
    `Otherwise, let us know if you think this is in error.\n\n` +
    `Thanks,\nGSB Wine Circle Leadership`;

  const payLinkHtml = payUrl ? `<a href="${escapeHtml(payUrl)}">here</a>` : 'here';
  const htmlBody =
    `<p>Hi all (bcc'd),</p>` +
    `<p>You are receiving this notice because our records show that you either (1) failed to attend or ` +
    `(2) came &gt;20 mins late (per policy) to the ${escapeHtml(event.name)} event on Thursday, and as a result, ` +
    `your Wine Circle membership is temporarily on pause. (Note, per the policy, declining the calendar invite ` +
    `does not count as notice, and you must email the organizer &gt;24 hours before the event that you have to ` +
    `miss in order to avoid the flake fee).</p>` +
    `<p>If you're hoping to attend upcoming events, please complete the $30 fee ${payLinkHtml}, upload a screenshot ` +
    `of your payment confirmation here, and shoot a quick note to Luke Forsthoefel to ensure you get back on the list.</p>` +
    `<p>Otherwise, let us know if you think this is in error.</p>` +
    `<p>Thanks,<br>GSB Wine Circle Leadership</p>`;

  const subject = `${orgName(settings)} — Flake fee notice for ${event.name}`;
  const result = await sendEmail({
    to: toLine,
    bcc,
    subject,
    body: plainBody,
    html: htmlBody,
    type: 'FlakeNotice',
    eventId: event.event_id,
    eventName: event.name,
  });

  // The real send is one message with everyone in bcc — but also log one
  // row per flaked member so the Email Log's "To" filter can still answer
  // "was this specific member notified", not just "was the batch sent".
  for (const m of flakedMembers) {
    try {
      await db.query(
        `INSERT INTO email_log (to_email, subject, type, event_id, event_name, status, error)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [m.email, subject, 'FlakeNotice', event.event_id, event.name, result.ok ? 'sent' : 'error', result.error]
      );
    } catch (logErr) {
      console.error('Email log write error:', logErr.message);
    }
  }

  return result;
}

/**
 * Notify a member their post-event outcome changed after an admin corrected
 * an attendance-taking mistake and re-finalized the event. Only sent to the
 * specific members whose attendance mark was updated during the correction —
 * never a blanket re-notify of the whole roster.
 *
 * @param {'Attended'|'Lost'} outcome — their corrected final outcome
 * @param {number|null} feeReversed — set if a previously-charged flake fee was waived
 */
async function emailAttendanceCorrected(member, event, outcome, feeReversed, settings) {
  if (!settings) settings = await getSettings(db);
  const contact = settings.leadership_email || '';

  const body = outcome === 'Attended'
    ? `Hi ${member.full_name || member.email},\n\n` +
      `We double-checked attendance for ${event.name} and you were marked as attending after all — sorry for the mix-up.` +
      (feeReversed ? ` The $${feeReversed} flake fee on your account has been reversed.` : '') +
      `\n\nQuestions: ${contact || 'reply to this email'}.` +
      sigBlock(settings)
    : `Hi ${member.full_name || member.email},\n\n` +
      `We double-checked attendance for ${event.name} — your waitlist spot didn't convert to attendance ` +
      `after all, so you're marked as not attended. No fee was charged.` +
      `\n\nQuestions: ${contact || 'reply to this email'}.` +
      sigBlock(settings);

  await sendEmail({
    to: member.email,
    subject: `${orgName(settings)} — attendance corrected for ${event.name}`,
    body,
    type: 'AttendanceCorrected',
    eventId: event.event_id,
    eventName: event.name,
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
  emailFlakeBatch,
  emailAttendanceCorrected,
  emailFeePaidConfirm,
  getSettings,
};

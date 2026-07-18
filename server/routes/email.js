// Email batch-send endpoints: invitations, lottery-lost, etc.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');
const emailSvc = require('../services/email');

const router = express.Router();

// POST /api/email/send-invitations
// Body: { event_id } — sends invitation emails to all 'Invited' signups that haven't been emailed yet.
router.post('/send-invitations', requireAdmin, async (req, res) => {
  const { event_id } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  try {
    const { rows: evRows } = await db.query('SELECT * FROM events WHERE event_id = $1', [event_id]);
    if (!evRows.length) return res.status(404).json({ error: 'Event not found' });
    const event = evRows[0];

    const { rows: signups } = await db.query(
      `SELECT s.*, m.email AS member_email, m.full_name AS member_name
       FROM signups s JOIN members m ON m.member_id = s.member_id
       WHERE s.event_id = $1 AND s.status = 'Invited' AND s.invite_sent_at IS NULL`,
      [event_id]
    );

    const settings = await emailSvc.getSettings(db);
    let sent = 0;
    let errors = 0;

    for (const s of signups) {
      try {
        await emailSvc.emailInvitation(
          { email: s.member_email, full_name: s.member_name },
          event, s.decline_token, settings
        );
        await db.query(
          'UPDATE signups SET invite_sent_at = NOW() WHERE signup_id = $1', [s.signup_id]
        );
        sent++;
      } catch (err) {
        console.error('Invitation email error for', s.member_email, err.message);
        errors++;
      }
    }

    await audit(req.member.email, 'SendInvitations', 'signups', event_id, null, { sent, errors });
    return res.json({ ok: true, sent, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/email/send-lottery-lost
// Body: { event_id } — sends "you didn't make it" to all Waitlist/Lost signups.
router.post('/send-lottery-lost', requireAdmin, async (req, res) => {
  const { event_id } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  try {
    const { rows: evRows } = await db.query('SELECT * FROM events WHERE event_id = $1', [event_id]);
    if (!evRows.length) return res.status(404).json({ error: 'Event not found' });
    const event = evRows[0];

    const { rows: evData } = await db.query(
      'SELECT send_lottery_lost_emails FROM events WHERE event_id = $1', [event_id]
    );
    if (evData[0] && !evData[0].send_lottery_lost_emails) {
      return res.status(400).json({ error: 'send_lottery_lost_emails is disabled for this event' });
    }

    const { rows: signups } = await db.query(
      `SELECT s.*, m.email AS member_email, m.full_name AS member_name
       FROM signups s JOIN members m ON m.member_id = s.member_id
       WHERE s.event_id = $1 AND s.status IN ('Waitlist', 'Lost')`,
      [event_id]
    );

    const settings = await emailSvc.getSettings(db);
    let sent = 0;
    let errors = 0;

    for (const s of signups) {
      try {
        await emailSvc.emailLotteryLost(
          { email: s.member_email, full_name: s.member_name },
          event, settings
        );
        sent++;
      } catch (err) {
        console.error('Lottery-lost email error for', s.member_email, err.message);
        errors++;
      }
    }

    await audit(req.member.email, 'SendLotteryLost', 'signups', event_id, null, { sent, errors });
    return res.json({ ok: true, sent, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/email/log — admin: view email log
router.get('/log', requireAdmin, async (req, res) => {
  try {
    const { event_id, limit = 100 } = req.query;
    let q = 'SELECT * FROM email_log';
    const params = [];
    if (event_id) { params.push(event_id); q += ` WHERE event_id = $${params.length}`; }
    q += ` ORDER BY sent_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit) || 100);
    const { rows } = await db.query(q, params);
    return res.json({ log: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;

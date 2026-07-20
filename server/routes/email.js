// Email batch-send endpoints: invitations, lottery-lost, etc.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');
const emailSvc = require('../services/email');

const router = express.Router();

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
// Optional filters: event_id (exact), type (exact), to_email (substring, case-insensitive)
router.get('/log', requireAdmin, async (req, res) => {
  try {
    const { event_id, type, to_email, limit = 100 } = req.query;
    let q = 'SELECT * FROM email_log';
    const params = [];
    const conditions = [];
    if (event_id) { params.push(event_id); conditions.push(`event_id = $${params.length}`); }
    if (type) { params.push(type); conditions.push(`type = $${params.length}`); }
    if (to_email) { params.push(`%${to_email}%`); conditions.push(`to_email ILIKE $${params.length}`); }
    if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
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

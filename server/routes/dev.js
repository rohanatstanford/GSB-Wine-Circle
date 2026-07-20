// Dev / seed helpers — only available when dev_mode_enabled = TRUE in settings.
// All endpoints return 403 in production mode.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

async function devGuard(req, res, next) {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'dev_mode_enabled'`);
  const enabled = rows[0]?.value?.toUpperCase() === 'TRUE';
  if (!enabled) {
    return res.status(403).json({ error: 'Dev helpers are disabled. Set dev_mode_enabled = TRUE in Settings.' });
  }
  next();
}

// POST /api/dev/seed-members
// Body: { n, base_email } — creates n test members with plus-addressed emails.
router.post('/seed-members', requireAdmin, devGuard, async (req, res) => {
  const { n = 10, base_email } = req.body;
  if (!base_email) return res.status(400).json({ error: 'base_email required' });

  const count = parseInt(n) || 10;
  const atIdx = base_email.indexOf('@');
  if (atIdx < 1) return res.status(400).json({ error: 'Invalid base_email' });

  const local = base_email.slice(0, atIdx);
  const domain = base_email.slice(atIdx);

  const created = [];
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (let i = 1; i <= count; i++) {
      const pad = String(i).padStart(2, '0');
      const email = `${local}+wctest${pad}${domain}`;
      const { rows: existing } = await client.query(
        'SELECT member_id FROM members WHERE LOWER(email) = $1', [email.toLowerCase()]
      );
      if (existing.length) { created.push({ email, created: false }); continue; }
      const memberId = 'm_' + uuidv4().replace(/-/g, '');
      await client.query(
        `INSERT INTO members (member_id, email, full_name, affiliation, is_admin, is_exec_team, fee_balance, status, notes)
         VALUES ($1, $2, $3, 'TestCohort', false, false, 0, 'Active', 'TEST')`,
        [memberId, email, `Test User ${pad}`]
      );
      created.push({ email, member_id: memberId, created: true });
    }
    await client.query('COMMIT');
    return res.json({ ok: true, members: created });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/dev/simulate-signups
// Body: { event_id, n } — creates n pending signups from test members.
router.post('/simulate-signups', requireAdmin, devGuard, async (req, res) => {
  const { event_id, n = 10 } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  const count = parseInt(n) || 10;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: evRows } = await client.query('SELECT * FROM events WHERE event_id = $1', [event_id]);
    if (!evRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    const event = evRows[0];

    const { rows: testMembers } = await client.query(
      `SELECT * FROM members WHERE notes LIKE '%TEST%' AND status = 'Active' LIMIT $1`, [count]
    );

    const created = [];
    for (const m of testMembers) {
      const { rows: existing } = await client.query(
        'SELECT signup_id FROM signups WHERE event_id = $1 AND member_id = $2', [event_id, m.member_id]
      );
      if (existing.length) { created.push({ member_id: m.member_id, created: false }); continue; }
      const signupId = 's_' + uuidv4().replace(/-/g, '');
      const declineToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
      await client.query(
        `INSERT INTO signups (signup_id, event_id, event_name, member_id, member_name, member_email, email_at_signup, status, decline_token)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8)`,
        [signupId, event_id, event.name, m.member_id, m.full_name, m.email, m.email, declineToken]
      );
      created.push({ member_id: m.member_id, signup_id: signupId, created: true });
    }
    await client.query('COMMIT');
    return res.json({ ok: true, signups: created });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/dev/reset-event
// Body: { event_id } — wipe all signups and reset event to Open.
router.post('/reset-event', requireAdmin, devGuard, async (req, res) => {
  const { event_id } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rowCount } = await client.query('DELETE FROM signups WHERE event_id = $1', [event_id]);
    await client.query(
      `UPDATE events SET status = 'Open', lottery_run_at = NULL WHERE event_id = $1`, [event_id]
    );
    await client.query('COMMIT');
    return res.json({ ok: true, signupsDeleted: rowCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/dev/wipe-test-data — remove all TEST-flagged members and their data.
router.post('/wipe-test-data', requireAdmin, devGuard, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: testMembers } = await client.query(
      `SELECT member_id FROM members WHERE notes LIKE '%TEST%'`
    );
    const ids = testMembers.map(m => m.member_id);

    if (!ids.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, membersDeleted: 0, signupsDeleted: 0, ledgerDeleted: 0 });
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rowCount: sCount } = await client.query(
      `DELETE FROM signups WHERE member_id IN (${placeholders})`, ids
    );
    const { rowCount: lCount } = await client.query(
      `DELETE FROM fee_ledger WHERE member_id IN (${placeholders})`, ids
    );
    await client.query(
      `DELETE FROM auth_sessions WHERE member_id IN (${placeholders})`, ids
    );
    const { rowCount: mCount } = await client.query(
      `DELETE FROM members WHERE member_id IN (${placeholders})`, ids
    );

    await client.query('COMMIT');
    return res.json({ ok: true, membersDeleted: mCount, signupsDeleted: sCount, ledgerDeleted: lCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/dev/dev-login — get a session token for a test member by email (no code needed).
router.post('/dev-login', requireAdmin, devGuard, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const { hashToken } = require('../middleware/auth');
  const { rows } = await db.query(
    `SELECT * FROM members WHERE LOWER(email) = $1`, [email.toLowerCase()]
  );
  if (!rows.length) return res.status(404).json({ error: 'Member not found' });
  const member = rows[0];

  const { getSettings } = require('../services/email');
  const settings = await getSettings(db);
  const ttlDays = parseInt(settings.session_ttl_days) || 14;
  const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await db.query(
    `INSERT INTO auth_sessions (token_hash, member_id, email, expires_at) VALUES ($1, $2, $3, $4)`,
    [tokenHash, member.member_id, member.email, expiresAt]
  );

  return res.json({ ok: true, token, member });
});

module.exports = router;

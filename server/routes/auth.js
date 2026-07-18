// Auth routes: send code, verify code, get session, logout.
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, hashToken } = require('../middleware/auth');
const { emailMagicLink, getSettings } = require('../services/email');

const router = express.Router();

function normalizeEmail(e) {
  return (e || '').trim().toLowerCase();
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

// POST /api/auth/send-code
// Body: { email }
// Sends a 6-digit code to the address if it's on the roster.
// Always returns ok:true to avoid leaking membership.
router.post('/send-code', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  if (!email || email.indexOf('@') < 1) {
    return res.status(400).json({ error: 'Invalid email' });
  }

  try {
    const { rows } = await db.query(
      'SELECT member_id, email, full_name FROM members WHERE LOWER(email) = $1 AND status != $2',
      [email, 'Inactive']
    );

    if (!rows.length) {
      // Tiny delay to mitigate timing attacks
      await new Promise(r => setTimeout(r, 300));
      return res.json({ ok: true });
    }

    const member = rows[0];
    const settings = await getSettings(db);
    const ttlMin = parseInt(settings.magic_link_ttl_minutes) || 15;

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const codeHash = hashCode(code);
    const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

    // Invalidate any existing unused codes for this email
    await db.query(
      'UPDATE auth_codes SET used = true WHERE email = $1 AND used = false',
      [email]
    );

    await db.query(
      `INSERT INTO auth_codes (email, code_hash, expires_at, used)
       VALUES ($1, $2, $3, false)`,
      [email, codeHash, expiresAt]
    );

    await emailMagicLink(member, code, ttlMin);

    return res.json({ ok: true });
  } catch (err) {
    console.error('send-code error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/auth/verify-code
// Body: { email, code }
// Returns { ok, token, member } on success.
router.post('/verify-code', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const code = String(req.body.code || '').trim();
  if (!email || !code) {
    return res.status(400).json({ error: 'Email and code required' });
  }

  const codeHash = hashCode(code);

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: codeRows } = await client.query(
      `SELECT id FROM auth_codes
       WHERE email = $1 AND code_hash = $2 AND used = false AND expires_at > NOW()`,
      [email, codeHash]
    );

    if (!codeRows.length) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid or expired code. Try again or request a new one.' });
    }

    // Mark code as used
    await client.query('UPDATE auth_codes SET used = true WHERE id = $1', [codeRows[0].id]);

    // Look up member
    const { rows: memberRows } = await client.query(
      `SELECT member_id, email, full_name, affiliation, is_admin, can_clear_fees, fee_balance, status
       FROM members WHERE LOWER(email) = $1`,
      [email]
    );
    if (!memberRows.length) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Member not found.' });
    }

    const member = memberRows[0];
    const settings = await getSettings(db);
    const ttlDays = parseInt(settings.session_ttl_days) || 14;

    const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    await client.query(
      `INSERT INTO auth_sessions (token_hash, member_id, email, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [tokenHash, member.member_id, email, expiresAt]
    );

    await client.query('COMMIT');

    return res.json({
      ok: true,
      token,
      member: publicMember(member),
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('verify-code error:', err);
    return res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// GET /api/auth/me
// Returns current session member, or ok:false.
router.get('/me', requireAuth, (req, res) => {
  res.json({ ok: true, member: publicMember(req.member) });
});

// POST /api/auth/logout
// Invalidates the current session token.
router.post('/logout', async (req, res) => {
  let token =
    req.headers['x-session-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (token) {
    const tokenHash = hashToken(token);
    await db.query('DELETE FROM auth_sessions WHERE token_hash = $1', [tokenHash]).catch(() => {});
  }
  res.json({ ok: true });
});

function publicMember(m) {
  return {
    member_id:      m.member_id,
    email:          m.email,
    full_name:      m.full_name,
    affiliation:    m.affiliation,
    is_admin:       !!m.is_admin,
    can_clear_fees: !!m.can_clear_fees,
    fee_balance:    parseFloat(m.fee_balance) || 0,
    status:         m.status,
  };
}

module.exports = router;

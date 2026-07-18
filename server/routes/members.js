// Member CRUD endpoints.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');
const emailSvc = require('../services/email');
const { getSettings } = emailSvc;
const { promoteNextWaitlist } = require('../services/fees');

const router = express.Router();

// GET /api/members — admin: list all members; member: get own record
router.get('/', requireAuth, async (req, res) => {
  try {
    if (req.isAdmin) {
      const { rows } = await db.query(
        `SELECT member_id, email, full_name, affiliation, is_admin, can_clear_fees,
                fee_balance, status, date_joined, notes
         FROM members ORDER BY full_name`
      );
      return res.json({ members: rows });
    }
    // Non-admin: return only their own record
    const { rows } = await db.query(
      `SELECT member_id, email, full_name, affiliation, is_admin, can_clear_fees,
              fee_balance, status, date_joined
       FROM members WHERE member_id = $1`,
      [req.member.member_id]
    );
    return res.json({ members: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/members/:id — admin or self
router.get('/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!req.isAdmin && req.member.member_id !== id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await db.query(
      `SELECT member_id, email, full_name, affiliation, is_admin, can_clear_fees,
              fee_balance, status, date_joined, notes
       FROM members WHERE member_id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    return res.json({ member: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/members — admin: create a new member
router.post('/', requireAdmin, async (req, res) => {
  const { email, full_name, affiliation, is_admin, can_clear_fees, notes } = req.body;
  if (!email || !full_name) {
    return res.status(400).json({ error: 'email and full_name required' });
  }
  const normalizedEmail = email.trim().toLowerCase();

  try {
    // Check for duplicate
    const { rows: existing } = await db.query(
      'SELECT member_id FROM members WHERE LOWER(email) = $1',
      [normalizedEmail]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'A member with that email already exists' });
    }

    const memberId = 'm_' + uuidv4().replace(/-/g, '');
    const { rows } = await db.query(
      `INSERT INTO members (member_id, email, full_name, affiliation, is_admin, can_clear_fees, fee_balance, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'Active', $7)
       RETURNING *`,
      [memberId, normalizedEmail, full_name.trim(), affiliation || '', !!is_admin, !!can_clear_fees, notes || '']
    );
    await audit(req.member.email, 'CreateMember', 'members', memberId, null, { email: normalizedEmail });
    return res.status(201).json({ member: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PATCH /api/members/:id — admin: update member fields
router.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: existing } = await db.query(
      'SELECT * FROM members WHERE member_id = $1', [id]
    );
    if (!existing.length) return res.status(404).json({ error: 'Member not found' });
    const old = existing[0];

    const allowed = ['full_name', 'affiliation', 'is_admin', 'can_clear_fees', 'status', 'notes'];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const values = [id, ...Object.values(updates)];
    const { rows } = await db.query(
      `UPDATE members SET ${setClauses} WHERE member_id = $1 RETURNING *`,
      values
    );

    await audit(req.member.email, 'UpdateMember', 'members', id, old, updates);
    return res.json({ member: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/members/:id/deactivation-impact — admin: preview open signups before deactivating
router.get('/:id/deactivation-impact', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT signup_id, event_id, event_name, status FROM signups
       WHERE member_id = $1 AND status IN ('Pending', 'Invited')`,
      [req.params.id]
    );
    return res.json({ count: rows.length, signups: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/members/:id/deactivate — admin: mark member inactive and cancel their open signups
router.post('/:id/deactivate', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: memberRows } = await client.query(
      `UPDATE members SET status = 'Inactive' WHERE member_id = $1 RETURNING *`, [id]
    );
    if (!memberRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Member not found' });
    }

    // Pending/Invited signups left behind would otherwise keep this member in
    // lottery pools and invitation lists — drop them and backfill from the waitlist.
    const { rows: openSignups } = await client.query(
      `SELECT signup_id, event_id, status FROM signups
       WHERE member_id = $1 AND status IN ('Pending', 'Invited') FOR UPDATE`,
      [id]
    );

    const promotions = [];
    for (const s of openSignups) {
      await client.query(`UPDATE signups SET status = 'Dropped' WHERE signup_id = $1`, [s.signup_id]);
      if (s.status === 'Invited') {
        const promoted = await promoteNextWaitlist(client, s.event_id);
        if (promoted) promotions.push(promoted);
      }
    }

    await client.query('COMMIT');

    // Best-effort: notify newly-promoted members after commit.
    if (promotions.length) {
      const settings = await getSettings(db);
      for (const p of promotions) {
        const { rows: evRows } = await db.query('SELECT * FROM events WHERE event_id = $1', [p.event_id]);
        if (evRows.length) {
          emailSvc.emailWaitlistPromotion(
            { email: p.member_email, full_name: p.member_name },
            evRows[0], p.newDeclineToken, settings
          ).catch(e => console.error('Promotion email error:', e.message));
        }
      }
    }

    await audit(req.member.email, 'DeactivateMember', 'members', id, null, {
      status: 'Inactive',
      cancelledSignups: openSignups.length,
      waitlistPromotions: promotions.length,
    });

    return res.json({
      member: memberRows[0],
      cancelledSignups: openSignups.length,
      waitlistPromotions: promotions.length,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// GET /api/members/:id/outstanding-charges — member: see what they owe
router.get('/:id/outstanding-charges', requireAuth, async (req, res) => {
  const { id } = req.params;
  if (!req.isAdmin && req.member.member_id !== id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const { rows } = await db.query(
      `SELECT ledger_id, event_id, event_name, type, amount, occurred_at, notes
       FROM fee_ledger WHERE member_id = $1 ORDER BY occurred_at`,
      [id]
    );
    // Net charges against credits, oldest first
    const charges = [];
    let credit = 0;
    rows.forEach(r => {
      const amt = Math.abs(parseFloat(r.amount)) || 0;
      const t = (r.type || '').toLowerCase();
      if (t === 'payment' || t === 'waiver') {
        credit += amt;
      } else if (t === 'charge') {
        charges.push({ ...r, remaining: amt });
      }
    });
    // Apply credits to oldest charges
    const outstanding = [];
    for (const c of charges) {
      if (credit >= c.remaining) {
        credit -= c.remaining;
      } else {
        outstanding.push({ ...c, remaining: c.remaining - credit });
        credit = 0;
      }
    }
    const { rows: memberRows } = await db.query(
      'SELECT fee_balance FROM members WHERE member_id = $1', [id]
    );
    return res.json({
      balance: memberRows[0] ? parseFloat(memberRows[0].fee_balance) : 0,
      charges: outstanding,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;

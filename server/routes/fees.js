// Fee ledger endpoints: list outstanding, record payment, record waiver.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin, requireCanClearFees } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { emailFeePaidConfirm, getSettings } = require('../services/email');
const { recomputeBalance } = require('../services/fees');

const router = express.Router();

// GET /api/fees/my — member: their own outstanding charges (alias for /mine)
router.get('/my', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT fl.ledger_id, fl.type, fl.amount, fl.occurred_at, fl.event_name, fl.notes
       FROM fee_ledger fl
       WHERE fl.member_id = $1
       ORDER BY fl.occurred_at DESC`,
      [req.member.member_id]
    );
    let balance = 0;
    rows.forEach(r => {
      const amt = Math.abs(parseFloat(r.amount)) || 0;
      const t = (r.type || '').toLowerCase();
      if (t === 'charge') balance += amt;
      else if (t === 'payment' || t === 'waiver') balance -= amt;
    });
    if (balance < 0) balance = 0;

    const charges = rows
      .filter(r => r.type === 'Charge')
      .map(r => ({ event_name: r.event_name, amount: parseFloat(r.amount) }));

    return res.json({ balance, charges, ledger: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/fees/mine — member: get my outstanding fee balance and charge breakdown
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const memberId = req.member.member_id;

    const { rows: ledger } = await db.query(
      `SELECT ledger_id, type, amount, event_name, occurred_at, notes
       FROM fee_ledger WHERE member_id = $1 ORDER BY occurred_at ASC`,
      [memberId]
    );

    let charges = 0, credits = 0;
    ledger.forEach(r => {
      const amt = Math.abs(parseFloat(r.amount)) || 0;
      const t = (r.type || '').toLowerCase();
      if (t === 'charge') charges += amt;
      else if (t === 'payment' || t === 'waiver') credits += amt;
    });
    const balance = Math.max(0, charges - credits);

    const outstanding = ledger
      .filter(r => (r.type || '').toLowerCase() === 'charge')
      .map(r => ({ event_name: r.event_name, amount: parseFloat(r.amount) || 0, occurred_at: r.occurred_at }));

    return res.json({ balance, outstanding });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/fees — admin: list all fee ledger entries (optionally filter by member_id)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { member_id, outstanding_only } = req.query;
    let query = `SELECT fl.*, m.full_name, m.email
                 FROM fee_ledger fl JOIN members m ON m.member_id = fl.member_id`;
    const params = [];
    const where = [];
    if (member_id) { params.push(member_id); where.push(`fl.member_id = $${params.length}`); }
    if (where.length) query += ' WHERE ' + where.join(' AND ');
    query += ' ORDER BY fl.occurred_at DESC';

    const { rows } = await db.query(query, params);

    // If outstanding_only, filter members with positive balance
    if (outstanding_only === 'true') {
      const { rows: blocked } = await db.query(
        `SELECT member_id, email, full_name, fee_balance, status
         FROM members WHERE fee_balance > 0 ORDER BY full_name`
      );
      return res.json({ ledger: rows, blockedMembers: blocked });
    }

    return res.json({ ledger: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/fees/outstanding — admin: list members with outstanding balances
router.get('/outstanding', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT member_id, email, full_name, fee_balance, status
       FROM members WHERE fee_balance > 0 ORDER BY full_name`
    );
    return res.json({ members: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/fees/payment — admin (can_clear_fees): record a payment
router.post('/payment', requireCanClearFees, async (req, res) => {
  const { member_id, amount, epay_reference, notes } = req.body;
  if (!member_id || !amount) return res.status(400).json({ error: 'member_id and amount required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: memberRows } = await client.query(
      'SELECT * FROM members WHERE member_id = $1 FOR UPDATE', [member_id]
    );
    if (!memberRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Member not found' }); }

    const ledgerId = 'l_' + uuidv4().replace(/-/g, '');
    await client.query(
      `INSERT INTO fee_ledger (ledger_id, member_id, event_id, event_name, type, amount, recorded_by, epay_reference, notes)
       VALUES ($1, $2, '', '', 'Payment', $3, $4, $5, $6)`,
      [ledgerId, member_id, Math.abs(parseFloat(amount)), req.member.email, epay_reference || '', notes || '']
    );

    const newBal = await recomputeBalance(client, member_id);
    if (newBal <= 0) {
      await client.query(
        `UPDATE members SET status = CASE WHEN status = 'Inactive' THEN status ELSE 'Active' END
         WHERE member_id = $1`, [member_id]
      );
    }
    await client.query('COMMIT');

    // Send confirmation email
    const settings = await getSettings(db);
    emailFeePaidConfirm(memberRows[0], amount, settings)
      .catch(e => console.error('Fee confirm email error:', e.message));

    await audit(req.member.email, 'RecordPayment', 'fee_ledger', member_id, null,
      { amount, ref: epay_reference });
    return res.json({ ok: true, balance: newBal });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/fees/waiver — admin (can_clear_fees): record a waiver
router.post('/waiver', requireCanClearFees, async (req, res) => {
  const { member_id, amount, notes } = req.body;
  if (!member_id || !amount) return res.status(400).json({ error: 'member_id and amount required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: memberRows } = await client.query(
      'SELECT * FROM members WHERE member_id = $1 FOR UPDATE', [member_id]
    );
    if (!memberRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Member not found' }); }

    const ledgerId = 'l_' + uuidv4().replace(/-/g, '');
    await client.query(
      `INSERT INTO fee_ledger (ledger_id, member_id, event_id, event_name, type, amount, recorded_by, notes)
       VALUES ($1, $2, '', '', 'Waiver', $3, $4, $5)`,
      [ledgerId, member_id, Math.abs(parseFloat(amount)), req.member.email, notes || '']
    );

    const newBal = await recomputeBalance(client, member_id);
    if (newBal <= 0) {
      await client.query(
        `UPDATE members SET status = CASE WHEN status = 'Inactive' THEN status ELSE 'Active' END
         WHERE member_id = $1`, [member_id]
      );
    }
    await client.query('COMMIT');

    await audit(req.member.email, 'RecordWaiver', 'fee_ledger', member_id, null,
      { amount, reason: notes });
    return res.json({ ok: true, balance: newBal });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

module.exports = router;


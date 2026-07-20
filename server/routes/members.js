// Member CRUD endpoints.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin, requireExecTeam } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { getSettings } = require('../services/email');
const { promoteNextWaitlist } = require('../services/fees');

const router = express.Router();

// GET /api/members — admin: list all members; member: get own record
router.get('/', requireAuth, async (req, res) => {
  try {
    if (req.isAdmin) {
      const { rows } = await db.query(
        `SELECT m.member_id, m.email, m.full_name, m.affiliation, m.is_admin, m.is_exec_team,
                m.fee_balance, m.status, m.date_joined, m.notes, m.school_year,
                m.partner_member_id, p.full_name AS partner_name
         FROM members m
         LEFT JOIN members p ON p.member_id = m.partner_member_id
         ORDER BY m.full_name`
      );
      return res.json({ members: rows });
    }
    // Non-admin: return only their own record
    const { rows } = await db.query(
      `SELECT member_id, email, full_name, affiliation, is_admin, is_exec_team,
              fee_balance, status, date_joined, school_year
       FROM members WHERE member_id = $1`,
      [req.member.member_id]
    );
    return res.json({ members: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/members/export.csv — admin: download the full member roster.
// Declared before /:id so "export.csv" isn't swallowed as an :id param.
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/export.csv', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT m.full_name, m.email, m.affiliation, m.school_year, m.status,
              m.is_admin, m.is_exec_team, m.fee_balance, m.date_joined,
              p.full_name AS partner_name
       FROM members m
       LEFT JOIN members p ON p.member_id = m.partner_member_id
       ORDER BY m.full_name`
    );

    const header = ['Full Name', 'Email', 'Affiliation', 'School Year', 'Status',
      'Admin', 'Exec Team', 'Fee Balance', 'Date Joined', 'Partner'];
    const lines = [header.join(',')];
    rows.forEach(r => {
      lines.push([
        r.full_name, r.email, r.affiliation, r.school_year, r.status,
        r.is_admin ? 'Yes' : 'No', r.is_exec_team ? 'Yes' : 'No',
        parseFloat(r.fee_balance).toFixed(2),
        r.date_joined ? new Date(r.date_joined).toISOString() : '',
        r.partner_name || '',
      ].map(csvEscape).join(','));
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="wine-circle-members.csv"');
    return res.send(lines.join('\r\n'));
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
      `SELECT member_id, email, full_name, affiliation, is_admin, is_exec_team,
              fee_balance, status, date_joined, notes, school_year
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
  const { email, full_name, affiliation, is_admin, is_exec_team, notes, school_year } = req.body;
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

    let year = (school_year || '').trim();
    if (!year) {
      const settings = await getSettings();
      year = settings.current_school_year || '2026-27';
    }

    const memberId = 'm_' + uuidv4().replace(/-/g, '');
    const { rows } = await db.query(
      `INSERT INTO members (member_id, email, full_name, affiliation, is_admin, is_exec_team, fee_balance, status, notes, school_year)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'Active', $7, $8)
       RETURNING *`,
      [memberId, normalizedEmail, full_name.trim(), affiliation || '', !!is_admin, !!is_exec_team, notes || '', year]
    );
    await audit(req.member.email, 'CreateMember', 'members', memberId, null, { email: normalizedEmail });
    return res.status(201).json({ member: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/members/bulk-import — admin: create members from a parsed roster
// spreadsheet. Body: { school_year, rows: [{ email, first_name, last_name, affiliation, sponsor_email }] }
// (parsing the pasted/uploaded CSV/TSV happens client-side; this endpoint only
// handles the domain logic: dedup, insert, and auto-linking SO/sponsor pairs as partners.)
router.post('/bulk-import', requireAdmin, async (req, res) => {
  const { rows, school_year } = req.body;
  if (!Array.isArray(rows) || !rows.length) {
    return res.status(400).json({ error: 'rows required' });
  }
  const schoolYear = (school_year || '').trim();
  if (!schoolYear) {
    return res.status(400).json({ error: 'school_year is required' });
  }

  const results = { inserted: 0, skipped: [], linked: 0, errors: [] };
  const memberIdByEmail = new Map();

  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    const fullName = `${(r.first_name || '').trim()} ${(r.last_name || '').trim()}`.trim();
    if (!email || !email.includes('@') || !fullName) {
      results.errors.push({ email: r.email || '(blank)', reason: 'Missing email or name' });
      continue;
    }
    try {
      const { rows: existing } = await db.query('SELECT member_id FROM members WHERE LOWER(email) = $1', [email]);
      if (existing.length) {
        results.skipped.push(email);
        memberIdByEmail.set(email, existing[0].member_id);
        continue;
      }
      const memberId = 'm_' + uuidv4().replace(/-/g, '');
      await db.query(
        `INSERT INTO members (member_id, email, full_name, affiliation, fee_balance, status, school_year)
         VALUES ($1, $2, $3, $4, 0, 'Active', $5)`,
        [memberId, email, fullName, (r.affiliation || '').trim(), schoolYear]
      );
      memberIdByEmail.set(email, memberId);
      results.inserted++;
    } catch (err) {
      results.errors.push({ email, reason: err.message });
    }
  }

  // Second pass: auto-link SO/sponsoring-student pairs where both sides are
  // known members and neither already has a partner.
  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    const sponsorEmail = (r.sponsor_email || '').trim().toLowerCase();
    if (!sponsorEmail || !memberIdByEmail.has(email)) continue;
    const memberId = memberIdByEmail.get(email);

    let sponsorId = memberIdByEmail.get(sponsorEmail);
    if (!sponsorId) {
      const { rows: sp } = await db.query('SELECT member_id FROM members WHERE LOWER(email) = $1', [sponsorEmail]);
      if (sp.length) sponsorId = sp[0].member_id;
    }
    if (!sponsorId || sponsorId === memberId) continue;

    try {
      const { rows: current } = await db.query(
        'SELECT member_id, partner_member_id FROM members WHERE member_id IN ($1, $2)',
        [memberId, sponsorId]
      );
      const me = current.find(m => m.member_id === memberId);
      const sponsor = current.find(m => m.member_id === sponsorId);
      if (me && sponsor && !me.partner_member_id && !sponsor.partner_member_id) {
        await db.query('UPDATE members SET partner_member_id = $1 WHERE member_id = $2', [sponsorId, memberId]);
        await db.query('UPDATE members SET partner_member_id = $1 WHERE member_id = $2', [memberId, sponsorId]);
        results.linked++;
      }
    } catch (err) {
      results.errors.push({ email, reason: `Partner link failed: ${err.message}` });
    }
  }

  await audit(req.member.email, 'BulkImportMembers', 'members', '', null, {
    inserted: results.inserted, skipped: results.skipped.length,
    linked: results.linked, errors: results.errors.length,
  });
  return res.json(results);
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

    const allowed = ['full_name', 'affiliation', 'is_admin', 'is_exec_team', 'status', 'notes', 'school_year'];
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

// POST /api/members/bulk-delete — admin + Exec Team: permanently delete member
// rows (and, via ON DELETE CASCADE, their signups and fee_ledger history).
router.post('/bulk-delete', requireAdmin, async (req, res) => {
  if (!req.member.is_exec_team) {
    return res.status(403).json({ error: 'Exec Team permission required' });
  }
  const { member_ids } = req.body;
  if (!Array.isArray(member_ids) || !member_ids.length) {
    return res.status(400).json({ error: 'member_ids required' });
  }
  if (member_ids.includes(req.member.member_id)) {
    return res.status(400).json({ error: "You can't delete your own account." });
  }

  try {
    const { rows } = await db.query(
      'DELETE FROM members WHERE member_id = ANY($1) RETURNING member_id, full_name, email',
      [member_ids]
    );
    await audit(req.member.email, 'BulkDeleteMembers', 'members', '', { deleted: rows }, null);
    return res.json({ ok: true, deleted: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/members/:id/link-partner — admin: mutually link two members as partners
router.post('/:id/link-partner', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { partner_id } = req.body;
  if (!partner_id || partner_id === id) {
    return res.status(400).json({ error: 'A valid, different partner_id is required' });
  }
  try {
    const { rows } = await db.query(
      'SELECT member_id, partner_member_id FROM members WHERE member_id IN ($1, $2)',
      [id, partner_id]
    );
    const me = rows.find(r => r.member_id === id);
    const other = rows.find(r => r.member_id === partner_id);
    if (!me || !other) return res.status(404).json({ error: 'Member not found' });
    if (me.partner_member_id && me.partner_member_id !== partner_id) {
      return res.status(409).json({ error: 'This member is already linked to someone else. Unlink first.' });
    }
    if (other.partner_member_id && other.partner_member_id !== id) {
      return res.status(409).json({ error: 'That member is already linked to someone else. Unlink first.' });
    }

    await db.query('UPDATE members SET partner_member_id = $1 WHERE member_id = $2', [partner_id, id]);
    await db.query('UPDATE members SET partner_member_id = $1 WHERE member_id = $2', [id, partner_id]);

    await audit(req.member.email, 'LinkPartner', 'members', id, null, { partner_id });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/members/:id/unlink-partner — admin: clear a partner link on both sides
router.post('/:id/unlink-partner', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query('SELECT partner_member_id FROM members WHERE member_id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Member not found' });
    const partnerId = rows[0].partner_member_id;

    await db.query('UPDATE members SET partner_member_id = NULL WHERE member_id = $1', [id]);
    if (partnerId) {
      await db.query('UPDATE members SET partner_member_id = NULL WHERE member_id = $1', [partnerId]);
    }

    await audit(req.member.email, 'UnlinkPartner', 'members', id, { partner_id: partnerId }, null);
    return res.json({ ok: true });
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

// Event CRUD and lifecycle endpoints.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');
const { getSettings } = require('../services/email');
const { recomputeBalance } = require('../services/fees');
const {
  assignLotteryResults,
  classifyFinalizeSignups,
} = require('../services/signupLogic');

const router = express.Router();

// GET /api/events — member-scoped view: open events + events the caller has
// signed up for. Always this view regardless of admin status, so an admin
// account still gets a genuine member experience on the member portal
// instead of the admin's full event list bleeding through.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT e.*,
              s.signup_id, s.member_visible_status AS signup_status, s.lottery_rank,
              s.invite_sent_at, s.decline_token, s.declined_at
       FROM events e
       LEFT JOIN signups s ON s.event_id = e.event_id AND s.member_id = $1
       WHERE e.status = 'Open' OR s.signup_id IS NOT NULL
       ORDER BY e.event_date ASC NULLS LAST`,
      [req.member.member_id]
    );
    return res.json({ events: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/events/all — admin: every event regardless of status, for the
// admin portal's event management list. Must be declared before /:id.
router.get('/all', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT * FROM events ORDER BY event_date DESC NULLS LAST`);
    return res.json({ events: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/events/:id
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM events WHERE event_id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    const event = rows[0];

    // Include caller's signup if any. `status` is the internal/admin-facing
    // field; members must only ever see `member_visible_status`, aliased here
    // as `status` so the frontend needs no changes.
    const { rows: signupRows } = await db.query(
      'SELECT * FROM signups WHERE event_id = $1 AND member_id = $2',
      [req.params.id, req.member.member_id]
    );
    let mySignup = signupRows[0] || null;
    if (mySignup) {
      mySignup = { ...mySignup, status: mySignup.member_visible_status };
      delete mySignup.member_visible_status;
    }
    return res.json({ event, mySignup });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/events — admin: create event
router.post('/', requireAdmin, async (req, res) => {
  const {
    name, event_date, location, capacity, description, host_notes,
    signup_opens_at, signup_closes_at, auto_invite_enabled, send_lottery_lost_emails
  } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const settings = await getSettings();
    const eventId = 'e_' + uuidv4().replace(/-/g, '');
    const cap = parseInt(capacity) || parseInt(settings.default_capacity) || 60;
    const autoInvite = auto_invite_enabled !== undefined
      ? !!auto_invite_enabled
      : settings.default_auto_invite_enabled !== 'FALSE';
    const sendLost = send_lottery_lost_emails !== undefined
      ? !!send_lottery_lost_emails
      : settings.default_send_lottery_lost_emails !== 'FALSE';

    const { rows } = await db.query(
      `INSERT INTO events
         (event_id, name, event_date, location, capacity, description, host_notes,
          signup_opens_at, signup_closes_at, auto_invite_enabled, send_lottery_lost_emails,
          status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Draft',$12)
       RETURNING *`,
      [
        eventId, name, event_date || null, location || '', cap,
        description || '', host_notes || '',
        signup_opens_at || null, signup_closes_at || null,
        autoInvite, sendLost, req.member.email,
      ]
    );
    await audit(req.member.email, 'CreateEvent', 'events', eventId, null, { name });
    return res.status(201).json({ event: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PATCH /api/events/:id — admin: update event fields
router.patch('/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows: existing } = await db.query('SELECT * FROM events WHERE event_id = $1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Event not found' });
    const old = existing[0];

    const allowed = [
      'name', 'event_date', 'location', 'capacity', 'description', 'host_notes',
      'signup_opens_at', 'signup_closes_at', 'auto_invite_enabled', 'send_lottery_lost_emails',
    ];
    const updates = {};
    allowed.forEach(f => { if (req.body[f] !== undefined) updates[f] = req.body[f]; });
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields' });

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(', ');
    const { rows } = await db.query(
      `UPDATE events SET ${setClauses} WHERE event_id = $1 RETURNING *`,
      [id, ...Object.values(updates)]
    );
    await audit(req.member.email, 'UpdateEvent', 'events', id, old, updates);
    return res.json({ event: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/events/:id/open — admin: open signups
router.post('/:id/open', requireAdmin, async (req, res) => {
  return setEventStatus(req, res, 'Open');
});

// POST /api/events/:id/close — admin: close signups
router.post('/:id/close', requireAdmin, async (req, res) => {
  return setEventStatus(req, res, 'Closed');
});

// POST /api/events/:id/cancel — admin: cancel event
router.post('/:id/cancel', requireAdmin, async (req, res) => {
  return setEventStatus(req, res, 'Cancelled');
});

// POST /api/events/:id/run-lottery — admin: run the lottery
router.post('/:id/run-lottery', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: evRows } = await client.query(
      'SELECT * FROM events WHERE event_id = $1 FOR UPDATE', [id]
    );
    if (!evRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    const event = evRows[0];
    if (!['Closed', 'Open'].includes(event.status)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Event must be Open or Closed to run lottery' });
    }

    // Get all pending signups
    const { rows: pending } = await client.query(
      `SELECT signup_id FROM signups WHERE event_id = $1 AND status = 'Pending'`, [id]
    );

    // Shuffle (Fisher-Yates via random sort)
    const shuffled = pending.sort(() => Math.random() - 0.5);
    const capacity = parseInt(event.capacity) || 60;

    // Use shared logic to assign ranks and statuses
    const results = assignLotteryResults(shuffled, capacity);
    for (const r of results) {
      await client.query(
        `UPDATE signups SET lottery_rank = $1, status = $2 WHERE signup_id = $3`,
        [r.lottery_rank, r.newStatus, r.signup_id]
      );
    }

    const inviteCount = results.filter(r => r.newStatus === 'Invited').length;
    const waitlistCount = results.filter(r => r.newStatus === 'Waitlist').length;

    await client.query(
      `UPDATE events SET status = 'Lotteried', lottery_run_at = NOW() WHERE event_id = $1`, [id]
    );

    await client.query('COMMIT');
    await audit(req.member.email, 'RunLottery', 'events', id, null,
      { invited: inviteCount, waitlist: waitlistCount });

    return res.json({ ok: true, invited: inviteCount, waitlist: waitlistCount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/events/:id/finalize — admin: finalize event (flake detection)
router.post('/:id/finalize', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: evRows } = await client.query(
      'SELECT * FROM events WHERE event_id = $1 FOR UPDATE', [id]
    );
    if (!evRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    const event = evRows[0];
    if (event.status === 'Completed') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Event already finalized' });
    }

    const settings = await getSettings();
    const feeAmount = parseFloat(settings.flake_fee_amount) || 30;

    // Fetch all non-terminal signups and classify using shared logic
    const { rows: allSignups } = await client.query(
      `SELECT s.*, m.email AS member_email, m.full_name AS member_name
       FROM signups s JOIN members m ON m.member_id = s.member_id
       WHERE s.event_id = $1 AND s.status IN ('Invited', 'Waitlist')`,
      [id]
    );
    const { toFlake, toLose } = classifyFinalizeSignups(allSignups);

    for (const s of toFlake) {
      await client.query(
        `UPDATE signups SET status = 'Flaked' WHERE signup_id = $1`, [s.signup_id]
      );
      // Charge flake fee
      const ledgerId = 'l_' + uuidv4().replace(/-/g, '');
      await client.query(
        `INSERT INTO fee_ledger (ledger_id, member_id, event_id, event_name, type, amount, recorded_by, notes)
         VALUES ($1, $2, $3, $4, 'Charge', $5, 'system', $6)`,
        [ledgerId, s.member_id, id, event.name, feeAmount, `Flake at event "${event.name}"`]
      );
      // Recompute balance and block member
      await recomputeBalance(client, s.member_id);
    }

    // Waitlist that never got promoted → Lost
    const lostIds = toLose.map(s => s.signup_id);
    if (lostIds.length) {
      await client.query(
        `UPDATE signups SET status = 'Lost' WHERE signup_id = ANY($1)`, [lostIds]
      );
    }
    const waitlisted = toLose; // alias for audit count below

    await client.query(
      `UPDATE events SET status = 'Completed' WHERE event_id = $1`, [id]
    );

    await client.query('COMMIT');

    await audit(req.member.email, 'FinalizeEvent', 'events', id, null,
      { flaked: toFlake.length, lost: waitlisted.length });

    return res.json({ ok: true, flaked: toFlake.length, lost: waitlisted.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/events/:id/push-updates — admin: sync member_visible_status to
// the current internal status for every signup on this event that has
// changed since the last push. This is the only way status changes become
// visible to members — nothing pushes automatically.
router.post('/:id/push-updates', requireAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await db.query(
      `UPDATE signups SET member_visible_status = status
       WHERE event_id = $1 AND status != member_visible_status
       RETURNING signup_id`,
      [id]
    );
    await audit(req.member.email, 'PushPortalUpdates', 'events', id, null, { pushed: rows.length });
    return res.json({ ok: true, pushed: rows.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/events/:id/signups — admin: list all signups for an event.
// Returns both the internal `status` and `member_visible_status` so the
// admin UI can show whether the latest change has been pushed to the portal.
router.get('/:id/signups', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.*, m.email AS member_email, m.full_name AS member_name, m.affiliation
       FROM signups s JOIN members m ON m.member_id = s.member_id
       WHERE s.event_id = $1
       ORDER BY s.lottery_rank ASC NULLS LAST, s.signed_up_at ASC`,
      [req.params.id]
    );
    return res.json({ signups: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/events/:id/attendees.csv — admin: download CSV of Attended members
function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

router.get('/:id/attendees.csv', requireAdmin, async (req, res) => {
  try {
    const { rows: evRows } = await db.query('SELECT name FROM events WHERE event_id = $1', [req.params.id]);
    if (!evRows.length) return res.status(404).json({ error: 'Event not found' });

    const { rows } = await db.query(
      `SELECT m.full_name, m.email, m.affiliation, s.attended_marked_at
       FROM signups s JOIN members m ON m.member_id = s.member_id
       WHERE s.event_id = $1 AND s.status = 'Attended'
       ORDER BY m.full_name`,
      [req.params.id]
    );

    const lines = [['Name', 'Email', 'Affiliation', 'Attended At'].join(',')];
    rows.forEach(r => {
      lines.push([
        r.full_name, r.email, r.affiliation,
        r.attended_marked_at ? new Date(r.attended_marked_at).toISOString() : '',
      ].map(csvEscape).join(','));
    });

    const safeName = (evRows[0].name || 'event').replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}-attendees.csv"`);
    return res.send(lines.join('\r\n'));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Helper: set event status
async function setEventStatus(req, res, newStatus) {
  const { id } = req.params;
  try {
    const { rows: existing } = await db.query('SELECT status FROM events WHERE event_id = $1', [id]);
    if (!existing.length) return res.status(404).json({ error: 'Event not found' });
    const { rows } = await db.query(
      `UPDATE events SET status = $1 WHERE event_id = $2 RETURNING *`, [newStatus, id]
    );
    await audit(req.member.email, `SetEventStatus:${newStatus}`, 'events', id,
      { status: existing[0].status }, { status: newStatus });
    return res.json({ event: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
}

module.exports = router;

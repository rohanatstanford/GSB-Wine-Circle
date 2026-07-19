// Signup lifecycle: enter, decline (by token), mark attendance, promote from waitlist.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');
const emailSvc = require('../services/email');
const { getSettings } = emailSvc;
const { recomputeBalance, promoteNextWaitlist } = require('../services/fees');
const {
  determineDeclineOutcome,
  isMemberBlocked,
  shouldAutoPromote,
} = require('../services/signupLogic');

const router = express.Router();

// POST /api/signups — member: enter lottery for an event
router.post('/', requireAuth, async (req, res) => {
  const { event_id } = req.body;
  if (!event_id) return res.status(400).json({ error: 'event_id required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Check member is not blocked
    const { rows: memberRows } = await client.query(
      `SELECT fee_balance, status FROM members WHERE member_id = $1 FOR UPDATE`, [req.member.member_id]
    );
    if (!memberRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Member not found' }); }
    const m = memberRows[0];

    const settings = await getSettings(client);
    if (isMemberBlocked(m)) {
      await client.query('ROLLBACK');
      return res.status(403).json({
        error: `You have an outstanding $${settings.flake_fee_amount || 30} flake fee. ` +
               `Pay at ${settings.assu_epay_url || '[ePay URL not configured]'} and a leader will unblock you.`,
        blocked: true,
      });
    }

    // Check event is open
    const { rows: evRows } = await client.query(
      `SELECT * FROM events WHERE event_id = $1`, [event_id]
    );
    if (!evRows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Event not found' }); }
    const event = evRows[0];
    if (event.status !== 'Open') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Signups are not open for this event.' });
    }

    // Check not already signed up
    const { rows: existing } = await client.query(
      `SELECT signup_id, status FROM signups WHERE event_id = $1 AND member_id = $2`,
      [event_id, req.member.member_id]
    );
    if (existing.length) {
      await client.query('ROLLBACK');
      return res.json({ signup: existing[0], alreadySignedUp: true });
    }

    const signupId = 's_' + uuidv4().replace(/-/g, '');
    const declineToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const { rows } = await client.query(
      `INSERT INTO signups
         (signup_id, event_id, event_name, member_id, member_name, member_email,
          email_at_signup, status, decline_token)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'Pending', $8)
       RETURNING *`,
      [
        signupId, event_id, event.name,
        req.member.member_id, req.member.full_name, req.member.email,
        req.member.email, declineToken,
      ]
    );

    await client.query('COMMIT');
    return res.status(201).json({ signup: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// GET /api/signups/invitations — member: their Invited + Waitlist signups with event detail
router.get('/invitations', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.signup_id, s.event_id, s.status, s.lottery_rank,
              s.invite_sent_at, s.decline_token, s.declined_at,
              e.name AS event_name, e.event_date, e.location, e.description
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       WHERE s.member_id = $1
         AND s.status IN ('Invited', 'Waitlist')
       ORDER BY e.event_date ASC NULLS LAST`,
      [req.member.member_id]
    );
    return res.json({ invitations: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/signups/my — member: all their signups
router.get('/my', requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.signup_id, s.event_id, s.status, s.lottery_rank,
              s.signed_up_at, s.invite_sent_at, s.declined_at,
              e.name AS event_name, e.event_date, e.location
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       WHERE s.member_id = $1
       ORDER BY s.signed_up_at DESC`,
      [req.member.member_id]
    );
    return res.json({ signups: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/signups/:id/decline — member: decline an invitation (authenticated)
router.post('/:id/decline', requireAuth, async (req, res) => {
  const signupId = req.params.id;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: signupRows } = await client.query(
      `SELECT s.*, e.name AS event_name_resolved, e.event_date, e.auto_invite_enabled,
              m.email AS member_email, m.full_name AS member_full_name
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       JOIN members m ON m.member_id = s.member_id
       WHERE s.signup_id = $1
         AND s.member_id = $2
         AND s.status IN ('Invited', 'Pending')
       FOR UPDATE`,
      [signupId, req.member.member_id]
    );
    if (!signupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found or already handled.' });
    }
    const s = signupRows[0];
    const settings = await getSettings(client);
    const { newStatus, feeAmount } = determineDeclineOutcome(s, settings, new Date());
    const wasInvited = s.status === 'Invited';

    await client.query(
      `UPDATE signups SET status = $1, declined_at = NOW() WHERE signup_id = $2`,
      [newStatus, s.signup_id]
    );

    if (newStatus === 'Flaked') {
      const ledgerId = 'l_' + uuidv4().replace(/-/g, '');
      await client.query(
        `INSERT INTO fee_ledger (ledger_id, member_id, event_id, event_name, type, amount, recorded_by, notes)
         VALUES ($1, $2, $3, $4, 'Charge', $5, 'system', $6)`,
        [ledgerId, s.member_id, s.event_id, s.event_name_resolved, feeAmount,
         `Late decline (flake) at event "${s.event_name_resolved}"`]
      );
      await recomputeBalance(client, s.member_id);
    }

    let promoted = null;
    if (shouldAutoPromote(s, { auto_invite_enabled: s.auto_invite_enabled })) {
      promoted = await promoteNextWaitlist(client, s.event_id);
    }

    await client.query('COMMIT');

    if (newStatus === 'Flaked') {
      emailSvc.emailFlakeNotice(
        { email: s.member_email, full_name: s.member_full_name },
        { event_id: s.event_id, name: s.event_name_resolved, event_date: s.event_date },
        feeAmount, settings
      ).catch(e => console.error('Flake notice error:', e.message));
    }

    if (promoted) {
      const { rows: evRows } = await db.query('SELECT * FROM events WHERE event_id = $1', [s.event_id]);
      if (evRows.length) {
        emailSvc.emailWaitlistPromotion(
          { email: promoted.member_email, full_name: promoted.member_name },
          evRows[0], promoted.newDeclineToken, settings
        ).catch(e => console.error('Promotion email error:', e.message));
      }
    }

    audit(req.member.email, 'DeclineSignup', 'signups', signupId, { status: s.status }, { status: newStatus });

    return res.json({ ok: true, status: newStatus, feeAmount });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/decline-by-token — public: decline via unique link in email
router.post('/decline-by-token', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: signupRows } = await client.query(
      `SELECT s.*, e.name AS event_name_resolved, e.event_date, e.auto_invite_enabled,
              m.email AS member_email, m.full_name AS member_full_name
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       JOIN members m ON m.member_id = s.member_id
       WHERE s.decline_token = $1
         AND s.status IN ('Invited', 'Pending')
       FOR UPDATE`,
      [token]
    );
    if (!signupRows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Invite not found or already declined.' });
    }
    const s = signupRows[0];
    const settings = await getSettings(client);
    const { newStatus, feeAmount } = determineDeclineOutcome(s, settings, new Date());
    const wasInvited = s.status === 'Invited';

    await client.query(
      `UPDATE signups SET status = $1, declined_at = NOW() WHERE signup_id = $2`,
      [newStatus, s.signup_id]
    );

    if (newStatus === 'Flaked') {
      // Charge fee
      const ledgerId = 'l_' + uuidv4().replace(/-/g, '');
      await client.query(
        `INSERT INTO fee_ledger (ledger_id, member_id, event_id, event_name, type, amount, recorded_by, notes)
         VALUES ($1, $2, $3, $4, 'Charge', $5, 'system', $6)`,
        [ledgerId, s.member_id, s.event_id, s.event_name_resolved, feeAmount,
         `Late decline (flake) at event "${s.event_name_resolved}"`]
      );
      await recomputeBalance(client, s.member_id);
    }

    // Auto-promote from waitlist if this was an Invited slot
    let promoted = null;
    if (shouldAutoPromote(s, { auto_invite_enabled: s.auto_invite_enabled })) {
      promoted = await promoteNextWaitlist(client, s.event_id);
    }

    await client.query('COMMIT');

    // Best-effort: send flake notice
    if (newStatus === 'Flaked') {
      emailSvc.emailFlakeNotice(
        { email: s.member_email, full_name: s.member_full_name },
        { event_id: s.event_id, name: s.event_name_resolved, event_date: s.event_date },
        feeAmount, settings
      ).catch(e => console.error('Flake notice error:', e.message));
    }

    // Send promotion email to next waitlist member
    if (promoted) {
      const { rows: evRows } = await db.query('SELECT * FROM events WHERE event_id = $1', [s.event_id]);
      if (evRows.length) {
        emailSvc.emailWaitlistPromotion(
          { email: promoted.member_email, full_name: promoted.member_name },
          evRows[0], promoted.newDeclineToken, settings
        ).catch(e => console.error('Promotion email error:', e.message));
      }
    }

    audit('system', 'DeclineSignup', 'signups', s.signup_id, { status: s.status }, { status: newStatus });

    return res.json({ ok: true, status: newStatus, promoted: !!promoted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// GET /api/signups/by-token/:token — public: get invite info for decline page
router.get('/by-token/:token', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT s.signup_id, s.status, s.event_id, s.event_name, s.member_name,
              e.event_date, e.location, e.description
       FROM signups s
       JOIN events e ON e.event_id = s.event_id
       WHERE s.decline_token = $1`,
      [req.params.token]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invite not found.' });
    return res.json({ invite: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/signups/:id/attendance — admin: mark attendance
router.post('/:id/attendance', requireAdmin, async (req, res) => {
  const { attended } = req.body;
  if (attended === undefined) return res.status(400).json({ error: 'attended required' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      'SELECT * FROM signups WHERE signup_id = $1', [req.params.id]
    );
    if (!existing.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = existing[0];

    const newStatus = attended ? 'Attended' : s.status;
    const { rows } = await client.query(
      `UPDATE signups SET status = $1, attended_marked_at = NOW(), marked_by = $2
       WHERE signup_id = $3 RETURNING *`,
      [newStatus, req.member.email, req.params.id]
    );
    await client.query('COMMIT');
    await audit(req.member.email, attended ? 'MarkAttended' : 'UnmarkAttended',
      'signups', req.params.id, { status: s.status }, { status: newStatus });
    return res.json({ signup: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/:id/promote — admin: manually promote a waitlist member
router.post('/:id/promote', requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT s.*, m.email AS member_email, m.full_name AS member_name
       FROM signups s JOIN members m ON m.member_id = s.member_id
       WHERE s.signup_id = $1`,
      [req.params.id]
    );
    if (!existing.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = existing[0];
    if (s.status !== 'Waitlist') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Signup is not on the waitlist' });
    }

    const newToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
    const { rows } = await client.query(
      `UPDATE signups SET status = 'Invited', decline_token = $1, invite_sent_at = NOW()
       WHERE signup_id = $2 RETURNING *`,
      [newToken, req.params.id]
    );
    await client.query('COMMIT');

    // Send promotion email
    const { rows: evRows } = await db.query('SELECT * FROM events WHERE event_id = $1', [s.event_id]);
    if (evRows.length) {
      const settings = await getSettings();
      emailSvc.emailWaitlistPromotion(
        { email: s.member_email, full_name: s.member_name },
        evRows[0], newToken, settings
      ).catch(e => console.error('Promotion email error:', e.message));
    }

    await audit(req.member.email, 'PromoteWaitlist', 'signups', req.params.id,
      { status: 'Waitlist' }, { status: 'Invited' });
    return res.json({ signup: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

// POST /api/signups/:id/demote — admin: manually remove a member from the
// Invited (lottery-winner) list, sending them back to Waitlist. Frees their
// slot, so the next waitlisted member is auto-promoted if the event allows it.
router.post('/:id/demote', requireAdmin, async (req, res) => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT s.*, e.auto_invite_enabled
       FROM signups s JOIN events e ON e.event_id = s.event_id
       WHERE s.signup_id = $1 FOR UPDATE`,
      [req.params.id]
    );
    if (!existing.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Signup not found' }); }
    const s = existing[0];
    if (s.status !== 'Invited') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Signup is not currently Invited' });
    }

    const { rows } = await client.query(
      `UPDATE signups SET status = 'Waitlist', decline_token = NULL, invite_sent_at = NULL
       WHERE signup_id = $1 RETURNING *`,
      [req.params.id]
    );

    let promoted = null;
    if (s.auto_invite_enabled) {
      // Exclude the signup we just moved to Waitlist - otherwise a lone
      // waitlister would immediately re-promote themselves right back.
      promoted = await promoteNextWaitlist(client, s.event_id, req.params.id);
    }

    await client.query('COMMIT');

    if (promoted) {
      const { rows: evRows } = await db.query('SELECT * FROM events WHERE event_id = $1', [s.event_id]);
      if (evRows.length) {
        const settings = await getSettings(db);
        emailSvc.emailWaitlistPromotion(
          { email: promoted.member_email, full_name: promoted.member_name },
          evRows[0], promoted.newDeclineToken, settings
        ).catch(e => console.error('Promotion email error:', e.message));
      }
    }

    await audit(req.member.email, 'DemoteFromInvited', 'signups', req.params.id,
      { status: 'Invited' }, { status: 'Waitlist', promoted: promoted ? promoted.signup_id : null });
    return res.json({ signup: rows[0], promoted: !!promoted });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  } finally {
    client.release();
  }
});

module.exports = router;

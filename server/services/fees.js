// Shared fee-balance and waitlist-promotion helpers used by signups/events/fees routes.
// Consolidated from three near-duplicate copies (see task-plans/13-fee-balance-deduplication.md).
const { v4: uuidv4 } = require('uuid');
const { computeBalance } = require('./signupLogic');

/**
 * Recompute a member's fee_balance from their fee_ledger and set their
 * Blocked/Active status accordingly. Never overrides an Inactive status.
 */
async function recomputeBalance(client, memberId) {
  const { rows } = await client.query(
    `SELECT type, amount FROM fee_ledger WHERE member_id = $1`, [memberId]
  );
  const bal = computeBalance(rows);
  const newStatus = bal > 0 ? 'Blocked' : 'Active';
  await client.query(
    `UPDATE members SET fee_balance = $1, status = CASE WHEN status = 'Inactive' THEN status ELSE $2 END
     WHERE member_id = $3`,
    [bal, newStatus, memberId]
  );
  return bal;
}

/**
 * Promote the next Waitlist signup (by lottery_rank) for an event to Invited,
 * issuing a fresh decline token. Returns the promoted signup row, or null if
 * the waitlist is empty. Caller is responsible for sending the promotion email.
 */
async function promoteNextWaitlist(client, eventId) {
  const { rows: waitlist } = await client.query(
    `SELECT s2.*, m.email AS member_email, m.full_name AS member_name
     FROM signups s2
     JOIN members m ON m.member_id = s2.member_id
     WHERE s2.event_id = $1 AND s2.status = 'Waitlist'
     ORDER BY s2.lottery_rank ASC
     LIMIT 1 FOR UPDATE`,
    [eventId]
  );
  if (!waitlist.length) return null;
  const next = waitlist[0];
  const newDeclineToken = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
  await client.query(
    `UPDATE signups SET status = 'Invited', decline_token = $1, invite_sent_at = NOW()
     WHERE signup_id = $2`,
    [newDeclineToken, next.signup_id]
  );
  return { ...next, newDeclineToken };
}

module.exports = { recomputeBalance, promoteNextWaitlist };

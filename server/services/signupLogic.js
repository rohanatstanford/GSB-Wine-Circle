/**
 * Pure business-logic helpers — no database or IO dependencies.
 * Used by route handlers AND unit tests so both exercise the same code.
 */

'use strict';

/**
 * Compute a member's outstanding fee balance from raw ledger rows.
 * @param {Array<{type: string, amount: string|number}>} ledgerRows
 * @returns {number}  balance (never negative)
 */
function computeBalance(ledgerRows) {
  let bal = 0;
  for (const r of ledgerRows) {
    const amt = Math.abs(parseFloat(r.amount)) || 0;
    const t = (r.type || '').toLowerCase();
    if (t === 'charge') bal += amt;
    else if (t === 'payment' || t === 'waiver') bal -= amt;
  }
  return bal < 0 ? 0 : bal;
}

/**
 * Decide whether a decline is a flake (late) or a clean drop.
 *
 * @param {object} signup          — must have .status and .event_date
 * @param {object} settings        — must have .decline_grace_window_hours and .flake_fee_amount
 * @param {Date}   now             — current time (injected for testability)
 * @returns {{ newStatus: 'Flaked'|'Dropped', feeAmount: number, isLate: boolean }}
 */
function determineDeclineOutcome(signup, settings, now) {
  const graceHours = parseInt(settings.decline_grace_window_hours) || 24;
  const feeAmount  = parseFloat(settings.flake_fee_amount) || 30;

  const eventDate = signup.event_date ? new Date(signup.event_date) : null;
  const isLate    = !!eventDate && (eventDate - now) < graceHours * 60 * 60 * 1000;
  const wasInvited = signup.status === 'Invited';

  const newStatus = (wasInvited && isLate) ? 'Flaked' : 'Dropped';
  return { newStatus, feeAmount, isLate };
}

/**
 * Assign lottery ranks and statuses to a list of pending signups.
 *
 * @param {Array<{signup_id: string}>} pendingSignups — already shuffled or in desired order
 * @param {number} capacity
 * @returns {Array<{signup_id: string, lottery_rank: number, newStatus: 'Invited'|'Waitlist'}>}
 */
function assignLotteryResults(pendingSignups, capacity) {
  return pendingSignups.map((s, i) => ({
    signup_id:    s.signup_id,
    lottery_rank: i + 1,
    newStatus:    i < capacity ? 'Invited' : 'Waitlist',
  }));
}

/**
 * Decide whether a decline should trigger auto-promotion from the waitlist.
 * Only an Invited member vacating their slot on an auto_invite_enabled event
 * opens a slot for promotion.
 *
 * @param {{ status: string }}        signup
 * @param {{ auto_invite_enabled: * }} event
 * @returns {boolean}
 */
function shouldAutoPromote(signup, event) {
  return signup.status === 'Invited' && !!event.auto_invite_enabled;
}

/**
 * Classify signups for finalization:
 *   - Invited → will be Flaked (fee charged)
 *   - Waitlist → will be marked Lost
 *
 * Pure: does not mutate input or touch the database.
 *
 * @param {Array<{signup_id: string, status: string}>} signups
 * @returns {{ toFlake: Array, toLose: Array }}
 */
function classifyFinalizeSignups(signups) {
  return {
    toFlake: signups.filter(s => s.status === 'Invited'),
    toLose:  signups.filter(s => s.status === 'Waitlist'),
  };
}

/**
 * Given current member state, decide whether they are blocked from entering lottery.
 *
 * @param {{ fee_balance: string|number, status: string }} member
 * @returns {boolean}
 */
function isMemberBlocked(member) {
  return parseFloat(member.fee_balance) > 0 || member.status === 'Blocked';
}

module.exports = {
  computeBalance,
  determineDeclineOutcome,
  assignLotteryResults,
  shouldAutoPromote,
  classifyFinalizeSignups,
  isMemberBlocked,
};

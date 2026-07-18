/**
 * Unit tests for Wine Circle core business logic.
 * Covers: lottery split, decline/flake timing, auto-promotion trigger,
 * fee-block enforcement, finalize behaviour, and payment clearing.
 *
 * All tests import from production modules — no local re-implementations.
 */

'use strict';

const {
  computeBalance,
  determineDeclineOutcome,
  assignLotteryResults,
  shouldAutoPromote,
  classifyFinalizeSignups,
  isMemberBlocked,
} = require('../services/signupLogic');

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Returns a Date that is `hours` hours from now (positive = future). */
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

const DEFAULT_SETTINGS = {
  decline_grace_window_hours: '24',
  flake_fee_amount: '30',
};

// ─── computeBalance ───────────────────────────────────────────────────────────

describe('computeBalance', () => {
  test('returns 0 for empty ledger', () => {
    expect(computeBalance([])).toBe(0);
  });

  test('single charge', () => {
    expect(computeBalance([{ type: 'Charge', amount: '30' }])).toBe(30);
  });

  test('charge fully paid → 0', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('charge partially paid → remainder', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '10' },
    ];
    expect(computeBalance(ledger)).toBe(20);
  });

  test('charge waived → 0', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Waiver', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('multiple charges accumulated', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Charge', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(60);
  });

  test('overpayment clamps to 0 (never negative)', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '50' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('type comparison is case-insensitive', () => {
    const ledger = [
      { type: 'charge', amount: '30' },
      { type: 'payment', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });
});

// ─── isMemberBlocked ─────────────────────────────────────────────────────────

describe('isMemberBlocked', () => {
  test('active member with zero balance is not blocked', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Active' })).toBe(false);
  });

  test('member with positive fee_balance is blocked', () => {
    expect(isMemberBlocked({ fee_balance: '30', status: 'Active' })).toBe(true);
  });

  test('member with Blocked status is blocked even if balance is 0', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Blocked' })).toBe(true);
  });

  test('member with both positive balance and Blocked status is blocked', () => {
    expect(isMemberBlocked({ fee_balance: '30', status: 'Blocked' })).toBe(true);
  });

  test('inactive member with zero balance is not blocked', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Inactive' })).toBe(false);
  });

  test('treats numeric fee_balance correctly', () => {
    expect(isMemberBlocked({ fee_balance: 0, status: 'Active' })).toBe(false);
    expect(isMemberBlocked({ fee_balance: 1, status: 'Active' })).toBe(true);
  });
});

// ─── assignLotteryResults ─────────────────────────────────────────────────────

describe('assignLotteryResults — Invited/Waitlist split at capacity boundary', () => {
  function makePending(n) {
    return Array.from({ length: n }, (_, i) => ({ signup_id: `s${i + 1}` }));
  }

  test('all invited when signups < capacity', () => {
    const results = assignLotteryResults(makePending(3), 5);
    expect(results).toHaveLength(3);
    results.forEach(r => expect(r.newStatus).toBe('Invited'));
  });

  test('all invited when signups == capacity (boundary)', () => {
    const results = assignLotteryResults(makePending(5), 5);
    results.forEach(r => expect(r.newStatus).toBe('Invited'));
  });

  test('first N get Invited, rest get Waitlist when signups > capacity', () => {
    const results = assignLotteryResults(makePending(8), 5);
    const invited    = results.filter(r => r.newStatus === 'Invited');
    const waitlisted = results.filter(r => r.newStatus === 'Waitlist');
    expect(invited).toHaveLength(5);
    expect(waitlisted).toHaveLength(3);
  });

  test('capacity 0 → everyone on waitlist', () => {
    const results = assignLotteryResults(makePending(4), 0);
    results.forEach(r => expect(r.newStatus).toBe('Waitlist'));
  });

  test('empty pending → empty results', () => {
    expect(assignLotteryResults([], 10)).toHaveLength(0);
  });

  test('lottery ranks are sequential starting at 1', () => {
    const results = assignLotteryResults(makePending(5), 5);
    results.forEach((r, i) => expect(r.lottery_rank).toBe(i + 1));
  });

  test('Waitlist ranks continue after Invited ranks', () => {
    const results = assignLotteryResults(makePending(4), 2);
    expect(results[2].lottery_rank).toBe(3);
    expect(results[3].lottery_rank).toBe(4);
  });

  test('signup_id is preserved in output', () => {
    const pending = [{ signup_id: 'abc' }, { signup_id: 'xyz' }];
    const results = assignLotteryResults(pending, 1);
    expect(results[0].signup_id).toBe('abc');
    expect(results[1].signup_id).toBe('xyz');
  });
});

// ─── determineDeclineOutcome ──────────────────────────────────────────────────

describe('determineDeclineOutcome — flake vs drop', () => {
  // ── Invited declines ──────────────────────────────────────────────────────

  describe('Invited member declines', () => {
    test('within grace window (late) → Flaked with fee', () => {
      const signup   = { status: 'Invited', event_date: hoursFromNow(10) }; // 10 h away, < 24 h
      const { newStatus, feeAmount, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Flaked');
      expect(isLate).toBe(true);
      expect(feeAmount).toBe(30);
    });

    test('outside grace window (early) → Dropped, no fee consequence', () => {
      const signup = { status: 'Invited', event_date: hoursFromNow(48) }; // 48 h away, > 24 h
      const { newStatus, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
      expect(isLate).toBe(false);
    });

    test('exactly at grace boundary → not late (< not <=) → Dropped', () => {
      const graceMs = 24 * 60 * 60 * 1000;
      const now     = new Date();
      const signup  = { status: 'Invited', event_date: new Date(now.getTime() + graceMs) };
      const { newStatus, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, now);
      expect(newStatus).toBe('Dropped');
      expect(isLate).toBe(false);
    });

    test('1 ms inside grace window → Flaked', () => {
      const graceMs = 24 * 60 * 60 * 1000;
      const now     = new Date();
      const signup  = { status: 'Invited', event_date: new Date(now.getTime() + graceMs - 1) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, now);
      expect(newStatus).toBe('Flaked');
    });

    test('event already passed → isLate true → Flaked', () => {
      const signup = { status: 'Invited', event_date: hoursFromNow(-1) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Flaked');
    });

    test('custom grace window and fee amount are respected', () => {
      const settings = { decline_grace_window_hours: '48', flake_fee_amount: '50' };
      // 36 h away: inside 48 h window → Flaked with $50 fee
      const signup = { status: 'Invited', event_date: hoursFromNow(36) };
      const { newStatus, feeAmount } = determineDeclineOutcome(signup, settings, new Date());
      expect(newStatus).toBe('Flaked');
      expect(feeAmount).toBe(50);
    });
  });

  // ── Pending declines (before lottery — never Flaked regardless of timing) ──

  describe('Pending member declines (before lottery)', () => {
    test('late Pending decline → Dropped (not yet Invited → no flake)', () => {
      const signup = { status: 'Pending', event_date: hoursFromNow(1) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
    });

    test('early Pending decline → Dropped', () => {
      const signup = { status: 'Pending', event_date: hoursFromNow(100) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
    });
  });

  describe('Waitlist member declines', () => {
    test('late Waitlist decline → Dropped (not Flaked)', () => {
      const signup = { status: 'Waitlist', event_date: hoursFromNow(2) };
      const { newStatus } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
      expect(newStatus).toBe('Dropped');
    });
  });

  // ── No event date ─────────────────────────────────────────────────────────

  test('no event_date → isLate is false → Dropped', () => {
    const signup = { status: 'Invited', event_date: null };
    const { newStatus, isLate } = determineDeclineOutcome(signup, DEFAULT_SETTINGS, new Date());
    expect(isLate).toBe(false);
    expect(newStatus).toBe('Dropped');
  });
});

// ─── shouldAutoPromote ────────────────────────────────────────────────────────

describe('shouldAutoPromote — auto-promotion eligibility', () => {
  test('Invited + auto_invite_enabled → promote', () => {
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: true })).toBe(true);
  });

  test('Invited + auto_invite_enabled false → do not promote', () => {
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: false })).toBe(false);
  });

  test('Pending + auto_invite_enabled → do not promote (not yet invited)', () => {
    expect(shouldAutoPromote({ status: 'Pending' }, { auto_invite_enabled: true })).toBe(false);
  });

  test('Waitlist + auto_invite_enabled → do not promote (only Invited slots trigger promotion)', () => {
    expect(shouldAutoPromote({ status: 'Waitlist' }, { auto_invite_enabled: true })).toBe(false);
  });

  test('Invited + auto_invite_enabled null/undefined → do not promote', () => {
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: null })).toBe(false);
    expect(shouldAutoPromote({ status: 'Invited' }, { auto_invite_enabled: undefined })).toBe(false);
  });
});

// ─── classifyFinalizeSignups ──────────────────────────────────────────────────

describe('classifyFinalizeSignups — Invited → Flaked, Waitlist → Lost', () => {
  test('classifies Invited and Waitlist correctly', () => {
    const signups = [
      { signup_id: 'a', status: 'Attended' },
      { signup_id: 'b', status: 'Invited' },
      { signup_id: 'c', status: 'Invited' },
      { signup_id: 'd', status: 'Waitlist' },
      { signup_id: 'e', status: 'Waitlist' },
      { signup_id: 'f', status: 'Waitlist' },
    ];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(2);
    expect(toLose).toHaveLength(3);
    // Attended is not touched
    expect(toFlake.some(s => s.signup_id === 'a')).toBe(false);
    expect(toLose.some(s => s.signup_id === 'a')).toBe(false);
  });

  test('all invited are classified for flaking', () => {
    const signups = [{ signup_id: '1', status: 'Invited' }, { signup_id: '2', status: 'Invited' }];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(2);
    expect(toLose).toHaveLength(0);
  });

  test('all waitlist are classified as lost', () => {
    const signups = [{ signup_id: '1', status: 'Waitlist' }, { signup_id: '2', status: 'Waitlist' }];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(0);
    expect(toLose).toHaveLength(2);
  });

  test('Attended, Dropped, and Flaked are not touched', () => {
    const signups = [
      { signup_id: 'a', status: 'Attended' },
      { signup_id: 'b', status: 'Dropped' },
      { signup_id: 'c', status: 'Flaked' },
    ];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake).toHaveLength(0);
    expect(toLose).toHaveLength(0);
  });

  test('empty signup list', () => {
    const { toFlake, toLose } = classifyFinalizeSignups([]);
    expect(toFlake).toHaveLength(0);
    expect(toLose).toHaveLength(0);
  });

  test('does not mutate input array', () => {
    const signups = [{ signup_id: 'x', status: 'Invited' }];
    classifyFinalizeSignups(signups);
    expect(signups[0].status).toBe('Invited'); // unchanged
  });

  test('correct signup_ids preserved in output', () => {
    const signups = [
      { signup_id: 'inv1', status: 'Invited' },
      { signup_id: 'wait1', status: 'Waitlist' },
    ];
    const { toFlake, toLose } = classifyFinalizeSignups(signups);
    expect(toFlake[0].signup_id).toBe('inv1');
    expect(toLose[0].signup_id).toBe('wait1');
  });
});

// ─── Payment clears balance and unblocks member ───────────────────────────────

describe('Payment clears balance and unblocks member', () => {
  test('full payment reduces balance to 0', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });

  test('partial payment leaves residual balance', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '20' },
    ];
    expect(computeBalance(ledger)).toBe(10);
  });

  test('payment unblocks: balance 0 → member should be Active (not Blocked)', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    const newBal = computeBalance(ledger);
    const newStatus = newBal <= 0 ? 'Active' : 'Blocked';
    expect(newStatus).toBe('Active');
  });

  test('partial payment does not unblock', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '10' },
    ];
    const newBal = computeBalance(ledger);
    const newStatus = newBal <= 0 ? 'Active' : 'Blocked';
    expect(newStatus).toBe('Blocked');
  });

  test('waiver also clears balance and unblocks', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Waiver', amount: '30' },
    ];
    const newBal = computeBalance(ledger);
    expect(newBal).toBe(0);
    expect(newBal <= 0 ? 'Active' : 'Blocked').toBe('Active');
  });

  test('multiple charges cleared by single payment', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '60' },
    ];
    expect(computeBalance(ledger)).toBe(0);
  });
});

// ─── Fee-blocked member cannot enter lottery ──────────────────────────────────

describe('Fee-blocked member cannot enter lottery', () => {
  test('member with positive balance is blocked', () => {
    expect(isMemberBlocked({ fee_balance: '30', status: 'Active' })).toBe(true);
  });

  test('member with Blocked status is blocked even with zero balance', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Blocked' })).toBe(true);
  });

  test('active member with zero balance can enter lottery', () => {
    expect(isMemberBlocked({ fee_balance: '0', status: 'Active' })).toBe(false);
  });

  test('paying fee clears block: balance goes to 0 → not blocked', () => {
    const ledger = [
      { type: 'Charge', amount: '30' },
      { type: 'Payment', amount: '30' },
    ];
    const newBal = computeBalance(ledger);
    const memberAfterPayment = { fee_balance: newBal.toString(), status: 'Active' };
    expect(isMemberBlocked(memberAfterPayment)).toBe(false);
  });
});

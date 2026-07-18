// =============================================================================
// Fees.gs — fee ledger entries + balance reconciliation.
// FeeLedger is the source of truth; Members.fee_balance is a cache.
// =============================================================================

function chargeFlakeFee_(member, event, signup) {
  if (!member) return;
  var amount = getSettingNum_('flake_fee_amount', 30);
  withLock_(function() {
    append_(TAB.FEE_LEDGER, {
      ledger_id:       uid_('l_'),
      member_id:       member.member_id,
      event_id:        event ? event.event_id : '',
      event_name:      event ? (event.name || '') : '',
      type:            'Charge',
      amount:          amount,
      occurred_at:     nowIso_(),
      recorded_by:     'system',
      epay_reference:  '',
      notes:           'Flake at event "' + (event ? event.name : '') + '"'
    });
    recomputeBalance_(member.member_id);
    blockMember_(member.member_id, 'Flake fee outstanding');
  });
  try { emailFlakeNotice(member, event, amount); } catch (err) { /* logged in EmailLog */ }
  audit_('system', 'ChargeFlakeFee', TAB.FEE_LEDGER, member.member_id, null, { amount: amount, event_id: event ? event.event_id : '' });
}

// Records a payment. Called from the Sheet menu after a can_clear_fees admin
// has confirmed the ASSU ePay payment manually.
function recordPayment_(memberId, amount, epayReference, byEmail, notes) {
  return withLock_(function() {
    var member = memberById_(memberId);
    if (!member) throw new Error('Member not found.');
    append_(TAB.FEE_LEDGER, {
      ledger_id:       uid_('l_'),
      member_id:       memberId,
      event_id:        '',
      event_name:      '',
      type:            'Payment',
      amount:          Math.abs(Number(amount) || 0),
      occurred_at:     nowIso_(),
      recorded_by:     byEmail || '',
      epay_reference:  epayReference || '',
      notes:           notes || ''
    });
    var newBal = recomputeBalance_(memberId);
    if (newBal <= 0) unblockMember_(memberId, byEmail);
    audit_(byEmail, 'RecordPayment', TAB.FEE_LEDGER, memberId, null, { amount: amount, ref: epayReference });
    try { emailFeePaidConfirm(member, amount); } catch (err) { /* logged */ }
    return { ok: true, balance: newBal };
  });
}

// Manual waiver — for documented emergencies.
function recordWaiver_(memberId, amount, reason, byEmail) {
  return withLock_(function() {
    var member = memberById_(memberId);
    if (!member) throw new Error('Member not found.');
    append_(TAB.FEE_LEDGER, {
      ledger_id:       uid_('l_'),
      member_id:       memberId,
      event_id:        '',
      event_name:      '',
      type:            'Waiver',
      amount:          Math.abs(Number(amount) || 0),
      occurred_at:     nowIso_(),
      recorded_by:     byEmail || '',
      epay_reference:  '',
      notes:           reason || ''
    });
    var newBal = recomputeBalance_(memberId);
    if (newBal <= 0) unblockMember_(memberId, byEmail);
    audit_(byEmail, 'RecordWaiver', TAB.FEE_LEDGER, memberId, null, { amount: amount, reason: reason });
    return { ok: true, balance: newBal };
  });
}

// Returns a per-event breakdown of what the member's outstanding balance is
// composed of — used by the member-facing blocked banner so they can see
// exactly which event(s) the fee is from. Charges and credits (payments,
// waivers) are netted against each other in occurred_at order so payments
// retire the oldest charge first.
function outstandingChargesForMember_(memberId) {
  var entries = findAll_(TAB.FEE_LEDGER, function(r) { return r.member_id === memberId; });
  entries.sort(function(a, b) { return new Date(a.occurred_at) - new Date(b.occurred_at); });

  var charges = [];   // each: { event_id, event_name, amount, occurred_at, remaining }
  var credit = 0;     // unspent payments/waivers
  entries.forEach(function(e) {
    var t = String(e.type || '').toLowerCase();
    var amt = Math.abs(Number(e.amount) || 0);
    if (t === 'charge') {
      charges.push({
        ledger_id:   e.ledger_id,
        event_id:    e.event_id || '',
        event_name:  e.event_name || '',
        amount:      amt,
        occurred_at: e.occurred_at ? new Date(e.occurred_at).toISOString() : '',
        remaining:   amt
      });
    } else if (t === 'payment' || t === 'waiver') {
      credit += amt;
    }
  });

  // Apply credit oldest-first.
  for (var i = 0; i < charges.length && credit > 0; i++) {
    var take = Math.min(credit, charges[i].remaining);
    charges[i].remaining -= take;
    credit -= take;
  }

  return charges.filter(function(c) { return c.remaining > 0.0001; });
}

// =============================================================================
// Members.gs — member lookups & blocked-status helpers.
// =============================================================================

function memberByEmail_(email) {
  var e = normalizeEmail_(email);
  return findRow_(TAB.MEMBERS, function(r) { return normalizeEmail_(r.email) === e; });
}

function memberById_(memberId) {
  return findRow_(TAB.MEMBERS, function(r) { return r.member_id === memberId; });
}

function isBlocked_(member) {
  if (!member) return true;
  if ((Number(member.fee_balance) || 0) > 0) return true;
  return member.status === MEMBER_STATUS.BLOCKED;
}

function blockMember_(memberId, reason) {
  var m = memberById_(memberId);
  if (!m) return;
  var before = { status: m.status, fee_balance: m.fee_balance };
  updateRow_(TAB.MEMBERS, m._rowIndex, { status: MEMBER_STATUS.BLOCKED });
  audit_('system', 'BlockMember', TAB.MEMBERS, memberId, before, { status: MEMBER_STATUS.BLOCKED, reason: reason });
}

function unblockMember_(memberId, byEmail) {
  var m = memberById_(memberId);
  if (!m) return;
  var before = { status: m.status };
  updateRow_(TAB.MEMBERS, m._rowIndex, { status: MEMBER_STATUS.ACTIVE });
  audit_(byEmail, 'UnblockMember', TAB.MEMBERS, memberId, before, { status: MEMBER_STATUS.ACTIVE });
}

// Recompute fee_balance for a member from the FeeLedger. Source of truth is
// the ledger; the column on Members is a cache.
function recomputeBalance_(memberId) {
  var entries = findAll_(TAB.FEE_LEDGER, function(r) { return r.member_id === memberId; });
  var bal = entries.reduce(function(sum, e) {
    var amt = Number(e.amount) || 0;
    var t = String(e.type || '').toLowerCase();
    if (t === 'charge')  return sum + Math.abs(amt);
    if (t === 'payment') return sum - Math.abs(amt);
    if (t === 'waiver')  return sum - Math.abs(amt);
    return sum;
  }, 0);
  if (bal < 0) bal = 0;
  var m = memberById_(memberId);
  if (m) updateRow_(TAB.MEMBERS, m._rowIndex, { fee_balance: bal });
  return bal;
}

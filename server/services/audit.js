// Audit log service — writes every admin action to audit_log table.
const db = require('../db');

/**
 * Write an audit log entry.
 * @param {string} adminEmail  — who performed the action (or 'system')
 * @param {string} action      — e.g. 'CreateEvent', 'RunLottery'
 * @param {string} targetTable — e.g. 'events', 'members'
 * @param {string} targetId    — primary key of the affected row
 * @param {object|null} before — state before change
 * @param {object|null} after  — state after change
 */
async function audit(adminEmail, action, targetTable, targetId, before, after) {
  try {
    await db.query(
      `INSERT INTO audit_log (admin_email, action, target_table, target_id, before_state, after_state)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        adminEmail || 'system',
        action,
        targetTable || '',
        targetId || '',
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
      ]
    );
  } catch (err) {
    // Audit failures must never crash the main operation.
    console.error('Audit write error:', err.message);
  }
}

module.exports = { audit };

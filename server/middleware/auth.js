// Session middleware: resolves the bearer token to a member row.
// Attaches req.member (or null) and req.isAdmin, req.canClearFees.
const crypto = require('crypto');
const db = require('../db');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Resolve session from Authorization header or X-Session-Token header.
 * Always calls next(); use requireAuth / requireAdmin in routes.
 */
async function sessionMiddleware(req, res, next) {
  req.member = null;
  req.isAdmin = false;
  req.canClearFees = false;

  let token =
    req.headers['x-session-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!token) return next();

  try {
    const tokenHash = hashToken(token);
    const { rows } = await db.query(
      `SELECT s.member_id, s.expires_at,
              m.email, m.full_name, m.affiliation,
              m.is_admin, m.can_clear_fees, m.fee_balance, m.status
       FROM auth_sessions s
       JOIN members m ON m.member_id = s.member_id
       WHERE s.token_hash = $1
         AND s.expires_at > NOW()`,
      [tokenHash]
    );
    if (rows.length) {
      const r = rows[0];
      req.member = {
        member_id:      r.member_id,
        email:          r.email,
        full_name:      r.full_name,
        affiliation:    r.affiliation,
        is_admin:       r.is_admin,
        can_clear_fees: r.can_clear_fees,
        fee_balance:    parseFloat(r.fee_balance) || 0,
        status:         r.status,
      };
      req.isAdmin = !!r.is_admin;
      req.canClearFees = !!r.can_clear_fees;
    }
  } catch (err) {
    console.error('Session resolution error:', err.message);
  }

  next();
}

function requireAuth(req, res, next) {
  if (!req.member) return res.status(401).json({ error: 'Authentication required' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.member) return res.status(401).json({ error: 'Authentication required' });
  if (!req.isAdmin) return res.status(403).json({ error: 'Admin access required' });
  next();
}

function requireCanClearFees(req, res, next) {
  if (!req.member) return res.status(401).json({ error: 'Authentication required' });
  if (!req.canClearFees) return res.status(403).json({ error: 'Fee-clearing permission required' });
  next();
}

module.exports = { sessionMiddleware, requireAuth, requireAdmin, requireCanClearFees, hashToken };

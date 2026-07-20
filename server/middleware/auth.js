// Session middleware: resolves the bearer token to a member row.
// Attaches req.member (or null) and req.isAdmin, req.isExecTeam.
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
  req.isExecTeam = false;

  let token =
    req.headers['x-session-token'] ||
    (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

  if (!token) return next();

  try {
    const tokenHash = hashToken(token);
    const { rows } = await db.query(
      `SELECT s.member_id, s.expires_at,
              m.email, m.full_name, m.affiliation,
              m.is_admin, m.is_exec_team, m.fee_balance, m.status
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
        is_exec_team:   r.is_exec_team,
        fee_balance:    parseFloat(r.fee_balance) || 0,
        status:         r.status,
      };
      req.isAdmin = !!r.is_admin;
      req.isExecTeam = !!r.is_exec_team;
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

function requireExecTeam(req, res, next) {
  if (!req.member) return res.status(401).json({ error: 'Authentication required' });
  if (!req.isExecTeam) return res.status(403).json({ error: 'Exec Team permission required' });
  next();
}

module.exports = { sessionMiddleware, requireAuth, requireAdmin, requireExecTeam, hashToken };

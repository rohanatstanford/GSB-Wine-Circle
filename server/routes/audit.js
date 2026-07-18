// Audit log endpoint — admin read-only.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

// GET /api/audit — list audit log entries (paginated)
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { limit = 100, offset = 0, action, target_table } = req.query;
    const params = [];
    const where = [];
    if (action) { params.push(action); where.push(`action = $${params.length}`); }
    if (target_table) { params.push(target_table); where.push(`target_table = $${params.length}`); }
    params.push(parseInt(limit) || 100);
    params.push(parseInt(offset) || 0);

    const q = `SELECT * FROM audit_log
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at DESC
               LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await db.query(q, params);
    return res.json({ log: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;

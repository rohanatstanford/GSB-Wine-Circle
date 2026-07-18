// Settings CRUD: admin can read/update system settings.
const express = require('express');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { audit } = require('../services/audit');

const router = express.Router();

// GET /api/settings/public — no auth: returns UI-facing settings needed by the member portal
const PUBLIC_KEYS = ['org_name', 'assu_epay_url', 'leadership_email', 'web_app_url', 'flake_fee_amount', 'decline_grace_window_hours'];
router.get('/public', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key = ANY($1)`,
      [PUBLIC_KEYS]
    );
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    // Supply sensible defaults for anything not yet configured
    return res.json({
      org_name: s.org_name || 'Wine Circle',
      assu_epay_url: s.assu_epay_url || '',
      leadership_email: s.leadership_email || '',
      web_app_url: s.web_app_url || '',
      flake_fee_amount: s.flake_fee_amount || '30',
      decline_grace_window_hours: s.decline_grace_window_hours || '24',
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/settings
router.get('/', requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query('SELECT key, value, description FROM settings ORDER BY key');
    return res.json({ settings: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PATCH /api/settings/:key
router.patch('/:key', requireAdmin, async (req, res) => {
  const { key } = req.params;
  const { value } = req.body;
  if (value === undefined) return res.status(400).json({ error: 'value required' });

  try {
    const { rows: existing } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    const before = existing[0]?.value;

    const { rows } = await db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
       RETURNING *`,
      [key, String(value)]
    );
    await audit(req.member.email, 'UpdateSetting', 'settings', key, { value: before }, { value: String(value) });
    return res.json({ setting: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;

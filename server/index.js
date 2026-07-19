// Wine Circle API Server
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const cron = require('node-cron');

const { sessionMiddleware } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const membersRoutes = require('./routes/members');
const eventsRoutes = require('./routes/events');
const signupsRoutes = require('./routes/signups');
const feesRoutes = require('./routes/fees');
const emailRoutes = require('./routes/email');
const settingsRoutes = require('./routes/settings');
const auditRoutes = require('./routes/audit');
const devRoutes = require('./routes/dev');

const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Trust the first proxy hop (needed for rate-limiter behind Replit's reverse proxy)
app.set('trust proxy', 1);

// ── Security & parsing middleware ─────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // Allow API to be consumed by any frontend
}));

app.use(cors({
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : true, // Allow all origins in dev
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

// ── Rate limiting ─────────────────────────────────────────────────────────────
// Members on the same campus WiFi/VPN commonly share one public IP after NAT,
// so IP-based keying alone would let one busy network egress point throttle
// everyone behind it. Key by session token when one is present (ties the
// budget to the actual person, not their network), falling back to IP only
// for the pre-login auth endpoints where no token exists yet.
function keyByTokenOrIp(req) {
  const token = req.headers['x-session-token'] || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  return token || ipKeyGenerator(req.ip);
}

// Strict: only the actual abuse surface (guessing a 6-digit code / spamming
// send-code). GET /api/auth/me and /logout are cheap, frequent, session-
// bearing calls fired on every page load and must NOT share this budget.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 600,
  keyGenerator: keyByTokenOrIp,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// apiLimiter first: since /api/auth/send-code and /verify-code also match
// the general '/api' prefix, both middlewares run on those routes either
// way (registration order only changes header-overwrite order, not which
// middleware applies) - registering the stricter authLimiter LAST makes
// its numbers the ones actually visible in the response headers, instead
// of the general limiter's silently masking it.
app.use('/api', apiLimiter);
app.use('/api/auth/send-code', authLimiter);
app.use('/api/auth/verify-code', authLimiter);

// ── Session resolution ────────────────────────────────────────────────────────
app.use(sessionMiddleware);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/members', membersRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/signups', signupsRoutes);
app.use('/api/fees', feesRoutes);
app.use('/api/email', emailRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/dev', devRoutes);

// ── Static frontend ───────────────────────────────────────────────────────────
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Decline page: /decline?token=... — must be explicit before the SPA fallback
app.get('/decline', (req, res) => {
  res.sendFile(path.join(publicDir, 'decline.html'));
});

// Admin portal
app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// SPA fallback: all other non-API GET requests serve index.html
app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Scheduled jobs ────────────────────────────────────────────────────────────
// Prune expired auth codes and sessions daily at 3 AM.
cron.schedule('0 3 * * *', async () => {
  const db = require('./db');
  try {
    await db.query(`DELETE FROM auth_codes WHERE expires_at < NOW() OR used = true`);
    await db.query(`DELETE FROM auth_sessions WHERE expires_at < NOW()`);
    console.log('Pruned expired auth codes and sessions');
  } catch (err) {
    console.error('Prune job error:', err.message);
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Wine Circle API listening on port ${PORT}`);
});

module.exports = app;

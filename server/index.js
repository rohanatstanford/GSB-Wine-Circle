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
const analyticsRoutes = require('./routes/analytics');

const path = require('path');

const app = express();
const PORT = process.env.PORT || 5000;

// Trust the first proxy hop (needed for rate-limiter behind Replit's reverse proxy)
app.set('trust proxy', 1);

// ── Security & parsing middleware ─────────────────────────────────────────────
app.use(helmet({
  // The public HTML pages rely on inline <script>/<style> blocks and inline
  // onclick="..." handlers throughout, so this can't be a "no unsafe-inline"
  // policy without a much larger refactor - it's still a real improvement
  // over no CSP at all, restricting which origins scripts/styles/connections
  // can come from even though the inline-code allowance stays broad.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      // script-src-attr governs onclick="..." etc. specifically and does NOT
      // reliably inherit 'unsafe-inline' from scriptSrc in practice (verified
      // live - without this, every inline handler in admin.html/index.html is
      // silently blocked) - must be set explicitly.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
}));

app.use(cors({
  // The frontend is always same-origin (public/*.html served by this same
  // Express app), so cross-origin access isn't actually needed in normal
  // use - CORS here only matters for direct third-party API consumption.
  // Fail closed in production if ALLOWED_ORIGINS was never configured,
  // rather than reflecting back every origin with credentials allowed.
  origin: process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : process.env.NODE_ENV === 'production' ? false : true, // prod: closed by default; dev: allow all for convenience
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
app.use('/api/analytics', analyticsRoutes);

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

// Auto-open/close signups based on signup_opens_at/signup_closes_at, for
// events where those fields are actually set (an empty field always means
// "requires a manual Open/Close click" and is left alone here). Only ever
// transitions Draft->Open or Open->Closed - never touches events an admin
// has moved further along (Lotteried/Completed/Cancelled) or manually Closed.
cron.schedule('* * * * *', async () => {
  const db = require('./db');
  try {
    const { rowCount: opened } = await db.query(
      `UPDATE events SET status = 'Open'
       WHERE status = 'Draft' AND signup_opens_at IS NOT NULL AND signup_opens_at <= NOW()`
    );
    const { rowCount: closed } = await db.query(
      `UPDATE events SET status = 'Closed'
       WHERE status = 'Open' AND signup_closes_at IS NOT NULL AND signup_closes_at <= NOW()`
    );
    if (opened || closed) console.log(`Signup window: auto-opened ${opened}, auto-closed ${closed}`);
  } catch (err) {
    console.error('Signup window cron error:', err.message);
  }
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Wine Circle API listening on port ${PORT}`);
});

module.exports = app;

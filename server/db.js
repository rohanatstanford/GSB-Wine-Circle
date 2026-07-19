// Database connection pool using pg
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  // pg's default (10) queues requests one-by-one under a concurrent burst
  // (e.g. everyone checking the site when a new event opens). This single
  // Node process is the only thing talking to Postgres, so raising it here
  // is the whole story - no other pool to coordinate with.
  max: 20,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err);
});

module.exports = pool;

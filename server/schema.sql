-- Wine Circle PostgreSQL Schema
-- All tables use text primary keys matching the Apps Script uid() convention.

-- ── Members ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS members (
  member_id       TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  full_name       TEXT NOT NULL DEFAULT '',
  affiliation     TEXT NOT NULL DEFAULT '',
  is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
  can_clear_fees  BOOLEAN NOT NULL DEFAULT FALSE,
  fee_balance     NUMERIC(10,2) NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'Active',   -- Active | Inactive | Blocked
  date_joined     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes           TEXT NOT NULL DEFAULT '',
  partner_member_id TEXT REFERENCES members (member_id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE members ADD COLUMN IF NOT EXISTS partner_member_id TEXT REFERENCES members (member_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_members_email  ON members (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_members_status ON members (status);
CREATE INDEX IF NOT EXISTS idx_members_partner_id ON members (partner_member_id);

-- ── Events ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  event_id                  TEXT PRIMARY KEY,
  name                      TEXT NOT NULL,
  event_date                TIMESTAMPTZ,
  location                  TEXT NOT NULL DEFAULT '',
  capacity                  INTEGER NOT NULL DEFAULT 60,
  signup_opens_at           TIMESTAMPTZ,
  signup_closes_at          TIMESTAMPTZ,
  lottery_run_at            TIMESTAMPTZ,
  auto_invite_enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  send_lottery_lost_emails  BOOLEAN NOT NULL DEFAULT TRUE,
  status                    TEXT NOT NULL DEFAULT 'Draft', -- Draft | Open | Closed | Lotteried | Completed | Cancelled
  description               TEXT NOT NULL DEFAULT '',
  host_notes                TEXT NOT NULL DEFAULT '',
  created_by                TEXT NOT NULL DEFAULT '',
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_status     ON events (status);
CREATE INDEX IF NOT EXISTS idx_events_event_date ON events (event_date);

-- ── Signups ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signups (
  signup_id           TEXT PRIMARY KEY,
  event_id            TEXT NOT NULL REFERENCES events (event_id) ON DELETE CASCADE,
  event_name          TEXT NOT NULL DEFAULT '',
  member_id           TEXT NOT NULL REFERENCES members (member_id) ON DELETE CASCADE,
  member_name         TEXT NOT NULL DEFAULT '',
  member_email        TEXT NOT NULL DEFAULT '',
  email_at_signup     TEXT NOT NULL DEFAULT '',
  signed_up_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lottery_rank        INTEGER,
  status              TEXT NOT NULL DEFAULT 'Pending', -- Pending | Lost | Waitlist | Invited | Dropped | Flaked | Attended
  -- What the member actually sees in their portal. Deliberately decoupled from
  -- `status` so admin actions (lottery, promote/demote, finalize) don't reveal
  -- anything until an admin explicitly pushes the update; member-caused
  -- transitions (signup, decline) set this in lockstep with `status` instead.
  member_visible_status TEXT NOT NULL DEFAULT 'Pending',
  invite_sent_at      TIMESTAMPTZ,
  decline_token       TEXT UNIQUE,
  declined_at         TIMESTAMPTZ,
  attended_marked_at  TIMESTAMPTZ,
  marked_by           TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, member_id)
);

ALTER TABLE signups ADD COLUMN IF NOT EXISTS member_visible_status TEXT NOT NULL DEFAULT 'Pending';
-- Backfill: existing rows should show as already-synced, not as a sudden
-- backlog of "pending push" the moment this ships.
UPDATE signups SET member_visible_status = status WHERE member_visible_status != status;

CREATE INDEX IF NOT EXISTS idx_signups_event_id     ON signups (event_id);
CREATE INDEX IF NOT EXISTS idx_signups_member_id    ON signups (member_id);
CREATE INDEX IF NOT EXISTS idx_signups_status       ON signups (status);
CREATE INDEX IF NOT EXISTS idx_signups_decline_token ON signups (decline_token);
CREATE INDEX IF NOT EXISTS idx_signups_lottery_rank ON signups (event_id, lottery_rank);

-- ── Fee Ledger ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fee_ledger (
  ledger_id       TEXT PRIMARY KEY DEFAULT ('l_' || gen_random_uuid()::text),
  member_id       TEXT NOT NULL REFERENCES members (member_id) ON DELETE CASCADE,
  event_id        TEXT NOT NULL DEFAULT '',
  event_name      TEXT NOT NULL DEFAULT '',
  type            TEXT NOT NULL,                  -- Charge | Payment | Waiver
  amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_by     TEXT NOT NULL DEFAULT 'system',
  epay_reference  TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fee_ledger_member_id ON fee_ledger (member_id);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_event_id  ON fee_ledger (event_id);
CREATE INDEX IF NOT EXISTS idx_fee_ledger_type      ON fee_ledger (type);

-- ── Email Log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS email_log (
  log_id      BIGSERIAL PRIMARY KEY,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL DEFAULT 'Generic',
  event_id    TEXT,
  signup_id   TEXT,
  event_name  TEXT,
  status      TEXT NOT NULL DEFAULT 'sent',   -- sent | error
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_log_event_id ON email_log (event_id);
CREATE INDEX IF NOT EXISTS idx_email_log_to_email ON email_log (to_email);
CREATE INDEX IF NOT EXISTS idx_email_log_sent_at  ON email_log (sent_at DESC);

-- ── Auth Codes ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_codes (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_codes_email ON auth_codes (email);

-- ── Auth Sessions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
  id          BIGSERIAL PRIMARY KEY,
  token_hash  TEXT NOT NULL UNIQUE,
  member_id   TEXT NOT NULL REFERENCES members (member_id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_token_hash ON auth_sessions (token_hash);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_member_id  ON auth_sessions (member_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires_at ON auth_sessions (expires_at);

-- ── Settings ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit Log ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id           BIGSERIAL PRIMARY KEY,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  admin_email  TEXT NOT NULL DEFAULT 'system',
  action       TEXT NOT NULL,
  target_table TEXT NOT NULL DEFAULT '',
  target_id    TEXT NOT NULL DEFAULT '',
  before_state JSONB,
  after_state  JSONB
);

CREATE INDEX IF NOT EXISTS idx_audit_log_action       ON audit_log (action);
CREATE INDEX IF NOT EXISTS idx_audit_log_target_table ON audit_log (target_table);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at   ON audit_log (created_at DESC);

-- ── Updated-at trigger ────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['members', 'events', 'signups'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname = 'trg_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER trg_%I_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
        t, t
      );
    END IF;
  END LOOP;
END;
$$;

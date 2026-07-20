-- Default settings seed — run once after schema creation.
-- Uses INSERT ... ON CONFLICT DO NOTHING so re-running is safe.

INSERT INTO settings (key, value, description) VALUES
  ('flake_fee_amount',                '30',                                                              'Dollar amount charged for a flake'),
  ('decline_grace_window_hours',      '24',                                                              'Drops within this window before event start become Flakes'),
  ('default_capacity',                '60',                                                              'Default capacity for new events'),
  ('assu_epay_url',                   'https://assuepay.stanford.edu/?redirect=%2Fpay%2F5844%2Fdues',    'Where blocked members go to pay'),
  ('magic_link_ttl_minutes',          '15',                                                              'How long a 6-digit login code is valid'),
  ('session_ttl_days',                '14',                                                              'How long a logged-in session lasts'),
  ('org_name',                        'Stanford GSB Wine Circle',                                        'Used in email subjects and page titles'),
  ('org_email_signature',             '— The Wine Circle Team',                                          'Sign-off for outgoing emails'),
  ('leadership_email',                'gsb_winecircle-leadership@lists.stanford.edu',                    'Contact for fee questions / appeals'),
  ('default_auto_invite_enabled',     'FALSE',                                                           'Default for new events: auto-promote from waitlist on drop'),
  ('default_send_lottery_lost_emails','FALSE',                                                           'Default for new events: send "you didn''t make it" emails'),
  ('web_app_url',                     '',                                                                'Set after deploy: the base URL of the web app'),
  ('dev_mode_enabled',                'FALSE',                                                           'TESTING ONLY: when TRUE, unlocks dev endpoints. Set to FALSE before going live.'),
  ('current_school_year',             '2026-27',                                                         'Default school year applied to new members and bulk imports — update each fall')
ON CONFLICT (key) DO NOTHING;

-- These two were previously seeded as TRUE; ON CONFLICT DO NOTHING above
-- can't flip an already-existing row, so force it explicitly.
UPDATE settings SET value = 'FALSE' WHERE key = 'default_auto_invite_enabled' AND value = 'TRUE';
UPDATE settings SET value = 'FALSE' WHERE key = 'default_send_lottery_lost_emails' AND value = 'TRUE';

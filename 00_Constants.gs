// =============================================================================
// Constants.gs — shared configuration & schema
// All tab names, column lists, status enums, and default settings live here.
// Edit Settings tab values in the Sheet for runtime tunables, not this file.
// =============================================================================

const TAB = {
  MEMBERS:    'Members',
  EVENTS:     'Events',
  SIGNUPS:    'Signups',          // Per-event spreadsheet only.
  FEE_LEDGER: 'FeeLedger',
  EMAIL_LOG:  'EmailLog',
  AUTH_CODES: 'AuthCodes',
  SESSIONS:   'AuthSessions',
  SETTINGS:   'Settings',
  AUDIT_LOG:  'AuditLog'
};

// Schema for tabs that live in the master spreadsheet.
const MASTER_SCHEMA = {
  Members: [
    'member_id', 'email', 'full_name', 'affiliation',
    'is_admin', 'can_clear_fees', 'fee_balance', 'status',
    'date_joined', 'notes'
  ],
  Events: [
    'event_id', 'name', 'event_date', 'location', 'capacity',
    'signup_opens_at', 'signup_closes_at', 'lottery_run_at',
    'auto_invite_enabled', 'send_lottery_lost_emails',
    'status', 'description', 'host_notes', 'created_by', 'created_at',
    'event_spreadsheet_id'
  ],
  FeeLedger: [
    'ledger_id', 'member_id', 'event_id', 'type', 'amount',
    'occurred_at', 'recorded_by', 'epay_reference', 'notes',
    'event_name'
  ],
  EmailLog: [
    'log_id', 'sent_at', 'to_email', 'subject', 'type',
    'event_id', 'signup_id', 'status', 'error',
    'event_name'
  ],
  AuthCodes: [
    'email', 'code_hash', 'expires_at', 'used', 'created_at'
  ],
  AuthSessions: [
    'token_hash', 'member_id', 'email', 'created_at', 'expires_at'
  ],
  Settings: ['key', 'value', 'description'],
  AuditLog: [
    'timestamp', 'admin_email', 'action',
    'target_table', 'target_id', 'before', 'after'
  ]
};

// Schema for tabs that live in per-event spreadsheets.
const EVENT_SCHEMA = {
  Signups: [
    'signup_id', 'event_id', 'event_name',
    'member_id', 'member_name', 'member_email',
    'email_at_signup', 'signed_up_at', 'lottery_rank', 'status',
    'invite_sent_at', 'decline_token', 'declined_at',
    'attended_marked_at', 'marked_by', 'notes'
  ]
};

// Combined schema lookup. Code that calls readAll_/append_/etc. references
// SCHEMA[tabName] regardless of whether the tab lives in master or per-event.
const SCHEMA = (function() {
  var combined = {};
  Object.keys(MASTER_SCHEMA).forEach(function(k) { combined[k] = MASTER_SCHEMA[k]; });
  Object.keys(EVENT_SCHEMA).forEach(function(k)  { combined[k] = EVENT_SCHEMA[k]; });
  return combined;
})();

// Display labels for the header row of each tab. Code keys are the snake_case
// names in SCHEMA above; sheet headers are these Title Case strings.
const HEADER_LABELS = {
  member_id:               'Member ID',
  email:                   'Email',
  full_name:               'Full Name',
  affiliation:             'Affiliation',
  is_admin:                'Is Admin',
  can_clear_fees:          'Can Clear Fees',
  fee_balance:             'Fee Balance',
  status:                  'Status',
  date_joined:             'Date Joined',
  notes:                   'Notes',

  event_id:                'Event ID',
  name:                    'Event Name',
  event_name:              'Event Name',
  event_date:              'Event Date',
  location:                'Location',
  capacity:                'Capacity',
  signup_opens_at:         'Signup Opens At',
  signup_closes_at:        'Signup Closes At',
  lottery_run_at:          'Lottery Run At',
  auto_invite_enabled:     'Auto-Invite Enabled',
  send_lottery_lost_emails:'Send Lottery-Lost Emails',
  description:             'Description',
  host_notes:              'Host Notes',
  created_by:              'Created By',
  created_at:              'Created At',
  event_spreadsheet_id:    'Event Spreadsheet ID',

  signup_id:               'Signup ID',
  member_name:             'Member Name',
  member_email:            'Member Email',
  email_at_signup:         'Email at Signup',
  signed_up_at:            'Signed Up At',
  lottery_rank:            'Lottery Rank',
  invite_sent_at:          'Invite Sent At',
  decline_token:           'Decline Token',
  declined_at:             'Declined At',
  attended_marked_at:      'Attendance Marked At',
  marked_by:               'Marked By',

  ledger_id:               'Ledger ID',
  type:                    'Type',
  amount:                  'Amount',
  occurred_at:             'Occurred At',
  recorded_by:             'Recorded By',
  epay_reference:          'ePay Reference',

  log_id:                  'Log ID',
  sent_at:                 'Sent At',
  to_email:                'To Email',
  subject:                 'Subject',
  error:                   'Error',

  code_hash:               'Code Hash',
  expires_at:              'Expires At',
  used:                    'Used',

  token_hash:              'Token Hash',

  key:                     'Key',
  value:                   'Value',

  timestamp:               'Timestamp',
  admin_email:             'Admin Email',
  action:                  'Action',
  target_table:            'Target Table',
  target_id:               'Target ID',
  before:                  'Before',
  after:                   'After'
};

function headerLabelsFor_(tabName) {
  var keys = SCHEMA[tabName] || [];
  return keys.map(function(k) { return HEADER_LABELS[k] || k; });
}

const SIGNUP_STATUS = {
  PENDING:  'Pending',
  LOST:     'Lost',
  WAITLIST: 'Waitlist',
  INVITED:  'Invited',
  DROPPED:  'Dropped',
  FLAKED:   'Flaked',
  ATTENDED: 'Attended'
};

const EVENT_STATUS = {
  DRAFT:     'Draft',
  OPEN:      'Open',
  CLOSED:    'Closed',
  LOTTERIED: 'Lotteried',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled'
};

const MEMBER_STATUS = {
  ACTIVE:   'Active',
  INACTIVE: 'Inactive',
  BLOCKED:  'Blocked'
};

const DEFAULT_SETTINGS = [
  ['flake_fee_amount',                '30',                                                              'Dollar amount charged for a flake'],
  ['decline_grace_window_hours',      '24',                                                              'Drops within this window before event start become Flakes'],
  ['default_capacity',                '60',                                                              'Default capacity for new events'],
  ['assu_epay_url',                   'https://assuepay.stanford.edu/?redirect=%2Fpay%2F5844%2Fdues',    'Where blocked members go to pay'],
  ['magic_link_ttl_minutes',          '15',                                                              'How long a 6-digit login code is valid'],
  ['session_ttl_days',                '14',                                                              'How long a logged-in session lasts'],
  ['org_name',                        'Stanford GSB Wine Circle',                                        'Used in email subjects and page titles'],
  ['org_email_signature',             '— The Wine Circle Team',                                          'Sign-off for outgoing emails'],
  ['leadership_email',                'gsb_winecircle-leadership@lists.stanford.edu',                    'Contact for fee questions / appeals'],
  ['default_auto_invite_enabled',     'TRUE',                                                            'Default for new events: auto-promote from waitlist on drop'],
  ['default_send_lottery_lost_emails','TRUE',                                                            'Default for new events: send "you didn\'t make it" emails'],
  ['web_app_url',                     '',                                                                'Set after deploy: the /exec URL of the web app'],
  ['events_drive_folder_id',          '',                                                                'Optional: Drive folder ID where per-event spreadsheets are stored. If blank, uses the master spreadsheet\'s parent folder.'],
  ['dev_mode_enabled',                'FALSE',                                                           'TESTING ONLY: when TRUE, unlocks the Dev submenu and the dev_* helpers in 90_Dev.gs. Set to FALSE before going live.']
];

// =============================================================================
// Lib.gs — Sheet read/write helpers + small utilities.
// All access to the underlying Sheet should go through these helpers so we can
// change storage layout in one place.
//
// Most helpers accept an optional `ss` (Spreadsheet handle). If omitted, the
// active (master) spreadsheet is used. Pass an `ss` from openById(...) to
// read/write a per-event spreadsheet.
//
// Sheet headers (row 1) are display labels (Title Case). Code keys are the
// snake_case names in SCHEMA[tabName]. readAll_ uses SCHEMA, not the row-1
// headers, so renaming a sheet header doesn't break code.
// =============================================================================

function getSheet_(name, ss) {
  ss = ss || SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet tab "' + name + '" not found in spreadsheet "' + ss.getName() + '". Did you run bootstrapSheet()?');
  return sheet;
}

// Read all rows of a tab as objects keyed by SCHEMA. Includes _rowIndex (the
// 1-based Sheet row number) so callers can write back to the same row.
function readAll_(tabName, ss) {
  var sheet = getSheet_(tabName, ss);
  var schema = SCHEMA[tabName];
  if (!schema) throw new Error('No SCHEMA defined for tab "' + tabName + '"');
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  var values = sheet.getRange(2, 1, lastRow - 1, schema.length).getValues();
  return values.map(function(row, i) {
    var obj = { _rowIndex: i + 2 };
    schema.forEach(function(h, j) { obj[h] = row[j]; });
    return obj;
  });
}

function append_(tabName, obj, ss) {
  var sheet = getSheet_(tabName, ss);
  var headers = SCHEMA[tabName];
  var row = headers.map(function(h) {
    var v = obj[h];
    if (v === undefined || v === null) return '';
    if (v instanceof Date) return v;
    return v;
  });
  sheet.appendRow(row);
  return sheet.getLastRow();
}

function updateRow_(tabName, rowIndex, updates, ss) {
  var sheet = getSheet_(tabName, ss);
  var headers = SCHEMA[tabName];
  var range = sheet.getRange(rowIndex, 1, 1, headers.length);
  var current = range.getValues()[0];
  headers.forEach(function(h, i) {
    if (Object.prototype.hasOwnProperty.call(updates, h)) {
      current[i] = updates[h];
    }
  });
  range.setValues([current]);
}

function deleteRow_(tabName, rowIndex, ss) {
  getSheet_(tabName, ss).deleteRow(rowIndex);
}

function findRow_(tabName, predicate, ss) {
  var rows = readAll_(tabName, ss);
  for (var i = 0; i < rows.length; i++) if (predicate(rows[i])) return rows[i];
  return null;
}

function findAll_(tabName, predicate, ss) {
  return readAll_(tabName, ss).filter(predicate);
}

// -- Settings -----------------------------------------------------------------

function getSetting_(key, defaultValue) {
  var row = findRow_(TAB.SETTINGS, function(r) { return r.key === key; });
  if (!row || row.value === '' || row.value === null || row.value === undefined) return defaultValue;
  return row.value;
}

function getSettingNum_(key, defaultValue) {
  var v = getSetting_(key, defaultValue);
  var n = Number(v);
  return isNaN(n) ? defaultValue : n;
}

function getSettingBool_(key, defaultValue) {
  var v = getSetting_(key, defaultValue);
  if (typeof v === 'boolean') return v;
  return String(v).toUpperCase() === 'TRUE';
}

// -- Locking ------------------------------------------------------------------

function withLock_(fn) {
  var lock = LockService.getDocumentLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// -- Per-event spreadsheet plumbing ------------------------------------------

// Per-execution cache so we don't openById the same spreadsheet repeatedly
// inside a single RPC call.
var _ssCache = {};
function openSpreadsheetById_(id) {
  if (!id) throw new Error('Empty spreadsheet ID');
  if (!_ssCache[id]) _ssCache[id] = SpreadsheetApp.openById(id);
  return _ssCache[id];
}

// Returns the per-event spreadsheet for an event row. Throws if the event has
// never had one provisioned (shouldn't happen for events created by createEvent_).
function eventSpreadsheet_(eventOrId) {
  var ev = (typeof eventOrId === 'string') ? eventById_(eventOrId) : eventOrId;
  if (!ev) throw new Error('Event not found.');
  if (!ev.event_spreadsheet_id) {
    throw new Error('Event "' + (ev.name || ev.event_id) + '" has no per-event spreadsheet attached. Run provisionEventSpreadsheet_(eventId) once to create it.');
  }
  return openSpreadsheetById_(ev.event_spreadsheet_id);
}

// Find or create the parent Drive folder for per-event spreadsheets.
function eventsParentFolder_() {
  var explicitId = getSetting_('events_drive_folder_id', '');
  if (explicitId) {
    try { return DriveApp.getFolderById(explicitId); }
    catch (err) { /* fall through to master parent */ }
  }
  var masterFile = DriveApp.getFileById(SpreadsheetApp.getActiveSpreadsheet().getId());
  var parents = masterFile.getParents();
  return parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
}

// Find or create a "YYYY Events" subfolder for the given year, beneath the
// parent returned by eventsParentFolder_().
function ensureYearEventsFolder_(year) {
  var parent = eventsParentFolder_();
  var name = year + ' Events';
  var matches = parent.getFoldersByName(name);
  return matches.hasNext() ? matches.next() : parent.createFolder(name);
}

// Bootstrap the Signups tab inside a per-event spreadsheet.
function bootstrapEventSpreadsheetTabs_(ss) {
  Object.keys(EVENT_SCHEMA).forEach(function(tabName) {
    var sheet = ss.getSheetByName(tabName);
    if (!sheet) sheet = ss.insertSheet(tabName);
    var labels = headerLabelsFor_(tabName);
    sheet.getRange(1, 1, 1, labels.length).setValues([labels]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, labels.length).setFontWeight('bold').setBackground('#fef7f4');
    sheet.autoResizeColumns(1, labels.length);
    if (sheet.getMaxColumns() > labels.length) {
      sheet.deleteColumns(labels.length + 1, sheet.getMaxColumns() - labels.length);
    }
  });
  // Drop the default Sheet1 if it's still around and empty.
  var sheet1 = ss.getSheetByName('Sheet1');
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 1) {
    ss.deleteSheet(sheet1);
  }
}

// -- Small utilities ----------------------------------------------------------

function uid_(prefix) {
  return (prefix || '') + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function hash_(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(str));
  return bytes.map(function(b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function normalizeEmail_(email) {
  return String(email || '').trim().toLowerCase();
}

function nowIso_() { return new Date().toISOString(); }

function addMinutes_(date, mins)  { return new Date(date.getTime() + mins * 60 * 1000); }
function addDays_(date, days)     { return new Date(date.getTime() + days * 86400 * 1000); }
function addHours_(date, hours)   { return new Date(date.getTime() + hours * 3600 * 1000); }

function shuffle_(arr) {
  var copy = arr.slice();
  for (var i = copy.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var tmp = copy[i]; copy[i] = copy[j]; copy[j] = tmp;
  }
  return copy;
}

function formatDate_(d) {
  if (!d) return '';
  var date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date.getTime())) return String(d);
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'EEE MMM d, yyyy h:mm a');
}

// "MM-DD" prefix for per-event spreadsheet filenames.
function formatMmDd_(d) {
  if (!d) return '';
  var date = (d instanceof Date) ? d : new Date(d);
  if (isNaN(date.getTime())) return '';
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'MM-dd');
}

// Strip characters that are invalid in Drive filenames.
function sanitizeFilename_(s) {
  return String(s || '').replace(/[\/\\?%*:|"<>]/g, ' ').replace(/\s+/g, ' ').trim();
}

function audit_(adminEmail, action, table, targetId, before, after) {
  append_(TAB.AUDIT_LOG, {
    timestamp:    nowIso_(),
    admin_email:  adminEmail || '',
    action:       action,
    target_table: table || '',
    target_id:    targetId || '',
    before:       before === undefined ? '' : JSON.stringify(before),
    after:        after  === undefined ? '' : JSON.stringify(after)
  });
}

function htmlEscape_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// =============================================================================
// Events.gs — event CRUD and queries.
// Most state transitions (Open / Close / Lottery / Finalize) live in Signups.gs
// since they involve the per-event Signups sheet; this file is just CRUD,
// reads, and per-event-spreadsheet provisioning.
// =============================================================================

function eventById_(eventId) {
  return findRow_(TAB.EVENTS, function(r) { return r.event_id === eventId; });
}

function openEvents_() {
  return findAll_(TAB.EVENTS, function(r) { return r.status === EVENT_STATUS.OPEN; })
    .sort(function(a, b) { return new Date(a.event_date) - new Date(b.event_date); });
}

function eventsForMember_(memberId) {
  // All events the member has signed up for, with their per-event signup row.
  // Walks every event's per-event spreadsheet.
  var events = readAll_(TAB.EVENTS);
  var out = [];
  events.forEach(function(ev) {
    if (!ev.event_spreadsheet_id) return;
    try {
      var ss = openSpreadsheetById_(ev.event_spreadsheet_id);
      var s = findRow_(TAB.SIGNUPS, function(r) { return r.member_id === memberId; }, ss);
      if (s) out.push({ event: ev, signup: s });
    } catch (err) { /* spreadsheet missing/inaccessible — skip */ }
  });
  return out;
}

// Create a new draft event. Used by the Sheet menu "New Event…" prompt and by
// the eventual web admin UI. Provisions a per-event spreadsheet for it too.
function createEvent_(input, byEmail) {
  var id = uid_('e_');
  var defaults = {
    event_id:                  id,
    name:                      input.name || 'Untitled Event',
    event_date:                input.event_date || '',
    location:                  input.location || '',
    capacity:                  Number(input.capacity) || getSettingNum_('default_capacity', 60),
    signup_opens_at:           input.signup_opens_at || '',
    signup_closes_at:          input.signup_closes_at || '',
    lottery_run_at:            '',
    auto_invite_enabled:       getSettingBool_('default_auto_invite_enabled', true),
    send_lottery_lost_emails:  getSettingBool_('default_send_lottery_lost_emails', true),
    status:                    EVENT_STATUS.DRAFT,
    description:               input.description || '',
    host_notes:                input.host_notes || '',
    created_by:                byEmail || '',
    created_at:                nowIso_(),
    event_spreadsheet_id:      ''
  };
  append_(TAB.EVENTS, defaults);
  // Provision the per-event spreadsheet immediately so leaders can share it.
  try {
    var fresh = eventById_(id);
    var ssId = provisionEventSpreadsheet_(fresh);
    defaults.event_spreadsheet_id = ssId;
  } catch (err) {
    // Don't fail event creation if Drive is briefly unhappy; the event row
    // will get a spreadsheet on first signup or via provisionMissingEventSpreadsheets().
    Logger.log('provisionEventSpreadsheet_ failed: ' + err);
  }
  audit_(byEmail, 'CreateEvent', TAB.EVENTS, id, null, defaults);
  return defaults;
}

// Create the "MM-DD Event Name" spreadsheet inside the appropriate
// "YYYY Events" folder, bootstrap its Signups tab, and write the resulting
// spreadsheet ID back onto the event row. Returns the spreadsheet ID.
function provisionEventSpreadsheet_(event) {
  if (!event || !event.event_id) throw new Error('Need a saved event row.');
  var dateForName = event.event_date ? new Date(event.event_date) : new Date();
  if (isNaN(dateForName.getTime())) dateForName = new Date();
  var year = dateForName.getFullYear();
  var folder = ensureYearEventsFolder_(year);
  var fileName = sanitizeFilename_(formatMmDd_(dateForName) + ' ' + (event.name || 'Untitled Event'));
  var ss = SpreadsheetApp.create(fileName);
  // Move the freshly-created file from My Drive into the year folder.
  try {
    DriveApp.getFileById(ss.getId()).moveTo(folder);
  } catch (err) {
    // Older Apps Script accounts: fall back to addToFolder + remove from root.
    var file = DriveApp.getFileById(ss.getId());
    folder.addFile(file);
    DriveApp.getRootFolder().removeFile(file);
  }
  bootstrapEventSpreadsheetTabs_(ss);

  // Write a small "About" sheet so the spreadsheet self-documents.
  var about = ss.getSheetByName('About') || ss.insertSheet('About');
  about.clear();
  about.getRange(1, 1, 6, 2).setValues([
    ['Event Name', event.name || ''],
    ['Event Date', event.event_date ? formatDate_(event.event_date) : ''],
    ['Location',   event.location  || ''],
    ['Capacity',   event.capacity  || ''],
    ['Event ID',   event.event_id],
    ['Master Sheet', SpreadsheetApp.getActiveSpreadsheet().getUrl()]
  ]);
  about.getRange(1, 1, 6, 1).setFontWeight('bold').setBackground('#fef7f4');
  about.autoResizeColumns(1, 2);

  // Move "About" before "Signups" so it's the first tab opened.
  ss.setActiveSheet(about);
  ss.moveActiveSheet(1);

  var fresh = eventById_(event.event_id);
  if (fresh) {
    updateRow_(TAB.EVENTS, fresh._rowIndex, { event_spreadsheet_id: ss.getId() });
  }
  return ss.getId();
}

function setEventStatus_(eventId, newStatus, byEmail) {
  var ev = eventById_(eventId);
  if (!ev) throw new Error('Event not found');
  var before = { status: ev.status };
  updateRow_(TAB.EVENTS, ev._rowIndex, { status: newStatus });
  audit_(byEmail, 'SetEventStatus', TAB.EVENTS, eventId, before, { status: newStatus });
}

function publicEvent_(ev) {
  return {
    event_id:    ev.event_id,
    name:        ev.name,
    event_date:  ev.event_date ? new Date(ev.event_date).toISOString() : '',
    event_date_formatted: formatDate_(ev.event_date),
    location:    ev.location,
    capacity:    Number(ev.capacity) || 0,
    signup_closes_at: ev.signup_closes_at ? new Date(ev.signup_closes_at).toISOString() : '',
    description: ev.description,
    status:      ev.status
  };
}

/**
 * Pure aggregation logic for the member x event analytics matrix.
 * No database or IO dependencies — takes flat rows, returns a pivoted shape.
 */

'use strict';

// A member was "given a chance" if they ever won a lottery slot for the
// event, regardless of what happened afterward (showed up, flaked, or
// cleanly declined before the event).
const GIVEN_CHANCE_STATUSES = ['Invited', 'Attended', 'Flaked'];

/**
 * @param {Array<{member_id, full_name, email, school_year}>} members
 * @param {Array<{event_id, name, event_date, dollar_value}>} events
 * @param {Array<{member_id, event_id, status}>} signupRows
 */
function buildAnalyticsMatrix(members, events, signupRows) {
  const cells = {};
  members.forEach(m => { cells[m.member_id] = {}; });

  const totals = {};
  events.forEach(e => {
    totals[e.event_id] = { applied: 0, dropped: 0, flaked: 0, attended: 0, givenChance: 0 };
  });

  signupRows.forEach(r => {
    if (!cells[r.member_id]) cells[r.member_id] = {};
    cells[r.member_id][r.event_id] = r.status;

    const t = totals[r.event_id];
    if (!t) return;
    t.applied++;
    if (r.status === 'Dropped') t.dropped++;
    else if (r.status === 'Flaked') t.flaked++;
    else if (r.status === 'Attended') t.attended++;
    if (GIVEN_CHANCE_STATUSES.includes(r.status)) t.givenChance++;
  });

  let grandTotalDollarValue = 0;
  events.forEach(e => {
    const t = totals[e.event_id];
    t.pctAttended = t.applied ? t.attended / t.applied : 0;
    t.pctGivenChance = t.applied ? t.givenChance / t.applied : 0;
    t.pctAttendedOfGivenChance = t.givenChance ? t.attended / t.givenChance : 0;
    t.dollarValue = e.dollar_value != null ? parseFloat(e.dollar_value) : null;
    t.totalDollarValue = t.dollarValue != null ? t.dollarValue * t.attended : 0;
    grandTotalDollarValue += t.totalDollarValue;
  });

  return { cells, totals, grandTotalDollarValue };
}

module.exports = { buildAnalyticsMatrix, GIVEN_CHANCE_STATUSES };

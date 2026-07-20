// Member x event analytics matrix + formatted Excel export. Exec Team only —
// this exposes attendance/flake history across the whole roster.
const express = require('express');
const ExcelJS = require('exceljs');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { buildAnalyticsMatrix } = require('../services/analytics');

const router = express.Router();

function requireExecTeam(req, res, next) {
  if (!req.member.is_exec_team) return res.status(403).json({ error: 'Exec Team permission required' });
  next();
}

async function loadAnalyticsData(schoolYear) {
  const memberParams = [];
  let memberWhere = '';
  if (schoolYear) {
    memberParams.push(schoolYear);
    memberWhere = 'WHERE school_year = $1';
  }
  const { rows: members } = await db.query(
    `SELECT member_id, full_name, email, affiliation, school_year FROM members ${memberWhere} ORDER BY full_name`,
    memberParams
  );
  const { rows: events } = await db.query(
    `SELECT event_id, name, event_date, dollar_value FROM events ORDER BY event_date ASC NULLS LAST`
  );

  const memberIds = members.map(m => m.member_id);
  let signupRows = [];
  if (memberIds.length) {
    const { rows } = await db.query(
      `SELECT member_id, event_id, status FROM signups WHERE member_id = ANY($1)`,
      [memberIds]
    );
    signupRows = rows;
  }
  return { members, events, signupRows };
}

// GET /api/analytics/matrix?school_year=2026-27
router.get('/matrix', requireAdmin, requireExecTeam, async (req, res) => {
  try {
    const { members, events, signupRows } = await loadAnalyticsData(req.query.school_year || null);
    const { cells, totals, grandTotalDollarValue } = buildAnalyticsMatrix(members, events, signupRows);
    return res.json({ members, events, cells, totals, grandTotalDollarValue });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

const STATUS_FILL = {
  Attended: 'FFC6EFCE',
  Flaked: 'FFFFC7CE',
  Dropped: 'FFF2F2F2',
  Lost: 'FFF2F2F2',
  Invited: 'FFD9E1F2',
  Waitlist: 'FFFFEB9C',
};

// GET /api/analytics/export.xlsx?school_year=2026-27
router.get('/export.xlsx', requireAdmin, requireExecTeam, async (req, res) => {
  try {
    const { members, events, signupRows } = await loadAnalyticsData(req.query.school_year || null);
    const { cells, totals } = buildAnalyticsMatrix(members, events, signupRows);

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Analytics');
    const fixedCols = ['Member', 'Email', 'Affiliation', 'School Year'];

    const header = ws.addRow([...fixedCols, ...events.map(e => e.name)]);
    header.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    });

    members.forEach(m => {
      const row = ws.addRow([
        m.full_name, m.email, m.affiliation || '', m.school_year || '',
        ...events.map(e => cells[m.member_id]?.[e.event_id] || ''),
      ]);
      events.forEach((e, i) => {
        const status = cells[m.member_id]?.[e.event_id];
        const fill = STATUS_FILL[status];
        if (fill) row.getCell(fixedCols.length + 1 + i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      });
    });

    const pct = v => (v * 100).toFixed(0) + '%';
    const addSummaryRow = (label, values) => {
      const row = ws.addRow([label, ...Array(fixedCols.length - 1).fill(''), ...values]);
      row.font = { bold: true };
      return row;
    };
    addSummaryRow('Applied', events.map(e => totals[e.event_id].applied));
    addSummaryRow('Dropped', events.map(e => totals[e.event_id].dropped));
    addSummaryRow('Flaked', events.map(e => totals[e.event_id].flaked));
    addSummaryRow('Attended', events.map(e => totals[e.event_id].attended));
    addSummaryRow('% Attended', events.map(e => pct(totals[e.event_id].pctAttended)));
    addSummaryRow('# Given a Chance', events.map(e => totals[e.event_id].givenChance));
    addSummaryRow('% Given a Chance', events.map(e => pct(totals[e.event_id].pctGivenChance)));
    addSummaryRow('% Attended of Given a Chance', events.map(e => pct(totals[e.event_id].pctAttendedOfGivenChance)));
    addSummaryRow('Dollar Value', events.map(e => totals[e.event_id].dollarValue != null ? '$' + totals[e.event_id].dollarValue.toFixed(2) : ''));
    addSummaryRow('Total Dollar Value', events.map(e => '$' + totals[e.event_id].totalDollarValue.toFixed(2)));

    ws.columns.forEach((col, i) => { col.width = i < fixedCols.length ? 24 : 14; });
    ws.views = [{ state: 'frozen', xSplit: fixedCols.length, ySplit: 1 }];

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="wine-circle-analytics.xlsx"');
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;

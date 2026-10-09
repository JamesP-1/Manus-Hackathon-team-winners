// Writes tests/fixtures/sample-timetable.ics: a made-up timetable (fictional modules and staff,
// real public room codes) that the iCal and timetable tests run against.
import { writeFileSync } from 'node:fs';

const events = [
  ['sample-0001', '20260910T100000Z', '20260910T110000Z', 'XYZ1001 Example Module One (Lecture)', 'Lecture', 'SA301 (Stokes Extension\\, Glasnevin)'],
  ['sample-0002', '20261008T090000Z', '20261008T100000Z', 'XYZ1002 Example Module Two (Lecture)', 'Lecture', 'HG23 (Alice Reeves Building\\, Glasnevin)'],
  ['sample-0003', '20261008T130000Z', '20261008T150000Z', 'XYZ1003 Example Module Three (Lab)', 'Lab', 'LG25\\, LG26\\, L125\\, L128 (McNulty Building\\, Glasnevin)'],
  ['sample-0004', '20261009T110000Z', '20261009T120000Z', 'XYZ1004 Example Module Four (Tutorial\\, Group A)', 'Tutorial', 'CG12 (Henry Grattan Building\\, Glasnevin)'],
  ['sample-0005', '20261012T090000Z', '20261012T100000Z', 'XYZ1005 Example Module Five (Lecture)', 'Lecture', 'FTG13 (Polaris\\, Glasnevin)'],
  ['sample-0006', '20261013T140000Z', '20261013T150000Z', 'XYZ1001 Example Module One (Lecture)', 'Lecture', 'QG15 (DCU Business School\\, Glasnevin)'],
  ['sample-0007', '20261020T100000Z', '20261020T110000Z', 'XYZ1002 Example Module Two (Lecture)', 'Lecture', 'SA101 (Stokes Extension\\, Glasnevin)'],
  ['sample-0008', '20261001T100000Z', '20261001T110000Z', 'XYZ1006 Example Module Six (Seminar)', 'Seminar', 'L101 (McNulty Building\\, Glasnevin)'],
];

const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'METHOD:PUBLISH', 'PRODID:-//DCU Maps//Made-up sample timetable for tests//EN'];
for (const [uid, start, end, summary, kind, location] of events) {
  lines.push(
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20260901T120000Z',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:Details: ${kind}\\nStaff: Example Lecturer`,
    `LOCATION:${location}`,
    'CLASS:PUBLIC',
    'END:VEVENT',
  );
}
lines.push('END:VCALENDAR');

writeFileSync(new URL('../tests/fixtures/sample-timetable.ics', import.meta.url), `${lines.join('\r\n')}\r\n`);

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { looksLikeIcal, parseIcal, parseIcalDate, parseProperty, unescapeText, unfoldLines } from '../src/lib/ical';

const fixture = readFileSync(new URL('./fixtures/sample-timetable.ics', import.meta.url), 'utf8');

test('unfolds CRLF continuation lines and strips a BOM', () => {
  const lines = unfoldLines('﻿BEGIN:VEVENT\r\nSUMMARY:A very long\r\n  summary\r\n\tcontinued\r\nEND:VEVENT\r\n');
  assert.deepEqual(lines, ['BEGIN:VEVENT', 'SUMMARY:A very long summarycontinued', 'END:VEVENT']);
});

test('unescapes RFC 5545 text sequences', () => {
  assert.equal(unescapeText('a\\, b\\; c\\nd\\Ne\\\\f'), 'a, b; c\nd\ne\\f');
});

test('parses property names, parameters and quoted values', () => {
  const property = parseProperty('DTSTART;TZID="Europe/Dublin";VALUE=DATE-TIME:20261008T100000');
  assert.equal(property?.name, 'DTSTART');
  assert.deepEqual(property?.params, { TZID: 'Europe/Dublin', VALUE: 'DATE-TIME' });
  assert.equal(property?.value, '20261008T100000');
  assert.equal(parseProperty('no colon here'), null);
});

test('parses UTC, TZID, floating and all-day dates', () => {
  assert.equal(parseIcalDate('20261008T100000Z')?.toISOString(), '2026-10-08T10:00:00.000Z');
  // Dublin is UTC+1 in October (IST) and UTC+0 in January.
  assert.equal(parseIcalDate('20261008T100000', { TZID: 'Europe/Dublin' })?.toISOString(), '2026-10-08T09:00:00.000Z');
  assert.equal(parseIcalDate('20260115T100000', { TZID: 'Europe/Dublin' })?.toISOString(), '2026-01-15T10:00:00.000Z');
  const floating = parseIcalDate('20261008T100000');
  assert.deepEqual([floating?.getFullYear(), floating?.getMonth(), floating?.getDate(), floating?.getHours()], [2026, 9, 8, 10]);
  const allDay = parseIcalDate('20261008', { VALUE: 'DATE' });
  assert.deepEqual([allDay?.getFullYear(), allDay?.getMonth(), allDay?.getDate(), allDay?.getHours()], [2026, 9, 8, 0]);
  assert.equal(parseIcalDate('not a date'), null);
  assert.equal(parseIcalDate('20261350T100000Z'), null);
});

test('falls back to local time for an unknown TZID instead of throwing', () => {
  const date = parseIcalDate('20261008T100000', { TZID: 'Not/AZone' });
  assert.deepEqual([date?.getHours(), date?.getMinutes()], [10, 0]);
});

test('parses the sample timetable fixture into events', () => {
  assert.ok(looksLikeIcal(fixture));
  const events = parseIcal(fixture);
  assert.equal(events.length, 8);

  const first = events[0];
  assert.equal(first.uid, 'sample-0001');
  assert.equal(first.summary, 'XYZ1001 Example Module One (Lecture)');
  assert.equal(first.location, 'SA301 (Stokes Extension, Glasnevin)');
  assert.equal(first.description, 'Details: Lecture\nStaff: Example Lecturer');
  assert.equal(first.start?.toISOString(), '2026-09-10T10:00:00.000Z');
  assert.equal(first.end?.toISOString(), '2026-09-10T11:00:00.000Z');
  assert.equal(first.allDay, false);
  assert.equal(first.timeZone, null);

  assert.ok(events.every((event) => event.start && event.end && event.uid));
  const tutorial = events.find((event) => event.summary.includes('Group A'));
  assert.equal(tutorial?.summary, 'XYZ1004 Example Module Four (Tutorial, Group A)');
});

test('ignores nested components and non-event blocks', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Dublin',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'UID:1',
    'SUMMARY:Outer',
    'BEGIN:VALARM',
    'SUMMARY:Alarm, not the event',
    'END:VALARM',
    'DTSTART;VALUE=DATE:20261008',
    'STATUS:cancelled',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const events = parseIcal(text);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Outer');
  assert.equal(events[0].allDay, true);
  assert.equal(events[0].status, 'CANCELLED');
  assert.equal(looksLikeIcal('<!doctype html><html>'), false);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import buildingData from '../src/data/buildings.json';
import roomData from '../src/data/rooms.json';
import {
  TimetableError,
  campusHintFrom,
  dayKey,
  groupByDay,
  isCourseId,
  loadTimetable,
  nextClass,
  parseTimetableInput,
  parseTimetableText,
  resolveLocation,
  splitLocation,
  upcomingClasses,
} from '../src/lib/timetable';
import type { Building, Room } from '../src/types';

const buildings = buildingData as Building[];
const rooms = roomData as Room[];
const fixture = readFileSync(new URL('./fixtures/sample-timetable.ics', import.meta.url), 'utf8');
const courseId = '11111111-2222-4333-8444-555555555555';
const proxiedUrl = `/api/timetable/events?course=${courseId}`;

function response(body: string, init: { status?: number; type?: string } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': init.type ?? 'text/calendar' } });
}

test('accepts a bare course id, the feed URL and page URLs carrying the id', () => {
  assert.ok(isCourseId(` ${courseId.toUpperCase()} `));
  const inputs = [
    courseId,
    `https://timetable.redbrick.dcu.ie/api/v3/timetable/events?course=${courseId}`,
    `timetable.redbrick.dcu.ie/?course=${courseId.toUpperCase()}`,
    `https://timetable.redbrick.dcu.ie/timetable/${courseId}#week`,
  ];
  for (const input of inputs) {
    const source = parseTimetableInput(input);
    assert.equal(source.courseId, courseId, input);
    assert.equal(source.proxiedUrl, proxiedUrl, input);
    assert.equal(source.feedUrl, `https://timetable.redbrick.dcu.ie/api/v3/timetable/events?course=${courseId}`);
  }
});

test('rejects foreign hosts, missing ids and junk with input errors', () => {
  const cases: Array<[string, RegExp]> = [
    ['', /Paste your timetable link/],
    [`https://example.com/?course=${courseId}`, /Only links from timetable.redbrick.dcu.ie/],
    ['https://timetable.redbrick.dcu.ie/', /no course id/],
    ['abc', /Enter a course id/],
    ['11111111-2222-4333', /Enter a course id/],
  ];
  for (const [input, pattern] of cases) {
    assert.throws(() => parseTimetableInput(input), (error: unknown) => error instanceof TimetableError && error.kind === 'input' && pattern.test(error.message), input);
  }
});

test('splits feed locations into room slots with campus hints', () => {
  assert.deepEqual(splitLocation('SA301 (Stokes Extension, Glasnevin)'), [
    { code: 'SA301', detail: 'Stokes Extension, Glasnevin', raw: 'SA301 (Stokes Extension, Glasnevin)' },
  ]);
  assert.deepEqual(
    splitLocation('LG25, LG26, L125, L128 (McNulty Building, Glasnevin)').map((slot) => slot.code),
    ['LG25', 'LG26', 'L125', 'L128'],
  );
  assert.deepEqual(
    splitLocation('SA301 (Stokes Extension, Glasnevin); CG12 (Henry Grattan Building, Glasnevin)').map((slot) => [slot.code, slot.detail]),
    [['SA301', 'Stokes Extension, Glasnevin'], ['CG12', 'Henry Grattan Building, Glasnevin']],
  );
  assert.deepEqual(splitLocation('Online'), [{ code: null, detail: 'Online', raw: 'Online' }]);
  assert.deepEqual(splitLocation(''), []);
  assert.equal(campusHintFrom("Block A, St Patrick's"), 'stpatricks');
  assert.equal(campusHintFrom('All Hallows'), 'allhallows');
  assert.equal(campusHintFrom('Somewhere else'), null);
});

test('uses the campus hint to break cross-campus ambiguity and keeps the original code', () => {
  const [withHint] = resolveLocation('CG12 (Henry Grattan Building, Glasnevin)', buildings, rooms);
  assert.equal(withHint.campusHint, 'glasnevin');
  assert.equal(withHint.resolution?.building?.id, 'glasnevin-C');
  assert.equal(withHint.resolution?.normalized, 'CG12');
  assert.equal(withHint.resolvedVia, 'code');

  const [noHint] = resolveLocation('C101', buildings, rooms);
  assert.equal(noHint.resolution?.status, 'ambiguous');
  assert.equal(noHint.resolution?.building, null);
});

test('falls back to the building named in the feed when the code is not decodable', () => {
  const [slot] = resolveLocation('SA1 (Stokes Extension, Glasnevin)', buildings, rooms);
  assert.equal(slot.resolvedVia, 'building-name');
  assert.equal(slot.resolution?.building?.id, 'glasnevin-SA');
  assert.equal(slot.resolution?.status, 'decoded');

  const [online] = resolveLocation('Online', buildings, rooms);
  assert.equal(online.code, null);
  assert.equal(online.resolution, null);
});

test('resolves every room in the fixture feed through the real datasets', () => {
  const source = parseTimetableInput(courseId);
  const feed = parseTimetableText(fixture, source, buildings, rooms);

  assert.equal(feed.classes.length, 8);
  assert.equal(feed.skipped, 0);
  assert.deepEqual(feed.roomSummary.unresolved, []);
  assert.deepEqual(feed.roomSummary.decoded, ['FTG13']);
  assert.deepEqual(feed.roomSummary.listed, ['CG12', 'HG23', 'L101', 'L125', 'L128', 'LG25', 'LG26', 'QG15', 'SA101', 'SA301']);
  assert.ok(feed.classes.every((cls) => cls.primary?.resolution?.building));

  const first = feed.classes.find((cls) => cls.id === 'sample-0001');
  assert.ok(first);
  assert.equal(first.moduleCode, 'XYZ1001');
  assert.equal(first.title, 'Example Module One');
  assert.equal(first.activity, 'Lecture');
  assert.equal(first.staff, 'Example Lecturer');
  assert.equal(first.primary?.resolution?.building?.name, 'Stokes Extension');

  const lab = feed.classes.find((cls) => cls.locations.length === 4);
  assert.ok(lab);
  assert.equal(lab.primary?.code, 'LG25');
  assert.equal(lab.primary?.resolution?.floor, 'Ground');
  assert.equal(lab.primary?.resolution?.building?.id, 'glasnevin-L');
});

test('upcoming, grouping and next-class helpers follow the clock', () => {
  const feed = parseTimetableText(fixture, parseTimetableInput(courseId), buildings, rooms);
  const now = new Date('2026-10-08T09:30:00Z');

  const next = nextClass(feed.classes, now);
  assert.equal(next?.summary, 'XYZ1002 Example Module Two (Lecture)');
  assert.equal(next?.start.toISOString(), '2026-10-08T09:00:00.000Z');

  const week = upcomingClasses(feed.classes, now, 7);
  assert.equal(week.length, 5);
  assert.ok(week.every((cls) => cls.end > now));
  assert.ok(upcomingClasses(feed.classes, now).length > week.length);

  const days = groupByDay(week, now);
  assert.equal(days[0].key, dayKey(next!.start));
  assert.match(days[0].label, /^Today/);
  assert.equal(days[0].classes[0].id, next?.id);
  assert.ok(days.every((day) => day.classes.every((cls) => dayKey(cls.start) === day.key)));

  assert.equal(nextClass(feed.classes, new Date('2027-06-01T00:00:00Z')), null);
});

test('loadTimetable fetches through the proxy and reports proxy, http and empty-feed errors', async () => {
  const calls: string[] = [];
  const feed = await loadTimetable(courseId, buildings, rooms, async (url) => {
    calls.push(url);
    return response(fixture);
  });
  assert.deepEqual(calls, [proxiedUrl]);
  assert.equal(feed.classes.length, 8);

  await assert.rejects(
    loadTimetable(courseId, buildings, rooms, async () => response('<!doctype html><html></html>', { type: 'text/html' })),
    (error: unknown) => error instanceof TimetableError && error.kind === 'proxy' && /proxy/.test(error.message),
  );
  await assert.rejects(
    loadTimetable(courseId, buildings, rooms, async () => response('nope', { status: 404 })),
    (error: unknown) => error instanceof TimetableError && error.kind === 'http' && /404/.test(error.message),
  );
  await assert.rejects(
    loadTimetable(courseId, buildings, rooms, async () => { throw new TypeError('Failed to fetch'); }),
    (error: unknown) => error instanceof TimetableError && error.kind === 'network',
  );
  await assert.rejects(
    loadTimetable(courseId, buildings, rooms, async () => response('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n')),
    (error: unknown) => error instanceof TimetableError && error.kind === 'parse',
  );
  await assert.rejects(loadTimetable('nonsense', buildings, rooms, async () => response(fixture)), (error: unknown) => error instanceof TimetableError && error.kind === 'input');
});

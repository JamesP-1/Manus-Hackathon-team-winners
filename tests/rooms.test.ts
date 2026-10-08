import assert from 'node:assert/strict';
import test from 'node:test';

import buildingData from '../src/data/buildings.json';
import roomData from '../src/data/rooms.json';
import { extractTimetableRooms, resolveRoom, searchBuildings } from '../src/lib/rooms';
import type { Building, Room } from '../src/types';

const scrapedBuildings = buildingData as Building[];
const scrapedRooms = roomData as Room[];

const buildings: Building[] = [
  {
    id: 'glasnevin-L',
    code: 'L',
    name: 'McNulty Building',
    campus: 'glasnevin',
    aliases: ['McNulty'],
    lat: null,
    lng: null,
    coordinateSource: null,
    coordinatePrecision: 'unknown',
    sourceUrls: [],
  },
  {
    id: 'glasnevin-C',
    code: 'C',
    name: 'Henry Grattan',
    campus: 'glasnevin',
    aliases: [],
    lat: null,
    lng: null,
    coordinateSource: null,
    coordinatePrecision: 'unknown',
    sourceUrls: [],
  },
  {
    id: 'glasnevin-CA',
    code: 'CA',
    name: 'Henry Grattan Extension',
    campus: 'glasnevin',
    aliases: ['DTS'],
    lat: null,
    lng: null,
    coordinateSource: null,
    coordinatePrecision: 'unknown',
    sourceUrls: [],
  },
  {
    id: 'glasnevin-A',
    code: 'A',
    name: 'Albert College',
    campus: 'glasnevin',
    aliases: [],
    lat: null,
    lng: null,
    coordinateSource: null,
    coordinatePrecision: 'unknown',
    sourceUrls: [],
  },
  {
    id: 'stpatricks-A',
    code: 'A',
    name: 'Block A',
    campus: 'stpatricks',
    aliases: [],
    lat: null,
    lng: null,
    coordinateSource: null,
    coordinatePrecision: 'unknown',
    sourceUrls: [],
  },
];

const rooms: Room[] = [
  {
    id: 'glasnevin-L101',
    code: 'L101',
    buildingId: 'glasnevin-L',
    campus: 'glasnevin',
    floor: '1',
    roomNumber: '01',
    sourceUrls: ['https://example.test/rooms'],
    evidence: 'listed',
  },
];

test('decodes a numeric floor and room number when a room is not listed', () => {
  const result = resolveRoom(' l 202 ', buildings, rooms);

  assert.equal(result.status, 'decoded');
  assert.equal(result.building?.id, 'glasnevin-L');
  assert.equal(result.floor, '2');
  assert.equal(result.roomNumber, '02');
  assert.match(result.message, /Room not confirmed in public listings/);
});

test('resolves a listed room before applying the convention', () => {
  const result = resolveRoom('l101', buildings, rooms);

  assert.equal(result.status, 'listed');
  assert.equal(result.room?.id, 'glasnevin-L101');
  assert.equal(result.floor, '1');
  assert.equal(result.roomNumber, '01');
});

test('decodes ground, lower-ground, and zero-prefixed forms', () => {
  const ground = resolveRoom('CG71', buildings, rooms);
  const lowerGround = resolveRoom('C LG01', buildings, rooms);
  const zero = resolveRoom('C071', buildings, rooms);

  assert.deepEqual([ground.floor, ground.roomNumber], ['Ground', '71']);
  assert.deepEqual([lowerGround.floor, lowerGround.roomNumber], ['Lower Ground', '01']);
  assert.deepEqual([zero.floor, zero.roomNumber], ['Ground', '71']);
});

test('uses the longest valid multi-letter building prefix', () => {
  const result = resolveRoom('CA101', buildings, rooms);

  assert.equal(result.status, 'decoded');
  assert.equal(result.building?.id, 'glasnevin-CA');
  assert.equal(result.floor, '1');
  assert.equal(result.roomNumber, '01');
});

test('keeps unknown codes and invalid suffixes explicit', () => {
  const unknown = resolveRoom('ZZ101', buildings, rooms);
  const invalid = resolveRoom('L1', buildings, rooms);

  assert.equal(unknown.status, 'unknown');
  assert.equal(invalid.status, 'unknown');
  assert.match(invalid.message, /supported room suffix/);
});

test('reports a same-code cross-campus room as ambiguous unless qualified', () => {
  const ambiguous = resolveRoom('A101', buildings, rooms);
  const qualified = resolveRoom('GLA.A101', buildings, rooms);

  assert.equal(ambiguous.status, 'ambiguous');
  assert.equal(ambiguous.building, null);
  assert.equal(qualified.status, 'decoded');
  assert.equal(qualified.building?.id, 'glasnevin-A');
});

test('allows an explicit building-only selection and normalised building search', () => {
  const selected = resolveRoom(' l ', buildings, rooms);
  const matches = searchBuildings('  mcnulty  ', buildings);

  assert.equal(selected.status, 'decoded');
  assert.equal(selected.building?.id, 'glasnevin-L');
  assert.equal(selected.room, null);
  assert.equal(matches[0]?.id, 'glasnevin-L');
});

test('decodes a basement suffix as a listed-form floor', () => {
  const result = resolveRoom('SB11', [...buildings, { ...buildings[0], id: 'glasnevin-S', code: 'S', name: 'Stokes', aliases: [] }], rooms);

  assert.equal(result.status, 'decoded');
  assert.equal(result.building?.id, 'glasnevin-S');
  assert.equal(result.floor, 'Basement');
  assert.equal(result.roomNumber, '11');
});

test('scraped room inventory: ids are unique and every buildingId resolves to a building', () => {
  const buildingIds = new Set(scrapedBuildings.map((building) => building.id));
  assert.equal(buildingIds.size, scrapedBuildings.length, 'building ids must be unique');
  assert.ok(scrapedRooms.length > 0, 'room inventory must not be empty');

  const roomIds = new Set(scrapedRooms.map((room) => room.id));
  assert.equal(roomIds.size, scrapedRooms.length, 'room ids must be unique');

  const buildingsById = new Map(scrapedBuildings.map((building) => [building.id, building]));
  for (const room of scrapedRooms) {
    const building = buildingsById.get(room.buildingId);
    assert.ok(building, `${room.id} references missing building ${room.buildingId}`);
    assert.equal(room.campus, building.campus, `${room.id} campus differs from its building`);
    assert.equal(room.id, `${room.campus}-${room.code}`, `${room.id} must follow campus-CODE`);
    assert.ok(room.code.startsWith(building.code), `${room.id} code must begin with its building code`);
    assert.equal(room.evidence, 'listed');
    assert.ok(room.sourceUrls.length > 0 && room.sourceUrls.every((url) => url.startsWith('https://www.dcu.ie/')), `${room.id} needs public dcu.ie sources`);
  }
});

test('scraped listed rooms resolve as listed through the real datasets', () => {
  const l101 = resolveRoom('GLA.L101', scrapedBuildings, scrapedRooms);
  const sb11 = resolveRoom('SB11', scrapedBuildings, scrapedRooms);

  assert.equal(l101.status, 'listed');
  assert.equal(l101.building?.id, 'glasnevin-L');
  assert.equal(sb11.status, 'listed');
  assert.equal(sb11.building?.id, 'glasnevin-S');
  assert.equal(sb11.floor, 'Basement');
});

test('extracts valid timetable rooms in order and deduplicates destinations', () => {
  const results = extractTimetableRooms('Mon L101; Tue CG71; Wed CA101; repeat GLA.L101.', buildings, rooms);

  assert.deepEqual(
    results.map((result) => [result.building?.id, result.floor, result.roomNumber]),
    [
      ['glasnevin-L', '1', '01'],
      ['glasnevin-C', 'Ground', '71'],
      ['glasnevin-CA', '1', '01'],
    ],
  );
});

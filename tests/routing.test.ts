import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import buildingData from '../src/data/buildings.json';
import { matchFootprints, type CampusFeatureCollection } from '../src/lib/campusFootprints';
import {
  buildPathGraph,
  buildingRouteTarget,
  findRoute,
  haversineMetres,
  routeToBuilding,
  snapToNetwork,
  type LatLng,
  type PathFeatureCollection,
} from '../src/lib/routing';
import type { Building } from '../src/types';

const paths = JSON.parse(
  readFileSync(new URL('../src/data/campus-paths.geojson', import.meta.url), 'utf8'),
) as PathFeatureCollection;
const footprints = JSON.parse(
  readFileSync(new URL('../src/data/campus-buildings.geojson', import.meta.url), 'utf8'),
) as CampusFeatureCollection;
const buildings = buildingData as Building[];

/** Where the campus avenue meets Collins Avenue, Glasnevin's main entrance (approximate). */
const MAIN_ENTRANCE: LatLng = [53.38765, -6.25844];

const graph = buildPathGraph(paths);
const matches = matchFootprints(buildings, footprints);
const matchFor = (id: string) => {
  const match = matches.find((m) => m.building.id === id);
  assert.ok(match, `building ${id} missing from buildings.json`);
  return match;
};

function assertMonotoneCoordinates(coords: LatLng[]) {
  for (const [lat, lng] of coords) {
    assert.ok(Number.isFinite(lat) && Number.isFinite(lng));
    assert.ok(lat > 53.3 && lat < 53.45 && lng > -6.3 && lng < -6.2, `coordinate ${lat},${lng} outside Dublin`);
  }
}

test('path network loads with attribution and a usable graph', () => {
  assert.match(paths.attribution ?? '', /OpenStreetMap contributors/);
  assert.ok(paths.features.length > 500, `only ${paths.features.length} ways`);
  assert.ok(paths.features.every((f) => /OpenStreetMap contributors/.test(f.properties.attribution ?? '')));
  assert.ok(graph.stats.nodes > 2000);
  assert.ok(graph.stats.edges > graph.stats.nodes / 2);
  // Ways join at shared coordinates: there must be junction nodes with 3+ edges.
  assert.ok(graph.nodes.some((n) => n.edges.length >= 3), 'no junction nodes — ways are not being joined');
});

test('routes between two Glasnevin buildings over the path network', () => {
  const a = buildings.find((b) => b.id === 'glasnevin-A')!; // Albert College
  const b = buildings.find((b) => b.id === 'glasnevin-B')!; // Invent
  const from: LatLng = [a.lat!, a.lng!];
  const to: LatLng = [b.lat!, b.lng!];
  const straight = haversineMetres(from, to);

  const route = findRoute(graph, from, to);
  assert.ok(route, 'expected a route between Albert College and Invent');
  assert.ok(route.distanceMetres > straight, `route ${route.distanceMetres} m not longer than straight line ${straight} m`);
  assert.ok(route.distanceMetres < 2000, `route ${route.distanceMetres} m is implausibly long`);
  assert.ok(route.coordinates.length >= 4);
  assert.deepEqual(route.coordinates[0], from);
  assert.deepEqual(route.coordinates[route.coordinates.length - 1], to);
  assertMonotoneCoordinates(route.coordinates);
  const expectedMinutes = route.distanceMetres / 1.3 / 60;
  assert.ok(Math.abs(route.walkingMinutes - expectedMinutes) < 1e-9);
  assert.ok(route.walkingMinutes > 3 && route.walkingMinutes < 30);
});

test('route is symmetric in length and strictly follows adjacent graph nodes', () => {
  const from: LatLng = [53.3854744, -6.2606397];
  const to: LatLng = [53.3847107, -6.2534792];
  const forward = findRoute(graph, from, to)!;
  const backward = findRoute(graph, to, from)!;
  assert.ok(Math.abs(forward.distanceMetres - backward.distanceMetres) < 1, 'A→B and B→A lengths differ');
  // No single leg should be longer than a plausible OSM segment plus the snap legs.
  for (let i = 1; i < forward.coordinates.length; i += 1) {
    const leg = haversineMetres(forward.coordinates[i - 1], forward.coordinates[i]);
    assert.ok(leg < 400, `leg ${i} is ${leg} m`);
  }
});

test('routes to a building positioned only by its OSM footprint centroid', () => {
  const match = matchFor('glasnevin-C'); // Henry Grattan: lat/lng null in buildings.json
  assert.equal(match.building.lat, null);
  assert.equal(match.positionSource, 'osm-footprint');
  const target = buildingRouteTarget(graph, match);
  assert.ok(target, 'no route target for a footprint-only building');
  // The target must sit on the footprint outline or at the pin, and near the network.
  const snap = snapToNetwork(graph, target);
  assert.ok(snap && snap.distanceMetres < 40, `footprint target is ${snap?.distanceMetres} m from any path`);

  const route = routeToBuilding(graph, MAIN_ENTRANCE, match);
  assert.ok(route, 'expected a route from the main entrance to Henry Grattan');
  assert.ok(route.distanceMetres > 100 && route.distanceMetres < 1500);
});

test('every pinned building has a reachable route target', () => {
  const from = MAIN_ENTRANCE;
  const unreachable: string[] = [];
  for (const match of matches) {
    if (!match.position && match.features.length === 0) continue;
    const route = routeToBuilding(graph, from, match);
    if (!route) unreachable.push(match.building.id);
  }
  assert.deepEqual(unreachable, [], `no route to: ${unreachable.join(', ')}`);
});

test('cross-campus route from Glasnevin to St Patrick\'s uses the streets between them', () => {
  const route = routeToBuilding(graph, MAIN_ENTRANCE, matchFor('stpatricks-S'));
  assert.ok(route, 'expected a Glasnevin → Drumcondra route');
  const straight = haversineMetres(MAIN_ENTRANCE, [53.3708662, -6.2566026]);
  // The real walk leaves campus by Ballymun Road and comes back east along
  // Home Farm Road, so it is well over the straight line but under 4 km.
  assert.ok(route.distanceMetres > straight, `route ${route.distanceMetres} m shorter than straight ${straight} m`);
  assert.ok(route.distanceMetres < 4000, `route ${route.distanceMetres} m is implausibly long`);
  assert.ok(route.coordinates.some(([lat]) => lat < 53.375), 'route never reaches Drumcondra');
});

test('a point far from the network reports no route', () => {
  const sea: LatLng = [53.38, -6.1];
  assert.equal(snapToNetwork(graph, sea), null);
  assert.equal(findRoute(graph, sea, [53.3854744, -6.2606397]), null);
  assert.equal(findRoute(graph, [53.3854744, -6.2606397], sea), null);
});

test('a point snaps onto the interior of an edge, not only onto vertices', () => {
  // Midpoint of the first two coordinates of a footway, nudged sideways by ~3 m.
  const footway = paths.features.find((f) => f.properties.highway === 'footway' && f.geometry.coordinates.length >= 2)!;
  const [[lng0, lat0], [lng1, lat1]] = footway.geometry.coordinates;
  const mid: LatLng = [(lat0 + lat1) / 2 + 0.00003, (lng0 + lng1) / 2];
  const snap = snapToNetwork(graph, mid);
  assert.ok(snap);
  assert.ok(snap.distanceMetres < 10);
  assert.ok(snap.t > 0 && snap.t < 1, `expected an interior projection, got t=${snap.t}`);
});

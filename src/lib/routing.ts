import type { FeatureCollection, LineString, Position } from 'geojson';
import type { FootprintMatch } from './campusFootprints';

/**
 * Client-side pedestrian routing over the OpenStreetMap path network bundled
 * in src/data/campus-paths.geojson (written by scripts/fetch-osm-paths.mjs).
 *
 * The graph joins ways wherever their coordinates coincide (OSM ways share node
 * coordinates at junctions). Edge weight is the haversine length in metres with
 * a mild multiplier for steps and for roads that are not primarily pedestrian.
 * Routing is outdoor only: it ends at the point of a building footprint that is
 * closest to the path network, not at a verified entrance.
 */

/** [lat, lng] — the order Leaflet uses. */
export type LatLng = [number, number];

export interface PathFeatureProperties {
  osmId: number;
  highway: string;
  name?: string;
  foot?: string;
  access?: string;
  attribution?: string;
}

export type PathFeatureCollection = FeatureCollection<LineString, PathFeatureProperties> & {
  attribution?: string;
  generated?: string;
  source?: string;
};

interface GraphNode {
  lat: number;
  lng: number;
  /** Indices into PathGraph.edges. */
  edges: number[];
}

interface GraphEdge {
  a: number;
  b: number;
  /** Haversine length in metres. */
  length: number;
  /** Routing weight: length × class multiplier. */
  cost: number;
  highway: string;
}

export interface PathGraphStats {
  ways: number;
  nodes: number;
  edges: number;
  skippedWays: number;
}

export interface PathGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  grid: Map<string, number[]>;
  stats: PathGraphStats;
}

export interface SnapResult {
  /** Closest point on the network. */
  point: LatLng;
  edge: number;
  /** Position along the edge, 0 = node a, 1 = node b. */
  t: number;
  /** Straight-line metres from the query point to `point`. */
  distanceMetres: number;
}

export interface RouteResult {
  /** [lat, lng] pairs from the origin, via the network, to the destination. */
  coordinates: LatLng[];
  /** Total walked metres, including the short off-network legs at each end. */
  distanceMetres: number;
  /** distanceMetres / WALKING_SPEED_MPS, in minutes (not rounded). */
  walkingMinutes: number;
  /** Metres from the origin to the network; large values mean the fix was off-path. */
  startSnapMetres: number;
  /** Metres from the network to the destination point. */
  endSnapMetres: number;
}

export interface RouteOptions {
  /** Points further than this from any path report no route. Default 150 m. */
  maxSnapMetres?: number;
}

export const WALKING_SPEED_MPS = 1.3;
export const DEFAULT_MAX_SNAP_METRES = 150;

const EARTH_RADIUS_M = 6371008.8;
const TO_RAD = Math.PI / 180;
/** Grid cell size in degrees (~111 m north–south, ~66 m east–west at Dublin). */
const CELL_DEG = 0.001;
const LON_METRES_PER_DEG_AT_DUBLIN = 111320 * Math.cos(53.38 * TO_RAD);
const CELL_MIN_METRES = CELL_DEG * LON_METRES_PER_DEG_AT_DUBLIN;

/** Multiplier applied to edge length to form the routing cost. */
const CLASS_MULTIPLIER: Record<string, number> = {
  footway: 1,
  path: 1,
  pedestrian: 1,
  corridor: 1,
  cycleway: 1.05,
  living_street: 1.1,
  service: 1.15,
  residential: 1.2,
  unclassified: 1.2,
  tertiary: 1.3,
  tertiary_link: 1.3,
  secondary: 1.5,
  secondary_link: 1.5,
  primary: 1.5,
  primary_link: 1.5,
  trunk: 1.6,
  trunk_link: 1.6,
  steps: 1.4,
};
const DEFAULT_MULTIPLIER = 1.3;
const PRIVATE_ACCESS_MULTIPLIER = 1.5;

export function haversineMetres(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * TO_RAD;
  const dLng = (b[1] - a[1]) * TO_RAD;
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * TO_RAD) * Math.cos(b[0] * TO_RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

function nodeKey(lng: number, lat: number): string {
  return `${lng.toFixed(6)},${lat.toFixed(6)}`;
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function cellOf(value: number): number {
  return Math.floor(value / CELL_DEG);
}

function wayMultiplier(props: PathFeatureProperties): number | null {
  if (props.foot === 'no') return null;
  let multiplier = CLASS_MULTIPLIER[props.highway] ?? DEFAULT_MULTIPLIER;
  const footAllowed = props.foot === 'yes' || props.foot === 'designated' || props.foot === 'permissive';
  if ((props.access === 'private' || props.access === 'no') && !footAllowed) {
    multiplier *= PRIVATE_ACCESS_MULTIPLIER;
  }
  return multiplier;
}

/** Builds the routing graph. Call once and reuse; it takes a few milliseconds for ~10k nodes. */
export function buildPathGraph(collection: PathFeatureCollection): PathGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const grid = new Map<string, number[]>();
  const nodeIndex = new Map<string, number>();
  let ways = 0;
  let skippedWays = 0;

  const nodeFor = (position: Position): number => {
    const [lng, lat] = position;
    const key = nodeKey(lng, lat);
    let index = nodeIndex.get(key);
    if (index === undefined) {
      index = nodes.length;
      nodes.push({ lat, lng, edges: [] });
      nodeIndex.set(key, index);
    }
    return index;
  };

  const register = (edgeIndex: number, a: GraphNode, b: GraphNode) => {
    const x0 = Math.min(cellOf(a.lng), cellOf(b.lng));
    const x1 = Math.max(cellOf(a.lng), cellOf(b.lng));
    const y0 = Math.min(cellOf(a.lat), cellOf(b.lat));
    const y1 = Math.max(cellOf(a.lat), cellOf(b.lat));
    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        const key = cellKey(cx, cy);
        const list = grid.get(key);
        if (list) list.push(edgeIndex);
        else grid.set(key, [edgeIndex]);
      }
    }
  };

  for (const feature of collection.features) {
    if (feature.geometry?.type !== 'LineString') continue;
    const multiplier = wayMultiplier(feature.properties);
    if (multiplier === null) {
      skippedWays += 1;
      continue;
    }
    const coords = feature.geometry.coordinates;
    if (coords.length < 2) {
      skippedWays += 1;
      continue;
    }
    ways += 1;
    let previous = nodeFor(coords[0]);
    for (let i = 1; i < coords.length; i += 1) {
      const current = nodeFor(coords[i]);
      if (current === previous) continue;
      const a = nodes[previous];
      const b = nodes[current];
      const length = haversineMetres([a.lat, a.lng], [b.lat, b.lng]);
      const edgeIndex = edges.length;
      edges.push({ a: previous, b: current, length, cost: length * multiplier, highway: feature.properties.highway });
      a.edges.push(edgeIndex);
      b.edges.push(edgeIndex);
      register(edgeIndex, a, b);
      previous = current;
    }
  }

  return { nodes, edges, grid, stats: { ways, nodes: nodes.length, edges: edges.length, skippedWays } };
}

/** Projects `point` onto edge `edge`; returns the parameter t in [0, 1] and the projected point. */
function projectOntoEdge(graph: PathGraph, edgeIndex: number, point: LatLng): { t: number; point: LatLng } {
  const edge = graph.edges[edgeIndex];
  const a = graph.nodes[edge.a];
  const b = graph.nodes[edge.b];
  // Local equirectangular frame centred on node a (segments are short, so this is accurate).
  const kx = 111320 * Math.cos(a.lat * TO_RAD);
  const ky = 110540;
  const bx = (b.lng - a.lng) * kx;
  const by = (b.lat - a.lat) * ky;
  const px = (point[1] - a.lng) * kx;
  const py = (point[0] - a.lat) * ky;
  const lengthSq = bx * bx + by * by;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq));
  return { t, point: [a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t] };
}

/** Finds the nearest point on the path network, or null if nothing is within `maxSnapMetres`. */
export function snapToNetwork(
  graph: PathGraph,
  point: LatLng,
  maxSnapMetres: number = DEFAULT_MAX_SNAP_METRES,
): SnapResult | null {
  const cx = cellOf(point[1]);
  const cy = cellOf(point[0]);
  const rings = Math.ceil(maxSnapMetres / CELL_MIN_METRES);
  const seen = new Set<number>();
  let best: SnapResult | null = null;
  for (let dx = -rings; dx <= rings; dx += 1) {
    for (let dy = -rings; dy <= rings; dy += 1) {
      const candidates = graph.grid.get(cellKey(cx + dx, cy + dy));
      if (!candidates) continue;
      for (const edgeIndex of candidates) {
        if (seen.has(edgeIndex)) continue;
        seen.add(edgeIndex);
        const projected = projectOntoEdge(graph, edgeIndex, point);
        const distance = haversineMetres(point, projected.point);
        if (distance <= maxSnapMetres && (best === null || distance < best.distanceMetres)) {
          best = { point: projected.point, edge: edgeIndex, t: projected.t, distanceMetres: distance };
        }
      }
    }
  }
  return best;
}

/** Minimal binary min-heap keyed on f-score. */
class MinHeap {
  private items: { id: number; f: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(id: number, f: number): void {
    const items = this.items;
    items.push({ id, f });
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent].f <= items[i].f) break;
      [items[parent], items[i]] = [items[i], items[parent]];
      i = parent;
    }
  }

  pop(): { id: number; f: number } | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && items[left].f < items[smallest].f) smallest = left;
        if (right < items.length && items[right].f < items[smallest].f) smallest = right;
        if (smallest === i) break;
        [items[smallest], items[i]] = [items[i], items[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function pathDistance(coordinates: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < coordinates.length; i += 1) total += haversineMetres(coordinates[i - 1], coordinates[i]);
  return total;
}

function finish(coordinates: LatLng[], start: SnapResult, end: SnapResult): RouteResult {
  const distanceMetres = pathDistance(coordinates);
  return {
    coordinates,
    distanceMetres,
    walkingMinutes: distanceMetres / WALKING_SPEED_MPS / 60,
    startSnapMetres: start.distanceMetres,
    endSnapMetres: end.distanceMetres,
  };
}

/**
 * A* over the path network between two arbitrary points. Both points are
 * snapped to their nearest edge (the edge is split at the projection) and the
 * returned coordinates start at `from` and finish at `to`.
 */
export function findRoute(graph: PathGraph, from: LatLng, to: LatLng, options: RouteOptions = {}): RouteResult | null {
  const maxSnap = options.maxSnapMetres ?? DEFAULT_MAX_SNAP_METRES;
  const start = snapToNetwork(graph, from, maxSnap);
  const end = snapToNetwork(graph, to, maxSnap);
  if (!start || !end) return null;

  if (start.edge === end.edge) {
    return finish([from, start.point, end.point, to], start, end);
  }

  const n = graph.nodes.length;
  const START = n;
  const GOAL = n + 1;
  const startEdge = graph.edges[start.edge];
  const endEdge = graph.edges[end.edge];

  const positionOf = (id: number): LatLng => {
    if (id === START) return start.point;
    if (id === GOAL) return end.point;
    const node = graph.nodes[id];
    return [node.lat, node.lng];
  };
  const heuristic = (id: number): number => haversineMetres(positionOf(id), end.point);

  const g = new Float64Array(n + 2).fill(Infinity);
  const cameFrom = new Int32Array(n + 2).fill(-1);
  const closed = new Uint8Array(n + 2);
  const open = new MinHeap();
  g[START] = 0;
  open.push(START, heuristic(START));

  const relax = (fromId: number, toId: number, cost: number) => {
    const tentative = g[fromId] + cost;
    if (tentative < g[toId]) {
      g[toId] = tentative;
      cameFrom[toId] = fromId;
      open.push(toId, tentative + heuristic(toId));
    }
  };

  while (open.size > 0) {
    const { id } = open.pop()!;
    if (closed[id]) continue;
    if (id === GOAL) break;
    closed[id] = 1;

    if (id === START) {
      relax(START, startEdge.a, start.t * startEdge.cost);
      relax(START, startEdge.b, (1 - start.t) * startEdge.cost);
      continue;
    }

    const node = graph.nodes[id];
    for (const edgeIndex of node.edges) {
      const edge = graph.edges[edgeIndex];
      relax(id, edge.a === id ? edge.b : edge.a, edge.cost);
    }
    if (id === endEdge.a) relax(id, GOAL, end.t * endEdge.cost);
    if (id === endEdge.b) relax(id, GOAL, (1 - end.t) * endEdge.cost);
  }

  if (g[GOAL] === Infinity) return null;

  const coordinates: LatLng[] = [to];
  for (let id = GOAL; id !== -1; id = cameFrom[id]) coordinates.push(positionOf(id));
  coordinates.push(from);
  coordinates.reverse();
  return finish(coordinates, start, end);
}

/**
 * Picks the destination point for a building: among its footprint vertices and
 * its pin, the point nearest to the path network. Returns null when the
 * building has no position at all.
 */
export function buildingRouteTarget(graph: PathGraph, match: FootprintMatch, options: RouteOptions = {}): LatLng | null {
  const maxSnap = options.maxSnapMetres ?? DEFAULT_MAX_SNAP_METRES;
  const candidates: LatLng[] = [];
  for (const feature of match.features) {
    const { geometry } = feature;
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const rings of polygons) {
      const outer = rings[0] ?? [];
      for (const [lng, lat] of outer) candidates.push([lat, lng]);
    }
  }
  if (match.position) candidates.push(match.position);
  if (candidates.length === 0) return null;

  let best: { point: LatLng; distance: number } | null = null;
  for (const candidate of candidates) {
    const snap = snapToNetwork(graph, candidate, maxSnap);
    if (snap && (best === null || snap.distanceMetres < best.distance)) {
      best = { point: candidate, distance: snap.distanceMetres };
    }
  }
  // Fall back to the pin so callers still get a sensible "no route" rather than nothing to try.
  return best?.point ?? match.position;
}

/** Routes from an arbitrary point to the building's footprint (or pin when no footprint matched). */
export function routeToBuilding(
  graph: PathGraph,
  from: LatLng,
  match: FootprintMatch,
  options: RouteOptions = {},
): RouteResult | null {
  const target = buildingRouteTarget(graph, match, options);
  if (!target) return null;
  return findRoute(graph, from, target, options);
}

export function formatDistance(metres: number): string {
  if (metres < 950) return `${Math.round(metres / 10) * 10} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

export function formatMinutes(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  return `about ${rounded} min`;
}

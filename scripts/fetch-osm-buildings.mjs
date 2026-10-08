#!/usr/bin/env node
/**
 * Fetches DCU building footprints from OpenStreetMap and writes them to
 * src/data/campus-buildings.geojson.
 *
 * Rerun with:  node scripts/fetch-osm-buildings.mjs
 *
 * Data: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)
 *
 * Sources, in order:
 *   1. Overpass API (nwr["building"] + amenity=university inside the campus bboxes)
 *   2. OSM API 0.6 /map.json per bbox (used automatically when Overpass is down)
 * Transport: Node's native fetch, then curl.exe, then PowerShell Invoke-WebRequest.
 * TLS verification is never disabled.
 *
 * Output: buildings whose centroid lies inside a DCU campus polygon
 * (amenity=university operated by Dublin City University), plus any OSM way
 * referenced in src/data/buildings.json. The campus outlines themselves are
 * included as features with properties.kind === "campus".
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '../src/data/campus-buildings.geojson');
const BUILDINGS_JSON = resolve(__dirname, '../src/data/buildings.json');
const USER_AGENT = 'dcu-campus-navigator/0.1 (student hackathon prototype; scripts/fetch-osm-buildings.mjs)';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSM_API = 'https://api.openstreetmap.org/api/0.6';

// Bounding boxes: [south, west, north, east]
const CAMPUS_BBOXES = {
  glasnevin: [53.3825, -6.2635, 53.3885, -6.2505],
  // St Patrick's (Drumcondra) and All Hallows are adjacent; one box covers both.
  drumcondra: [53.3685, -6.2575, 53.3755, -6.2475],
};

// ---------- transport ----------

async function viaFetch(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      'User-Agent': USER_AGENT,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function viaCurl(url, { body } = {}) {
  const args = ['-sS', '-f', '-m', '120', '-A', USER_AGENT];
  let tmp = null;
  if (body) {
    tmp = join(tmpdir(), `osm-${process.pid}-${Date.now()}.txt`);
    writeFileSync(tmp, body);
    args.push('--data-binary', `@${tmp}`);
  }
  args.push(url);
  try {
    const r = spawnSync('curl.exe', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(r.stderr.trim() || `curl exit ${r.status}`);
    return r.stdout;
  } finally {
    if (tmp) { try { unlinkSync(tmp); } catch { /* ignore */ } }
  }
}

function viaPowerShell(url, { body } = {}) {
  const ps1 = join(tmpdir(), `osm-${process.pid}-${Date.now()}.ps1`);
  const out = `${ps1}.out`;
  const lines = [
    '$ProgressPreference = "SilentlyContinue"',
    body
      ? `$body = [System.IO.File]::ReadAllText("${ps1}.body")`
      : '',
    body
      ? `Invoke-WebRequest -UseBasicParsing -UserAgent "${USER_AGENT}" -Method Post -Uri "${url}" -ContentType "application/x-www-form-urlencoded" -Body $body -OutFile "${out}"`
      : `Invoke-WebRequest -UseBasicParsing -UserAgent "${USER_AGENT}" -Uri "${url}" -OutFile "${out}"`,
  ];
  writeFileSync(ps1, lines.join('\n'));
  if (body) writeFileSync(`${ps1}.body`, body);
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf8' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(r.stderr.trim() || `powershell exit ${r.status}`);
    return readFileSync(out, 'utf8');
  } finally {
    for (const f of [ps1, `${ps1}.body`, out]) { try { unlinkSync(f); } catch { /* ignore */ } }
  }
}

const TRANSPORTS = [['fetch', viaFetch], ['curl', viaCurl], ['powershell', viaPowerShell]];

async function getJson(url, options, errors) {
  for (const [name, fn] of TRANSPORTS) {
    try {
      const text = await fn(url, options);
      const json = JSON.parse(text);
      if (!Array.isArray(json.elements)) throw new Error('no elements array in response');
      return json.elements;
    } catch (err) {
      errors.push(`${name} ${url}: ${err.message}`);
    }
  }
  return null;
}

// ---------- sources ----------

function referencedWayIds() {
  try {
    const buildings = JSON.parse(readFileSync(BUILDINGS_JSON, 'utf8'));
    const ids = new Set();
    for (const b of buildings) {
      const text = `${b.coordinateSource ?? ''} ${(b.sourceUrls ?? []).join(' ')}`;
      for (const m of text.matchAll(/way[/ ](\d+)/g)) ids.add(Number(m[1]));
    }
    return [...ids];
  } catch {
    return [];
  }
}

function overpassQuery(wayIds) {
  const clauses = Object.values(CAMPUS_BBOXES).flatMap((b) => [
    `  nwr["building"](${b.join(',')});`,
    `  nwr["amenity"="university"](${b.join(',')});`,
  ]);
  if (wayIds.length) clauses.push(`  way(id:${wayIds.join(',')});`);
  return `[out:json][timeout:90];\n(\n${clauses.join('\n')}\n);\n(._;>;);\nout body;`;
}

async function fromOverpass(wayIds, errors) {
  const body = `data=${encodeURIComponent(overpassQuery(wayIds))}`;
  for (const url of OVERPASS_ENDPOINTS) {
    process.stderr.write(`Overpass: ${url}\n`);
    const elements = await getJson(url, { method: 'POST', body }, errors);
    if (elements) return elements;
  }
  return null;
}

async function fromOsmApi(wayIds, errors) {
  const all = [];
  for (const [name, [s, w, n, e]] of Object.entries(CAMPUS_BBOXES)) {
    const url = `${OSM_API}/map.json?bbox=${w},${s},${e},${n}`;
    process.stderr.write(`OSM API map (${name}): ${url}\n`);
    const elements = await getJson(url, {}, errors);
    if (!elements) return null;
    all.push(...elements);
  }
  // Campus relations (multipolygons) may have member ways outside the bbox.
  const relationIds = all
    .filter((el) => el.type === 'relation' && el.tags?.amenity === 'university')
    .map((el) => el.id);
  for (const id of relationIds) {
    const url = `${OSM_API}/relation/${id}/full.json`;
    process.stderr.write(`OSM API relation: ${url}\n`);
    const elements = await getJson(url, {}, errors);
    if (elements) all.push(...elements);
  }
  const have = new Set(all.filter((el) => el.type === 'way').map((el) => el.id));
  const missing = wayIds.filter((id) => !have.has(id));
  if (missing.length) {
    const url = `${OSM_API}/ways.json?ways=${missing.join(',')}`;
    process.stderr.write(`OSM API ways: ${url}\n`);
    const ways = await getJson(url, {}, errors);
    if (ways) {
      all.push(...ways);
      const nodeIds = [...new Set(ways.flatMap((w) => w.nodes ?? []))];
      for (let i = 0; i < nodeIds.length; i += 500) {
        const chunk = nodeIds.slice(i, i + 500);
        const nodes = await getJson(`${OSM_API}/nodes.json?nodes=${chunk.join(',')}`, {}, errors);
        if (nodes) all.push(...nodes);
      }
    }
  }
  return all;
}

// ---------- geometry ----------

function closeRing(ring) {
  if (ring.length === 0) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, ring[0]];
}

function centroid(ring) {
  // Area-weighted centroid of a closed ring; falls back to vertex mean for degenerate rings.
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-14) {
    const n = ring.length - 1 || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  area *= 0.5;
  return [cx / (6 * area), cy / (6 * area)];
}

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygons(point, polygons) {
  // polygons: array of [outer, ...inners]
  return polygons.some(([outer, ...inners]) => pointInRing(point, outer) && !inners.some((r) => pointInRing(point, r)));
}

/** Join way segments into closed rings (for multipolygon relations). */
function assembleRings(segments) {
  const pending = segments.map((s) => [...s]);
  const rings = [];
  while (pending.length) {
    let ring = pending.shift();
    let extended = true;
    while (extended && (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1])) {
      extended = false;
      const tail = ring[ring.length - 1];
      for (let i = 0; i < pending.length; i += 1) {
        const seg = pending[i];
        const head = seg[0];
        const end = seg[seg.length - 1];
        if (head[0] === tail[0] && head[1] === tail[1]) {
          ring = ring.concat(seg.slice(1));
        } else if (end[0] === tail[0] && end[1] === tail[1]) {
          ring = ring.concat(seg.slice(0, -1).reverse());
        } else {
          continue;
        }
        pending.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4) rings.push(closeRing(ring));
  }
  return rings;
}

function buildGeometryIndex(elements) {
  const nodes = new Map();
  const ways = new Map();
  const relations = new Map();
  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way') ways.set(el.id, el);
    else if (el.type === 'relation') relations.set(el.id, el);
  }

  const wayRing = (id) => {
    const way = ways.get(id);
    if (!way?.nodes) return null;
    const coords = [];
    for (const nid of way.nodes) {
      const n = nodes.get(nid);
      if (!n) return null; // incomplete way
      coords.push([n.lon, n.lat]);
    }
    return coords;
  };

  /** Returns array of polygons ([outer, ...inners]) or null. */
  const polygonsOf = (el) => {
    if (el.type === 'way') {
      const ring = wayRing(el.id);
      if (!ring || ring.length < 4) return null;
      return [[closeRing(ring)]];
    }
    if (el.type === 'relation') {
      const outerSegs = [];
      const innerSegs = [];
      for (const m of el.members ?? []) {
        if (m.type !== 'way') continue;
        const ring = wayRing(m.ref);
        if (!ring) continue;
        (m.role === 'inner' ? innerSegs : outerSegs).push(ring);
      }
      const outers = assembleRings(outerSegs);
      const inners = assembleRings(innerSegs);
      if (!outers.length) return null;
      return outers.map((outer) => [outer, ...inners.filter((inner) => pointInRing(inner[0], outer))]);
    }
    return null;
  };

  return { ways, relations, polygonsOf };
}

// ---------- main ----------

function campusKey(tags) {
  const name = `${tags.name ?? ''}`.toLowerCase();
  if (name.includes('glasnevin')) return 'glasnevin';
  if (name.includes('patrick')) return 'stpatricks';
  if (name.includes('all hallows')) return 'allhallows';
  return 'other';
}

function isDcuCampus(tags) {
  if (!tags || tags.amenity !== 'university') return false;
  const haystack = `${tags.name ?? ''} ${tags.operator ?? ''} ${tags.alt_name ?? ''}`.toLowerCase();
  return haystack.includes('dublin city university') || /\bdcu\b/.test(haystack);
}

function featureProperties(el, extra) {
  const tags = el.tags ?? {};
  return {
    osmType: el.type,
    osmId: el.id,
    name: tags.name ?? tags['addr:housename'] ?? null,
    ref: tags.ref ?? null,
    building: tags.building ?? null,
    levels: tags['building:levels'] ?? null,
    note: tags.note ?? tags.description ?? null,
    ...extra,
  };
}

function toGeometry(polygons) {
  return polygons.length === 1
    ? { type: 'Polygon', coordinates: polygons[0] }
    : { type: 'MultiPolygon', coordinates: polygons };
}

async function main() {
  const wayIds = referencedWayIds();
  const errors = [];
  let elements = await fromOverpass(wayIds, errors);
  let source = 'Overpass API';
  if (!elements) {
    process.stderr.write('Overpass unavailable, falling back to OSM API 0.6\n');
    elements = await fromOsmApi(wayIds, errors);
    source = 'OSM API 0.6 map.json';
  }
  if (!elements) {
    throw new Error(`All download attempts failed:\n${errors.join('\n')}`);
  }

  const { ways, relations, polygonsOf } = buildGeometryIndex(elements);
  const candidates = [...ways.values(), ...relations.values()];

  // Campus outlines
  const campuses = [];
  for (const el of candidates) {
    if (!isDcuCampus(el.tags)) continue;
    const polygons = polygonsOf(el);
    if (!polygons) continue;
    campuses.push({ el, polygons, campus: campusKey(el.tags) });
  }
  if (!campuses.length) {
    process.stderr.write('Warning: no DCU campus polygon found; keeping every building in the bounding boxes.\n');
  }

  const referenced = new Set(wayIds);
  const features = [];
  const seen = new Set();

  for (const { el, polygons, campus } of campuses) {
    features.push({
      type: 'Feature',
      id: `${el.type}/${el.id}`,
      properties: featureProperties(el, { kind: 'campus', campus }),
      geometry: toGeometry(polygons),
    });
    seen.add(`${el.type}/${el.id}`);
  }

  for (const el of candidates) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key) || !el.tags?.building || el.tags.building === 'no') continue;
    const polygons = polygonsOf(el);
    if (!polygons) continue;
    const [lon, lat] = centroid(polygons[0][0]);
    const campus = campuses.find((c) => pointInPolygons([lon, lat], c.polygons));
    const isReferenced = el.type === 'way' && referenced.has(el.id);
    if (!campus && campuses.length && !isReferenced) continue;
    seen.add(key);
    features.push({
      type: 'Feature',
      id: key,
      properties: featureProperties(el, {
        kind: 'building',
        campus: campus?.campus ?? 'other',
        centroid: [Number(lat.toFixed(7)), Number(lon.toFixed(7))],
      }),
      geometry: toGeometry(polygons),
    });
  }

  features.sort((a, b) => {
    if (a.properties.kind !== b.properties.kind) return a.properties.kind === 'campus' ? -1 : 1;
    return String(a.id).localeCompare(String(b.id));
  });

  const collection = {
    type: 'FeatureCollection',
    attribution: '© OpenStreetMap contributors, ODbL 1.0 — https://www.openstreetmap.org/copyright',
    generated: new Date().toISOString(),
    source,
    bboxes: CAMPUS_BBOXES,
    features,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, `${JSON.stringify(collection)}\n`);

  const buildings = features.filter((f) => f.properties.kind === 'building');
  const named = buildings.filter((f) => f.properties.name || f.properties.ref).length;
  const missingRefs = wayIds.filter((id) => !seen.has(`way/${id}`));
  console.log(`Source: ${source}`);
  console.log(`Wrote ${campuses.length} campus outlines and ${buildings.length} building footprints (${named} with name/ref) to ${OUTPUT}`);
  if (missingRefs.length) console.log(`Referenced ways not found: ${missingRefs.join(', ')}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

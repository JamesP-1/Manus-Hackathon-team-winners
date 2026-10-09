#!/usr/bin/env node
/**
 * Fetches the walkable path network around the DCU campuses from OpenStreetMap
 * and writes it to src/data/campus-paths.geojson for client-side routing.
 *
 * Rerun with:  node scripts/fetch-osm-paths.mjs
 *
 * Data: © OpenStreetMap contributors, ODbL 1.0 (https://www.openstreetmap.org/copyright)
 *
 * Sources, in order:
 *   1. Overpass API (ways tagged highway=<walkable class> inside one bbox that
 *      covers Glasnevin, St Patrick's/Drumcondra, All Hallows and the streets
 *      between them)
 *   2. OSM API 0.6 /map.json per sub-bbox (used automatically when Overpass is down;
 *      the bbox is split so each request stays under the API's node limit)
 * Transport: Node's native fetch, then curl.exe, then PowerShell Invoke-WebRequest.
 * TLS verification is never disabled.
 *
 * Output: one LineString feature per OSM way with a small set of tags
 * (highway, name, foot, access) so the file stays well under 1.5 MB. Node ids
 * are not kept; src/lib/routing.ts joins ways where their coordinates are equal.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '../src/data/campus-paths.geojson');
const USER_AGENT = 'dcumaps/0.1 (student hackathon prototype; scripts/fetch-osm-paths.mjs)';
const ATTRIBUTION = '© OpenStreetMap contributors, ODbL 1.0';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const OSM_API = 'https://api.openstreetmap.org/api/0.6';

// One generous box: [south, west, north, east]. Glasnevin sits in the north-west
// corner, St Patrick's and All Hallows in the south-east, with Drumcondra Road /
// Collins Avenue / Griffith Avenue between them so cross-campus routes connect.
const BBOX = [53.366, -6.268, 53.391, -6.244];

// trunk is included because the N1 (Swords Road / Drumcondra Road), the direct
// street between Glasnevin and Drumcondra, is tagged highway=trunk in OSM.
// Routing penalises these heavily; pedestrians still use their footpaths.
const HIGHWAY_CLASSES = [
  'footway', 'path', 'pedestrian', 'steps', 'cycleway', 'service', 'residential',
  'living_street', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk',
  'tertiary_link', 'secondary_link', 'primary_link', 'trunk_link', 'corridor',
];
const HIGHWAY_SET = new Set(HIGHWAY_CLASSES);
const KEPT_TAGS = ['highway', 'name', 'foot', 'access'];
const COORD_DECIMALS = 6; // ~0.1 m; also what joins shared endpoints in routing.ts

// ---------- transport (same approach as fetch-osm-buildings.mjs) ----------

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
  const args = ['-sS', '-f', '-m', '180', '-A', USER_AGENT];
  let tmp = null;
  if (body) {
    tmp = join(tmpdir(), `osm-paths-${process.pid}-${Date.now()}.txt`);
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
  const ps1 = join(tmpdir(), `osm-paths-${process.pid}-${Date.now()}.ps1`);
  const out = `${ps1}.out`;
  const lines = [
    '$ProgressPreference = "SilentlyContinue"',
    body ? `$body = [System.IO.File]::ReadAllText("${ps1}.body")` : '',
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

function overpassQuery() {
  const regex = `^(${HIGHWAY_CLASSES.join('|')})$`;
  return `[out:json][timeout:120];\nway["highway"~"${regex}"](${BBOX.join(',')});\n(._;>;);\nout body;`;
}

async function fromOverpass(errors) {
  const body = `data=${encodeURIComponent(overpassQuery())}`;
  for (const url of OVERPASS_ENDPOINTS) {
    process.stderr.write(`Overpass: ${url}\n`);
    const elements = await getJson(url, { method: 'POST', body }, errors);
    if (elements) return elements;
  }
  return null;
}

/** Splits BBOX into a grid so each /map.json call stays below the 50 000-node limit. */
function subBoxes(rows, cols) {
  const [s, w, n, e] = BBOX;
  const boxes = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      boxes.push([
        s + ((n - s) * r) / rows,
        w + ((e - w) * c) / cols,
        s + ((n - s) * (r + 1)) / rows,
        w + ((e - w) * (c + 1)) / cols,
      ]);
    }
  }
  return boxes;
}

async function fromOsmApi(errors) {
  const all = [];
  for (const [s, w, n, e] of subBoxes(4, 4)) {
    const url = `${OSM_API}/map.json?bbox=${w.toFixed(4)},${s.toFixed(4)},${e.toFixed(4)},${n.toFixed(4)}`;
    process.stderr.write(`OSM API map: ${url}\n`);
    const elements = await getJson(url, {}, errors);
    if (!elements) return null;
    all.push(...elements);
  }
  return all;
}

// ---------- main ----------

function round(value) {
  return Number(value.toFixed(COORD_DECIMALS));
}

function walkable(tags) {
  if (!tags || !HIGHWAY_SET.has(tags.highway)) return false;
  if (tags.area === 'yes') return false; // pedestrian areas are polygons, not centre lines
  return true;
}

async function main() {
  const errors = [];
  let elements = await fromOverpass(errors);
  let source = 'Overpass API';
  if (!elements) {
    process.stderr.write('Overpass unavailable, falling back to OSM API 0.6\n');
    elements = await fromOsmApi(errors);
    source = 'OSM API 0.6 map.json';
  }
  if (!elements) {
    throw new Error(`All download attempts failed:\n${errors.join('\n')}`);
  }

  const nodes = new Map();
  const ways = new Map();
  for (const el of elements) {
    if (el.type === 'node') nodes.set(el.id, el);
    else if (el.type === 'way' && walkable(el.tags)) ways.set(el.id, el);
  }

  const features = [];
  const usedNodes = new Set();
  let incomplete = 0;
  for (const way of [...ways.values()].sort((a, b) => a.id - b.id)) {
    const coords = [];
    for (const nid of way.nodes ?? []) {
      const n = nodes.get(nid);
      if (!n) continue; // node outside the bbox; keep the rest of the way
      coords.push([round(n.lon), round(n.lat)]);
      usedNodes.add(nid);
    }
    if (coords.length < 2) {
      incomplete += 1;
      continue;
    }
    const properties = { osmId: way.id, attribution: ATTRIBUTION };
    for (const key of KEPT_TAGS) {
      if (way.tags[key] !== undefined) properties[key] = way.tags[key];
    }
    features.push({
      type: 'Feature',
      id: `way/${way.id}`,
      properties,
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  const collection = {
    type: 'FeatureCollection',
    attribution: `${ATTRIBUTION} — https://www.openstreetmap.org/copyright`,
    generated: new Date().toISOString(),
    source,
    bbox: BBOX,
    highwayClasses: HIGHWAY_CLASSES,
    features,
  };

  mkdirSync(dirname(OUTPUT), { recursive: true });
  const text = `${JSON.stringify(collection)}\n`;
  writeFileSync(OUTPUT, text);

  const byClass = {};
  for (const f of features) byClass[f.properties.highway] = (byClass[f.properties.highway] ?? 0) + 1;
  console.log(`Source: ${source}`);
  console.log(`Wrote ${features.length} ways / ${usedNodes.size} nodes (${(Buffer.byteLength(text) / 1024).toFixed(0)} KB) to ${OUTPUT}`);
  console.log(`By class: ${Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (incomplete) console.log(`Skipped ${incomplete} ways with fewer than two nodes inside the bbox`);
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});

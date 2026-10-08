#!/usr/bin/env node
/**
 * Collect public, official DCU room-location records for the campus navigator.
 *
 * No authenticated timetable or booking system is accessed.  The primary
 * inventory is DCU's public Campus Explorer location table; supporting public
 * pages only add corroborating source URLs to records already listed there.
 *
 * Retrieval order for every request: native Node fetch, then `curl.exe`, then
 * PowerShell `Invoke-WebRequest`.  TLS verification is never disabled.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { load } from 'cheerio';

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scriptDir, '..');
const dataDir = path.join(root, 'src', 'data');
const workDir = path.join(root, '.work', 'campus-nav', 'room-data');
const rawDir = path.join(workDir, 'downloads');
const logDir = path.join(workDir, 'log');
const runLog = path.join(logDir, 'scrape-log.jsonl');

const USER_AGENT = 'DCUCampusNavigatorRoomData/1.0 (+local development; public DCU pages only)';
const TIMEOUT_MS = 15_000;
const CONCURRENCY = 3;
const CAMPUS_EXPLORER_URL = 'https://www.dcu.ie/CampusExplorer/poi-information';
const ROBOTS_URL = 'https://www.dcu.ie/robots.txt';

const sources = [
  { url: CAMPUS_EXPLORER_URL, kind: 'html', role: 'primary public room inventory (Campus Location Tables)' },
  { url: 'https://www.dcu.ie/campus-maps', kind: 'html', role: 'official building-code context' },
  { url: 'https://www.dcu.ie/timetables', kind: 'html', role: 'official location-code convention and timetable access boundary' },
  { url: 'https://www.dcu.ie/registry/room-booking-information-registry', kind: 'html', role: 'official room-booking context' },
  { url: 'https://www.dcu.ie/library/group-study-rooms', kind: 'html', role: 'public group-study-room corroboration' },
  { url: 'https://www.dcu.ie/sites/default/files/agency/docs/timetable_guide_v7.pdf', kind: 'pdf', role: 'public timetable guide corroboration' },
  { url: 'https://www.dcu.ie/CampusExplorer', kind: 'html', role: 'Campus Explorer landing page (checked for additional location tables)' },
  { url: 'https://www.dcu.ie/sites/default/files/2020-11/orientationfacilities.pdf', kind: 'pdf', role: 'public orientation facilities guide (checked for location codes)' },
];

function now() {
  return new Date().toISOString();
}

function safeFileStem(url) {
  const parsed = new URL(url);
  return `${parsed.hostname}${parsed.pathname}`.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').slice(0, 120);
}

async function appendLog(entry) {
  await writeFile(runLog, `${JSON.stringify({ at: now(), ...entry })}\n`, { flag: 'a' });
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

function userAgentRules(robotsText) {
  const sections = robotsText.replace(/\r/g, '').split(/\n\s*\n/);
  let wildcard = [];
  for (const section of sections) {
    const agents = [...section.matchAll(/^\s*User-agent:\s*(.+)\s*$/gim)].map((match) => match[1].trim().toLowerCase());
    if (!agents.includes('*')) continue;
    wildcard = [...section.matchAll(/^\s*Disallow:\s*(\S+)\s*$/gim)].map((match) => match[1]);
  }
  return wildcard;
}

function permittedByRobots(url, disallowRules) {
  const pathname = new URL(url).pathname;
  return !disallowRules.some((rule) => {
    if (!rule) return false;
    // Drupal-style rules may contain "*" and a trailing "$" anchor.
    const pattern = `^${rule.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}`;
    return new RegExp(pattern.endsWith('\\$') ? `${pattern.slice(0, -2)}$` : pattern).test(pathname);
  });
}

// ---------------------------------------------------------------------------
// Fetching: native fetch -> curl.exe -> PowerShell Invoke-WebRequest
// ---------------------------------------------------------------------------

async function fetchWithNode(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/pdf;q=0.9,*/*;q=0.1' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { bytes, contentType: response.headers.get('content-type') || '', finalUrl: response.url, status: response.status, transport: 'node-fetch' };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchWithCurl(url) {
  const tmp = path.join(os.tmpdir(), `dcu-rooms-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
  try {
    const { stdout } = await execFileAsync(
      'curl.exe',
      ['-sS', '-L', '--max-time', String(TIMEOUT_MS / 1000), '-A', USER_AGENT, '-o', tmp, '-w', '%{http_code}\n%{content_type}\n%{url_effective}', url],
      { timeout: TIMEOUT_MS + 2_000, windowsHide: true },
    );
    const [status, contentType, finalUrl] = stdout.trim().split(/\r?\n/).map((line) => line.trim());
    if (!/^2\d\d$/.test(status)) throw new Error(`HTTP ${status}`);
    const bytes = new Uint8Array(await readFile(tmp));
    return { bytes, contentType: contentType || '', finalUrl: finalUrl || url, status: Number(status), transport: 'curl.exe' };
  } finally {
    await rm(tmp, { force: true });
  }
}

async function fetchWithPowerShell(url) {
  const tmp = path.join(os.tmpdir(), `dcu-rooms-${process.pid}-${Math.random().toString(36).slice(2)}.bin`);
  const command = [
    '$ProgressPreference = "SilentlyContinue";',
    `$r = Invoke-WebRequest -Uri '${url.replace(/'/g, "''")}' -UserAgent '${USER_AGENT}' -TimeoutSec ${Math.round(TIMEOUT_MS / 1000)} -OutFile '${tmp.replace(/'/g, "''")}' -PassThru -UseBasicParsing;`,
    'Write-Output $r.StatusCode; Write-Output ([string]$r.Headers["Content-Type"]); Write-Output $r.BaseResponse.ResponseUri.AbsoluteUri',
  ].join(' ');
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: TIMEOUT_MS + 5_000, windowsHide: true },
    );
    const [status, contentType, finalUrl] = stdout.trim().split(/\r?\n/);
    if (!/^2\d\d$/.test(status)) throw new Error(`HTTP ${status}`);
    const bytes = new Uint8Array(await readFile(tmp));
    return { bytes, contentType: contentType || '', finalUrl: finalUrl || url, status: Number(status), transport: 'powershell-invoke-webrequest' };
  } finally {
    await rm(tmp, { force: true });
  }
}

async function fetchPublic(url, robotsRules) {
  if (robotsRules && !permittedByRobots(url, robotsRules)) {
    throw new Error(`Blocked by https://www.dcu.ie/robots.txt rule for ${new URL(url).pathname}`);
  }
  const attempts = [];
  for (const [name, transport] of [['node-fetch', fetchWithNode], ['curl.exe', fetchWithCurl], ['powershell-invoke-webrequest', fetchWithPowerShell]]) {
    try {
      const response = await transport(url);
      return { ...response, attempts };
    } catch (error) {
      const message = error instanceof Error ? `${error.message}${error.cause ? ` (${error.cause.code || error.cause.message})` : ''}` : String(error);
      attempts.push({ transport: name, error: message });
      // An HTTP error status is a server answer, not a transport failure: do not retry it elsewhere.
      if (/^HTTP \d{3}/.test(message)) break;
    }
  }
  const error = new Error(attempts.map((attempt) => `${attempt.transport}: ${attempt.error}`).join('; '));
  error.attempts = attempts;
  throw error;
}

// ---------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------

async function pdfToText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(' '));
  }
  return pages.join('\n');
}

function textFromHtml(html) {
  const $ = load(html);
  return $('body').text().replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Location-code decoding
// ---------------------------------------------------------------------------

function campusFromLabel(label) {
  const normalized = label.trim().toLowerCase();
  if (normalized.includes('glasnevin') || normalized === 'gla') return 'glasnevin';
  if (normalized.includes('patrick') || normalized === 'spd' || normalized === 'spc') return 'stpatricks';
  if (normalized.includes('hallows') || normalized === 'ahc') return 'allhallows';
  return null;
}

function campusFromPrefix(prefix) {
  return ({ GLA: 'glasnevin', SPD: 'stpatricks', SPC: 'stpatricks', AHC: 'allhallows' })[prefix] || null;
}

const floorLabels = { G: 'Ground', B: 'Basement' };

/**
 * Splits a bare location code (e.g. `CAG21`, `SB12-A`, `H1`) into its building
 * code, floor and room number using the longest building code documented for
 * that campus in buildings.json.  Returns null when no documented building
 * code is followed by a floor marker (G, B or a digit).
 */
function splitLocationCode(code, campus, buildingCodesByCampus) {
  const canonical = code.toUpperCase().replace(/\s+/g, '');
  const candidates = (buildingCodesByCampus[campus] || []).slice().sort((left, right) => right.length - left.length);
  const buildingCode = candidates.find((candidate) => canonical.startsWith(candidate) && /^(?:G|B|[0-9])/.test(canonical.slice(candidate.length)));
  if (!buildingCode) return null;
  const rest = canonical.slice(buildingCode.length);
  const floorMatch = /^(G|B|[0-9])(.*)$/.exec(rest);
  if (!floorMatch) return null;
  return { buildingCode, floor: floorLabels[floorMatch[1]] || floorMatch[1], roomNumber: floorMatch[2] || null };
}

/**
 * Expands one Campus Explorer "Room" cell into explicit location codes.
 * Observed forms: `GLA.L101`, `GLA.SB12.&.SB12-A` (two rooms listed together),
 * `GLA.AG42.(Pedagogy)` (annotation), `SPC.C100L-C.&.100L-D` (second code
 * inherits the building letter) and `GLA.Invent.Video.Conference` (no code).
 */
function expandRoomCell(cellText, buildingCodesByCampus) {
  const match = /^\s*(GLA|SPD|SPC|AHC)\.(.+?)\s*$/i.exec(cellText);
  if (!match) return { campus: null, locations: [], rejected: [cellText] };
  const campus = campusFromPrefix(match[1].toUpperCase());
  const locations = [];
  const rejected = [];
  let inheritedBuilding = null;
  for (const rawPart of match[2].toUpperCase().split(/\.?&\.?/)) {
    const part = rawPart.replace(/\.\(.*?\)\s*$/, '').replace(/\s+/g, '').replace(/^\.+|\.+$/g, '');
    if (!part) continue;
    let parsed = splitLocationCode(part, campus, buildingCodesByCampus);
    let code = part;
    if (!parsed && inheritedBuilding && /^(?:G|B|[0-9])/.test(part)) {
      code = `${inheritedBuilding}${part}`;
      parsed = splitLocationCode(code, campus, buildingCodesByCampus);
    }
    if (!parsed) {
      rejected.push(part);
      continue;
    }
    inheritedBuilding = parsed.buildingCode;
    locations.push({ campus, code, ...parsed });
  }
  return { campus, locations, rejected };
}

function locationFromQualifiedToken(value, buildingCodesByCampus) {
  const match = /\b(GLA|SPD|SPC|AHC)\.([A-Z0-9-]+)\b/i.exec(value);
  if (!match) return null;
  const campus = campusFromPrefix(match[1].toUpperCase());
  const code = match[2].toUpperCase();
  const parts = campus && splitLocationCode(code, campus, buildingCodesByCampus);
  if (!campus || !parts) return null;
  return { campus, code, ...parts };
}

function makeRoom(location, sourceUrl) {
  return {
    id: `${location.campus}-${location.code}`,
    code: location.code,
    buildingId: `${location.campus}-${location.buildingCode}`,
    campus: location.campus,
    floor: location.floor,
    roomNumber: location.roomNumber,
    sourceUrls: [sourceUrl],
    evidence: 'listed',
  };
}

function addRoom(rooms, room) {
  const prior = rooms.get(room.id);
  if (!prior) {
    rooms.set(room.id, room);
    return true;
  }
  for (const url of room.sourceUrls) {
    if (!prior.sourceUrls.includes(url)) prior.sourceUrls.push(url);
  }
  return false;
}

function parseCampusExplorer(html, rooms, buildingCodesByCampus, buildingsById) {
  const $ = load(html);
  const report = { tableRows: 0, rowsWithoutCode: [], rejectedParts: [], campusMismatches: [], unknownBuildings: [], buildingNamesByBuildingId: {}, found: 0 };
  $('table').each((_, table) => {
    const header = $(table).find('tr').first().text().replace(/\s+/g, ' ').toLowerCase();
    if (!header.includes('campus') || !header.includes('room short name') || !header.includes('building name')) return;
    $(table).find('tr').slice(1).each((__, row) => {
      const cells = [];
      $(row).find('td, th').each((___, cell) => cells.push($(cell).text().replace(/\s+/g, ' ').trim()));
      report.tableRows += 1;
      // Official columns: On OCP, Icon, Campus, Room, Room Short Name, Location Name, Building Name, Map ID, Description, Campus Explorer Link.
      const roomCell = cells[3] || '';
      const cellCampus = campusFromLabel(cells[2] || '');
      const { campus, locations, rejected } = expandRoomCell(roomCell, buildingCodesByCampus);
      if (!campus) {
        report.rowsWithoutCode.push({ campus: cells[2] || '', room: roomCell, locationName: cells[5] || '', buildingName: cells[6] || '', mapId: cells[7] || '' });
        return;
      }
      for (const part of rejected) report.rejectedParts.push({ room: roomCell, part, buildingName: cells[6] || '', mapId: cells[7] || '' });
      if (campus !== cellCampus) {
        report.campusMismatches.push({ room: roomCell, campusCell: cells[2] || '' });
        return;
      }
      for (const location of locations) {
        const room = makeRoom(location, CAMPUS_EXPLORER_URL);
        if (!buildingsById.has(room.buildingId)) {
          report.unknownBuildings.push({ room: roomCell, buildingId: room.buildingId, buildingName: cells[6] || '', mapId: cells[7] || '' });
          continue;
        }
        const names = (report.buildingNamesByBuildingId[room.buildingId] ||= {});
        const label = `${cells[6] || '?'} [map ${cells[7] || '?'}]`;
        names[label] = (names[label] || 0) + 1;
        if (addRoom(rooms, room)) report.found += 1;
      }
    });
  });
  return report;
}

function findQualifiedLocations(text, buildingCodesByCampus) {
  const matches = text.match(/\b(?:GLA|SPD|SPC|AHC)\.[A-Z0-9-]+\b/gi) || [];
  return [...new Set(matches.map((token) => token.toUpperCase()))]
    .map((token) => locationFromQualifiedToken(token, buildingCodesByCampus))
    .filter(Boolean);
}

function addCorroboratingSources(text, sourceUrl, rooms, buildingCodesByCampus) {
  const linked = [];
  const unmatched = [];
  for (const location of findQualifiedLocations(text, buildingCodesByCampus)) {
    const existing = rooms.get(`${location.campus}-${location.code}`);
    if (!existing) {
      unmatched.push(`${location.campus}:${location.code}`);
      continue;
    }
    if (!existing.sourceUrls.includes(sourceUrl)) {
      existing.sourceUrls.push(sourceUrl);
      linked.push(existing.id);
    }
  }
  return { linked, unmatched };
}

async function runBounded(items, task) {
  const results = new Array(items.length);
  let index = 0;
  async function worker() {
    while (true) {
      const current = index;
      index += 1;
      if (current >= items.length) return;
      results[current] = await task(items[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(rawDir, { recursive: true }), mkdir(logDir, { recursive: true })]);
  await writeFile(runLog, '');

  const buildings = JSON.parse(await readFile(path.join(dataDir, 'buildings.json'), 'utf8'));
  const buildingsById = new Map(buildings.map((building) => [building.id, building]));
  const buildingCodesByCampus = {};
  for (const building of buildings) {
    (buildingCodesByCampus[building.campus] ||= []).push(building.code.toUpperCase().replace(/\s+/g, ''));
  }

  const pages = [];
  let robotsRules;
  try {
    const robotsResponse = await fetchPublic(ROBOTS_URL, null);
    const robotsText = new TextDecoder().decode(robotsResponse.bytes);
    robotsRules = userAgentRules(robotsText);
    await writeFile(path.join(rawDir, 'www_dcu_ie_robots.txt'), robotsText);
    await appendLog({ event: 'robots', status: 'ok', url: ROBOTS_URL, transport: robotsResponse.transport, failedAttempts: robotsResponse.attempts, disallowRules: robotsRules });
  } catch (error) {
    // A robots retrieval failure must not be treated as permission to crawl.
    const message = error instanceof Error ? error.message : String(error);
    await appendLog({ event: 'robots', status: 'failed', url: ROBOTS_URL, error: message });
    console.error(`robots.txt could not be retrieved (${message}); no DCU pages were requested and src/data was left unchanged.`);
    process.exitCode = 1;
    return;
  }

  const fetched = await runBounded(sources, async (source) => {
    try {
      const response = await fetchPublic(source.url, robotsRules);
      const isPdf = source.kind === 'pdf' || response.contentType.includes('pdf');
      const rawPath = path.join(rawDir, `${safeFileStem(source.url)}${isPdf ? '.pdf' : '.html'}`);
      await writeFile(rawPath, response.bytes);
      let text;
      let html = '';
      if (isPdf) {
        text = await pdfToText(response.bytes);
      } else {
        html = new TextDecoder().decode(response.bytes);
        text = textFromHtml(html);
      }
      await writeFile(`${rawPath}.txt`, text);
      await appendLog({ event: 'fetch', status: 'ok', url: source.url, finalUrl: response.finalUrl, httpStatus: response.status, transport: response.transport, failedAttempts: response.attempts, bytes: response.bytes.length, rawPath });
      return { source, ok: true, html, text, finalUrl: response.finalUrl, transport: response.transport };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendLog({ event: 'fetch', status: 'failed', url: source.url, error: message, attempts: error.attempts || [] });
      return { source, ok: false, error: message };
    }
  });

  const rooms = new Map();
  const primary = fetched.find((result) => result.source.url === CAMPUS_EXPLORER_URL);
  let primaryReport = null;
  if (primary?.ok) {
    primaryReport = parseCampusExplorer(primary.html, rooms, buildingCodesByCampus, buildingsById);
    await writeFile(path.join(logDir, 'campus-explorer-parse-report.json'), `${JSON.stringify(primaryReport, null, 2)}\n`);
    await appendLog({ event: 'parse', status: 'ok', url: CAMPUS_EXPLORER_URL, ...primaryReport, buildingNamesByBuildingId: undefined });
  }

  for (const result of fetched) {
    if (!result.ok) {
      pages.push({ url: result.source.url, status: 'failed', roomsFound: 0, note: `${result.source.role}: ${result.error}` });
      continue;
    }
    const redirected = result.finalUrl && new URL(result.finalUrl).hostname !== new URL(result.source.url).hostname ? ` Redirected to ${result.finalUrl}.` : '';
    if (result.source.url === CAMPUS_EXPLORER_URL) {
      const r = primaryReport;
      pages.push({
        url: result.source.url,
        status: 'ok',
        roomsFound: r.found,
        note: `${result.source.role}; parsed ${r.tableRows} table rows on a single page (no pagination or per-campus sub-pages were served). ${r.rowsWithoutCode.length} rows carry no location code (unnamed sports facilities and Morton Stadium) and ${r.rejectedParts.length} cell part(s) are not location codes; ${r.unknownBuildings.length} code(s) referenced a building absent from buildings.json. Details in .work/campus-nav/room-data/log/campus-explorer-parse-report.json.`,
        transport: result.transport,
      });
      continue;
    }
    const { linked, unmatched } = addCorroboratingSources(result.text, result.source.url, rooms, buildingCodesByCampus);
    const unmatchedNote = unmatched.length ? ` ${unmatched.length} qualified token(s) on this page are not in the Campus Explorer table and were not added: ${unmatched.join(', ')}.` : '';
    pages.push({
      url: result.source.url,
      status: 'ok',
      roomsFound: 0,
      note: `${result.source.role}; ${linked.length} existing room record(s) received this page as an additional source URL${linked.length ? ` (${linked.join(', ')})` : ''}.${unmatchedNote}${redirected}`,
      transport: result.transport,
    });
  }

  const roomList = [...rooms.values()]
    .map((room) => ({ ...room, sourceUrls: [...room.sourceUrls].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const perCampus = {};
  for (const room of roomList) perCampus[room.campus] = (perCampus[room.campus] || 0) + 1;

  const primarySucceeded = Boolean(primary?.ok);
  if (!primarySucceeded) {
    await appendLog({ event: 'export', status: 'skipped', reason: 'primary inventory unavailable; src/data/rooms.json left unchanged' });
    console.error('Campus Explorer table could not be fetched; src/data/rooms.json was left unchanged. See the scrape log.');
    process.exitCode = 1;
    return;
  }

  const limitations = [
    'The public Campus Explorer location table (Campus Location Tables) is the only room inventory; DCU does not state that it is a complete institutional room list, and this export does not claim that.',
    'DCU states that individual and staff timetables require MyTimetable sign-in, so authenticated timetable and room-booking data was not accessed.',
    'No room identifiers were generated from naming conventions. Records are emitted only when the public table explicitly lists the qualified location code; combined listings such as "GLA.SB12.&.SB12-A" are emitted as the two codes DCU printed.',
    'Building assignment uses the longest documented building code for the campus (for example SA before S, CA before C). Codes whose second character is B (SB11, XB09) are read as basement rooms of S and X; DCU\'s table files them under the same map IDs.',
    'DCU\'s table labels most X-prefixed rooms "Postgraduate Residences" while giving them map ID X (Lonsdale) and labels X101 "Londsdale Building"; all X rooms are assigned to the documented X building (Lonsdale). SPC.C208 is listed under "Belvedere House" (map 21), which shares the C code with Block C in both DCU\'s table and OpenStreetMap; it is assigned to the single documented St Patrick\'s C building.',
    'Unqualified room numbers on the library group-study page (O\'Reilly rooms 1-18, Cregan Library G215/G315) carry no campus/building code and were not added.',
    'Rows for unnamed sports facilities (pool, courts, pitches, Morton Stadium) and the "GLA.Invent.Video.Conference" entry have no location code and are not room records.',
  ];
  if (primaryReport.unknownBuildings.length) {
    limitations.unshift(`${primaryReport.unknownBuildings.length} listed code(s) reference building ids missing from buildings.json and were omitted: ${[...new Set(primaryReport.unknownBuildings.map((entry) => `${entry.buildingId} (${entry.buildingName})`))].join(', ')}.`);
  }

  const metadata = {
    generatedAt: now(),
    summary: `${roomList.length} deduplicated public DCU room records with evidence 'listed' from the Campus Explorer location table (${Object.entries(perCampus).map(([campus, count]) => `${count} ${campus}`).join(', ')}).`,
    roomsPerCampus: perCampus,
    fetchPolicy: 'robots.txt checked first; native Node fetch, then curl.exe, then PowerShell Invoke-WebRequest; 3 concurrent requests; 15 s timeout; TLS verification never disabled.',
    pages,
    limitations,
  };

  await writeFile(path.join(dataDir, 'rooms.json'), `${JSON.stringify(roomList, null, 2)}\n`);
  await writeFile(path.join(dataDir, 'sources.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  await appendLog({ event: 'export', status: 'ok', rooms: roomList.length, roomsPerCampus: perCampus, roomsPath: path.join(dataDir, 'rooms.json') });
  console.log(`Wrote ${roomList.length} room records to ${path.join(dataDir, 'rooms.json')} (${JSON.stringify(perCampus)})`);
  if (primaryReport.unknownBuildings.length) {
    console.warn(`Omitted ${primaryReport.unknownBuildings.length} code(s) whose building is not in buildings.json; see campus-explorer-parse-report.json`);
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  try {
    await mkdir(logDir, { recursive: true });
    await appendLog({ event: 'fatal', status: 'failed', error: message });
  } catch {
    // Do not hide the original fatal error if logging itself fails.
  }
  console.error(message);
  process.exitCode = 1;
});

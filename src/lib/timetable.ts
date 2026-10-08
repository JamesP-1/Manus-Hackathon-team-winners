import { looksLikeIcal, parseIcal, type IcalEvent } from './ical';
import { resolveRoom } from './rooms';
import type { Building, CampusId, Room, RoomResolution } from '../types';

/*
 * Personal DCU timetable feed support.
 *
 * The feed lives at https://timetable.redbrick.dcu.ie/api/v3/timetable/events?course=<uuid>
 * and returns iCalendar text with no CORS header, so the browser fetches it through a
 * same-origin proxy path (`/api/timetable`, configured in vite.config.mjs and documented
 * in README). Event content stays in memory; only the feed link is ever persisted, and
 * only when the student explicitly opts in (see TimetablePanel).
 */

export const TIMETABLE_HOST = 'timetable.redbrick.dcu.ie';
export const TIMETABLE_UPSTREAM_BASE = `https://${TIMETABLE_HOST}/api/v3/timetable`;
export const TIMETABLE_PROXY_BASE = '/api/timetable';

export type TimetableErrorKind = 'input' | 'network' | 'proxy' | 'http' | 'parse';

export class TimetableError extends Error {
  readonly kind: TimetableErrorKind;

  constructor(kind: TimetableErrorKind, message: string) {
    super(message);
    this.name = 'TimetableError';
    this.kind = kind;
  }
}

export interface TimetableSource {
  /** Course / timetable identifier from the redbrick feed. */
  courseId: string;
  /** Canonical upstream feed URL (safe to show and to remember). */
  feedUrl: string;
  /** Same-origin URL the browser actually requests. */
  proxiedUrl: string;
}

export interface TimetableLocation {
  /** Original text for this slot, e.g. "SA301 (Stokes Extension, Glasnevin)". */
  raw: string;
  /** Room token as written in the feed, or null when the slot has no room (online, TBC). */
  code: string | null;
  /** Building/campus text in parentheses, if any. */
  detail: string | null;
  campusHint: CampusId | null;
  /** Result of resolveRoom; null when there was no code to resolve. */
  resolution: RoomResolution | null;
  /** Whether the building came from the room code or from the building name in the detail text. */
  resolvedVia: 'code' | 'building-name' | null;
}

export interface TimetableClass {
  id: string;
  /** Module code such as CSC1020, when the summary begins with one. */
  moduleCode: string | null;
  /** Module title without the code and trailing activity, e.g. "Systems Analysis". */
  title: string;
  /** Activity type from the summary's final parentheses, e.g. "Lecture". */
  activity: string | null;
  summary: string;
  staff: string | null;
  start: Date;
  end: Date;
  locations: TimetableLocation[];
  /** First location that resolved to a building, used for the map selection. */
  primary: TimetableLocation | null;
}

export interface TimetableFeed {
  source: TimetableSource;
  classes: TimetableClass[];
  /** Events skipped because they had no usable start/end. */
  skipped: number;
  /** Distinct room codes grouped by how they resolved. */
  roomSummary: TimetableRoomSummary;
}

export interface TimetableRoomSummary {
  listed: string[];
  decoded: string[];
  unresolved: string[];
}

export interface TimetableDay {
  /** Local calendar date, YYYY-MM-DD. */
  key: string;
  date: Date;
  label: string;
  classes: TimetableClass[];
}

const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const exactUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for a bare course UUID (whitespace tolerated). */
export function isCourseId(value: string): boolean {
  return exactUuidPattern.test(value.trim());
}

export function buildTimetableSource(courseId: string): TimetableSource {
  const id = courseId.trim().toLowerCase();
  const query = `events?course=${encodeURIComponent(id)}`;
  return {
    courseId: id,
    feedUrl: `${TIMETABLE_UPSTREAM_BASE}/${query}`,
    proxiedUrl: `${TIMETABLE_PROXY_BASE}/${query}`,
  };
}

/**
 * Accepts a bare course UUID, the full feed URL, or any page URL from
 * timetable.redbrick.dcu.ie that carries the course id (`?course=` or in the path).
 */
export function parseTimetableInput(input: string): TimetableSource {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new TimetableError('input', 'Paste your timetable link or course id first.');
  }
  if (isCourseId(trimmed)) {
    return buildTimetableSource(trimmed);
  }

  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /[./]/.test(trimmed);
  let url: URL | null = null;
  if (looksLikeUrl) {
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
      url = null;
    }
  }

  if (url) {
    if (url.hostname.toLowerCase() !== TIMETABLE_HOST) {
      throw new TimetableError(
        'input',
        `Only links from ${TIMETABLE_HOST} are supported. Open your timetable there and copy the link that contains your course id.`,
      );
    }
    const fromQuery = url.searchParams.get('course') ?? url.searchParams.get('courseId') ?? url.searchParams.get('id');
    if (fromQuery && isCourseId(fromQuery)) {
      return buildTimetableSource(fromQuery);
    }
    const anywhere = `${url.pathname} ${url.search} ${url.hash}`.match(uuidPattern);
    if (anywhere) {
      return buildTimetableSource(anywhere[0]);
    }
    throw new TimetableError(
      'input',
      'That timetable link has no course id. Use the link containing "course=" followed by a long id, or paste the id itself.',
    );
  }

  const loose = trimmed.match(uuidPattern);
  if (loose) {
    return buildTimetableSource(loose[0]);
  }
  throw new TimetableError(
    'input',
    'Enter a course id (8-4-4-4-12 hex characters) or your timetable.redbrick.dcu.ie link.',
  );
}

const campusHints: Array<[RegExp, CampusId]> = [
  [/\bglasnevin\b/i, 'glasnevin'],
  [/\bst\.?\s*pat(?:rick)?'?s?\b|\bdrumcondra\b|\bspc\b/i, 'stpatricks'],
  [/\ball\s*hallows\b|\bahc\b/i, 'allhallows'],
];

const campusQualifier: Record<CampusId, string | null> = {
  glasnevin: 'GLA.',
  stpatricks: 'SPC.',
  allhallows: 'AHC.',
  other: null,
};

export function campusHintFrom(text: string | null): CampusId | null {
  if (!text) return null;
  for (const [pattern, campus] of campusHints) {
    if (pattern.test(text)) return campus;
  }
  return null;
}

interface LocationSlot {
  code: string | null;
  detail: string | null;
  raw: string;
}

const roomTokenPattern = /^[A-Z]{1,3}\s?[A-Z]?\d{1,4}(?:-?[A-Z0-9]+)?$/i;

/**
 * Splits a LOCATION string into room slots. Handles "SA301 (Stokes Extension, Glasnevin)",
 * "L101, L114, L128 (McNulty Building, Glasnevin)", several groups joined by ";" and
 * locations with no room at all ("Online", "").
 */
export function splitLocation(location: string): LocationSlot[] {
  const text = location.trim();
  if (!text) return [];

  const slots: LocationSlot[] = [];
  const groupPattern = /([^()]*)(?:\(([^)]*)\))?/g;
  for (const match of text.matchAll(groupPattern)) {
    const head = (match[1] ?? '').trim().replace(/^[,;\s]+|[,;\s]+$/g, '');
    const detail = match[2]?.trim() || null;
    if (!head && !detail) continue;

    const tokens = head
      .split(/[,;]+/)
      .map((token) => token.trim())
      .filter(Boolean);

    if (tokens.length === 0) {
      slots.push({ code: null, detail, raw: match[0].trim() });
      continue;
    }
    for (const token of tokens) {
      const isRoom = roomTokenPattern.test(token);
      slots.push({
        code: isRoom ? token.toUpperCase().replace(/\s+/g, '') : null,
        detail: isRoom ? detail : [token, detail].filter(Boolean).join(' · '),
        raw: detail ? `${token} (${detail})` : token,
      });
    }
  }
  return slots;
}

function buildingNameFrom(detail: string | null): string | null {
  if (!detail) return null;
  const [name] = detail.split(',');
  const cleaned = name.trim();
  return cleaned || null;
}

export function resolveLocation(location: string, buildings: Building[], rooms: Room[]): TimetableLocation[] {
  return splitLocation(location).map((slot) => {
    const campusHint = campusHintFrom(slot.detail);
    if (!slot.code) {
      return { raw: slot.raw, code: null, detail: slot.detail, campusHint, resolution: null, resolvedVia: null };
    }

    const qualifier = campusHint ? campusQualifier[campusHint] : null;
    let resolution = resolveRoom(qualifier ? `${qualifier}${slot.code}` : slot.code, buildings, rooms);
    if (resolution.status === 'ambiguous' && !qualifier) {
      // No usable campus hint: leave the ambiguity visible rather than guessing.
    } else if (!resolution.building && resolution.status !== 'ambiguous') {
      // The code itself is not decodable; fall back to the building named in the feed.
      const name = buildingNameFrom(slot.detail);
      if (name) {
        const byName = resolveRoom(qualifier ? `${qualifier}${name}` : name, buildings, rooms);
        if (byName.building) {
          return {
            raw: slot.raw,
            code: slot.code,
            detail: slot.detail,
            campusHint,
            resolution: {
              ...byName,
              query: slot.code,
              normalized: slot.code,
              message: `${slot.code} is not a decodable room code, but the timetable places it in ${byName.building.name}.`,
            },
            resolvedVia: 'building-name',
          };
        }
      }
    }
    // Keep the student's code as the displayed token rather than the qualified query.
    resolution = { ...resolution, query: slot.code, normalized: slot.code };
    return { raw: slot.raw, code: slot.code, detail: slot.detail, campusHint, resolution, resolvedVia: 'code' };
  });
}

const summaryPattern = /^([A-Z]{2,4}\d{3,4}[A-Z]?)\s+(.*)$/;

function parseSummary(summary: string): { moduleCode: string | null; title: string; activity: string | null } {
  let rest = summary.trim();
  let moduleCode: string | null = null;
  const moduleMatch = rest.match(summaryPattern);
  if (moduleMatch) {
    moduleCode = moduleMatch[1];
    rest = moduleMatch[2];
  }
  let activity: string | null = null;
  const activityMatch = rest.match(/^(.*)\s\(([^()]*)\)$/);
  if (activityMatch) {
    rest = activityMatch[1].trim();
    activity = activityMatch[2].trim() || null;
  }
  return { moduleCode, title: rest || summary.trim(), activity };
}

function parseStaff(description: string): string | null {
  const match = description.match(/^Staff:\s*(.+)$/im);
  return match ? match[1].trim() || null : null;
}

/** Converts parsed VEVENTs into display-ready classes with resolved rooms. */
export function resolveTimetableEvents(
  events: IcalEvent[],
  buildings: Building[],
  rooms: Room[],
): { classes: TimetableClass[]; skipped: number } {
  const classes: TimetableClass[] = [];
  let skipped = 0;
  const locationCache = new Map<string, TimetableLocation[]>();

  events.forEach((event, index) => {
    if (!event.start || Number.isNaN(event.start.getTime()) || event.status === 'CANCELLED') {
      skipped += 1;
      return;
    }
    const end = event.end && !Number.isNaN(event.end.getTime()) ? event.end : new Date(event.start.getTime() + 60 * 60 * 1000);

    let locations = locationCache.get(event.location);
    if (!locations) {
      locations = resolveLocation(event.location, buildings, rooms);
      locationCache.set(event.location, locations);
    }

    const { moduleCode, title, activity } = parseSummary(event.summary);
    classes.push({
      id: event.uid ?? `${event.start.toISOString()}-${index}`,
      moduleCode,
      title,
      activity,
      summary: event.summary,
      staff: parseStaff(event.description),
      start: event.start,
      end,
      locations,
      primary: locations.find((location) => location.resolution?.building) ?? null,
    });
  });

  classes.sort((left, right) => left.start.getTime() - right.start.getTime());
  return { classes, skipped };
}

export function summariseRooms(classes: TimetableClass[]): TimetableRoomSummary {
  const listed = new Set<string>();
  const decoded = new Set<string>();
  const unresolved = new Set<string>();
  for (const cls of classes) {
    for (const location of cls.locations) {
      if (!location.code) continue;
      const status = location.resolution?.status;
      if (status === 'listed') listed.add(location.code);
      else if (status === 'decoded') decoded.add(location.code);
      else unresolved.add(location.code);
    }
  }
  const sorted = (set: Set<string>) => [...set].sort();
  return { listed: sorted(listed), decoded: sorted(decoded), unresolved: sorted(unresolved) };
}

export function parseTimetableText(
  text: string,
  source: TimetableSource,
  buildings: Building[],
  rooms: Room[],
): TimetableFeed {
  if (!looksLikeIcal(text)) {
    throw new TimetableError(
      'proxy',
      'The response was not a calendar feed. The app must be served behind a proxy that forwards /api/timetable to timetable.redbrick.dcu.ie (see README); in development, restart the Vite dev server after changing vite.config.mjs.',
    );
  }
  const events = parseIcal(text);
  const { classes, skipped } = resolveTimetableEvents(events, buildings, rooms);
  return { source, classes, skipped, roomSummary: summariseRooms(classes) };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Fetches a feed through the same-origin proxy and resolves each class to a building. */
export async function loadTimetable(
  input: string,
  buildings: Building[],
  rooms: Room[],
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<TimetableFeed> {
  const source = parseTimetableInput(input);

  let response: Response;
  try {
    response = await fetchImpl(source.proxiedUrl, { headers: { Accept: 'text/calendar, text/plain;q=0.9, */*;q=0.1' } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TimetableError(
      'network',
      `Could not reach the timetable feed (${detail}). The browser cannot call timetable.redbrick.dcu.ie directly, so this app needs its /api/timetable proxy to be running.`,
    );
  }

  if (!response.ok) {
    const hint = response.status === 404 || response.status === 400
      ? ' Check that the course id is correct.'
      : response.status === 502 || response.status === 504
        ? ' The timetable server may be down; try again shortly.'
        : '';
    throw new TimetableError('http', `The timetable server answered ${response.status}.${hint}`);
  }

  const text = await response.text();
  const feed = parseTimetableText(text, source, buildings, rooms);
  if (feed.classes.length === 0) {
    throw new TimetableError('parse', 'The feed loaded but contains no classes. Double-check the course id.');
  }
  return feed;
}

/* ---------- time helpers ---------- */

export function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dayLabel(date: Date, now: Date = new Date()): string {
  const today = startOfDay(now).getTime();
  const target = startOfDay(date).getTime();
  const diffDays = Math.round((target - today) / 86_400_000);
  const dateText = date.toLocaleDateString('en-IE', { weekday: 'short', day: 'numeric', month: 'short' });
  if (diffDays === 0) return `Today · ${dateText}`;
  if (diffDays === 1) return `Tomorrow · ${dateText}`;
  if (diffDays === -1) return `Yesterday · ${dateText}`;
  return dateText;
}

/** Classes that have not finished yet, soonest first. */
export function upcomingClasses(classes: TimetableClass[], now: Date = new Date(), withinDays?: number): TimetableClass[] {
  const horizon = withinDays === undefined ? Number.POSITIVE_INFINITY : startOfDay(now).getTime() + (withinDays + 1) * 86_400_000;
  return classes
    .filter((cls) => cls.end.getTime() > now.getTime() && cls.start.getTime() < horizon)
    .sort((left, right) => left.start.getTime() - right.start.getTime());
}

/** Groups classes by local calendar day, preserving chronological order. */
export function groupByDay(classes: TimetableClass[], now: Date = new Date()): TimetableDay[] {
  const days = new Map<string, TimetableDay>();
  for (const cls of [...classes].sort((left, right) => left.start.getTime() - right.start.getTime())) {
    const key = dayKey(cls.start);
    let day = days.get(key);
    if (!day) {
      day = { key, date: startOfDay(cls.start), label: dayLabel(cls.start, now), classes: [] };
      days.set(key, day);
    }
    day.classes.push(cls);
  }
  return [...days.values()];
}

/** The class in progress right now, or else the next one to start. */
export function nextClass(classes: TimetableClass[], now: Date = new Date()): TimetableClass | null {
  return upcomingClasses(classes, now)[0] ?? null;
}

export function isInProgress(cls: TimetableClass, now: Date = new Date()): boolean {
  return cls.start.getTime() <= now.getTime() && cls.end.getTime() > now.getTime();
}

export function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-IE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

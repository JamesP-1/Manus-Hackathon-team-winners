/**
 * Minimal, dependency-free iCalendar (RFC 5545) reader.
 *
 * Covers what calendar feeds such as the DCU timetable export actually use:
 * line unfolding, text unescaping, UTC / TZID / floating / all-day dates, and
 * the handful of VEVENT properties the app displays. Anything else is ignored.
 */

export interface IcalProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcalEvent {
  uid: string | null;
  summary: string;
  description: string;
  location: string;
  start: Date | null;
  end: Date | null;
  /** True when DTSTART carried VALUE=DATE (an all-day event). */
  allDay: boolean;
  /** TZID parameter on DTSTART, when present. */
  timeZone: string | null;
  status: string | null;
  lastModified: Date | null;
}

/** Joins folded continuation lines (CRLF followed by a space or tab). */
export function unfoldLines(text: string): string[] {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]/g, '')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Reverses RFC 5545 TEXT escaping: \n \N \, \; and \\. */
export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, char: string) => {
    if (char === 'n' || char === 'N') return '\n';
    return char;
  });
}

function splitOutsideQuotes(input: string, separator: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of input) {
    if (char === '"') {
      quoted = !quoted;
      current += char;
    } else if (char === separator && !quoted) {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts;
}

function stripQuotes(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

/** Parses one unfolded content line into name, parameters and raw value. */
export function parseProperty(line: string): IcalProperty | null {
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) {
      colon = index;
      break;
    }
  }
  if (colon <= 0) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [rawName, ...rawParams] = splitOutsideQuotes(head, ';');
  const name = rawName.trim().toUpperCase();
  if (!name) return null;

  const params: Record<string, string> = {};
  for (const param of rawParams) {
    const equals = param.indexOf('=');
    if (equals <= 0) continue;
    params[param.slice(0, equals).trim().toUpperCase()] = stripQuotes(param.slice(equals + 1).trim());
  }
  return { name, params, value };
}

const dateTimePattern = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/;

function wallClockOffsetMs(instantMs: number, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(instantMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return wall - instantMs;
}

function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, s: number, timeZone: string): Date | null {
  try {
    const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
    let offset = wallClockOffsetMs(asUtc, timeZone);
    let guess = asUtc - offset;
    const secondOffset = wallClockOffsetMs(guess, timeZone);
    if (secondOffset !== offset) {
      offset = secondOffset;
      guess = asUtc - offset;
    }
    return new Date(guess);
  } catch {
    // Unknown IANA name (for example a Windows zone id): caller falls back to local time.
    return null;
  }
}

/**
 * Parses a DATE or DATE-TIME value. `Z` means UTC, a TZID parameter names an
 * IANA zone, and a bare value is "floating" (interpreted in the browser's zone).
 */
export function parseIcalDate(value: string, params: Record<string, string> = {}): Date | null {
  const match = value.trim().match(dateTimePattern);
  if (!match) return null;
  const [, year, month, day, hour = '0', minute = '0', second = '0', utc] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  const h = Number(hour);
  const mi = Number(minute);
  const s = Number(second);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;

  if (utc) return new Date(Date.UTC(y, mo - 1, d, h, mi, s));

  const timeZone = params.TZID;
  if (timeZone) {
    const zoned = zonedToUtc(y, mo, d, h, mi, s, timeZone);
    if (zoned) return zoned;
  }
  return new Date(y, mo - 1, d, h, mi, s);
}

function emptyEvent(): IcalEvent {
  return {
    uid: null,
    summary: '',
    description: '',
    location: '',
    start: null,
    end: null,
    allDay: false,
    timeZone: null,
    status: null,
    lastModified: null,
  };
}

/** Extracts every VEVENT from an iCalendar document. Other components are skipped. */
export function parseIcal(text: string): IcalEvent[] {
  const events: IcalEvent[] = [];
  let current: IcalEvent | null = null;
  let depth = 0; // nesting inside a VEVENT (e.g. VALARM) is ignored

  for (const line of unfoldLines(text)) {
    const property = parseProperty(line);
    if (!property) continue;
    const { name, params, value } = property;

    if (name === 'BEGIN') {
      if (value.toUpperCase() === 'VEVENT' && !current) {
        current = emptyEvent();
      } else if (current) {
        depth += 1;
      }
      continue;
    }
    if (name === 'END') {
      if (current && depth > 0) {
        depth -= 1;
      } else if (current && value.toUpperCase() === 'VEVENT') {
        events.push(current);
        current = null;
      }
      continue;
    }
    if (!current || depth > 0) continue;

    switch (name) {
      case 'UID':
        current.uid = value.trim() || null;
        break;
      case 'SUMMARY':
        current.summary = unescapeText(value).trim();
        break;
      case 'DESCRIPTION':
        current.description = unescapeText(value).trim();
        break;
      case 'LOCATION':
        current.location = unescapeText(value).trim();
        break;
      case 'DTSTART':
        current.start = parseIcalDate(value, params);
        current.allDay = params.VALUE?.toUpperCase() === 'DATE';
        current.timeZone = params.TZID ?? null;
        break;
      case 'DTEND':
        current.end = parseIcalDate(value, params);
        break;
      case 'STATUS':
        current.status = value.trim().toUpperCase() || null;
        break;
      case 'LAST-MODIFIED':
        current.lastModified = parseIcalDate(value, params);
        break;
      default:
        break;
    }
  }

  return events;
}

/** True when the text looks like an iCalendar document rather than HTML or JSON. */
export function looksLikeIcal(text: string): boolean {
  return /^\s*(?:﻿)?BEGIN:VCALENDAR/i.test(text);
}

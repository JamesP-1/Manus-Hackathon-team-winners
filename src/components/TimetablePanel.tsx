import { useEffect, useRef, useState } from 'react';
import { AlertCircle, CalendarClock, CheckCircle2, Loader2, MapPin } from 'lucide-react';
import { extractTimetableRooms } from '../lib/rooms';
import {
  TimetableError,
  formatTime,
  groupByDay,
  isInProgress,
  loadTimetable,
  nextClass,
  upcomingClasses,
  type TimetableClass,
  type TimetableFeed,
  type TimetableLocation,
} from '../lib/timetable';
import type { Building, Room, RoomResolution, TimetablePanelProps } from '../types';
import FloorChip from './FloorChip';
import './timetable.css';

/** Only the feed link is ever stored, and only after the student opts in. */
const FEED_LINK_STORAGE_KEY = 'dcumaps.timetable-feed-url';
const DEFAULT_WINDOW_DAYS = 7;

function readRememberedLink(): string | null {
  try {
    return window.localStorage.getItem(FEED_LINK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRememberedLink(link: string | null): void {
  try {
    if (link) window.localStorage.setItem(FEED_LINK_STORAGE_KEY, link);
    else window.localStorage.removeItem(FEED_LINK_STORAGE_KEY);
  } catch {
    // Storage may be unavailable (private mode); remembering is best-effort.
  }
}

function uniqueResolutions(resolutions: RoomResolution[]): RoomResolution[] {
  const seen = new Set<string>();
  return resolutions.filter((resolution) => {
    if (!resolution.building || (resolution.status !== 'listed' && resolution.status !== 'decoded')) {
      return false;
    }
    const key = resolution.room?.id ?? `${resolution.status}:${resolution.normalized}:${resolution.building?.id ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function badgeClass(location: TimetableLocation | null): 'listed' | 'decoded' | 'unknown' {
  const status = location?.resolution?.status;
  if (status === 'listed') return 'listed';
  if (status === 'decoded') return 'decoded';
  return 'unknown';
}

function badgeText(location: TimetableLocation | null): string {
  const status = location?.resolution?.status;
  if (status === 'listed') return 'Listed';
  if (status === 'decoded') return 'Decoded';
  if (status === 'ambiguous') return 'Ambiguous';
  if (!location?.code) return 'No room';
  return 'Unknown';
}

function whereText(cls: TimetableClass): string {
  const primary = cls.primary;
  if (primary?.resolution?.building) {
    return primary.resolution.building.name;
  }
  const first = cls.locations[0];
  if (!first) return 'No location in the feed';
  if (!first.code) return first.detail ?? first.raw;
  return first.resolution?.message ?? 'Room not recognised';
}

interface ClassRowProps {
  cls: TimetableClass;
  now: Date;
  isNext: boolean;
  onSelect: (resolution: RoomResolution) => void;
}

function ClassRow({ cls, now, isNext, onSelect }: ClassRowProps) {
  const primary = cls.primary;
  const live = isInProgress(cls, now);
  const extraRooms = cls.locations.filter((location) => location !== primary && location.resolution?.building);
  const codes = cls.locations.map((location) => location.code).filter(Boolean) as string[];

  return (
    <div className={`timetable-class${isNext ? ' next' : ''}${primary ? '' : ' unresolved'}`}>
      <button
        type="button"
        className="timetable-class-main"
        disabled={!primary?.resolution}
        onClick={() => primary?.resolution && onSelect(primary.resolution)}
        aria-label={`${formatTime(cls.start)} ${cls.summary}${primary?.code ? `, ${primary.code}` : ''}`}
      >
        <span className="timetable-time">
          <strong>{formatTime(cls.start)}</strong>
          <small>{formatTime(cls.end)}</small>
        </span>
        <span className="timetable-class-body">
          <span className="timetable-class-title">
            {isNext && <span className={`timetable-next-tag${live ? ' timetable-live-tag' : ''}`}>{live ? 'Now' : 'Next'}</span>}
            {cls.moduleCode && <code>{cls.moduleCode}</code>}
            <span title={cls.summary}>{cls.title}{cls.activity ? ` · ${cls.activity}` : ''}</span>
          </span>
          <span className="timetable-class-where">
            {primary?.resolution?.building
              ? <FloorChip floor={primary.resolution.floor} />
              : <MapPin size={13} aria-hidden="true" className={`result-icon ${badgeClass(primary)}`} />}
            {codes.length > 0 && <code>{primary?.code ?? codes[0]}{codes.length > 1 ? ` +${codes.length - 1}` : ''}</code>}
            <span className={`result-badge ${badgeClass(primary ?? cls.locations[0] ?? null)}`}>{badgeText(primary ?? cls.locations[0] ?? null)}</span>
            <span>{whereText(cls)}</span>
          </span>
        </span>
      </button>
      {extraRooms.length > 0 && (
        <span className="timetable-extra-rooms" aria-label="Other rooms for this class">
          {extraRooms.map((location) => (
            <button
              type="button"
              key={location.code ?? location.raw}
              title={location.resolution?.message}
              onClick={() => location.resolution && onSelect(location.resolution)}
            >
              {location.code}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

interface FeedSectionProps {
  buildings: Building[];
  rooms: Room[];
  onSelect: (resolution: RoomResolution) => void;
}

function ConnectTimetable({ buildings, rooms, onSelect }: FeedSectionProps) {
  const [link, setLink] = useState('');
  const [remember, setRemember] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<TimetableError | null>(null);
  const [feed, setFeed] = useState<TimetableFeed | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const requestId = useRef(0);

  const load = async (input: string, rememberThis: boolean) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await loadTimetable(input, buildings, rooms);
      if (id !== requestId.current) return;
      setFeed(result);
      setShowAll(false);
      setNow(new Date());
      writeRememberedLink(rememberThis ? result.source.feedUrl : null);
    } catch (caught) {
      if (id !== requestId.current) return;
      setFeed(null);
      setError(caught instanceof TimetableError ? caught : new TimetableError('network', (caught as Error)?.message ?? 'Unknown error'));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  };

  // A remembered link was stored at the student's explicit request, so reload it.
  useEffect(() => {
    const remembered = readRememberedLink();
    if (remembered) {
      setLink(remembered);
      setRemember(true);
      void load(remembered, true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const toggleRemember = (checked: boolean) => {
    setRemember(checked);
    if (!checked) writeRememberedLink(null);
    else if (feed) writeRememberedLink(feed.source.feedUrl);
  };

  const forget = () => {
    requestId.current += 1;
    writeRememberedLink(null);
    setRemember(false);
    setFeed(null);
    setError(null);
    setLink('');
    setLoading(false);
  };

  const upcoming = feed ? upcomingClasses(feed.classes, now, showAll ? undefined : DEFAULT_WINDOW_DAYS) : [];
  const totalUpcoming = feed ? upcomingClasses(feed.classes, now).length : 0;
  const days = groupByDay(upcoming, now);
  const next = feed ? nextClass(feed.classes, now) : null;

  return (
    <div className="timetable-feed">
      <div className="timetable-feed-intro">
        <h2>Your classes</h2>
        <p>
          Paste the feed link or course id from{' '}
          <a href="https://timetable.redbrick.dcu.ie/" target="_blank" rel="noreferrer">timetable.redbrick.dcu.ie</a>
          {' '}and each class is matched to its building.
        </p>
      </div>

      <form
        className="timetable-feed-form"
        onSubmit={(event) => {
          event.preventDefault();
          void load(link, remember);
        }}
      >
        <label htmlFor="timetable-feed-link">Feed link or course id</label>
        <div className="timetable-feed-input">
          <input
            id="timetable-feed-link"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck="false"
            value={link}
            aria-invalid={error?.kind === 'input' ? 'true' : undefined}
            aria-describedby={error ? 'timetable-feed-error' : undefined}
            placeholder="https://timetable.redbrick.dcu.ie/api/v3/timetable/events?course=…"
            onChange={(event) => {
              setLink(event.target.value);
              if (error?.kind === 'input') setError(null);
            }}
          />
          <button type="submit" className="primary-search" disabled={loading || !link.trim()}>
            {loading ? 'Loading' : 'Load'}
          </button>
        </div>
        <label className="timetable-remember">
          <input type="checkbox" checked={remember} onChange={(event) => toggleRemember(event.target.checked)} />
          <span>
            <strong>Remember on this device</strong> — stores only the link, never your classes.
          </span>
        </label>
      </form>

      {loading && (
        <p className="timetable-feed-status loading" role="status">
          <Loader2 size={15} aria-hidden="true" /> Fetching your timetable…
        </p>
      )}

      {error && (
        <p className="timetable-feed-error" id="timetable-feed-error" role="alert">
          <AlertCircle size={16} aria-hidden="true" />
          <span>{error.message}</span>
        </p>
      )}

      {feed && !loading && (
        <div className="timetable-feed-results" aria-live="polite">
          <div className="timetable-feed-meta">
            <span>
              <CalendarClock size={13} aria-hidden="true" /> {feed.classes.length} classes in feed · {totalUpcoming} upcoming
            </span>
            <button type="button" className="link-button" onClick={forget}>Disconnect</button>
          </div>

          {days.length === 0 ? (
            <p className="empty-extraction">
              {totalUpcoming === 0 ? 'No upcoming classes in this feed.' : `No classes in the next ${DEFAULT_WINDOW_DAYS} days.`}
            </p>
          ) : (
            days.map((day) => (
              <div className="timetable-day" key={day.key}>
                <div className="timetable-day-heading">
                  <span>{day.label}</span>
                  <span>{day.classes.length} {day.classes.length === 1 ? 'class' : 'classes'}</span>
                </div>
                {day.classes.map((cls) => (
                  <ClassRow key={cls.id} cls={cls} now={now} isNext={next?.id === cls.id} onSelect={onSelect} />
                ))}
              </div>
            ))
          )}

          {!showAll && totalUpcoming > upcoming.length && (
            <button type="button" className="timetable-show-more" onClick={() => setShowAll(true)}>
              Show all {totalUpcoming} upcoming classes
            </button>
          )}
          {showAll && totalUpcoming > 0 && (
            <button type="button" className="timetable-show-more" onClick={() => setShowAll(false)}>
              Show next {DEFAULT_WINDOW_DAYS} days only
            </button>
          )}

          <p className="timetable-room-summary">
            Rooms: {feed.roomSummary.listed.length} publicly listed, {feed.roomSummary.decoded.length} decoded from the code convention
            {feed.roomSummary.unresolved.length > 0 && (
              <>, {feed.roomSummary.unresolved.length} not matched (<code>{feed.roomSummary.unresolved.join(', ')}</code>)</>
            )}
            . Pins are building-level, not room entrances.
            {feed.skipped > 0 && ` ${feed.skipped} cancelled or undated events skipped.`}
          </p>
        </div>
      )}
    </div>
  );
}

export default function TimetablePanel({ buildings, rooms, onSelect }: TimetablePanelProps) {
  const [text, setText] = useState('');
  const [extracted, setExtracted] = useState<RoomResolution[] | null>(null);

  const extractRooms = () => {
    setExtracted(uniqueResolutions(extractTimetableRooms(text, buildings, rooms)));
  };

  return (
    <section className="timetable-panel" aria-label="Connect a timetable feed or extract room codes from pasted text">
      <ConnectTimetable buildings={buildings} rooms={rooms} onSelect={onSelect} />

      <div className="timetable-intro">
        <h2>Or paste timetable text</h2>
        <p>Room codes are picked out on this device. Nothing is saved.</p>
      </div>

      <label htmlFor="timetable-text" className="visually-hidden">Timetable text</label>
      <textarea
        id="timetable-text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setExtracted(null);
        }}
        placeholder="Paste lines from your timetable here"
        spellCheck="false"
      />
      <div className="timetable-actions">
        <span><CheckCircle2 size={13} aria-hidden="true" /> Browser only</span>
        <button type="button" className="primary-search" disabled={!text.trim()} onClick={extractRooms}>Extract rooms</button>
      </div>

      {extracted !== null && (
        <div className="extracted-rooms" aria-live="polite">
          <div className="results-heading">
            <span>Supported destinations</span>
            <span>{extracted.length} found</span>
          </div>
          {extracted.length > 0 ? (
            <div className="timetable-list">
              {extracted.map((resolution) => (
                <button
                  type="button"
                  className="timetable-result"
                  key={resolution.room?.id ?? `${resolution.normalized}-${resolution.building?.id ?? 'unknown'}`}
                  onClick={() => onSelect(resolution)}
                >
                  <FloorChip floor={resolution.floor} />
                  <span className="result-main">
                    <code>{resolution.room?.code ?? resolution.normalized}</code>
                    <small>{resolution.building ? resolution.building.name : resolution.message}</small>
                  </span>
                  <span className={`result-badge ${resolution.status === 'listed' ? 'listed' : 'decoded'}`}>
                    {resolution.status === 'listed' ? 'Listed' : 'Decoded'}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="empty-extraction">No supported room tokens were found. Check the code formatting or use Search.</p>
          )}
        </div>
      )}
    </section>
  );
}

import { useMemo, useState, type CSSProperties } from 'react';
import { ClipboardList, Footprints, MapPin, Moon, Search, Sun, X } from 'lucide-react';
import CampusMap from './components/CampusMap';
import FloorChip from './components/FloorChip';
import SearchPanel from './components/SearchPanel';
import TimetablePanel from './components/TimetablePanel';
import buildingsData from './data/buildings.json';
import roomsData from './data/rooms.json';
import { BUILDING_COLOR, floorStyle } from './lib/floors';
import { formatDistance, formatMinutes } from './lib/routing';
import { useTheme } from './lib/theme';
import type { Building, Room, RoomResolution, RouteSummary } from './types';

const buildings = buildingsData as Building[];
const rooms = roomsData as Room[];

type Tab = 'search' | 'timetable';

const CAMPUS_LABELS: Record<Building['campus'], string> = {
  glasnevin: 'Glasnevin',
  stpatricks: "St Patrick's",
  allhallows: 'All Hallows',
  other: 'Other',
};

interface DestinationCardProps {
  resolution: RoomResolution;
  route: RouteSummary | null;
  onClear: () => void;
}

function DestinationCard({ resolution, route, onClear }: DestinationCardProps) {
  const { building, room, status } = resolution;
  const sources = [...new Set([...(room?.sourceUrls ?? []), ...(building?.sourceUrls ?? [])])];
  const badge = status === 'listed' ? 'Public listing' : status === 'decoded' ? 'Decoded, not confirmed' : 'Unresolved';
  const floor = resolution.floor ? floorStyle(resolution.floor) : null;
  const accent = { '--accent': floor?.color ?? BUILDING_COLOR, '--accent-tint': floor?.tint ?? '#eef3ff' } as CSSProperties;

  return (
    <section className="destination-card" style={accent} aria-live="polite" aria-label="Selected destination">
      <div className="destination-head">
        <code>{resolution.normalized || resolution.query}</code>
        <span className={`result-badge ${status === 'listed' ? 'listed' : 'decoded'}`}>{badge}</span>
        <button type="button" className="icon-button" onClick={onClear} aria-label="Clear destination">
          <X size={16} aria-hidden="true" />
        </button>
      </div>

      {building && (
        <div className="destination-floor">
          <FloorChip floor={resolution.floor} solid />
          <span>
            {floor ? floor.label : 'Building only'}{resolution.roomNumber ? ` · room ${resolution.roomNumber}` : ''}
          </span>
        </div>
      )}

      {building ? (
        <dl className="destination-facts">
          <div><dt>Building</dt><dd>{building.name} ({building.code})</dd></div>
          <div><dt>Campus</dt><dd>{CAMPUS_LABELS[building.campus]}</dd></div>
        </dl>
      ) : (
        <p className="destination-message">{resolution.message}</p>
      )}

      {route ? (
        <p className="destination-route">
          <Footprints size={15} aria-hidden="true" />
          <strong>{formatDistance(route.distanceMetres)}</strong>
          <span>· {formatMinutes(route.walkingMinutes)} walk{route.origin === 'demo' ? ' from the main entrance (demo)' : ' from you'}</span>
        </p>
      ) : building && (
        <p className="destination-route destination-route--hint">
          <Footprints size={15} aria-hidden="true" />
          <span>Tap <strong>My location</strong> on the map for a walking route.</span>
        </p>
      )}

      {building && (
        <p className="destination-note">
          <MapPin size={13} aria-hidden="true" />
          {building.lat === null
            ? 'Pin placed at the OpenStreetMap footprint; not a verified entrance.'
            : 'Pin is a building-level coordinate, not an entrance or indoor position.'}
        </p>
      )}

      {sources.length > 0 && (
        <details className="destination-sources">
          <summary>Public references ({sources.length})</summary>
          <ul>{sources.map((s) => <li key={s}><a href={s} target="_blank" rel="noreferrer">{s}</a></li>)}</ul>
        </details>
      )}
    </section>
  );
}

export default function App() {
  const [tab, setTab] = useState<Tab>('search');
  const [selected, setSelected] = useState<RoomResolution | null>(null);
  const [route, setRoute] = useState<RouteSummary | null>(null);
  const [theme, toggleTheme] = useTheme();

  const selectedBuilding = selected?.building ?? null;
  const counts = useMemo(() => ({ rooms: rooms.length, buildings: buildings.length }), []);

  const handleMapSelect = (building: Building) => {
    setSelected({
      query: building.code,
      normalized: building.code.toUpperCase(),
      status: 'decoded',
      building,
      room: null,
      floor: null,
      roomNumber: null,
      message: `Building found: ${building.name}. Room not confirmed in public listings.`,
    });
  };

  return (
    <div className="app">
      <div className="map-layer">
        <CampusMap
          buildings={buildings}
          selectedBuilding={selectedBuilding}
          selectedFloor={selected?.floor ?? null}
          onSelectBuilding={handleMapSelect}
          onRouteChange={setRoute}
        />
      </div>

      <aside className="side-panel">
        <header className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <p className="wordmark">DCU / NAV</p>
            <h1>Find your next room.</h1>
          </div>
          <button
            type="button"
            className="icon-button theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Light mode' : 'Dark mode'}
          >
            {theme === 'dark' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
          </button>
        </header>

        <div className="tabs" role="tablist" aria-label="Lookup method">
          <button role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
            <Search size={15} aria-hidden="true" /> Search
          </button>
          <button role="tab" aria-selected={tab === 'timetable'} className={tab === 'timetable' ? 'active' : ''} onClick={() => setTab('timetable')}>
            <ClipboardList size={15} aria-hidden="true" /> Timetable
          </button>
        </div>

        <div className="panel-body" role="tabpanel">
          {selected && <DestinationCard resolution={selected} route={route} onClear={() => setSelected(null)} />}
          {tab === 'search'
            ? <SearchPanel buildings={buildings} rooms={rooms} onSelect={setSelected} selected={selected} />
            : <TimetablePanel buildings={buildings} rooms={rooms} onSelect={setSelected} />}
        </div>

        <footer className="panel-footer">
          {counts.rooms} public room listings · {counts.buildings} buildings · independent student prototype, not an official DCU service.
        </footer>
      </aside>
    </div>
  );
}

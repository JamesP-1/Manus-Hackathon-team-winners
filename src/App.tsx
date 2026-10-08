import { useMemo, useState } from 'react';
import { ExternalLink, MapPin, Navigation, Search, ClipboardList } from 'lucide-react';
import CampusMap from './components/CampusMap';
import SearchPanel from './components/SearchPanel';
import TimetablePanel from './components/TimetablePanel';
import buildingsData from './data/buildings.json';
import roomsData from './data/rooms.json';
import type { Building, Room, RoomResolution } from './types';

const buildings = buildingsData as Building[];
const rooms = roomsData as Room[];

type Tab = 'search' | 'timetable';

function walkingUrl(building: Building): string | null {
  if (building.lat === null || building.lng === null) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${building.lat},${building.lng}&travelmode=walking`;
}

function DestinationCard({ resolution }: { resolution: RoomResolution }) {
  const { building, room, status } = resolution;
  const sources = [...new Set([...(room?.sourceUrls ?? []), ...(building?.sourceUrls ?? [])])];
  const url = building ? walkingUrl(building) : null;
  const badge = status === 'listed' ? 'Public listing' : status === 'decoded' ? 'Decoded, not confirmed' : 'Unresolved';

  return (
    <section className="destination-card" aria-live="polite" aria-label="Selected destination">
      <div className="destination-head">
        <span className={`result-badge ${status === 'listed' ? 'listed' : 'decoded'}`}>{badge}</span>
        {resolution.normalized && <code>{resolution.normalized}</code>}
      </div>
      <p className="destination-message">{resolution.message}</p>
      {building && (
        <dl className="destination-facts">
          <div><dt>Building</dt><dd>{building.name} ({building.code})</dd></div>
          <div><dt>Campus</dt><dd>{building.campus}</dd></div>
          {resolution.floor && <div><dt>Floor</dt><dd>{resolution.floor}</dd></div>}
          {resolution.roomNumber && <div><dt>Room</dt><dd>{resolution.roomNumber}</dd></div>}
        </dl>
      )}
      {building && (
        <p className="destination-note">
          <MapPin size={14} aria-hidden="true" />{' '}
          {building.lat === null
            ? 'No sourced coordinate for this building.'
            : `Pin is a ${building.coordinatePrecision}-level coordinate, not a verified entrance or indoor position.`}
        </p>
      )}
      {url && (
        <a className="primary-search directions" href={url} target="_blank" rel="noreferrer">
          <Navigation size={16} aria-hidden="true" /> Walking directions to building <ExternalLink size={13} aria-hidden="true" />
        </a>
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
        <CampusMap buildings={buildings} selectedBuilding={selectedBuilding} onSelectBuilding={handleMapSelect} />
      </div>

      <aside className="side-panel">
        <header className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <p className="wordmark">DCU / NAV</p>
            <h1>Find your next room.</h1>
          </div>
        </header>
        <p className="prototype-label">Independent student prototype, not an official DCU service.</p>

        <div className="tabs" role="tablist" aria-label="Lookup method">
          <button role="tab" aria-selected={tab === 'search'} className={tab === 'search' ? 'active' : ''} onClick={() => setTab('search')}>
            <Search size={15} aria-hidden="true" /> Search
          </button>
          <button role="tab" aria-selected={tab === 'timetable'} className={tab === 'timetable' ? 'active' : ''} onClick={() => setTab('timetable')}>
            <ClipboardList size={15} aria-hidden="true" /> Timetable
          </button>
        </div>

        <div className="panel-body" role="tabpanel">
          {tab === 'search'
            ? <SearchPanel buildings={buildings} rooms={rooms} onSelect={setSelected} selected={selected} />
            : <TimetablePanel buildings={buildings} rooms={rooms} onSelect={setSelected} />}
          {selected && <DestinationCard resolution={selected} />}
        </div>

        <footer className="panel-footer">
          Public-source coverage: {counts.rooms} listed rooms in {counts.buildings} buildings. Not a complete DCU room list.
        </footer>
      </aside>
    </div>
  );
}

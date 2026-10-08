import { useMemo, useState, type FormEvent } from 'react';
import { Building2, CheckCircle2, ChevronRight, Search, X } from 'lucide-react';
import { resolveRoom, searchBuildings } from '../lib/rooms';
import type { Building, Room, RoomResolution, SearchPanelProps } from '../types';

function roomResolution(room: Room, building: Building | undefined): RoomResolution {
  return {
    query: room.code,
    normalized: room.code.toUpperCase(),
    status: 'listed',
    building: building ?? null,
    room,
    floor: room.floor,
    roomNumber: room.roomNumber,
    message: building
      ? `${room.code} is in the public room listings for ${building.name}.`
      : `${room.code} is in the public room listings; its mapped building is unavailable.`,
  };
}

function buildingResolution(building: Building): RoomResolution {
  return {
    query: building.code,
    normalized: building.code.toUpperCase(),
    status: 'decoded',
    building,
    room: null,
    floor: null,
    roomNumber: null,
    message: `Building found: ${building.name}. Room not confirmed in public listings.`,
  };
}

function resultLabel(room: Room, building: Building | undefined): string {
  const location = [building?.name, room.floor ? `Floor ${room.floor}` : null].filter(Boolean).join(' · ');
  return location || 'Public room listing';
}

export default function SearchPanel({ buildings, rooms, onSelect, selected }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const trimmedQuery = query.trim();

  const buildingsById = useMemo(() => new Map(buildings.map((building) => [building.id, building])), [buildings]);
  const matchingBuildings = useMemo(
    () => trimmedQuery ? searchBuildings(trimmedQuery, buildings).slice(0, 5) : [],
    [buildings, trimmedQuery],
  );
  const matchingRooms = useMemo(() => {
    if (!trimmedQuery) return [];
    const needle = trimmedQuery.toUpperCase().replace(/\s+/g, '');
    return rooms.filter((room) => {
      const building = buildingsById.get(room.buildingId);
      return room.code.toUpperCase().includes(needle)
        || Boolean(building && `${building.code} ${building.name}`.toUpperCase().includes(needle));
    }).slice(0, 8);
  }, [buildingsById, rooms, trimmedQuery]);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedQuery) return;
    onSelect(resolveRoom(trimmedQuery, buildings, rooms));
  };

  const useExample = () => {
    setQuery('L101');
    onSelect(resolveRoom('L101', buildings, rooms));
  };

  const hasResults = matchingRooms.length > 0 || matchingBuildings.length > 0;

  return (
    <section className="search-panel" aria-label="Search rooms and buildings">
      <form className="search-form" onSubmit={submitSearch}>
        <label htmlFor="room-search">Room or building</label>
        <div className="search-input-wrap">
          <Search size={18} aria-hidden="true" />
          <input
            id="room-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Try L101 or Library"
            autoComplete="off"
            spellCheck="false"
            aria-describedby="search-help"
          />
          {query && (
            <button className="clear-search" type="button" onClick={() => setQuery('')} aria-label="Clear room or building search">
              <X size={16} aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="search-actions">
          <p id="search-help">Search a known code or select a building. Enter submits a code lookup.</p>
          <button className="primary-search" type="submit" disabled={!trimmedQuery}>Find on map</button>
        </div>
      </form>

      {!trimmedQuery && (
        <div className="search-empty-state">
          <p><strong>First time here?</strong> Start with a code from your timetable.</p>
          <button type="button" className="example-code" onClick={useExample}>
            Try <code>L101</code><ChevronRight size={15} aria-hidden="true" />
          </button>
          <small>This is a code lookup example, not a claim that L101 is publicly listed.</small>
        </div>
      )}

      {trimmedQuery && (
        <div className="search-results" aria-live="polite">
          <div className="results-heading">
            <span>Matches for <code>{trimmedQuery}</code></span>
            {hasResults ? <span>{matchingRooms.length + matchingBuildings.length} shown</span> : null}
          </div>

          {matchingRooms.length > 0 && (
            <div className="result-group">
              <h2>Public room listings</h2>
              {matchingRooms.map((room) => {
                const building = buildingsById.get(room.buildingId);
                const isSelected = selected?.room?.id === room.id;
                return (
                  <button
                    type="button"
                    className={`search-result room-result${isSelected ? ' selected' : ''}`}
                    key={room.id}
                    onClick={() => onSelect(roomResolution(room, building))}
                  >
                    <span className="result-icon listed"><CheckCircle2 size={16} aria-hidden="true" /></span>
                    <span className="result-main"><code>{room.code}</code><small>{resultLabel(room, building)}</small></span>
                    <span className="result-badge listed">Listed</span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}

          {matchingBuildings.length > 0 && (
            <div className="result-group">
              <h2>Buildings</h2>
              {matchingBuildings.map((building) => {
                const isSelected = selected?.room === null && selected.building?.id === building.id;
                return (
                  <button
                    type="button"
                    className={`search-result building-result${isSelected ? ' selected' : ''}`}
                    key={building.id}
                    onClick={() => onSelect(buildingResolution(building))}
                  >
                    <span className="result-icon decoded"><Building2 size={16} aria-hidden="true" /></span>
                    <span className="result-main"><code>{building.code}</code><small>{building.name} · {building.campus}</small></span>
                    <span className="result-badge decoded">Building</span>
                    <ChevronRight size={17} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}

          {!hasResults && (
            <div className="no-search-matches">
              <p>No catalogue match is shown yet.</p>
              <button type="button" onClick={() => onSelect(resolveRoom(trimmedQuery, buildings, rooms))}>Decode <code>{trimmedQuery}</code> anyway</button>
              <small>Code decoding can identify a building convention; it does not confirm a public room listing.</small>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

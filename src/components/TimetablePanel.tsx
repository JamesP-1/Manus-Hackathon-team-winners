import { useState } from 'react';
import { CheckCircle2, Clock3, MapPin } from 'lucide-react';
import { extractTimetableRooms } from '../lib/rooms';
import type { RoomResolution, TimetablePanelProps } from '../types';

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

export default function TimetablePanel({ buildings, rooms, onSelect }: TimetablePanelProps) {
  const [text, setText] = useState('');
  const [extracted, setExtracted] = useState<RoomResolution[] | null>(null);

  const extractRooms = () => {
    setExtracted(uniqueResolutions(extractTimetableRooms(text, buildings, rooms)));
  };

  return (
    <section className="timetable-panel" aria-label="Extract room codes from pasted timetable text">
      <div className="timetable-intro">
        <span className="local-only"><CheckCircle2 size={15} aria-hidden="true" /> Browser only</span>
        <h2>Paste a timetable snippet</h2>
        <p>We look for supported room tokens in the text on this device. Nothing is saved or used to infer a schedule.</p>
      </div>

      <label htmlFor="timetable-text">Timetable text</label>
      <textarea
        id="timetable-text"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setExtracted(null);
        }}
        placeholder={'Example:\nMon 09:00 — L101\nWed 14:00 — C123'}
        spellCheck="false"
      />
      <div className="timetable-actions">
        <span><Clock3 size={15} aria-hidden="true" /> Local extraction only</span>
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
                  <span className={`result-icon ${resolution.status === 'listed' ? 'listed' : 'decoded'}`}>
                    <MapPin size={16} aria-hidden="true" />
                  </span>
                  <span className="result-main">
                    <code>{resolution.room?.code ?? resolution.normalized}</code>
                    <small>{resolution.building ? `${resolution.building.name}${resolution.floor ? ` · Floor ${resolution.floor}` : ''}` : resolution.message}</small>
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

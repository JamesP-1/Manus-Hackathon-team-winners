/**
 * One colour per floor, shared by the map (building footprint / pin), result
 * rows and the destination card so a floor reads the same everywhere.
 */
export interface FloorStyle {
  /** Canonical floor key as stored on Room.floor, e.g. "Ground", "1". */
  key: string;
  /** Human label, e.g. "Ground floor", "Floor 2". */
  label: string;
  /** One or two character chip text, e.g. "G", "1". */
  short: string;
  /** Solid colour for map fills, pins and chips. */
  color: string;
  /** Pale tint for chip backgrounds on white panels. */
  tint: string;
}

export const FLOOR_PALETTE: FloorStyle[] = [
  { key: 'Basement', label: 'Basement', short: 'B', color: '#6d4fc2', tint: '#ece6fa' },
  { key: 'Lower Ground', label: 'Lower Ground floor', short: 'LG', color: '#4f6bb8', tint: '#e6ecf8' },
  { key: 'Ground', label: 'Ground floor', short: 'G', color: '#0f8a63', tint: '#e0f4ec' },
  { key: '1', label: 'Floor 1', short: '1', color: '#1663ef', tint: '#e4ecfd' },
  { key: '2', label: 'Floor 2', short: '2', color: '#e0760a', tint: '#fdeedd' },
  { key: '3', label: 'Floor 3', short: '3', color: '#c2338f', tint: '#f9e2f0' },
  { key: '4', label: 'Floor 4', short: '4', color: '#c62d2d', tint: '#fae2e2' },
];

export const UNKNOWN_FLOOR: FloorStyle = {
  key: '',
  label: 'Floor not known',
  short: '?',
  color: '#7b8794',
  tint: '#eef1f4',
};

/** Neutral colour used for a building when no room (and so no floor) is selected. */
export const BUILDING_COLOR = '#1663ef';

export function floorStyle(floor: string | null | undefined): FloorStyle {
  if (!floor) return UNKNOWN_FLOOR;
  const found = FLOOR_PALETTE.find((entry) => entry.key === floor);
  if (found) return found;
  // Floors above 4 are not in the public listings today; keep them readable anyway.
  return { key: floor, label: `Floor ${floor}`, short: floor, color: '#8a3ab9', tint: '#f1e6f8' };
}

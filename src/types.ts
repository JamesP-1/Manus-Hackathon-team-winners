export type CampusId = 'glasnevin' | 'stpatricks' | 'allhallows' | 'other';
export interface Building {
  id: string;
  code: string;
  name: string;
  campus: CampusId;
  aliases: string[];
  lat: number | null;
  lng: number | null;
  coordinateSource: string | null;
  coordinatePrecision: 'building' | 'approximate' | 'unknown';
  sourceUrls: string[];
}
export interface Room {
  id: string;
  code: string;
  buildingId: string;
  campus: CampusId;
  floor: string | null;
  roomNumber: string | null;
  sourceUrls: string[];
  evidence: 'listed';
}
export interface RoomResolution {
  query: string;
  normalized: string;
  status: 'listed' | 'decoded' | 'unknown' | 'ambiguous';
  building: Building | null;
  room: Room | null;
  floor: string | null;
  roomNumber: string | null;
  message: string;
}
export interface CampusMapProps {
  buildings: Building[];
  selectedBuilding: Building | null;
  onSelectBuilding: (building: Building) => void;
}
export interface SearchPanelProps {
  buildings: Building[];
  rooms: Room[];
  onSelect: (resolution: RoomResolution) => void;
  selected: RoomResolution | null;
}
export interface TimetablePanelProps {
  buildings: Building[];
  rooms: Room[];
  onSelect: (resolution: RoomResolution) => void;
}

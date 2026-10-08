import type { Building, CampusId, Room, RoomResolution } from '../types';

type ParsedSuffix = {
  floor: string;
  roomNumber: string;
};

type CampusQualifiedToken = {
  campus: CampusId | null;
  token: string;
};

const campusAliases: Record<string, CampusId> = {
  GLA: 'glasnevin',
  GLASNEVIN: 'glasnevin',
  SPC: 'stpatricks',
  STP: 'stpatricks',
  STPATRICKS: 'stpatricks',
  AHC: 'allhallows',
  ALLHALLOWS: 'allhallows',
};

const campusNames: Record<CampusId, string> = {
  glasnevin: 'Glasnevin',
  stpatricks: "St Patrick's",
  allhallows: 'All Hallows',
  other: 'other campus',
};

function normalise(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, ' ');
}

function compact(value: string): string {
  return normalise(value).replace(/\s+/g, '');
}

function buildingCode(building: Building): string {
  return compact(building.code);
}

function uniqueBuildings(buildings: Building[]): Building[] {
  return [...new Map(buildings.map((building) => [building.id, building])).values()];
}

function campusQualifiedToken(normalized: string): CampusQualifiedToken {
  const match = normalized.match(
    /^(GLA|GLASNEVIN|SPC|STP|ST\.?\s*PATRICK'?S|AHC|ALL\s*HALLOWS)[.:\s/-]+(.+)$/,
  );

  if (!match) {
    return { campus: null, token: compact(normalized) };
  }

  const alias = match[1].replace(/[^A-Z]/g, '');
  return {
    campus: campusAliases[alias] ?? null,
    token: compact(match[2]),
  };
}

function parseSuffix(suffix: string): ParsedSuffix | null {
  const lowerGround = suffix.match(/^LG(\d{2,}(?:-[A-Z0-9]+)?)$/);
  if (lowerGround) {
    return { floor: 'Lower Ground', roomNumber: lowerGround[1] };
  }

  const ground = suffix.match(/^G(\d{2,}(?:-[A-Z0-9]+)?)$/);
  if (ground) {
    return { floor: 'Ground', roomNumber: ground[1] };
  }

  // Basement rooms (e.g. SB11, XB09) are explicitly listed in DCU's public Campus Explorer table.
  const basement = suffix.match(/^B(\d{2,}(?:-[A-Z0-9]+)?)$/);
  if (basement) {
    return { floor: 'Basement', roomNumber: basement[1] };
  }

  const zero = suffix.match(/^0(\d{2,}(?:-[A-Z0-9]+)?)$/);
  if (zero) {
    return { floor: 'Ground', roomNumber: zero[1] };
  }

  const numeric = suffix.match(/^([1-9])(\d{2,}(?:-[A-Z0-9]+)?)$/);
  if (numeric) {
    return { floor: numeric[1], roomNumber: numeric[2] };
  }

  return null;
}

function floorDescription(floor: string): string {
  if (floor === 'Ground') {
    return 'Ground floor';
  }
  if (floor === 'Lower Ground') {
    return 'Lower Ground floor';
  }
  if (floor === 'Basement') {
    return 'Basement';
  }
  return `floor ${floor}`;
}

function emptyResolution(query: string, normalized: string, message: string): RoomResolution {
  return {
    query,
    normalized,
    status: 'unknown',
    building: null,
    room: null,
    floor: null,
    roomNumber: null,
    message,
  };
}

function ambiguousResolution(
  query: string,
  normalized: string,
  buildings: Building[],
  codeOrName: string,
): RoomResolution {
  const choices = uniqueBuildings(buildings)
    .map((building) => `${building.name} (${campusNames[building.campus]})`)
    .join('; ');

  return {
    query,
    normalized,
    status: 'ambiguous',
    building: null,
    room: null,
    floor: null,
    roomNumber: null,
    message: `${codeOrName} is ambiguous across campuses: ${choices}. Add a campus qualifier such as GLA.${codeOrName} or select a campus.`,
  };
}

function listedRoomToken(room: Room): CampusQualifiedToken {
  return campusQualifiedToken(normalise(room.code));
}

function scoreBuildingMatch(building: Building, normalized: string, compactQuery: string): number | null {
  const code = normalise(building.code);
  const names = [building.name, ...building.aliases].map(normalise);
  const searchable = [code, ...names];

  if (code === normalized || compact(code) === compactQuery) {
    return 0;
  }
  if (names.some((name) => name === normalized || compact(name) === compactQuery)) {
    return 1;
  }
  if (searchable.some((value) => value.startsWith(normalized) || compact(value).startsWith(compactQuery))) {
    return 2;
  }
  if (searchable.some((value) => value.includes(normalized) || compact(value).includes(compactQuery))) {
    return 3;
  }

  return null;
}

/**
 * Searches documented building codes, names and aliases. Blank input returns the
 * supplied order; otherwise exact code/name matches are ranked before partial matches.
 */
export function searchBuildings(query: string, buildings: Building[]): Building[] {
  const normalized = normalise(query);
  if (!normalized) {
    return [...buildings];
  }

  const compactQuery = compactQueryFor(normalized);
  return buildings
    .map((building, index) => ({
      building,
      index,
      score: scoreBuildingMatch(building, normalized, compactQuery),
    }))
    .filter((entry): entry is { building: Building; index: number; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.building);
}

function compactQueryFor(normalized: string): string {
  return normalized.replace(/\s+/g, '');
}

/**
 * Resolves an exact publicly listed room before applying documented room-code
 * conventions. Decoded results are intentionally not room inventory records.
 */
export function resolveRoom(query: string, buildings: Building[], rooms: Room[]): RoomResolution {
  const normalized = normalise(query);
  if (!normalized) {
    return emptyResolution(query, normalized, 'Enter a building code, room code, or documented building name.');
  }

  const qualified = campusQualifiedToken(normalized);
  const token = qualified.token;
  if (!token) {
    return emptyResolution(query, normalized, 'Enter a building code after the campus qualifier.');
  }

  const buildingsById = new Map(buildings.map((building) => [building.id, building]));
  const listedMatches = rooms
    .map((room) => {
      const building = buildingsById.get(room.buildingId);
      const roomToken = listedRoomToken(room);
      const roomCampus = roomToken.campus ?? building?.campus ?? room.campus;
      return { room, building, roomToken, roomCampus };
    })
    .filter(
      (candidate): candidate is { room: Room; building: Building; roomToken: CampusQualifiedToken; roomCampus: CampusId } =>
        candidate.building !== undefined &&
        candidate.roomToken.token === token &&
        (qualified.campus === null || candidate.roomCampus === qualified.campus),
    );

  const listedBuildingIds = uniqueBuildings(listedMatches.map((candidate) => candidate.building));
  if (listedBuildingIds.length > 1) {
    return ambiguousResolution(query, normalized, listedBuildingIds, token);
  }
  if (listedMatches.length > 0) {
    const { room, building } = listedMatches[0];
    const suffix = token.startsWith(buildingCode(building)) ? token.slice(buildingCode(building).length) : '';
    const parsed = parseSuffix(suffix);
    const floor = room.floor ?? parsed?.floor ?? null;
    const roomNumber = room.roomNumber ?? parsed?.roomNumber ?? null;
    const roomDetail = floor && roomNumber ? `, ${floorDescription(floor)}, room ${roomNumber}` : '';

    return {
      query,
      normalized,
      status: 'listed',
      building,
      room,
      floor,
      roomNumber,
      message: `${room.code} is a publicly listed room in ${building.name}${roomDetail}.`,
    };
  }

  const campusBuildings = qualified.campus
    ? buildings.filter((building) => building.campus === qualified.campus)
    : buildings;
  const directMatches = uniqueBuildings(
    campusBuildings.filter((building) => {
      const exactValues = [buildingCode(building), normalise(building.name), ...building.aliases.map(normalise)];
      return exactValues.some((value) => value === token || compact(value) === token);
    }),
  );

  if (directMatches.length > 1) {
    return ambiguousResolution(query, normalized, directMatches, token);
  }
  if (directMatches.length === 1) {
    const building = directMatches[0];
    return {
      query,
      normalized,
      status: 'decoded',
      building,
      room: null,
      floor: null,
      roomNumber: null,
      message: `Building ${building.code} — ${building.name} selected; no room was specified.`,
    };
  }

  const codes = [...new Set(campusBuildings.map(buildingCode))].sort((left, right) => right.length - left.length || left.localeCompare(right));
  const matchedCode = codes.find((code) => token.startsWith(code));

  if (!matchedCode) {
    const qualifier = qualified.campus ? ` on ${campusNames[qualified.campus]}` : '';
    return emptyResolution(query, normalized, `No documented building code matches ${token}${qualifier}.`);
  }

  const suffix = token.slice(matchedCode.length);
  const parsed = parseSuffix(suffix);
  const matchedBuildings = uniqueBuildings(campusBuildings.filter((building) => buildingCode(building) === matchedCode));

  if (!parsed) {
    return emptyResolution(
      query,
      normalized,
      `Building ${matchedCode} was recognised, but ${token} has no supported room suffix. Use a form such as ${matchedCode}101, ${matchedCode}G01, ${matchedCode}LG01, or ${matchedCode}001.`,
    );
  }

  if (matchedBuildings.length > 1) {
    return ambiguousResolution(query, normalized, matchedBuildings, token);
  }
  if (matchedBuildings.length === 0) {
    return emptyResolution(query, normalized, `No documented building is available for ${matchedCode}.`);
  }

  const building = matchedBuildings[0];
  return {
    query,
    normalized,
    status: 'decoded',
    building,
    room: null,
    floor: parsed.floor,
    roomNumber: parsed.roomNumber,
    message: `${token} decoded as ${building.name}, ${floorDescription(parsed.floor)}, room ${parsed.roomNumber}. Room not confirmed in public listings.`,
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extracts supported room-like tokens from timetable text, resolves them with the
 * caller-provided data, and preserves the first occurrence of each destination.
 */
export function extractTimetableRooms(text: string, buildings: Building[], rooms: Room[]): RoomResolution[] {
  const codes = [...new Set(buildings.map(buildingCode))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length || left.localeCompare(right));

  if (!text || codes.length === 0) {
    return [];
  }

  const codePattern = codes.map(escapeRegularExpression).join('|');
  const campusPattern = '(?:(?:GLA|GLASNEVIN|SPC|STP|ST\\.?\\s*PATRICK\'?S|AHC|ALL\\s*HALLOWS)[.:\\s/-]+)?';
  const suffixPattern = '(?:LG\\s*\\d{2,}|G\\s*\\d{2,}|B\\s*\\d{2,}|0\\s*\\d{2,}|[1-9]\\s*\\d{2,})(?:-[A-Z0-9]+)?';
  const matcher = new RegExp(`\\b${campusPattern}(?:${codePattern})\\s*${suffixPattern}\\b`, 'gi');
  const seen = new Set<string>();
  const results: RoomResolution[] = [];

  for (const match of text.matchAll(matcher)) {
    const resolution = resolveRoom(match[0], buildings, rooms);
    if ((resolution.status !== 'listed' && resolution.status !== 'decoded') || !resolution.building || !resolution.roomNumber) {
      continue;
    }

    const key = resolution.room?.id ?? `${resolution.building.id}|${resolution.floor ?? ''}|${resolution.roomNumber}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(resolution);
    }
  }

  return results;
}

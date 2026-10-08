import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson';
import type { Building, CampusId } from '../types';

/** Properties written by scripts/fetch-osm-buildings.mjs. */
export interface CampusFeatureProperties {
  osmType: 'way' | 'relation';
  osmId: number;
  name: string | null;
  ref: string | null;
  building: string | null;
  levels: string | null;
  note: string | null;
  kind: 'campus' | 'building';
  campus: CampusId;
  /** [lat, lng] of the footprint centroid (buildings only). */
  centroid?: [number, number];
}

export type CampusFeature = Feature<Polygon | MultiPolygon, CampusFeatureProperties>;
export type CampusFeatureCollection = FeatureCollection<Polygon | MultiPolygon, CampusFeatureProperties> & {
  attribution?: string;
  generated?: string;
  source?: string;
};

export interface FootprintMatch {
  building: Building;
  features: CampusFeature[];
  /** How the first footprint was associated with the building. */
  method: 'osm-id' | 'ref' | 'name' | 'containment' | 'none';
  /** Marker position: the building's sourced coordinate, else the footprint centroid. */
  position: [number, number] | null;
  positionSource: 'buildings.json' | 'osm-footprint' | null;
}

export function featureKey(feature: CampusFeature): string {
  return `${feature.properties.osmType}/${feature.properties.osmId}`;
}

function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function tokenSet(value: string): string {
  return normaliseName(value).split(' ').filter(Boolean).sort().join(' ');
}

function referencedWayIds(building: Building): number[] {
  const text = `${building.coordinateSource ?? ''} ${building.sourceUrls.join(' ')}`;
  return [...text.matchAll(/way[/ ](\d+)/g)].map((m) => Number(m[1]));
}

function pointInRing([lng, lat]: [number, number], ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(point: [number, number], rings: Position[][]): boolean {
  const [outer, ...inners] = rings;
  return pointInRing(point, outer) && !inners.some((ring) => pointInRing(point, ring));
}

export function featureContains(feature: CampusFeature, lat: number, lng: number): boolean {
  const point: [number, number] = [lng, lat];
  const { geometry } = feature;
  if (geometry.type === 'Polygon') return pointInPolygonRings(point, geometry.coordinates);
  return geometry.coordinates.some((rings) => pointInPolygonRings(point, rings));
}

/**
 * Associates OSM footprints with buildings.json records. Order of preference:
 * explicit OSM way ids cited in the record, then OSM `ref` tags on the same
 * campus (handles shared refs such as "S;SA"), then name/alias equality, then
 * containment of the sourced coordinate.
 */
export function matchFootprints(buildings: Building[], collection: CampusFeatureCollection): FootprintMatch[] {
  const footprints = collection.features.filter((f) => f.properties.kind === 'building');

  const byId = new Map<string, CampusFeature>();
  const byRef = new Map<string, CampusFeature[]>();
  const byName = new Map<string, CampusFeature[]>();
  const push = (map: Map<string, CampusFeature[]>, key: string, feature: CampusFeature) => {
    const list = map.get(key);
    if (list) list.push(feature);
    else map.set(key, [feature]);
  };

  for (const feature of footprints) {
    const { campus, ref, name } = feature.properties;
    byId.set(featureKey(feature), feature);
    if (ref) {
      for (const token of ref.split(/[;,]/)) {
        const code = token.trim().toUpperCase();
        if (code) push(byRef, `${campus}:${code}`, feature);
      }
    }
    if (name) push(byName, `${campus}:${tokenSet(name)}`, feature);
  }

  return buildings.map((building) => {
    const found = new Map<string, CampusFeature>();
    let method: FootprintMatch['method'] = 'none';
    const add = (features: CampusFeature[] | undefined, how: FootprintMatch['method']) => {
      for (const feature of features ?? []) {
        if (!found.has(featureKey(feature))) {
          found.set(featureKey(feature), feature);
          if (method === 'none') method = how;
        }
      }
    };

    add(
      referencedWayIds(building)
        .map((id) => byId.get(`way/${id}`))
        .filter((f): f is CampusFeature => Boolean(f)),
      'osm-id',
    );

    if (found.size === 0) {
      add(byRef.get(`${building.campus}:${building.code.toUpperCase()}`), 'ref');
      for (const alias of [building.name, ...building.aliases]) {
        add(byName.get(`${building.campus}:${tokenSet(alias)}`), 'name');
      }
    }

    if (found.size === 0 && building.lat !== null && building.lng !== null) {
      const { lat, lng } = building;
      add(
        footprints.filter((f) => f.properties.campus === building.campus && featureContains(f, lat, lng)),
        'containment',
      );
    }

    const features = [...found.values()];
    let position: [number, number] | null = null;
    let positionSource: FootprintMatch['positionSource'] = null;
    if (building.lat !== null && building.lng !== null) {
      position = [building.lat, building.lng];
      positionSource = 'buildings.json';
    } else if (features[0]?.properties.centroid) {
      position = features[0].properties.centroid;
      positionSource = 'osm-footprint';
    }

    return { building, features, method, position, positionSource };
  });
}

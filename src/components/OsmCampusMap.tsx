import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Building, CampusMapProps } from '../types';
import campusGeoJsonText from '../data/campus-buildings.geojson?raw';
import {
  featureKey,
  matchFootprints,
  type CampusFeature,
  type CampusFeatureCollection,
  type FootprintMatch,
} from '../lib/campusFootprints';

const campusCollection = JSON.parse(campusGeoJsonText) as CampusFeatureCollection;

const OSM_COPYRIGHT_URL = 'https://www.openstreetmap.org/copyright';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors';

// A viewpoint near the centre of DCU Glasnevin, not a building entrance.
const GLASNEVIN_CENTER: L.LatLngTuple = [53.3856, -6.2578];
const GLASNEVIN_ZOOM = 16;
const BUILDING_ZOOM = 18;
// Covers Glasnevin, St Patrick's and All Hallows with a little slack for panning.
const DCU_MAX_BOUNDS = L.latLngBounds([53.362, -6.278], [53.396, -6.232]);
const MIN_ZOOM = 14;
const MAX_ZOOM = 19;

const CAMPUS_LABELS: Record<Building['campus'], string> = {
  glasnevin: 'Glasnevin',
  stpatricks: "St Patrick's",
  allhallows: 'All Hallows',
  other: 'Other',
};

const FOOTPRINT_STYLE: L.PathOptions = {
  color: '#5b6b85',
  weight: 1,
  fillColor: '#9aa8bf',
  fillOpacity: 0.3,
};
const MATCHED_STYLE: L.PathOptions = {
  color: '#0b4fa3',
  weight: 1.5,
  fillColor: '#1663ef',
  fillOpacity: 0.28,
};
const SELECTED_STYLE: L.PathOptions = {
  color: '#0b1b3a',
  weight: 3,
  fillColor: '#1663ef',
  fillOpacity: 0.5,
};
const CAMPUS_STYLE: L.PathOptions = {
  color: '#1663ef',
  weight: 2,
  dashArray: '6 6',
  fill: false,
  interactive: false,
};

const rootStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
  background: '#e9eef2',
  // Own stacking context: Leaflet panes/controls and our overlays stay below the app side panel.
  zIndex: 0,
};

const hostStyle: CSSProperties = {
  width: '100%',
  height: '100%',
};

// Overlays are positioned top-left inline; styles.css moves them to the right edge on desktop.
const overlayBase: CSSProperties = {
  position: 'absolute',
  zIndex: 1000,
  left: 12,
  border: '1px solid rgba(15, 35, 57, 0.14)',
  borderRadius: 8,
  background: 'rgba(255, 255, 255, 0.94)',
  color: '#102a43',
  boxShadow: '0 2px 10px rgba(15, 35, 57, 0.12)',
  fontSize: 13,
  lineHeight: 1.35,
};

const statusStyle: CSSProperties = {
  ...overlayBase,
  top: 12,
  maxWidth: 'min(360px, calc(100% - 24px))',
  padding: '8px 10px',
};

const controlStyle: CSSProperties = {
  ...overlayBase,
  top: 58,
  minHeight: 36,
  padding: '8px 11px',
  border: '1px solid #0b63ce',
  background: '#ffffff',
  color: '#0b4fa3',
  cursor: 'pointer',
  fontWeight: 700,
  borderRadius: 7,
};

const selectionStyle: CSSProperties = {
  ...overlayBase,
  top: 106,
  maxWidth: 'min(340px, calc(100% - 24px))',
  padding: '10px 12px',
  background: 'rgba(255, 255, 255, 0.96)',
  lineHeight: 1.4,
};

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function flightOptions(): L.ZoomPanOptions {
  return prefersReducedMotion() ? { animate: false } : { animate: true, duration: 1 };
}

function pinIcon(building: Building, selected: boolean, inferred: boolean): L.DivIcon {
  const classes = ['campus-map__pin'];
  if (selected) classes.push('campus-map__pin--selected');
  if (inferred) classes.push('campus-map__pin--inferred');
  return L.divIcon({
    className: 'campus-map__pin-wrap',
    html: `<span class="${classes.join(' ')}">${escapeHtml(building.code)}</span>`,
    iconSize: undefined,
    iconAnchor: [0, 0],
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function pinPrecisionLabel(match: FootprintMatch): string {
  if (match.positionSource === 'osm-footprint') {
    return 'OpenStreetMap footprint centre (no sourced coordinate in buildings.json)';
  }
  switch (match.building.coordinatePrecision) {
    case 'building':
      return 'Building-level coordinate';
    case 'approximate':
      return 'Approximate building-centre pin';
    default:
      return 'Coordinate precision has not been verified';
  }
}

function outdoorDirectionsUrl(position: [number, number] | null): string | null {
  if (!position) return null;
  const destination = encodeURIComponent(`${position[0]},${position[1]}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;
}

type MapRefs = {
  map: L.Map;
  markers: Map<string, L.Marker>;
  footprintLayers: Map<string, L.Path>;
  footprintBuildingIds: Map<string, string[]>;
};

/**
 * Local-first campus map: OpenStreetMap raster tiles, OSM building footprints bundled
 * from src/data/campus-buildings.geojson, and a labelled capsule pin per building.
 * No API key required.
 */
export default function OsmCampusMap({ buildings, selectedBuilding, onSelectBuilding }: CampusMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const refs = useRef<MapRefs | null>(null);
  const onSelectBuildingRef = useRef(onSelectBuilding);
  const selectedIdRef = useRef<string | null>(selectedBuilding?.id ?? null);
  const [tileStatus, setTileStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    onSelectBuildingRef.current = onSelectBuilding;
  }, [onSelectBuilding]);

  const matches = useMemo(() => matchFootprints(buildings, campusCollection), [buildings]);
  const matchById = useMemo(() => new Map(matches.map((m) => [m.building.id, m])), [matches]);

  const stats = useMemo(() => {
    const footprints = campusCollection.features.filter((f) => f.properties.kind === 'building').length;
    const matched = matches.filter((m) => m.features.length > 0).length;
    const pinned = matches.filter((m) => m.position !== null).length;
    return { footprints, matched, pinned, total: buildings.length };
  }, [matches, buildings.length]);

  // Create the map once per host element and buildings list.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    const map = L.map(host, {
      center: GLASNEVIN_CENTER,
      zoom: GLASNEVIN_ZOOM,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      maxBounds: DCU_MAX_BOUNDS,
      maxBoundsViscosity: 1,
      zoomControl: false,
      attributionControl: false,
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);
    L.control.attribution({ position: 'bottomright', prefix: false }).addTo(map);

    const tiles = L.tileLayer(TILE_URL, {
      attribution: TILE_ATTRIBUTION,
      maxZoom: MAX_ZOOM,
      maxNativeZoom: 19,
      crossOrigin: true,
    });
    let tilesFailed = false;
    tiles.on('load', () => {
      if (!tilesFailed) setTileStatus('ready');
    });
    tiles.on('tileerror', () => {
      tilesFailed = true;
      setTileStatus('error');
    });
    tiles.addTo(map);

    const footprintLayers = new Map<string, L.Path>();
    const footprintBuildingIds = new Map<string, string[]>();
    for (const match of matches) {
      for (const feature of match.features) {
        const key = featureKey(feature);
        const list = footprintBuildingIds.get(key);
        if (list) list.push(match.building.id);
        else footprintBuildingIds.set(key, [match.building.id]);
      }
    }

    L.geoJSON(campusCollection as GeoJSON.FeatureCollection, {
      filter: (feature) => (feature as CampusFeature).properties.kind === 'campus',
      style: CAMPUS_STYLE,
      interactive: false,
    }).addTo(map);

    L.geoJSON(campusCollection as GeoJSON.FeatureCollection, {
      filter: (feature) => (feature as CampusFeature).properties.kind === 'building',
      style: (feature) => {
        const key = featureKey(feature as CampusFeature);
        return footprintBuildingIds.has(key) ? MATCHED_STYLE : FOOTPRINT_STYLE;
      },
      onEachFeature: (feature, layer) => {
        const typed = feature as CampusFeature;
        const key = featureKey(typed);
        if (layer instanceof L.Path) footprintLayers.set(key, layer);
        const owners = footprintBuildingIds.get(key) ?? [];
        const label = typed.properties.name ?? typed.properties.ref ?? 'Building';
        if (owners.length > 0) {
          const first = matchById.get(owners[0]);
          if (first) {
            layer.bindTooltip(`${first.building.code} · ${first.building.name}`, { sticky: true, direction: 'top' });
            layer.on('click', (event) => {
              L.DomEvent.stopPropagation(event);
              onSelectBuildingRef.current(first.building);
            });
          }
        } else {
          layer.bindTooltip(`${label} (OSM, not in building list)`, { sticky: true, direction: 'top' });
        }
      },
    }).addTo(map);

    const markers = new Map<string, L.Marker>();
    for (const match of matches) {
      if (!match.position) continue;
      const { building } = match;
      const marker = L.marker(match.position, {
        icon: pinIcon(building, building.id === selectedIdRef.current, match.positionSource === 'osm-footprint'),
        title: `${building.name} (${building.code}, ${CAMPUS_LABELS[building.campus]})`,
        alt: `${building.code} ${building.name}`,
        keyboard: true,
        riseOnHover: true,
        zIndexOffset: building.id === selectedIdRef.current ? 1000 : 0,
      });
      marker.on('click', (event) => {
        L.DomEvent.stopPropagation(event);
        onSelectBuildingRef.current(building);
      });
      marker.addTo(map);
      markers.set(building.id, marker);
    }

    refs.current = { map, markers, footprintLayers, footprintBuildingIds };

    // Leaflet measures the container on creation; make sure it has the final size.
    const resize = () => map.invalidateSize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(host);
    requestAnimationFrame(resize);

    return () => {
      observer?.disconnect();
      if (refs.current?.map === map) refs.current = null;
      map.remove();
      setTileStatus('loading');
    };
  }, [matches, matchById]);

  // Highlight and fly to the selected building.
  useEffect(() => {
    const current = refs.current;
    selectedIdRef.current = selectedBuilding?.id ?? null;
    if (!current) return;
    const { map, markers, footprintLayers, footprintBuildingIds } = current;

    for (const [id, marker] of markers) {
      const match = matchById.get(id);
      if (!match) continue;
      const selected = id === selectedBuilding?.id;
      marker.setIcon(pinIcon(match.building, selected, match.positionSource === 'osm-footprint'));
      marker.setZIndexOffset(selected ? 1000 : 0);
    }

    for (const [key, layer] of footprintLayers) {
      const owners = footprintBuildingIds.get(key) ?? [];
      const selected = selectedBuilding !== null && owners.includes(selectedBuilding.id);
      layer.setStyle(selected ? SELECTED_STYLE : owners.length > 0 ? MATCHED_STYLE : FOOTPRINT_STYLE);
      if (selected) layer.bringToFront();
    }

    if (!selectedBuilding) return;
    const match = matchById.get(selectedBuilding.id);
    if (!match) return;

    const bounds = L.latLngBounds([]);
    for (const feature of match.features) {
      const layer = footprintLayers.get(featureKey(feature));
      if (layer instanceof L.Polygon) bounds.extend(layer.getBounds());
    }
    if (match.position) bounds.extend(match.position);

    if (bounds.isValid()) {
      map.flyToBounds(bounds, { ...flightOptions(), maxZoom: BUILDING_ZOOM, padding: [48, 48] });
    }
  }, [selectedBuilding, matchById]);

  const returnToOverview = () => {
    refs.current?.map.flyTo(GLASNEVIN_CENTER, GLASNEVIN_ZOOM, flightOptions());
  };

  const selectedMatch = selectedBuilding ? matchById.get(selectedBuilding.id) ?? null : null;
  const directionsUrl = selectedMatch ? outdoorDirectionsUrl(selectedMatch.position) : null;

  const statusMessage =
    tileStatus === 'error'
      ? 'OpenStreetMap tiles could not load (offline?). Building footprints and pins are still shown from local data.'
      : `OpenStreetMap map — ${stats.footprints} OSM footprints, ${stats.matched}/${stats.total} buildings matched, ${stats.pinned} pinned.`;

  return (
    <section
      className="campus-map campus-map--osm"
      style={rootStyle}
      aria-label="DCU interactive campus map (OpenStreetMap)"
    >
      <div ref={hostRef} className="campus-map__host campus-map__leaflet" style={hostStyle} aria-label="Campus map" />

      <div
        className={`campus-map__status campus-map__status--${tileStatus}`}
        style={statusStyle}
        role={tileStatus === 'error' ? 'alert' : 'status'}
        aria-live="polite"
      >
        <strong>{statusMessage}</strong>{' '}
        <span className="campus-map__attribution">
          Data{' '}
          <a href={OSM_COPYRIGHT_URL} target="_blank" rel="noreferrer">
            © OpenStreetMap contributors
          </a>{' '}
          (ODbL). No API key needed.
        </span>
      </div>

      <button
        className="campus-map__overview-control"
        style={controlStyle}
        type="button"
        onClick={returnToOverview}
        aria-label="Return to the DCU Glasnevin overview"
      >
        Campus overview
      </button>

      {selectedBuilding && selectedMatch && (
        <aside className="campus-map__selection" style={selectionStyle} aria-live="polite">
          <strong>
            {selectedBuilding.code} · {selectedBuilding.name}
          </strong>
          <div>Campus: {CAMPUS_LABELS[selectedBuilding.campus]}.</div>
          <div>Pin precision: {pinPrecisionLabel(selectedMatch)}.</div>
          <div>
            {selectedMatch.features.length > 0
              ? `Footprint: ${selectedMatch.features.length} OSM ${selectedMatch.features.length === 1 ? 'polygon' : 'polygons'} (matched by ${selectedMatch.method}).`
              : 'No OSM footprint matched for this building.'}
          </div>
          {!selectedMatch.position && <div>No coordinate available — this building is not pinned on the map.</div>}
          <div>Outdoor location only — this map does not provide indoor routing.</div>
          {directionsUrl && (
            <a
              href={directionsUrl}
              target="_blank"
              rel="noreferrer"
              className="campus-map__directions-link"
              style={{ color: '#0b4fa3', fontWeight: 700 }}
            >
              Open outdoor walking directions
            </a>
          )}
        </aside>
      )}
    </section>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { AlertTriangle, Compass, Footprints, LocateFixed } from 'lucide-react';
import './routing.css';
import type { Building, CampusMapProps } from '../types';
import { BUILDING_COLOR, floorStyle } from '../lib/floors';
import campusGeoJsonText from '../data/campus-buildings.geojson?raw';
import pathsGeoJsonText from '../data/campus-paths.geojson?raw';
import {
  featureKey,
  matchFootprints,
  type CampusFeature,
  type CampusFeatureCollection,
  type FootprintMatch,
} from '../lib/campusFootprints';
import {
  buildPathGraph,
  formatDistance,
  formatMinutes,
  haversineMetres,
  routeToBuilding,
  type LatLng,
  type PathFeatureCollection,
  type PathGraph,
  type RouteResult,
} from '../lib/routing';

const campusCollection = JSON.parse(campusGeoJsonText) as CampusFeatureCollection;
const pathCollection = JSON.parse(pathsGeoJsonText) as PathFeatureCollection;

let pathGraphCache: PathGraph | null = null;
function getPathGraph(): PathGraph {
  if (!pathGraphCache) pathGraphCache = buildPathGraph(pathCollection);
  return pathGraphCache;
}

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

// Where the campus avenue meets Collins Avenue: Glasnevin's main entrance, approximately
// (read off the OSM path network, not a verified entrance coordinate).
const GLASNEVIN_MAIN_ENTRANCE: LatLng = [53.38765, -6.25844];
// Approximate campus centres used only to decide whether a GPS fix is anywhere near DCU.
const CAMPUS_CENTRES: LatLng[] = [
  [53.3856, -6.2578], // Glasnevin
  [53.3712, -6.2535], // St Patrick's
  [53.3703, -6.2487], // All Hallows
];
const FAR_FROM_CAMPUS_METRES = 3000;
// Position updates closer than this (metres) or sooner than this (ms) are coalesced.
const MIN_MOVE_METRES = 10;
const MIN_UPDATE_INTERVAL_MS = 2000;

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
// The selected footprint takes the selected floor's colour (see src/lib/floors.ts).
function selectedStyleFor(accent: string): L.PathOptions {
  return { color: '#0f1f3d', weight: 3, fillColor: accent, fillOpacity: 0.55 };
}
const CAMPUS_STYLE: L.PathOptions = {
  color: '#1663ef',
  weight: 2,
  dashArray: '6 6',
  fill: false,
  interactive: false,
};
const ROUTE_CASING_STYLE: L.PolylineOptions = {
  color: '#ffffff',
  weight: 9,
  opacity: 0.9,
  lineCap: 'round',
  lineJoin: 'round',
  interactive: false,
};
const ROUTE_STYLE: L.PolylineOptions = {
  color: '#1663ef',
  weight: 5,
  opacity: 0.95,
  dashArray: '10 8',
  lineCap: 'round',
  lineJoin: 'round',
  interactive: false,
};
const ACCURACY_STYLE: L.PathOptions = {
  color: '#1663ef',
  weight: 1,
  opacity: 0.6,
  fillColor: '#1663ef',
  fillOpacity: 0.12,
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

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
}

function flightOptions(): L.ZoomPanOptions {
  return prefersReducedMotion() ? { animate: false } : { animate: true, duration: 1 };
}

function pinIcon(building: Building, selected: boolean, inferred: boolean, accent: string): L.DivIcon {
  const classes = ['campus-map__pin'];
  if (selected) classes.push('campus-map__pin--selected');
  if (inferred) classes.push('campus-map__pin--inferred');
  return L.divIcon({
    className: 'campus-map__pin-wrap',
    html: `<span class="${classes.join(' ')}" style="--pin-color:${accent}">${escapeHtml(building.code)}</span>`,
    iconSize: undefined,
    iconAnchor: [0, 0],
  });
}

function userIcon(demo: boolean): L.DivIcon {
  const classes = ['campus-map__user-dot'];
  if (demo) classes.push('campus-map__user-dot--demo');
  return L.divIcon({
    className: 'campus-map__user-marker',
    html: `<span class="${classes.join(' ')}"></span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function pinPrecisionLabel(match: FootprintMatch): string {
  if (match.positionSource === 'osm-footprint') {
    return 'OpenStreetMap footprint centre';
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

type GeoStatus = 'idle' | 'locating' | 'watching' | 'denied' | 'unavailable' | 'timeout' | 'insecure' | 'unsupported';

interface UserFix {
  lat: number;
  lng: number;
  /** Reported accuracy radius in metres. */
  accuracy: number;
}

interface RouteOrigin {
  point: LatLng;
  kind: 'gps' | 'demo';
  accuracy: number | null;
}

type MapRefs = {
  map: L.Map;
  markers: Map<string, L.Marker>;
  footprintLayers: Map<string, L.Path>;
  footprintBuildingIds: Map<string, string[]>;
};

function distanceToNearestCampus(point: LatLng): number {
  return Math.min(...CAMPUS_CENTRES.map((centre) => haversineMetres(centre, point)));
}

/**
 * Local-first campus map: OpenStreetMap raster tiles, OSM building footprints bundled
 * from src/data/campus-buildings.geojson, a labelled capsule pin per building, and
 * on-device walking routes over the OSM path network in src/data/campus-paths.geojson.
 * No API key required.
 */
export default function OsmCampusMap({
  buildings,
  selectedBuilding,
  onSelectBuilding,
  selectedFloor = null,
  onRouteChange,
}: CampusMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const accent = selectedFloor ? floorStyle(selectedFloor).color : BUILDING_COLOR;
  const refs = useRef<MapRefs | null>(null);
  const onSelectBuildingRef = useRef(onSelectBuilding);
  const selectedIdRef = useRef<string | null>(selectedBuilding?.id ?? null);
  const [tileStatus, setTileStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  // Bumped whenever the Leaflet map is (re)created so layer effects re-attach.
  const [mapVersion, setMapVersion] = useState(0);

  // Geolocation state.
  const [geoStatus, setGeoStatus] = useState<GeoStatus>('idle');
  const [fix, setFix] = useState<UserFix | null>(null);
  const [useDemoStart, setUseDemoStart] = useState(false);
  const watchIdRef = useRef<number | null>(null);
  const lastAppliedRef = useRef<{ fix: UserFix; at: number } | null>(null);
  const pendingFixRef = useRef<UserFix | null>(null);
  const pendingTimerRef = useRef<number | null>(null);

  // Route layers.
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const userLayerRef = useRef<L.LayerGroup | null>(null);
  const fittedRouteForRef = useRef<string | null>(null);

  useEffect(() => {
    onSelectBuildingRef.current = onSelectBuilding;
  }, [onSelectBuilding]);

  const matches = useMemo(() => matchFootprints(buildings, campusCollection), [buildings]);
  const matchById = useMemo(() => new Map(matches.map((m) => [m.building.id, m])), [matches]);
  const graph = useMemo(() => getPathGraph(), []);

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
        icon: pinIcon(building, building.id === selectedIdRef.current, match.positionSource === 'osm-footprint', BUILDING_COLOR),
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
    routeLayerRef.current = null;
    userLayerRef.current = null;
    fittedRouteForRef.current = null;
    setMapVersion((v) => v + 1);

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
      marker.setIcon(pinIcon(match.building, selected, match.positionSource === 'osm-footprint', accent));
      marker.setZIndexOffset(selected ? 1000 : 0);
    }

    const selectedStyle = selectedStyleFor(accent);
    for (const [key, layer] of footprintLayers) {
      const owners = footprintBuildingIds.get(key) ?? [];
      const selected = selectedBuilding !== null && owners.includes(selectedBuilding.id);
      layer.setStyle(selected ? selectedStyle : owners.length > 0 ? MATCHED_STYLE : FOOTPRINT_STYLE);
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
  }, [selectedBuilding, matchById, mapVersion, accent]);

  // ---------- geolocation ----------

  const clearPendingFix = useCallback(() => {
    if (pendingTimerRef.current !== null) {
      window.clearTimeout(pendingTimerRef.current);
      pendingTimerRef.current = null;
    }
    pendingFixRef.current = null;
  }, []);

  const stopWatching = useCallback(() => {
    if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
    }
    watchIdRef.current = null;
    clearPendingFix();
    lastAppliedRef.current = null;
  }, [clearPendingFix]);

  const applyFix = useCallback((candidate: UserFix) => {
    lastAppliedRef.current = { fix: candidate, at: Date.now() };
    setFix(candidate);
    setGeoStatus('watching');
  }, []);

  /** Coalesces jittery updates: ignore moves under 10 m, and apply at most one update per 2 s. */
  const handlePosition = useCallback(
    (position: GeolocationPosition) => {
      const candidate: UserFix = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      const last = lastAppliedRef.current;
      if (!last) {
        applyFix(candidate);
        return;
      }
      const moved = haversineMetres([last.fix.lat, last.fix.lng], [candidate.lat, candidate.lng]);
      const accuracyImproved = candidate.accuracy < last.fix.accuracy * 0.5;
      if (moved < MIN_MOVE_METRES && !accuracyImproved) return;
      const elapsed = Date.now() - last.at;
      if (elapsed >= MIN_UPDATE_INTERVAL_MS) {
        clearPendingFix();
        applyFix(candidate);
        return;
      }
      pendingFixRef.current = candidate;
      if (pendingTimerRef.current === null) {
        pendingTimerRef.current = window.setTimeout(() => {
          pendingTimerRef.current = null;
          const pending = pendingFixRef.current;
          pendingFixRef.current = null;
          if (pending) applyFix(pending);
        }, MIN_UPDATE_INTERVAL_MS - elapsed);
      }
    },
    [applyFix, clearPendingFix],
  );

  const handlePositionError = useCallback(
    (error: GeolocationPositionError) => {
      if (error.code === error.PERMISSION_DENIED) {
        stopWatching();
        setFix(null);
        setGeoStatus('denied');
      } else if (error.code === error.POSITION_UNAVAILABLE) {
        setGeoStatus('unavailable');
      } else {
        // Timeout: keep watching; a later fix may still arrive.
        setGeoStatus((status) => (status === 'watching' ? status : 'timeout'));
      }
    },
    [stopWatching],
  );

  const startWatching = useCallback(() => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator) || !navigator.geolocation) {
      setGeoStatus('unsupported');
      return;
    }
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      setGeoStatus('insecure');
      return;
    }
    stopWatching();
    setGeoStatus('locating');
    watchIdRef.current = navigator.geolocation.watchPosition(handlePosition, handlePositionError, {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 20000,
    });
  }, [handlePosition, handlePositionError, stopWatching]);

  const toggleLocation = () => {
    if (geoStatus === 'locating' || geoStatus === 'watching' || geoStatus === 'timeout') {
      stopWatching();
      setFix(null);
      setGeoStatus('idle');
    } else {
      startWatching();
    }
  };

  // Stop watching on unmount.
  useEffect(() => () => stopWatching(), [stopWatching]);

  const watching = geoStatus === 'locating' || geoStatus === 'watching' || geoStatus === 'timeout';
  const farFromCampus = fix ? distanceToNearestCampus([fix.lat, fix.lng]) : null;
  const fixIsFar = farFromCampus !== null && farFromCampus > FAR_FROM_CAMPUS_METRES;
  const locationUnusable =
    fixIsFar || ['denied', 'unavailable', 'insecure', 'unsupported'].includes(geoStatus) || (geoStatus === 'timeout' && !fix);

  const origin: RouteOrigin | null = useMemo(() => {
    if (useDemoStart) return { point: GLASNEVIN_MAIN_ENTRANCE, kind: 'demo', accuracy: null };
    if (fix && !fixIsFar) return { point: [fix.lat, fix.lng], kind: 'gps', accuracy: fix.accuracy };
    return null;
  }, [useDemoStart, fix, fixIsFar]);

  // ---------- routing ----------

  const selectedMatch = selectedBuilding ? matchById.get(selectedBuilding.id) ?? null : null;

  const originLat = origin?.point[0] ?? null;
  const originLng = origin?.point[1] ?? null;
  const route: RouteResult | null = useMemo(() => {
    if (originLat === null || originLng === null || !selectedMatch) return null;
    return routeToBuilding(graph, [originLat, originLng], selectedMatch);
  }, [graph, originLat, originLng, selectedMatch]);

  // User marker + accuracy circle.
  useEffect(() => {
    const current = refs.current;
    if (!current) return;
    userLayerRef.current?.remove();
    userLayerRef.current = null;
    if (!origin) return;
    const layers: L.Layer[] = [];
    if (origin.kind === 'gps' && origin.accuracy !== null && Number.isFinite(origin.accuracy)) {
      layers.push(L.circle(origin.point, { ...ACCURACY_STYLE, radius: Math.max(origin.accuracy, 5) }));
    }
    layers.push(
      L.marker(origin.point, {
        icon: userIcon(origin.kind === 'demo'),
        title: origin.kind === 'demo' ? 'Demo start: Glasnevin main entrance (approximate)' : 'Your location',
        alt: origin.kind === 'demo' ? 'Demo start point' : 'Your location',
        interactive: false,
        keyboard: false,
        zIndexOffset: 2000,
      }),
    );
    userLayerRef.current = L.layerGroup(layers).addTo(current.map);
  }, [origin, mapVersion]);

  // Route polyline; fit the view to it the first time a route is drawn for a destination.
  useEffect(() => {
    const current = refs.current;
    if (!current) return;
    routeLayerRef.current?.remove();
    routeLayerRef.current = null;
    if (!route || !selectedBuilding) {
      fittedRouteForRef.current = null;
      return;
    }
    const casing = L.polyline(route.coordinates, ROUTE_CASING_STYLE);
    const line = L.polyline(route.coordinates, { ...ROUTE_STYLE, color: accent });
    routeLayerRef.current = L.layerGroup([casing, line]).addTo(current.map);
    if (fittedRouteForRef.current !== selectedBuilding.id) {
      fittedRouteForRef.current = selectedBuilding.id;
      current.map.flyToBounds(line.getBounds(), { ...flightOptions(), padding: [56, 56], maxZoom: BUILDING_ZOOM });
    }
  }, [route, selectedBuilding, mapVersion, accent]);

  // Let the side panel show the route summary next to the destination.
  useEffect(() => {
    onRouteChange?.(
      route && origin
        ? { distanceMetres: route.distanceMetres, walkingMinutes: route.walkingMinutes, origin: origin.kind }
        : null,
    );
  }, [route, origin, onRouteChange]);

  const returnToOverview = () => {
    refs.current?.map.flyTo(GLASNEVIN_CENTER, GLASNEVIN_ZOOM, flightOptions());
  };

  const originLabel = origin?.kind === 'demo' ? 'the main entrance (demo)' : 'you';

  const geoNotice = (() => {
    switch (geoStatus) {
      case 'locating':
        return { tone: '', text: 'Finding your location…' };
      case 'watching':
        if (fix && fixIsFar) {
          return {
            tone: 'warn',
            text: `You're about ${(farFromCampus! / 1000).toFixed(1)} km from DCU, too far to route from.`,
          };
        }
        return null;
      case 'timeout':
        return fix ? null : { tone: 'warn', text: 'Still waiting for a location fix.' };
      case 'denied':
        return { tone: 'error', text: 'Location access was denied for this site.' };
      case 'unavailable':
        return { tone: 'error', text: 'Your device could not find a position.' };
      case 'insecure':
        return { tone: 'error', text: 'Location needs an https page.' };
      case 'unsupported':
        return { tone: 'error', text: 'This browser has no geolocation.' };
      default:
        return null;
    }
  })();

  const showDemoToggle = locationUnusable || useDemoStart;
  const dataSummary = `${stats.footprints} OSM footprints · ${stats.matched}/${stats.total} buildings matched · ${stats.pinned} pinned · ${graph.stats.ways} paths`;
  const pinNote = selectedMatch ? pinPrecisionLabel(selectedMatch) : null;

  return (
    <section
      className="campus-map campus-map--osm"
      style={rootStyle}
      aria-label="DCU interactive campus map (OpenStreetMap)"
    >
      <div ref={hostRef} className="campus-map__host campus-map__leaflet" style={hostStyle} aria-label="Campus map" />

      <div className="campus-map__stack">
        <div className="campus-map__controls" role="group" aria-label="Map controls" title={dataSummary}>
          <button className="campus-map__control" type="button" onClick={returnToOverview} aria-label="Return to the campus overview">
            <Compass size={16} aria-hidden="true" />
            <span>Overview</span>
          </button>
          <button
            className={`campus-map__control${watching ? ' campus-map__control--active' : ''}`}
            type="button"
            onClick={toggleLocation}
            aria-pressed={watching}
            aria-label={watching ? 'Stop using my location' : 'Use my location to draw a walking route'}
          >
            <LocateFixed size={16} aria-hidden="true" />
            <span>{watching ? 'Locating' : 'My location'}</span>
          </button>
        </div>

        {tileStatus === 'error' && (
          <div className="campus-map__notice campus-map__notice--warn" role="alert">
            <AlertTriangle size={14} aria-hidden="true" />
            <span>Map tiles could not load. Buildings and routes still work from local data.</span>
          </div>
        )}

        {(geoNotice || showDemoToggle) && (
          <div
            className={`campus-map__notice${geoNotice?.tone ? ` campus-map__notice--${geoNotice.tone}` : ''}`}
            role={geoNotice?.tone === 'error' ? 'alert' : 'status'}
            aria-live="polite"
          >
            {geoNotice && <span>{geoNotice.text}</span>}
            {showDemoToggle && (
              <label className="campus-map__toggle">
                <input type="checkbox" checked={useDemoStart} onChange={(event) => setUseDemoStart(event.target.checked)} />
                <span>Demo from the main entrance</span>
              </label>
            )}
          </div>
        )}
      </div>

      {selectedBuilding && selectedMatch && origin && (
        <div className="campus-map__route-pill" style={{ '--accent': accent } as CSSProperties} aria-live="polite">
          <Footprints size={16} aria-hidden="true" />
          {route ? (
            <>
              <strong>{formatDistance(route.distanceMetres)}</strong>
              <span className="campus-map__route-sep">·</span>
              <strong>{formatMinutes(route.walkingMinutes)}</strong>
              <small>from {originLabel}</small>
            </>
          ) : (
            <small>No mapped path from {originLabel}{pinNote ? ` · ${pinNote}` : ''}</small>
          )}
        </div>
      )}
    </section>
  );
}

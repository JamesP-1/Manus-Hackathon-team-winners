import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Building, CampusMapProps } from '../types';
import { loadGoogleMapsLibrary } from '../lib/googleMaps';

type MapDisplayMode = 'loading' | 'three-d' | 'two-d' | 'error';

type LatLngLiteral = {
  lat: number;
  lng: number;
  altitude?: number;
};

type CameraOptions = {
  center: LatLngLiteral;
  range: number;
  tilt: number;
  heading: number;
};

type Map3DInstance = HTMLElement & {
  flyCameraTo?: (options: {
    endCamera: CameraOptions;
    durationMillis: number;
  }) => void;
  stopCameraAnimation?: () => void;
};

type Map3DLibrary = {
  Map3DElement: new (options: CameraOptions & { mode?: unknown }) => Map3DInstance;
  Marker3DInteractiveElement: new (options: {
    position: LatLngLiteral;
    label?: string;
  }) => HTMLElement;
  MapMode?: { SATELLITE?: unknown };
};

type Google2DMapInstance = {
  panTo?: (position: LatLngLiteral) => void;
  setZoom?: (zoom: number) => void;
};

type Google2DMarker = {
  addListener?: (
    eventName: 'click',
    listener: () => void,
  ) => { remove?: () => void } | undefined;
  setMap?: (map: Google2DMapInstance | null) => void;
};

type Google2DMapsLibrary = {
  Map: new (
    element: HTMLElement,
    options: {
      center: LatLngLiteral;
      zoom: number;
      mapTypeId: 'satellite';
      streetViewControl: boolean;
      fullscreenControl: boolean;
      mapTypeControl: boolean;
    },
  ) => Google2DMapInstance;
  Marker?: new (options: {
    position: LatLngLiteral;
    map: Google2DMapInstance;
    label: string;
    title: string;
  }) => Google2DMarker;
};

const MAPS_3D_SETUP_URL =
  'https://developers.google.com/maps/documentation/javascript/3d/get-started';
const MAPS_3D_COVERAGE_URL = 'https://developers.google.com/maps/coverage';

// A map viewpoint near the centre of DCU Glasnevin, not a building entrance or room coordinate.
const GLASNEVIN_OVERVIEW_CAMERA: CameraOptions = {
  center: { lat: 53.38565, lng: -6.25785, altitude: 65 },
  range: 1_650,
  tilt: 55,
  heading: -18,
};

const rootStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minHeight: 0,
  overflow: 'hidden',
  background: '#e9eef2',
};

const hostStyle: CSSProperties = {
  width: '100%',
  height: '100%',
};

const statusStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 2,
  top: 12,
  left: 12,
  maxWidth: 'min(360px, calc(100% - 24px))',
  padding: '8px 10px',
  border: '1px solid rgba(15, 35, 57, 0.14)',
  borderRadius: 8,
  background: 'rgba(255, 255, 255, 0.94)',
  color: '#102a43',
  boxShadow: '0 2px 10px rgba(15, 35, 57, 0.12)',
  fontSize: 13,
  lineHeight: 1.35,
};

const controlStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 2,
  top: 58,
  left: 12,
  minHeight: 36,
  padding: '8px 11px',
  border: '1px solid #0b63ce',
  borderRadius: 7,
  background: '#ffffff',
  color: '#0b4fa3',
  boxShadow: '0 2px 10px rgba(15, 35, 57, 0.12)',
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 700,
};

const selectionStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 2,
  top: 106,
  left: 12,
  maxWidth: 'min(340px, calc(100% - 24px))',
  padding: '10px 12px',
  border: '1px solid rgba(15, 35, 57, 0.14)',
  borderRadius: 8,
  background: 'rgba(255, 255, 255, 0.96)',
  color: '#102a43',
  boxShadow: '0 2px 10px rgba(15, 35, 57, 0.12)',
  fontSize: 13,
  lineHeight: 1.4,
};

function hasMapCoordinates(building: Building): building is Building & {
  lat: number;
  lng: number;
} {
  return Number.isFinite(building.lat) && Number.isFinite(building.lng);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMap3DLibrary(value: unknown): value is Map3DLibrary {
  return (
    isRecord(value) &&
    typeof value.Map3DElement === 'function' &&
    typeof value.Marker3DInteractiveElement === 'function'
  );
}

function isGoogle2DMapsLibrary(value: unknown): value is Google2DMapsLibrary {
  return isRecord(value) && typeof value.Map === 'function';
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(
      window.WebGLRenderingContext &&
        (canvas.getContext('webgl2') || canvas.getContext('webgl')),
    );
  } catch {
    return false;
  }
}

function animationDuration(): number {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : 950;
}

function buildingCamera(building: Building & { lat: number; lng: number }): CameraOptions {
  return {
    center: { lat: building.lat, lng: building.lng },
    range: building.coordinatePrecision === 'building' ? 520 : 700,
    tilt: 62,
    heading: -18,
  };
}

function pinPrecisionLabel(building: Building): string {
  switch (building.coordinatePrecision) {
    case 'building':
      return 'Building-level coordinate';
    case 'approximate':
      return 'Approximate building-centre pin';
    default:
      return 'Coordinate precision has not been verified';
  }
}

function outdoorDirectionsUrl(building: Building): string | null {
  if (!hasMapCoordinates(building)) {
    return null;
  }

  const destination = encodeURIComponent(`${building.lat},${building.lng}`);
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`;
}

function flyMap3DTo(map: Map3DInstance, camera: CameraOptions): void {
  map.stopCameraAnimation?.();
  map.flyCameraTo?.({
    endCamera: camera,
    durationMillis: animationDuration(),
  });
}

/**
 * Renders a real Google Maps 3D scene when maps3d is available. The fallback is
 * still Google Maps imagery, but is explicitly labelled as a 2D satellite map.
 */
export default function CampusMap({
  buildings,
  selectedBuilding,
  onSelectBuilding,
}: CampusMapProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const map3DRef = useRef<Map3DInstance | null>(null);
  const map2DRef = useRef<Google2DMapInstance | null>(null);
  const onSelectBuildingRef = useRef(onSelectBuilding);
  const [displayMode, setDisplayMode] = useState<MapDisplayMode>('loading');
  const [statusMessage, setStatusMessage] = useState('Loading Google Maps 3D…');

  useEffect(() => {
    onSelectBuildingRef.current = onSelectBuilding;
  }, [onSelectBuilding]);

  const flyToBuilding = (building: Building) => {
    if (!hasMapCoordinates(building)) {
      return;
    }

    const map3D = map3DRef.current;
    if (map3D) {
      flyMap3DTo(map3D, buildingCamera(building));
      return;
    }

    const map2D = map2DRef.current;
    map2D?.panTo?.({ lat: building.lat, lng: building.lng });
    map2D?.setZoom?.(17);
  };

  const returnToOverview = () => {
    const map3D = map3DRef.current;
    if (map3D) {
      flyMap3DTo(map3D, GLASNEVIN_OVERVIEW_CAMERA);
      return;
    }

    const map2D = map2DRef.current;
    map2D?.panTo?.(GLASNEVIN_OVERVIEW_CAMERA.center);
    map2D?.setZoom?.(16);
  };

  useEffect(() => {
    if (selectedBuilding) {
      flyToBuilding(selectedBuilding);
    }
  }, [selectedBuilding, displayMode]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }

    let cancelled = false;
    let createdMap3D: Map3DInstance | null = null;
    let createdMap2D: Google2DMapInstance | null = null;
    let clearFallbackMarkers: () => void = () => undefined;

    const selectFromMarker = (building: Building) => {
      flyToBuilding(building);
      onSelectBuildingRef.current(building);
    };

    const add3DMarkers = (map: Map3DInstance, library: Map3DLibrary) => {
      buildings.filter(hasMapCoordinates).forEach((building) => {
        const marker = new library.Marker3DInteractiveElement({
          position: { lat: building.lat, lng: building.lng },
          label: building.code,
        });

        marker.addEventListener('gmp-click', (event) => {
          event.stopPropagation();
          selectFromMarker(building);
        });
        map.append(marker);
      });
    };

    const add2DMarkers = (
      map: Google2DMapInstance,
      library: Google2DMapsLibrary,
    ): (() => void) => {
      const Marker = library.Marker;
      if (!Marker) {
        return () => undefined;
      }

      const removals: Array<() => void> = [];
      buildings.filter(hasMapCoordinates).forEach((building) => {
        const marker = new Marker({
          position: { lat: building.lat, lng: building.lng },
          map,
          label: building.code,
          title: `${building.name} (${building.code})`,
        });
        const listener = marker.addListener?.('click', () => selectFromMarker(building));
        removals.push(() => {
          listener?.remove?.();
          marker.setMap?.(null);
        });
      });

      return () => removals.forEach((remove) => remove());
    };

    const showUnavailable = () => {
      if (cancelled) {
        return;
      }
      host.replaceChildren();
      setDisplayMode('error');
      setStatusMessage(
        'Google Maps is unavailable. Check the browser network connection and Maps JavaScript API configuration.',
      );
    };

    const show2DFallback = async (reason: 'webgl' | 'maps3d') => {
      try {
        const mapsLibrary = await loadGoogleMapsLibrary<unknown>('maps');
        if (cancelled) {
          return;
        }
        if (!isGoogle2DMapsLibrary(mapsLibrary)) {
          showUnavailable();
          return;
        }

        host.replaceChildren();
        createdMap2D = new mapsLibrary.Map(host, {
          center: GLASNEVIN_OVERVIEW_CAMERA.center,
          zoom: 16,
          mapTypeId: 'satellite',
          streetViewControl: false,
          fullscreenControl: true,
          mapTypeControl: true,
        });
        map2DRef.current = createdMap2D;
        clearFallbackMarkers = add2DMarkers(createdMap2D, mapsLibrary);
        setDisplayMode('two-d');
        setStatusMessage(
          reason === 'webgl'
            ? 'Google 2D satellite fallback — 3D needs WebGL support in this browser.'
            : 'Google 2D satellite fallback — Google Maps 3D could not be initialized.',
        );
      } catch {
        showUnavailable();
      }
    };

    const initialiseMap = async () => {
      setDisplayMode('loading');
      setStatusMessage('Loading Google Maps 3D…');

      if (!supportsWebGL()) {
        await show2DFallback('webgl');
        return;
      }

      try {
        const maps3DLibrary = await loadGoogleMapsLibrary<unknown>('maps3d');
        if (cancelled) {
          return;
        }
        if (!isMap3DLibrary(maps3DLibrary)) {
          await show2DFallback('maps3d');
          return;
        }

        const map = new maps3DLibrary.Map3DElement({
          ...GLASNEVIN_OVERVIEW_CAMERA,
          mode: maps3DLibrary.MapMode?.SATELLITE ?? 'SATELLITE',
        });
        map.style.width = '100%';
        map.style.height = '100%';
        map.style.display = 'block';
        host.replaceChildren(map);
        createdMap3D = map;
        map3DRef.current = map;
        add3DMarkers(map, maps3DLibrary);
        setDisplayMode('three-d');
        setStatusMessage('Google 3D map active — visual detail depends on Google coverage.');
      } catch {
        await show2DFallback('maps3d');
      }
    };

    void initialiseMap();

    return () => {
      cancelled = true;
      createdMap3D?.stopCameraAnimation?.();
      clearFallbackMarkers();

      if (map3DRef.current === createdMap3D) {
        map3DRef.current = null;
      }
      if (map2DRef.current === createdMap2D) {
        map2DRef.current = null;
      }
      host.replaceChildren();
    };
  }, [buildings]);

  const directionsUrl = selectedBuilding ? outdoorDirectionsUrl(selectedBuilding) : null;
  const isReady = displayMode === 'three-d' || displayMode === 'two-d';

  return (
    <section
      className="campus-map"
      style={rootStyle}
      aria-label="DCU Glasnevin interactive campus map"
    >
      <div
        ref={hostRef}
        className="campus-map__host"
        style={hostStyle}
        aria-label="Google Maps campus view"
      />

      <div
        className={`campus-map__status campus-map__status--${displayMode}`}
        style={statusStyle}
        role={displayMode === 'error' ? 'alert' : 'status'}
        aria-live="polite"
      >
        <strong>{statusMessage}</strong>
        {displayMode === 'error' && (
          <span>
            {' '}
            <a href={MAPS_3D_SETUP_URL} target="_blank" rel="noreferrer">
              Review 3D setup
            </a>
            {' or '}
            <a href={MAPS_3D_COVERAGE_URL} target="_blank" rel="noreferrer">
              check coverage
            </a>
            .
          </span>
        )}
      </div>

      <button
        className="campus-map__overview-control"
        style={{ ...controlStyle, opacity: isReady ? 1 : 0.55 }}
        type="button"
        onClick={returnToOverview}
        disabled={!isReady}
        aria-label="Return to the DCU Glasnevin overview"
      >
        Campus overview
      </button>

      {selectedBuilding && (
        <aside className="campus-map__selection" style={selectionStyle} aria-live="polite">
          <strong>
            {selectedBuilding.code} · {selectedBuilding.name}
          </strong>
          <div>Pin precision: {pinPrecisionLabel(selectedBuilding)}.</div>
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

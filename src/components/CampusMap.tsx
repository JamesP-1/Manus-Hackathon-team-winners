import type { CampusMapProps } from '../types';
import GoogleCampusMap from './GoogleCampusMap';
import OsmCampusMap from './OsmCampusMap';

function hasGoogleCredentials(): boolean {
  const direct = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim();
  const managed = (import.meta.env.VITE_MANUS_API_BROWSER_KEY as string | undefined)?.trim();
  return Boolean(direct || managed);
}

const useGoogle = hasGoogleCredentials();

/**
 * Chooses the map implementation at build time: Google Maps 3D when a browser
 * key (direct or managed) is configured, otherwise the key-free OpenStreetMap map.
 */
export default function CampusMap(props: CampusMapProps) {
  return useGoogle ? <GoogleCampusMap {...props} /> : <OsmCampusMap {...props} />;
}

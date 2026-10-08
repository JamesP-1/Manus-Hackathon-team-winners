# Google Maps integration

## Component contract

`src/components/CampusMap.tsx` default-exports `CampusMap` and accepts the frozen `CampusMapProps` contract:

```ts
{
  buildings: Building[];
  selectedBuilding: Building | null;
  onSelectBuilding: (building: Building) => void;
}
```

It fills **100% of its parent container**. The parent must therefore give its map region an explicit, non-zero height. It does not import or alter global styles.

- The default 3D camera is an overview near **DCU Glasnevin** (`53.38565, -6.25785`), based on the product's supplied target and checked against DCU's [Glasnevin campus map](https://www.dcu.ie/campus-maps). This is a map viewpoint, **not** an entrance, room, or source-grade building coordinate.
- Marker creation is restricted to records where both `lat` and `lng` are finite. It never manufactures a coordinate for an unlocated building.
- A `Marker3DInteractiveElement` is created for each mappable building. Clicking it calls `onSelectBuilding`; a selected building triggers a short `flyCameraTo` camera movement. The **Campus overview** control returns to the Glasnevin view.
- Flights respect `prefers-reduced-motion` (duration is zero when reduced motion is requested).
- The selected-map note distinguishes a building-level coordinate from an approximate building-centre pin and explicitly says that the map is **not indoor routing**. Its walking link opens an outdoor Google Maps route to the available building coordinate.

## SDK loading and configuration

`src/lib/googleMaps.ts` contains the only Maps JavaScript loader. It creates one module-scoped SDK promise, handles `gm_authFailure`, has a 15-second script timeout and a 12-second per-library timeout, and avoids displaying raw network errors (which can include a request URL).

Configuration precedence is deliberate:

1. If `VITE_GOOGLE_MAPS_API_KEY` is set, the loader uses the direct, browser-side `https://maps.googleapis.com/maps/api/js` endpoint.
2. Otherwise it calls the supplied managed endpoint exactly under `VITE_MANUS_API_URL` at `/v1/maps/proxy/maps/api/js`, passing the supplied browser key and requesting `v=beta` with `libraries=maps3d`.

Do **not** add a key value to source control. A direct key is browser-visible and should be origin/API restricted. The managed browser configuration is expected from the existing Vite definitions; no private service key is used.

The loader and component use `google.maps.importLibrary('maps3d')`, `Map3DElement`, `Marker3DInteractiveElement`, and `flyCameraTo` in line with Google documentation:

- [3D Maps JavaScript getting started](https://developers.google.com/maps/documentation/javascript/3d/get-started)
- [3D Maps overview and coverage guidance](https://developers.google.com/maps/documentation/javascript/3d/overview)
- [Official 3D camera animation sample](https://developers.google.com/maps/documentation/javascript/examples/3d/move-camera)
- [Official 3D markers and animation codelab](https://developers.google.com/codelabs/maps-platform/maps-platform-3d-maps-js-markers)
- [3D Maps coverage](https://developers.google.com/maps/coverage)

Google's own map element renders the map, logo, terms, and other required attribution. The app does not replace or hide that attribution.

## User-visible states

| State | Meaning | Result |
|---|---|---|
| Loading | SDK or `maps3d` is being requested. | A concise status chip is shown while the host remains a real map container. |
| Google 3D active | `Map3DElement` initialized successfully. | Interactive Google 3D map with pan/tilt/zoom and building markers. Google imagery detail remains coverage-dependent. |
| Google 2D satellite fallback | WebGL is unavailable or the 3D library/element could not initialize, but the standard Maps SDK did. | A **clearly labelled Google 2D satellite fallback**, with available standard marker support; it is never described as 3D. |
| Error | Neither map mode could initialize. | No simulated canvas is shown. The UI gives direct links to Google's 3D setup and coverage documentation. |

## Styling hooks

The component has essential inline layout/overlay styles so it is usable on its own. The interface layer may refine these classes without changing map SDK behavior:

| Class | Element |
|---|---|
| `.campus-map` | Full-size relative map root |
| `.campus-map__host` | Google-owned map element host |
| `.campus-map__status` | Loading, active, fallback, or error status chip |
| `.campus-map__status--loading` | Loading-state modifier |
| `.campus-map__status--three-d` | Active 3D-state modifier |
| `.campus-map__status--two-d` | Explicit 2D fallback modifier |
| `.campus-map__status--error` | Error-state modifier |
| `.campus-map__overview-control` | Overview/fit control |
| `.campus-map__selection` | Selected building precision and routing note |
| `.campus-map__directions-link` | Outdoor walking-directions link |

## Known limitations and local blocker

- A successful `Map3DElement` initialization confirms the 3D API is available; it does **not** guarantee Google supplies photorealistic 3D detail at every campus location. Verify DCU visually against Google's coverage information in a browser.
- Google Maps is outdoor mapping in this integration. A building-centre pin, especially one marked `approximate`, is not a verified entrance and must not be presented as indoor or turn-by-turn campus routing.
- Maps JavaScript 3D requires a compatible browser and WebGL support, an enabled/configured Maps JavaScript API, and an eligible browser key/proxy connection.
- The managed endpoint has an observed local TLS certificate name mismatch (`ERR_TLS_CERT_ALTNAME_INVALID` with an unrelated Whalebone certificate). The implementation does **not** weaken certificate validation, disable TLS checks, or bypass the managed network boundary. Until that local network/certificate issue is corrected, the component will surface its normal setup/network state; testing can use a correctly origin-restricted direct browser key only when authorized.

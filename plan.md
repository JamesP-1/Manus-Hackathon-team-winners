# DCU Campus Navigator — implementation plan

## Product
An interactive Google-powered 3D view of DCU that translates timetable room codes into named buildings and floors. Search a room, select its building, fly the camera there, and open Google Maps walking directions. Collect all publicly discoverable DCU room listings with provenance; do not claim a complete institutional inventory without evidence. Default map view is Glasnevin; preserve campus identifiers wherever other campuses are discovered.

## Architecture and constraints
- React + TypeScript + Vite, client-side static app. Node scripts collect public university data at development time; no account, database or application backend needed.
- Google Maps JavaScript API maps3d supplies real imagery, markers and camera controls. Load through the supplied managed proxy using MANUS_API_URL and MANUS_API_BROWSER_KEY. Embed only browser-safe values via Vite configuration. Do not expose a private service key.
- Check actual maps3d support and campus imagery coverage. If unavailable, provide a clearly labeled Google 2D satellite fallback and report the 3D blocker; never present that as completed 3D or invent campus geometry. Ask for an independent Google demo key only after verifying the managed path cannot support it.
- Room and building datasets are static JSON, with citations. Coordinates must have source and precision labels; approximate building-centre pins are not verified entrances. Google routing must not claim indoor navigation.
- Numeric codes follow building prefix + floor digit + room suffix (L101 → L, first floor, 01). Ground-floor forms include G, LG and zero only where supported by evidence. Longest valid building prefix wins. Unknown and ambiguous codes need explicit UI states.
- A convention-matching code not found in the scrape is 'decoded, not confirmed' and is not added to the scraped inventory.
- Timetable text stays in the browser. Extract supported room tokens and allow selecting matches; do not silently guess schedules or campuses.
- Persist only UI preferences/favourites locally if needed, never timetable text without clear user intent.

## Project structure
- src/types.ts: frozen shared interfaces.
- src/data/buildings.json: building records and sourced coordinates.
- src/data/rooms.json: actual publicly listed room identifiers and evidence.
- src/data/sources.json: scrape coverage, failures and source metadata.
- src/lib/rooms.ts: normalize/decode/search helpers, timetable token extraction.
- src/lib/googleMaps.ts: one-time Maps SDK loader and error handling.
- src/components/CampusMap.tsx: real Google 3D scene with labelled fallback.
- src/components/SearchPanel.tsx and TimetablePanel.tsx: search, results, room/building details and pasted timetable flow.
- src/App.tsx, src/styles.css: page composition, map/sidebar selection and responsive design.
- scripts/scrape-rooms.mjs: rerunnable bounded public-page scraper; raw sources/logs in .work/campus-nav/.
- public/: favicon and manus-routes.json.
- outputs/: completed data exports and hackathon explainer copied after verification.
- tests/: deterministic code-decoding tests. .work/: build logs, review and browser evidence.

## Shared data contract
Building: id, code, name, campus ('glasnevin'|'stpatricks'|'allhallows'|'other'), aliases:string[], lat:number|null, lng:number|null, coordinateSource:string|null, coordinatePrecision:'building'|'approximate'|'unknown', sourceUrls:string[].
Room: id, code, buildingId, campus, floor:string|null, roomNumber:string|null, sourceUrls:string[], evidence:'listed'.
RoomResolution: query, normalized, status:'listed'|'decoded'|'unknown'|'ambiguous', building:Building|null, room:Room|null, floor:string|null, roomNumber:string|null, message:string.
CampusMap props: buildings:Building[], selectedBuilding:Building|null, onSelectBuilding:(building:Building)=>void.
SearchPanel props: buildings:Building[], rooms:Room[], onSelect:(resolution:RoomResolution)=>void, selected:RoomResolution|null.
TimetablePanel props: buildings:Building[], rooms:Room[], onSelect:(resolution:RoomResolution)=>void.
Helper exports: resolveRoom(query, buildings, rooms):RoomResolution; searchBuildings(query, buildings):Building[]; extractTimetableRooms(text, buildings, rooms):RoomResolution[].

## Parallel ownership
1. Room-data agent: scripts/scrape-rooms.mjs, src/data/rooms.json, src/data/sources.json, SCRAPING.md. Extract evidence, deduplicate, source every record, record gaps. No other edits or dependency installs.
2. Building/decoding agent: src/data/buildings.json, src/lib/rooms.ts, tests/rooms.test.ts, BUILDINGS.md. Source names and coordinates, retain uncertainty, implement shared helper signatures.
3. Google 3D agent: src/lib/googleMaps.ts and src/components/CampusMap.tsx only, plus MAPS.md. Read current official docs, implement managed loader, select markers, camera movement, SDK/WebGL/error states, cleanup and labelled Google fallback.
4. Interface agent: src/App.tsx, src/styles.css, src/components/SearchPanel.tsx, src/components/TimetablePanel.tsx only, plus UI.md. Build the room → building → map workflow using frozen contracts; distinguish listed versus decoded rooms and show citations.
Parent owns scaffold, types, package/configuration, installs, integration, service start and checkpoints. A fifth read-only agent reviews integrated code after all four complete. No child changes Git, publishes, initializes resources, asks the user, or prints credentials.

## Design
Design movement: modern transit wayfinding and cartographic information design, not a marketing landing page.
Principles: map-first; one clear search action; explicit provenance/uncertainty; generous mobile touch targets.
Colours: near-white information panels, ink/navy text and vivid campus-blue wayfinding accents; blue is the ownable brand colour. Green badges mean sourced listings, amber means inference, never unqualified room verification.
Layout: edge-to-edge map with a narrow floating left navigation panel and compact corner controls; mobile bottom sheet rather than central card grids.
Signatures: stacked room-code typographic lockup, building-code capsule pins, thin route-like blue accent lines.
Interaction: immediate search; selectable results; selection makes the destination and floor obvious; reduced-motion support.
Animation: short panel transitions and a gentle camera flight (roughly one second), no distracting continuous orbit by default; optional overview control.
Typography: system sans-serif (Segoe UI/Inter compatible), bold concise headings, tabular/monospaced room codes, legible 14–16px detail copy.
Brand essence: 'Your room code, made clear.' For DCU students moving between classes; direct, calm, dependable.
Voice: 'Find your next room.' and 'Building found. Room not confirmed in public listings.'
Wordmark: DCU / NAV with a custom path-corner locator mark drawn as a simple vector; do not imply official university endorsement.

## Build workflow
Scaffold and enable diagnostics → start four independent agents → parent tests Google proxy and installs dependencies → integrate supplied modules/data → run build and code tests → read-only review and targeted fixes → start declared local preview and verify HTTP/routes → save a managed checkpoint if appropriate. Do not publicly publish without existing authorization. Keep Google imagery inside its supported SDK, visible attribution intact, and scraped DCU facts distinct from Google imagery.

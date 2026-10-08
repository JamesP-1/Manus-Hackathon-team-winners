# DCU Campus Navigator

A student hackathon project connecting DCU timetable room codes to buildings, floors and an interactive Google Maps view. Independent prototype, not an official DCU service.

## Setup checkpoint

This first checkpoint provides a working React/TypeScript/Vite shell, pinned dependencies, shared data contracts and an implementation plan. Room collection, decoding, the Google 3D component and the final interface are in progress in parallel and are intentionally excluded from the setup-only commit. The shell does not claim those features already work.

## Development

Use Node 22.12+ (this workstation uses Node 24.14) and npm 11.9.0.

```sh
npm ci
npm run dev -- --host 127.0.0.1 --port 5173 --strictPort
npm run build
```

On Windows PowerShell where npm.ps1 is blocked, use `npm.cmd` instead. Do not change the execution policy.

For this Manus session, the preview port is configured through project settings. Other developers can choose their own local port. Do not commit session-specific port settings or API keys.

## Personal timetable feed

The Timetable tab can load a student's own DCU timetable from `https://timetable.redbrick.dcu.ie/api/v3/timetable/events?course=<course-uuid>` (paste the feed link, the page link, or the bare id). The feed is iCalendar text and the server sends no `Access-Control-Allow-Origin` header, so the browser cannot call it directly. The app instead requests `/api/timetable/...` on its own origin:

- `vite.config.mjs` proxies `/api/timetable` → `https://timetable.redbrick.dcu.ie/api/v3/timetable` for both `vite dev` and `vite preview` (TLS verification stays on; the dev server only reads the config on start, so restart it after changing the proxy).
- The static `dist/` build has no server of its own. Whatever host serves it must apply the same rewrite, e.g. an nginx `location /api/timetable/ { proxy_pass https://timetable.redbrick.dcu.ie/api/v3/timetable/; proxy_ssl_server_name on; }`, a Netlify/Vercel rewrite from `/api/timetable/*` to `https://timetable.redbrick.dcu.ie/api/v3/timetable/:splat`, or an equivalent. Without it the panel shows a "response was not a calendar feed" error.

Parsing (`src/lib/ical.ts`) and room resolution (`src/lib/timetable.ts`) run in the browser. Class content is never stored; the feed link is saved to `localStorage` only when the student ticks "Remember this link on this device", and "Disconnect" removes it. A saved copy of one feed lives in `tests/fixtures/dcu-timetable.ics` for the unit tests.

## Collaboration

Read [plan.md](plan.md) for architecture and the exact contracts in [src/types.ts](src/types.ts). The active workstreams own:

| Workstream | Files |
| --- | --- |
| Public room inventory | `scripts/scrape-rooms.mjs`, `src/data/rooms.json`, `src/data/sources.json` |
| Buildings and decoding | `src/data/buildings.json`, `src/lib/rooms.ts`, `tests/rooms.test.ts` |
| Google 3D rendering | `src/lib/googleMaps.ts`, `src/components/CampusMap.tsx` |
| Student interface | `src/App.tsx`, `src/styles.css`, search/timetable components |
| Integration | App entry, dependencies, shared interfaces, build/preview and data exports |

Avoid editing those active files without coordinating. New teammates can work on a separate branch and new modules such as accessibility improvements, timetable import extensions or verified entrance data. Agree contracts before touching shared types.

## Data and maps principles

Only room identifiers genuinely found in public sources belong in the scraped room inventory. A plausible code such as L101 can be decoded without asserting the room exists. Coordinates carry provenance and precision; building centres are not verified entrances. Google supplies exterior imagery, not indoor room geometry.

The project supports managed browser Maps credentials. A direct browser Google Maps key may be needed if 3D is unavailable through the managed endpoint; `.env.example` documents the variable name, with no value. Keys stay outside Git and should be restricted to approved origins/APIs. No paid Google billing is enabled by this project setup.

Manus version history uses a separate managed repository; this user Git repository remains independent.

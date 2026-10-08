# DCU NAV interface

## Scope

The interface is a **map-first, student-facing wayfinding prototype**. It deliberately avoids an institutional or marketing presentation: the map stays visible behind a compact navigation panel, with a clear DCU / NAV locator mark and an explicit **Independent student prototype** label.

## Core flow

1. Search a room code (for example, `L101`) or a building name/code.
2. Select a public room listing or building result.
3. The selected building is passed to `CampusMap`, which can fly or focus its camera.
4. Read the destination card for building/campus, floor and room where known.
5. Use the Google Maps **walking directions** link for the building coordinate.

`L101` is offered as a first-screen lookup example only. The UI never implies that it is a confirmed public listing before `resolveRoom` returns a listed result.

## Evidence and uncertainty

| UI treatment | Meaning |
|---|---|
| Green **Listed / Public listing** badge | A room record exists in the public-source catalogue. |
| Amber **Decoded code / Building** badge | A code convention or building match identified a building. It is not a public confirmation of a room. |
| Amber clarification state | The entered value is ambiguous or absent from supported matches. |

The destination card combines room and building source URLs, labels them as public references, and keeps coordinate uncertainty visible. A pin is expressly described as a sourced building-level or approximate building-centre coordinate—not a verified entrance or indoor position. The Google link uses `travelmode=walking` but does not promise indoor routing.

The header and panel footer expose live catalogue counts as **public-source coverage**, never as a claim to list every DCU room.

## Timetable handling

The Timetable tab accepts pasted text only in React component state. Clicking **Extract rooms** calls `extractTimetableRooms` locally, deduplicates supported destination resolutions, and lets the student select one for the map. It does not persist text, upload it, infer a class schedule, or guess unsupported room codes.

## Responsive and accessibility behavior

- Desktop uses a narrow floating left panel over the map.
- At 720px and below, that panel becomes a bottom sheet capped at 55vh, retaining substantial map visibility.
- Native buttons, labels, tab semantics, keyboard form submission, focus-visible states, and `aria-live` result/status regions are provided.
- `prefers-reduced-motion` suppresses nonessential interface transitions; map-specific status remains the responsibility of `CampusMap` and is not hidden by this UI.

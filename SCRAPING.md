# DCU public room-data scrape

## Purpose

`scripts/scrape-rooms.mjs` creates the static room inventory used by the DCU Maps. It only targets **public official DCU pages** and never accesses MyTimetable, room-booking systems, or any other sign-in/private endpoint.

Run from the repository root:

```powershell
npm.cmd run scrape
```

The script resolves all paths from its own location, so it does not depend on the terminal's current directory.

## Sources and scope

| Public official source | Intended use |
|---|---|
| [Campus Explorer location tables](https://www.dcu.ie/CampusExplorer/poi-information) | Primary room inventory. The table lists a campus, a qualified room token, building, and floor/location information. |
| [DCU Timetable Information](https://www.dcu.ie/timetables) | Confirms location-code structure and the authenticated timetable boundary. |
| [Campus Maps](https://www.dcu.ie/campus-maps) | Official Glasnevin building-code context. |
| [Registry room booking information](https://www.dcu.ie/registry/room-booking-information-registry) | Public room-booking context; it is not treated as an inventory. |
| [Library group study rooms](https://www.dcu.ie/library/group-study-rooms) | Public corroboration when identifiers can be matched to an already listed qualified location. |

Before requesting pages, the scraper requests `https://www.dcu.ie/robots.txt`; it stops public crawling (and leaves `src/data` untouched, exit code 1) if that guidance cannot be retrieved. Its fetch worker is capped at **three concurrent requests** with a **15-second timeout**. Each request tries native Node `fetch` first and, only on a transport failure (not an HTTP error status), falls back to `curl.exe` and then PowerShell `Invoke-WebRequest` via `child_process`. TLS verification is never disabled on any transport; the transport that succeeded is recorded per page in the log and in `sources.json`. HTML text is parsed with Cheerio, while PDFs are extracted through `pdfjs-dist`.

Two additional public pages are checked for location codes on every run: the Campus Explorer landing page (`/CampusExplorer`, whose per-campus links redirect straight to the Bentley 3D viewer, not to further tables) and the 2020 orientation facilities PDF. Probes for `/registry/examinations`, `/registry/exam-venues`, `/registry/examination-venues`, `/registry/exam-timetables`, `/CampusExplorer/campus-location-tables` and `/library/study-spaces` returned 404 and are not in the source list.

## Exports

| File | Contents |
|---|---|
| `src/data/rooms.json` | Deduplicated records conforming exactly to `Room`: `id`, `code`, `buildingId`, `campus`, `floor`, `roomNumber`, `sourceUrls`, and `evidence: "listed"`. |
| `src/data/sources.json` | Generation time, outcome summary, a page-by-page status/room count/note, and explicit coverage limitations. |
| `.work/campus-nav/room-data/downloads/` | Public raw downloads plus extracted text in a normal run. |
| `.work/campus-nav/room-data/log/scrape-log.jsonl` | One JSON event per robots check, fetch outcome, and export. |

Room IDs and building IDs use the required form `campus-UPPERCASECODE`, for example `glasnevin-L101` and `glasnevin-L`. Codes are copied from a source rather than invented. Building codes are read from `src/data/buildings.json` at run time; the parser uses the longest documented code for the campus (for example `SA` before `S`, `CA` before `C`) before separating the floor marker (`G` = Ground, `B` = Basement, or a digit) and the remaining room number. A code whose building is not in `buildings.json` is reported in the parse report and omitted rather than guessed.

The Campus Explorer "Room" cell is expanded literally: `GLA.SB12.&.SB12-A` yields `SB12` and `SB12-A`, `SPC.C100L-C.&.100L-D` yields `C100L-C` and `C100L-D` (the second code inherits the building letter DCU printed), and annotations such as `GLA.AG42.(Pedagogy)` are stripped. `GLA.H1.(Ward)` is kept as a listed location with floor `1` and no room number.

## Current run: full crawl (2026-10-08)

`robots.txt` and all eight public sources were retrieved with native Node `fetch` (the curl fallback was also exercised end to end and produced a byte-identical `rooms.json`). The Campus Explorer location table is served as a **single page with 351 rows**; it has no pagination and the campus links on `/CampusExplorer` redirect to the Bentley viewer rather than to further tables.

Result: **344 listed rooms** — 232 Glasnevin, 94 St Patrick's, 18 All Hallows — replacing the earlier 80-room fallback seed. Of the 351 rows, 11 have no location code (unnamed sports facilities in the U building and Morton Stadium) and one (`GLA.Invent.Video.Conference`) is not a location code. Every room's `buildingId` exists in `buildings.json`; `stpatricks-S` (Sports Building, map 9) was added because the table lists `SPC.S110`, `SPC.SG01` and `SPC.SG13` there.

Corroboration: `GLA.QG13` appears on the public timetable page and in the timetable guide PDF and carries all three source URLs. No other public page added or corroborated a qualified code. The library group-study page lists only unqualified numbers (O'Reilly rooms 1–18, Cregan Library `G215`/`G315`) and was not used as an inventory.

Known data quirks in DCU's own table, recorded in `sources.json` limitations: most `X`-prefixed rooms are labelled "Postgraduate Residences" while carrying map ID `X` (Lonsdale), and `SPC.C208` is labelled "Belvedere House" (map 21), which shares code `C` with Block C. Rooms are assigned by documented building code; the labels are preserved in `.work/campus-nav/room-data/log/campus-explorer-parse-report.json`.

Raw downloads, extracted text and the JSONL event log are in `.work/campus-nav/room-data/`. DCU's timetable page says personal and staff timetables require sign-in; those private data sources are out of scope.

## St Patrick's prefix note

The current public timetable page describes St Patrick's as `SPD`, whereas the public Campus Explorer rows observed in this run use `SPC`. The parser accepts both source prefixes and normalizes both to `campus: "stpatricks"`; exported IDs do not include the source campus abbreviation.

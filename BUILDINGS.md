# DCU building directory and coordinates

## Sources and scope

The primary directory is DCU's current **Campus Maps** page, retrieved on 2026-10-08.  It identifies the current Glasnevin code/name directory and links to the September 2026 campus maps:

- [DCU Campus Maps](https://www.dcu.ie/campus-maps)
- [Glasnevin map — September 2026](https://www.dcu.ie/sites/default/files/community_editor/2026-08/22706-gla-monoliths_24_07_26.pdf)
- [St Patrick's map — September 2026](https://www.dcu.ie/sites/default/files/community_editor/2026-08/16100-spa-main-entrance-monoliths_24_07_26.pdf)
- [All Hallows map — September 2026](https://www.dcu.ie/sites/default/files/community_editor/2026-08/dcu-all-hallows_24_07_26.pdf)

`src/data/buildings.json` contains the complete current **Glasnevin** directory from that official page: A, B, C, CA, D, E, F, FT, G, GA, H, J, KA, L, M, N, P, PR, Q, QA, R, S, SA, T, U, V1, V2, VA, VB, W, X, Y and Z. It also keeps the published **St Patrick's** Block A–G and **All Hallows** C/D/OD/P/S namespaces. The All Hallows map assigns its D and S codes to more than one named place; each is deliberately retained as one transparent shared-code selection rather than inventing an undocumented physical sub-code.

## Coordinates and precision

Each non-null coordinate has a source in its record. Most are centres of named, code-tagged [OpenStreetMap](https://www.openstreetmap.org/) building footprints retrieved through the public Overpass API on 2026-10-08 and cross-checked against DCU's official code/name directory. They are **building-location pins, not verified entrances**. `coordinatePrecision: "building"` means the source is a matching mapped footprint centre; it does not imply an entrance or indoor-routing point.

Two intentionally qualified exceptions are present:

- **CA** is an `approximate` pin because the mapped feature is a building part labelled *The Street* and explicitly noted as part of the Henry Grattan Extension.
- **W** is an `approximate` pin: the arithmetic mean of four OpenStreetMap footprint centres tagged `ref=W`, representing the College Park Residences complex. It is not a residence entrance.

Where a current official code/name could not be confidently joined to a published spatial feature, the record has `lat`/`lng: null`, `coordinateSource: null`, and `coordinatePrecision: "unknown"`. This applies to C, FT, J, KA, V1 and V2, and to the retained non-Glasnevin entries. No pin was hand-drawn from the campus-plan artwork.

## Room-code rules

`src/lib/rooms.ts` accepts case/space-normalised queries, resolves a scraped listing before applying the documented convention, and uses the longest valid building prefix. Examples:

- `L101` → McNulty (L), floor `1`, room `01`
- `CG71` → Henry Grattan (C), `Ground`, room `71`
- `C LG01` → Henry Grattan (C), `Lower Ground`, room `01`
- `C071` → Henry Grattan (C), `Ground`, room `71`

A convention match which is not in the passed room inventory returns `status: "decoded"` with **“Room not confirmed in public listings.”** It does not create a room record. Plain codes such as `L` are explicit building selections. Codes that exist on more than one campus return `ambiguous` unless a supported campus qualifier (for example `GLA.L101`, `SPC.A101`, or `AHC.ODG01`) is supplied.

## Reproducibility material

The exact source URLs, directory transcription, OSM way IDs/centres, and retrieval notes are stored under `.work/campus-nav/buildings/`. Public DCU pages could not be downloaded directly from the active device because its network connection to `www.dcu.ie:443` failed; the browser research fetches succeeded and no TLS validation was disabled or bypassed.

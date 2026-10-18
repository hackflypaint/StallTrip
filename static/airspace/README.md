# Drone flight constraints (removable)

Isolated map overlay that answers, for a viewport: **no-fly**, **authorization required**, or **unconstrained** (no tint).

Uses **official public FeatureServers only** (FAA AIS/UDDS + NPS Land Resources). Never Autopylot private APIs. Not a LAANC / flight-authorization product.

## Legality mapping

| Visual class | Meaning (informational) | Data |
| --- | --- | --- |
| **No-fly** | Launch/operate generally blocked | NPS unit boundaries; FAA Prohibited + Restricted SUA; National Defense UAS TFRs; stadium NSFRs; UASFM cells with **0 ft** ceiling |
| **Auth required** | Controlled airspace / UASFM — typically needs airspace authorization (e.g. LAANC or FAA approval) | FAA Class B/C/D; UASFM cells with ceiling &gt; 0 |
| **Unconstrained** | No overlay in view | Absence of the above — **not** legal clearance (remote ID, NOTAMs, local rules still apply) |

**Auth** here means “airspace authorization is typically required,” not “this app issued LAANC.” Always verify with FAA / park rules before flying.

## Data sources & attribution

| Layer | Source |
| --- | --- |
| National Park Service units | `https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2` |
| Prohibited / Restricted SUA | FAA `Special_Use_Airspace` (`TYPE_CODE IN ('P','R')`) |
| National defense UAS TFRs | FAA `National_Defense_Airspace_TFR_Areas` |
| Class B/C/D | FAA `Class_Airspace` |
| UAS Facility Maps | FAA `FAA_UAS_FacilityMap_Data` |
| Stadium NSFRs | FAA `Stadiums` |

FAA org catalog: [services6…/ssFJjBXIUyZDrSYZ](https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services)  
Hubs: [ADDS](https://adds-faa.opendata.arcgis.com/) · [UDDS](https://udds-faa.opendata.arcgis.com/)  
NPS UAS policy: [nps.gov — Uncrewed Aircraft in the National Parks](https://www.nps.gov/articles/uncrewed-aircraft-in-the-national-parks.htm)

Queries use `geometry` + `esriGeometryEnvelope` + `f=geojson` + `outSR=4326`, CORS `*`.

## Removed / de-emphasized (vs prior Airspace / UAS chrome)

- Airport point markers (ident chrome) — removed
- Class B / C / D as separate colored rings — unified as **Auth required**
- MOA / Warning / other SUA types — not fetched
- Autopylot-style purple UASFM ceiling gradient — simplified to auth / 0-ft no-fly

## Behavior / performance

- Toggle **Drone flight** in the Layers panel.
- Fetches only when enabled; debounced on `moveend` / `zoomend`.
- Min zoom **7** for parks / SUA / Class / defense TFRs; **9** for UASFM; **8** for stadium points.
- Viewport-bounded with bbox pad; `resultRecordCount` caps; in-flight requests aborted on pan/zoom.

## Files

| Path | Role |
| --- | --- |
| `airspace-overlay.js` | Module API: mount/unmount, fetch, Leaflet GeoJSON |
| `airspace.css` | Panel + marker + popup badge styles |
| `README.md` | This file |

## How to remove later

1. Delete the folder `static/airspace/` entirely.
2. In `static/index.html`, remove:
   - `<link rel="stylesheet" href="/airspace/airspace.css">`
   - `<script src="/airspace/airspace-overlay.js"></script>`
   - the `#airspaceSlot` element inside the layers panel
3. In `static/app.js`, remove the optional `AirspaceModule.mount` / `unmount` hook.
4. Remove airspace mentions from `app-guide.md` / Context guides.
5. Drop airspace assertions from `tests/verify_ui.js` and `tests/test_airspace.js`.

No routing, charger, foliage, or Docker logic depends on this module.

## Limitations

- Not a LAANC / flight-authorization tool; “Auth required” ≠ approval granted.
- NPS polygons are legislated unit boundaries (policy no-fly for launch/land/operate on NPS lands) — not a substitute for park-specific exceptions.
- Part-time national security UAS restrictions and other dynamic NOTAMs are not fully covered.
- At low zoom, overlays are suppressed so CONUS is not loaded naively.
- UASFM max ~1500 cells per viewport; dense metros may truncate until zoomed closer.

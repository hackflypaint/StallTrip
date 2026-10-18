# Airspace / UAS Module (removable)

Isolated FAA airspace + UAS Facility Map overlay for the Layers panel.

Evokes Autopylot-style UAS planning maps (controlled-airspace rings, special-use
polygons, UASFM ceiling cells, airport/stadium markers) using **official FAA
ArcGIS FeatureServers only** — never Autopylot private APIs.

## Data sources & attribution

FAA Aeronautical Information Services (AIS) / ADDS & UAS Data Delivery System (UDDS).

| Layer | ArcGIS FeatureServer query (GeoJSON) |
| --- | --- |
| Class B/C/D | `https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services/Class_Airspace/FeatureServer/0/query` |
| Special Use (R/W/P/MOA…) | `…/Special_Use_Airspace/FeatureServer/0/query` |
| UAS Facility Maps | `…/FAA_UAS_FacilityMap_Data/FeatureServer/0/query` |
| Stadiums | `…/Stadiums/FeatureServer/0/query` |
| Airports | `…/US_Airport/FeatureServer/0/query` |

Org catalog: [FAA ArcGIS services](https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services)  
Open data hubs: [ADDS](https://adds-faa.opendata.arcgis.com/) · [UDDS](https://udds-faa.opendata.arcgis.com/)  
UAS Facility Maps explainer: [faa.gov UAS Facility Maps](https://www.faa.gov/uas/commercial_operators/uas_facility_maps)

**Attribution (shown in UI):** FAA AIS / ADDS · UDDS. UASFM cells are informational only and do **not** authorize flight.

Queries use `geometry` + `esriGeometryEnvelope` + `f=geojson` + `outSR=4326`, CORS `*`.

## Behavior / performance

- Toggle **Airspace / UAS** in the Layers panel.
- Fetches only when enabled; debounced on `moveend` / `zoomend`.
- Min zoom **7** for Class + SUA; **9** for dense UASFM cells; **8** for airport/stadium points.
- Viewport-bounded with a small bbox pad; `resultRecordCount` caps per layer.
- In-flight requests aborted on pan/zoom.

## Files

| Path | Role |
| --- | --- |
| `airspace-overlay.js` | Module API: mount/unmount, fetch, Leaflet GeoJSON |
| `airspace.css` | Panel + marker styles |
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

- Not a LAANC / flight-authorization tool.
- No Autopylot weather / radar / live TFRs beyond what these static FAA layers include (`National_Defense_Airspace_TFR_Areas` etc. not wired yet).
- Park / noise-sensitive area tints (if shown on Autopylot) are out of scope here.
- At low zoom, overlays are suppressed so CONUS is not loaded naively.
- UASFM max ~1500 cells per viewport; dense metro areas may truncate until zoomed closer.

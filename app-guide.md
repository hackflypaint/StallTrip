# Tesla Supercharger Route Planner - Application Guide

A modern web application for planning electric vehicle road trips, discovering Tesla Superchargers along highway corridors, maximizing charger visits, and force-including custom geographic regions of chargers into an efficient route.

![Visit Maximizer Route View](media/01_visit_maximizer_route.png)

---

## Map Layers

Open the **Layers** button (layer-group icon on the map toolbar) for basemaps and overlays:

| Layer | Type | Description |
| --- | --- | --- |
| **Streets** | Basemap (default) | OpenStreetMap tiles with the app’s dark tile filter |
| **Topographic** | Basemap | OpenTopoMap terrain tiles (contours / hillshade) |
| **Nearby stations** | Overlay | Corridor Supercharger markers |
| **Fall Foliage** | Overlay + day slider | Explore Fall daily CONUS color map |
| **Airspace / UAS** | Overlay | FAA Class B/C/D, special-use, UAS Facility Map cells |

![Topographic basemap](media/topo_layer.png)

### Airspace / UAS (FAA ArcGIS)
Airspace lives in a **removable** module under `static/airspace/` (see that folder’s `README.md`).

- **Sources (public FAA FeatureServers, org `ssFJjBXIUyZDrSYZ`):** viewport-bounded GeoJSON from `Class_Airspace`, `Special_Use_Airspace`, `FAA_UAS_FacilityMap_Data`, `Stadiums`, `US_Airport`. Catalog: [FAA ArcGIS REST](https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services). Hubs: [ADDS](https://adds-faa.opendata.arcgis.com/) · [UDDS](https://udds-faa.opendata.arcgis.com/).
- **Not used:** Autopylot private APIs (AutoPylot is an FAA-approved LAANC USS; map visuals come from FAA GIS).
- **Performance:** fetches only when the overlay is on; min zoom 7 (Class/SUA), 9 (UASFM grids), 8 (airport/stadium points); debounced + abortable.
- **Attribution:** FAA AIS / ADDS · UDDS. UAS Facility Maps are informational only (not flight authorization).

**How to delete airspace later:** remove `static/airspace/`, drop the `#airspaceSlot` + airspace CSS/JS includes from `index.html`, and remove the optional `AirspaceModule.mount` hook in `app.js`.

### Fall Foliage (Explore Fall rasters)
Foliage lives in a **removable** module under `static/foliage/` (see that folder’s `README.md`).

- **Source:** daily public PNGs that power [Explore Fall’s map](https://www.explorefall.com/fall-foliage-map):  
  `https://www.explorefall.com/maps/2026/{YYYYMMDD}.png` (CORS `*`), georeferenced to Explore Fall’s CONUS corners `[-126,52]…[-65,23]`.
- **Day slider:** Sep 1 – Dec 31 (same season window as Explore Fall). Cached mid-October dates under `static/foliage/cache/` for offline demos; other dates load live.
- **Attribution:** UI credits and links to [ExploreFall.com](https://www.explorefall.com/) (required for their open map products / KMLs).
- **Not used:** US state choropleth. Explore Fall also publishes Mon/Thu KMLs; this module uses their daily map rasters for a continuous regional wash matching the public map.

**How to delete foliage later:** remove `static/foliage/`, drop the `#foliageSlot` + foliage CSS/JS includes from `index.html`, and remove the optional `FoliageModule.mount` hook in `app.js`.

![Fall Foliage overlay](media/foliage_layer.png)

---

## Core Routing Features

### 1. Visit Maximizer Mode (Default)
Rather than merely stopping when the vehicle's battery is low, **Visit Maximizer** turns road trips into an EV safari or rally.
- Distributes stops across the journey progression, selecting optimal Superchargers along the highway corridor.
- Prioritizes high-power stations (250kW V3 / 325kW V4) with minimal detours (typically 0.1 to 0.3 miles off highway exits) and healthy stall counts (12+ stalls).
- Eliminates erratic backtracking through a 2-opt untangling optimization pass.
- Configurable stop density (6–**50** corridor stops; UI + backend clamp at 50).
- Changing strategy (Maximize Visits ↔ Min Stops), max stops, corridor buffer, or vehicle settings **replans automatically** when origin and destination are set.

### 2. Map Area Selection & Force-Included Chargers
Area tools live on the **top-right map toolbar** (alongside Layers), not in the left sidebar. Use **Box** or **Freehand**, with **Clear selection** next to them:

![Area Selection on Map](media/03_area_selected_route.png)

- **How Area Selection Works**:
  1. On the map toolbar (top-right), click **Box** or **Freehand** to start drawing.
  2. **Box:** click-drag a rectangle. **Freehand:** click-drag an outline; release closes the polygon.
  3. Stations inside the selection are force-included (cyan markers on the map). There is no left-sidebar Force-Included list.
  4. Routing guarantees inclusion of all selected stations in an efficient order.
  5. Individual stations can still be toggled from the charger drawer.
  6. **Clear selection** (eraser on the same toolbar) cancels an in-progress draw, removes the overlay, drops chargers from that area select, and restores map pan/zoom. Individually pinned stops stay (unpin from the drawer).

### 3. Fastest Trip (Min Stops) Mode
When speed is priority, toggle to **Min Stops** mode. The algorithm uses a greedy lookahead simulation to calculate the minimum number of charging stops required to safely reach the destination while preserving a reserve buffer (e.g., 15% arrival SoC).

---

## Global Tesla Supercharger Dataset
- **11,289 verified Superchargers** across 58 countries (9,013 open stations) bundled locally in `data/superchargers.json`.
- Complete specifications:
  - Power: 60 kW to 500 kW V4/Megachargers.
  - Stall counts: up to 55+ stalls per hub.
  - Plug standards: NACS and CCS support.
  - Amenities: Solar canopy, Megapack battery storage, open to non-Tesla EVs, and host facility names.

---

## Quick Start & Try-It Instructions

The application uses a **multi-stage Docker build on Red Hat Hardened Images (HI)**:

- Builder: `registry.access.redhat.com/hi/python:3.12-builder`
- Runtime: `registry.access.redhat.com/hi/python:3.12` (minimal; no shell)

Prefer `git pull` then `docker compose up -d --build` so the HI image is rebuilt. Also runnable with local Python.

### Sync with git (recommended)
```bash
***REMOVED***
git clone <repository-url> tesla-supercharger-planner
cd tesla-supercharger-planner
git pull --ff-only origin main
docker compose up -d --build
# → http://localhost:8080
```

### Option 1: Docker Compose
From the repository root (`tesla-supercharger-planner`):
```bash
# Build (HI multi-stage) and start the container in background
docker compose up -d --build

# Verify container status and health
docker compose ps

# View live container logs
docker compose logs -f
```
Open your browser to:
```
http://localhost:8080
```
To stop the service:
```bash
docker compose down
```

### Option 2: Docker CLI (`docker run`)
Build and run the standalone image:
```bash
# Build the Docker image
docker build -t tesla-supercharger-planner:hi-3.12 .

# Run the container mapping port 8080
docker run -d --name tesla-supercharger-planner -p 8080:8080 tesla-supercharger-planner:hi-3.12

# Inspect logs
docker logs -f tesla-supercharger-planner

# Smoke-test health check
curl http://localhost:8080/api/health
```
To stop and remove the container:
```bash
docker rm -f tesla-supercharger-planner
```

### Option 3: Local Python (No Docker Required)
- Python 3.10+ (Standard library only; zero external pip dependencies).
```bash
python3 server.py 8080
```
Open `http://localhost:8080` in your browser.

### Dataset Refresh Utility
To fetch and update the bundled dataset from upstream open records:
```bash
python3 scripts/fetch_superchargers.py
```

---

## Testing & Verification

### Unit & Integration Tests (11/11 Passing)
Tests dataset loading, Haversine geometry, radial queries, text searches, polyline corridor searches, Visit Maximizer sequencing, force-included area stops, and geocoding:
```bash
python3 -m unittest discover -s tests -v
```

### Playwright Browser Test Suite
Runs end-to-end automated UI checks including Visit Maximizer calculation, drawer interactions, map bounding box selection, station exploration, and mobile layout:
```bash
node tests/verify_ui.js
```

---

## API Reference

- `GET /api/health`: Health status.
- `GET /api/stats`: Dataset statistics.
- `GET /api/superchargers`: Query stations by bounds, radius, text search, status, power, or stalls.
- `GET /api/geocode?q=<address>`: Geocode address names or `lat, lng` coordinates.
- `POST /api/plan-route`:
  ```json
  {
    "origin": [37.7749, -122.4194],
    "destination": [34.0522, -118.2437],
    "routing_mode": "MAXIMIZE",
    "forced_chargers": [{"id": 4298, "name": "Baker, CA", "lat": 35.269, "lng": -116.066}],
    "max_stops": 15,
    "initial_battery": 90,
    "target_arrival": 15,
    "max_range_km": 450,
    "corridor_buffer_km": 30
  }
  ```

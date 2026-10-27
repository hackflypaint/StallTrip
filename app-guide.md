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
| **Drone flight** | Overlay | No-fly / auth-required constraints (FAA + NPS parks) |

![Topographic basemap](media/topo_layer.png)

### Drone flight constraints (FAA + NPS)
Lives in a **removable** module under `static/airspace/` (see that folder’s `README.md`).

- **Purpose:** show whether flight is typically **no-fly**, **authorization required**, or unconstrained — not a LAANC approval tool.
- **Class toggles:** under Drone flight, **Do Not Fly**, **National park**, and **Fly with Approval** are independently show/hide; Restricted (R) SUA is **hard no-fly**. Visual language mirrors Autopylot (amber UASFM grids + ceiling labels, red blocking, purple→red parks) using public FAA/NPS data only.
- **Sources:** FAA FeatureServers (`Class_Airspace` B/C/D, Prohibited/Restricted SUA, `National_Defense_Airspace_TFR_Areas`, `FAA_UAS_FacilityMap_Data`, `Stadiums`) plus official NPS Land Resources boundaries (`…/fBc8EJBxQRMcHlei/…/NPS_Land_Resources_Division_Boundary_and_Tract_Data_Service/FeatureServer/2`). Hubs: [ADDS](https://adds-faa.opendata.arcgis.com/) · [UDDS](https://udds-faa.opendata.arcgis.com/).
- **Not used:** Autopylot private APIs; airport markers; MOA/Warning SUA chrome.
- **Performance:** fetches only when master Show is on; min zoom 7 (parks/SUA/Class/TFRs), 9 (UASFM), 8 (stadium points); debounced + abortable.
- **Attribution:** FAA AIS / ADDS · UDDS · NPS. Blank map ≠ legal clearance.

**How to delete later:** remove `static/airspace/`, drop the `#airspaceSlot` + airspace CSS/JS includes from `index.html`, and remove the optional `AirspaceModule.mount` hook in `app.js`.

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
git clone <repository-url> stalltrip
cd stalltrip
git pull --ff-only origin main
docker compose up -d --build
# → http://localhost:8080
```

### Option 1: Docker Compose
From the repository root:
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
docker build -t stalltrip:1.0.4 .

# Run the container mapping port 8080
docker run -d --name stalltrip -p 8080:8080 stalltrip:1.0.4

# Inspect logs
docker logs -f stalltrip

# Smoke-test health check
curl http://localhost:8080/api/health
```
To stop and remove the container:
```bash
docker rm -f stalltrip
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

### Mobile shell smoke (`/mobile`)
Phone viewport Playwright checks for map-first shell, Plan sheet, SF→LA plan, and `/` UA → `/mobile`:
```bash
# requires Chrome + playwright (npm install --no-save playwright)
node tests/verify_mobile.js
```
Platform UA redirect on **`/`** is **on by default**: any phone/tablet mobile → **`/mobile`**, Tesla MCU browser → **`/tesla`**, desktop stays **`/`**. Escape: `/?desktop=1`. Kill switch: `PLATFORM_UA_REDIRECT=0`.

### Tesla landscape suite (in-car profiles)
Chromium with `deviceScaleFactor: 1.53`, `hasTouch: true`, viewports **773×601** and **1254×784**. Smoke: **`/tesla`** (car mode) → preset plan → drawer → box select → layers (+ `/tesla-probe`). Screenshots go to the TESLA Project store `media/tesla-emulation/car-shell/` when run:
```bash
# requires: npm install playwright && server on :8080 (or let the script start it)
node tests/verify_tesla_ui.js
```

### Tesla in-car entry + probe
- **Canonical car planner:** `GET /tesla` — map-first car shell ON (bookmark over HTTPS/ngrok).
- **UA on `/`:** `QtCarBrowser` / `Tesla/<fw>` → 302 `/tesla`.
- Optional on `/`: `?car=1` (car chrome) or `?desktop=1` (skip UA redirect). Phone/tablet shell: `/mobile`.
- **Fingerprint probe:** `GET /tesla-probe` (also `/tesla-probe.html`) — UA, Chromium, viewport/screen, DPR, touch, MQs, geolocation.
- Needs **public HTTPS** in the car — LAN/localhost are blocked (see Project store `docs/https-car-access.md`).

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

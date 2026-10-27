# Code architecture — Tesla Supercharger Route Planner

In-depth map of the codebase: file summary, request/data flow, modules, packages/dependencies, and the Red Hat HI Docker build. Companion short README: [README.md](./README.md). Product features: [app-guide.md](./app-guide.md).

---

## 1. Code summary (all files)

Approximate sizes from the packaged app tree (~5k LOC excluding `data/` and foliage PNG cache).

### Root

| File | LOC | Purpose |
| --- | ---: | --- |
| `server.py` | ~235 | `http.server` app: REST under `/api/*`, SPA static from `static/` |
| `routing.py` | ~850 | Core domain: load JSON, query, geocode, OSRM, corridor search, trip planning |
| `main.py` | ~20 | Legacy SimpleSample clock script (not used by the planner) |
| `Dockerfile` | ~49 | Multi-stage Red Hat HI Python 3.12 build |
| `docker-compose.yml` | ~16 | Service `stalltrip`, HI build arg, image tag `stalltrip:1.0.7` |
| `.dockerignore` | — | Drops `__pycache__`, `node_modules`, etc. |
| `README.md` | — | Quick start: git clone/pull + Docker |

### Data & scripts

| Path | Purpose |
| --- | --- |
| `data/superchargers.json` | Bundled global dataset (~11,289 sites); loaded once into memory |
| `scripts/fetch_superchargers.py` | Offline ETL: pull `supercharge.info` → rewrite `data/superchargers.json` (not in runtime image path unless you run it) |

### Frontend (`static/`)

| Path | LOC | Purpose |
| --- | ---: | --- |
| `index.html` | ~411 | Shell: sidebar (route/explore), map, layers, area tools, drawer |
| `app.js` | ~1242 | UI state, Leaflet map, plan/explore, area select, geocode UX |
| `style.css` | ~1287 | Dark theme, sidebar, map controls, timeline, drawer |
| `foliage/` | modular | Removable Explore Fall overlay (`foliage-overlay.js`, CSS, mid-Oct PNG cache) |
| `airspace/` | modular | Removable drone no-fly / auth overlay (FAA + NPS; `airspace-overlay.js`, CSS) |

### Tests

| Path | Purpose |
| --- | --- |
| `tests/test_routing.py` | Unittest: dataset, queries, MAXIMIZE, force-include (int IDs), max_stops clamp |
| `tests/test_clear_selection.js` | Pure JS: clear-selection model + point-in-polygon |
| `tests/verify_ui.js` | Playwright end-to-end screenshots (needs Node + Playwright) |

---

## 2. Architecture overview

```
Browser (Leaflet SPA)
    │  GET  /  /static/...
    │  GET  /api/health|/stats|/superchargers|/geocode
    │  POST /api/plan-route|/find-along-route
    ▼
server.py  (stdlib HTTP, serves static/ + JSON APIs)
    ▼
routing.py
    ├─ data/superchargers.json  (in-memory)
    ├─ Photon / Nominatim       (geocode)
    └─ OSRM public router       (driving geometry)
```

**Design choices**

- **Zero pip dependencies** at runtime — easier HI/runtime slim images and supply-chain surface.
- **Single process, in-memory dataset** — fast corridor scans; not multi-tenant scaled.
- **Public geo services** — no API keys; depends on OSRM / Photon / Nominatim availability and ToS.
- **Foliage is optional** — mount via `FoliageModule`; delete `static/foliage/` to remove.
- **Airspace / UAS is optional** — mount via `AirspaceModule`; delete `static/airspace/` to remove.

---

## 3. In-depth: backend

### 3.1 `server.py`

`SuperchargerRequestHandler` extends `SimpleHTTPRequestHandler` with `directory=static/`.

**GET**

| Path | Handler | Notes |
| --- | --- | --- |
| `/api/health` | JSON healthy | Compose/Docker HEALTHCHECK target |
| `/api/stats` | Counts / max power / countries | From loaded dataset |
| `/api/superchargers` | Filtered list | Bounds, radius, `q`, status, power, stalls, `limit` |
| `/api/geocode?q=` | Place → lat/lng | Delegates to `routing.geocode_address` |
| `/` and unknown paths | `index.html` | SPA fallback |

**POST**

| Path | Body (JSON) | Result |
| --- | --- | --- |
| `/api/plan-route` | origin, destination, battery/range, mode, max_stops, forced_* | Full trip plan + geometry + corridor list |
| `/api/find-along-route` | `coordinates` [[lng,lat],…], buffer, status | Chargers near polyline |

Same-origin only: no `Access-Control-Allow-Origin` (OPTIONS → 403). Cache-Control is `no-store`. The process uses a threaded `TCPServer` (`ThreadingMixIn`) with geocode/plan rate limits and a concurrency semaphore around heavy plan/corridor work.

### 3.2 `routing.py`

**Load & index**

- `load_superchargers()` reads JSON once into `SUPERCHARGERS` and `SUPERCHARGERS_BY_ID`.
- `haversine_km` / `distance_point_to_segment_km` for distance and corridor “detour” metrics.

**Query**

- `query_superchargers(...)` — bbox, radius, text, status, min power/stalls, limit.
- `find_superchargers_along_route(coords, corridor_buffer_km)` — stations near a polyline.

**Geocode** (`geocode_address`)

1. Local presets (SF, LA, Vegas, …)  
2. `"lat, lng"` parse  
3. Photon (`photon.komoot.io`)  
4. Nominatim fallback  

**Routing**

- `get_osrm_route` — one OSRM `driving` request.  
- `get_chunked_osrm_route` — splits long via-point lists (chunk ~18) and stitches geometry.  
- `create_direct_route_fallback` — straight segments if OSRM fails.

**Stop selection**

- `select_maximizer_stops` — Visit Maximizer: space stops along corridor + forced stops; `max_stops` 1–50.  
- `select_min_stops_for_range` — greedy range-aware min stops (used when mode is `MIN_STOPS` **and** no forced stops).  
- `sequence_stops_efficiently` — 2-opt style untangle to reduce backtracking.

**Trip assembly** (`plan_trip`)

1. Resolve `forced_chargers` objects and `forced_charger_ids`.  
2. Baseline OSRM origin→destination.  
3. Corridor candidates (+ power filter).  
4. Select stops (MAXIMIZE vs MIN_STOPS).  
5. Simulate charge timing / SOC along stops (haversine legs).  
6. Build multi-stop OSRM geometry; return summary, stops, route, corridor list.

**Helpers:** `format_duration`.

### 3.3 Dataset ETL (`scripts/fetch_superchargers.py`)

Fetches `https://supercharge.info/service/supercharge/allSites`, normalizes GPS/address/stalls/plugs/amenities, writes compact `data/superchargers.json`. Run manually when refreshing data — not invoked by `server.py`.

---

## 4. In-depth: frontend

### 4.1 Shell (`index.html`)

- CDN: Leaflet CSS/JS (SRI), Inter (Google Fonts), Font Awesome (no SRI).  
- Left sidebar: Route vs Explore tabs, origin/destination, vehicle sliders, plan button.  
- Map: layers control, **Box / Freehand / Clear selection** (top-right) — no Force-Included sidebar list.  
- Drawer for station detail; optional `#foliageSlot`, `#airspaceSlot`.

### 4.2 `app.js` state machine

`state` holds map, markers, origin/dest, `forcedChargers` Map, area-select mode, `planRouteSeq` (stale-response guard), routing mode, vehicle params.

**Map:** OSM streets (dark filter) vs OpenTopoMap; nearby-station overlay; foliage + airspace mounts.

**Area tools:** box bounds or freehand ring → `/api/superchargers` or client filter → force-include batch → optional auto-replan. **Clear selection** drops area batch only (manual pins kept).

**Plan route:** POST `/api/plan-route` with forced charger objects; renders polyline, stop markers, timeline.

**Explore:** bounds queries on pan/filter; list + drawer.

### 4.3 Foliage module (`static/foliage/`)

- Daily CONUS PNG from Explore Fall (`maps/2026/{YYYYMMDD}.png`), georeferenced overlay.  
- Mid-October dates cached under `foliage/cache/` for offline demos.  
- Credit UI required. Removable: delete folder + slot/hooks (see foliage README).

### 4.4 Drone flight module (`static/airspace/`)

- Viewport-bounded GeoJSON: FAA Class B/C/D + P/R SUA + defense TFRs + UASFM + stadiums, plus NPS Land Resources boundaries (park no-fly).  
- Maps to pilot-facing **no-fly** / **auth required**; debounced fetch; zoom gates; no Autopylot private APIs.  
- Removable: delete folder + slot/hooks (see airspace README).

---

## 5. Packages & dependencies

There is **no** `requirements.txt` / `package.json` for the running app. Everything below is either stdlib, CDN, or outbound HTTP.

### 5.1 Python standard library (runtime)

Used across `server.py` / `routing.py` / scripts:

| Module | Use |
| --- | --- |
| `http.server` | HTTP handler / static files |
| `socketserver` | TCP server |
| `json` | Request/response + dataset |
| `urllib.parse` / `urllib.request` | Query parsing; OSRM / Photon / Nominatim / ETL |
| `os`, `sys` | Paths, PORT, CLI |
| `math` | Haversine / geometry |
| `mimetypes` | Static content types |
| `typing` | Type hints |
| `datetime` | `main.py` only |
| `unittest` | `tests/test_routing.py` |

**No PyPI packages** in production.

### 5.2 Browser / CDN (client)

| Package | Version | Source | Notes |
| --- | --- | --- | --- |
| Leaflet | 1.9.4 | unpkg | CSS + JS with **SRI** |
| Font Awesome | 6.5.1 | cdnjs | Icons; **no SRI** today |
| Inter (font) | — | fonts.googleapis.com | UI type |

### 5.3 Test-only (Node)

| Package | Use |
| --- | --- |
| Playwright (`chromium`) | `tests/verify_ui.js` screenshots / E2E |

Not required to run the app.

### 5.4 External HTTP services (not “packages”, but runtime deps)

| Service | URL / pattern | Used for |
| --- | --- | --- |
| OSRM | `http://router.project-osrm.org` | Driving routes |
| Photon | `https://photon.komoot.io/api` | Geocoding |
| Nominatim | `https://nominatim.openstreetmap.org` | Geocode fallback |
| OpenStreetMap / OpenTopoMap | tile URLs in `app.js` | Basemaps |
| Explore Fall | `https://www.explorefall.com/maps/2026/…` | Foliage rasters |
| supercharge.info | ETL only | Dataset refresh |

### 5.5 Container base images (HI)

| Image | Role |
| --- | --- |
| `registry.access.redhat.com/hi/python:3.12-builder` | Build stage (compile + import check) |
| `registry.access.redhat.com/hi/python:3.12` | Runtime (UID **65532**, no shell) |

Public catalog pulls; no Red Hat subscription required for these HI tags. Docs/catalog: [images.redhat.com](https://images.redhat.com).

---

## 6. HI build process

### 6.1 Why multi-stage HI

Red Hat **Hardened Images** split **builder** (tools/shell for assemble) from **runtime** (minimal, no package manager/shell). The app is stdlib-only, so the builder stage only copies sources, byte-compiles, and import-smokes — **no `pip install`**.

### 6.2 Stages (from `Dockerfile`)

```text
ARG PYTHON_HI_VERSION=3.12

Stage 1 — builder
  FROM registry.access.redhat.com/hi/python:${PYTHON_HI_VERSION}-builder
  COPY routing.py server.py data/ static/
  RUN python3 -m compileall -q .
  RUN python3 -c "import routing; import server"

Stage 2 — runtime
  FROM registry.access.redhat.com/hi/python:${PYTHON_HI_VERSION}
  COPY --from=builder --chown=65532:65532 /build/ /app/
  USER 65532
  HEALTHCHECK  → GET http://127.0.0.1:8080/api/health  (exec-form; no /bin/sh)
  ENTRYPOINT ["python3", "server.py"]
  CMD ["8080"]
```

Important: HEALTHCHECK and ENTRYPOINT use **exec JSON form** because the HI runtime image has **no shell**.

### 6.3 Compose wiring

`docker-compose.yml` passes:

```yaml
build:
  args:
    PYTHON_HI_VERSION: "3.12"
image: stalltrip:1.0.7
```

### 6.4 Commands

```bash
# Preferred (compose + rebuild)
docker compose up --build -d

# Equivalent CLI
docker build -t stalltrip:1.0.7 .
docker run -d --name stalltrip -p 8080:8080 \
  stalltrip:1.0.7

# Podman (cloud CI style)
podman build --format docker -t stalltrip:1.0.7 .
```

Expect on the order of ~100–120 MB image after a successful HI build (environment-dependent).

### 6.5 What is copied into the image

Included: `routing.py`, `server.py`, `data/`, `static/` (including foliage cache PNGs).

Typically excluded by `.dockerignore`: `__pycache__`, `node_modules`, lockfiles. Tests and `scripts/` are **not** COPY’d in the current Dockerfile (refresh dataset outside the image).

### 6.6 Runtime identity

Process runs as **UID 65532** (non-root). Port **8080**. Env: `PYTHONUNBUFFERED=1`, `PYTHONDONTWRITEBYTECODE=1`, `PORT=8080`.

---

## 7. API cheat sheet

```bash
curl -fsS localhost:8080/api/health
curl -fsS 'localhost:8080/api/stats'
curl -fsS 'localhost:8080/api/geocode?q=San%20Francisco'
curl -fsS 'localhost:8080/api/superchargers?lat=37.77&lng=-122.42&radius_km=30&limit=20'

curl -fsS localhost:8080/api/plan-route -H 'Content-Type: application/json' -d '{
  "origin": [37.7749, -122.4194],
  "destination": [34.0522, -118.2437],
  "routing_mode": "MAXIMIZE",
  "max_stops": 12,
  "initial_battery": 90,
  "target_arrival": 15,
  "max_range_km": 450,
  "corridor_buffer_km": 30
}'
```

---

## 8. Related Context docs

- [README.md](./README.md) — short start  
- [app-guide.md](./app-guide.md) — features & UX  
- [project-context.md](./project-context.md) — cloud vs local git workflow
- `internal/prod-readiness-review.md` — security/bug NO-GO notes (pre-prod hardening)

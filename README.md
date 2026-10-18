# Tesla Supercharger Route Planner

Plan EV road trips that **maximize Supercharger visits** along a corridor (or minimize stops for range). Map area tools (box / freehand / clear) force-include stations. Dark Leaflet UI, bundled global Supercharger dataset, Docker on **Red Hat Hardened Images (HI)**.

## Quick start (git)

```bash
***REMOVED***
git clone <repository-url> tesla-supercharger-planner
cd tesla-supercharger-planner
git checkout main
git pull --ff-only origin main
docker compose up -d --build
# → http://localhost:8080
curl -fsS http://localhost:8080/api/health
```

Everyday update:

```bash
***REMOVED***/tesla-supercharger-planner
git pull --ff-only origin main
docker compose up -d --build
```

Local Python (no Docker): `python3 server.py 8080` — **stdlib only**, no `pip install`.

**Mobile:** map-first web shell at **`/mobile`** (`COST_PROFILE=lean`) — separate from desktop `/` and Tesla car shell. Soft UA redirect stays **off**. Deploy notes: [mobile-deploy.md](./mobile-deploy.md). *(You may optionally tunnel with ngrok himself; agents do not run ngrok.)*

### Mobile verify
```bash
python3 -m unittest tests.test_mobile tests.test_security -v
COST_PROFILE=lean python3 server.py 8080
# phones → http://localhost:8080/mobile
```

## What’s in the box

| Layer | Role |
| --- | --- |
| `server.py` | HTTP API + static file server |
| `routing.py` | Dataset, geocode, OSRM, trip planning |
| `static/` | SPA (map, route, explore, foliage module) |
| `data/superchargers.json` | ~11k stations (bundled) |
| `Dockerfile` | Multi-stage **HI** Python 3.12 build |

## Tesla in-car probe

`GET /tesla-probe` — fingerprint page for car browser (viewport, DPR, touch, geolocation). The car cannot hit LAN/localhost; use a public HTTPS tunnel or deploy (Project store runbook `docs/https-car-access.md`).

Tesla Playwright profiles: `node tests/verify_tesla_ui.js` (773×601 & 1254×784, DPR 1.53, touch).

## Docs

| Doc | Purpose |
| --- | --- |
| [app-guide.md](./app-guide.md) | Product / feature guide |
| [code-architecture.md](./code-architecture.md) | Full code summary, deep dive, packages, HI build |
| [project-context.md](./project-context.md) | Cloud vs local git workflow |

## Requirements

- **Runtime:** Python 3.10+ (3.12 in HI image) — stdlib only
- **Browser CDN:** Leaflet 1.9.4 (SRI), Font Awesome 6.5.1, Google Fonts
- **Outbound (live):** OSRM, Photon, Nominatim; optional Explore Fall PNGs
- **Build:** Docker/Podman; pull `registry.access.redhat.com/hi/python:3.12(-builder)` (public)

## Image tag

`tesla-supercharger-planner:hi-3.12` — see [HI build process](./code-architecture.md#hi-build-process).

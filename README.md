# Tesla Supercharger Route Planner

Plan EV road trips that **maximize Supercharger visits** along a corridor (or minimize stops for range). Map area tools (box / freehand / clear) force-include stations. Dark Leaflet UI, bundled global Supercharger dataset, Docker on **Red Hat Hardened Images (HI)**.

## Quick start (git)

```bash
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
cd tesla-supercharger-planner
git pull --ff-only origin main
docker compose up -d --build
```

Local Python (no Docker): `python3 server.py 8080` — **stdlib only**, no `pip install`.

**Mobile / Tesla entry:** hitting **`/`** redirects by User-Agent — phone/tablet → **`/mobile`**, Tesla in-car browser → **`/tesla`**, desktop stays **`/`**. Escape hatch: **`/?desktop=1`**. Opt out: `PLATFORM_UA_REDIRECT=0`. Deploy notes: [mobile-deploy.md](./mobile-deploy.md). Optional public tunnel: `./scripts/mobile-ngrok.sh` (uses local ngrok config; never commit tokens).

### Mobile / platform verify
```bash
python3 -m unittest tests.test_platform_redirect tests.test_mobile tests.test_security -v
COST_PROFILE=lean python3 server.py 8080
# phones → http://localhost:8080/  (302 → /mobile) or explicit /mobile
```

## What’s in the box

| Layer | Role |
| --- | --- |
| `server.py` | HTTP API + static file server |
| `routing.py` | Dataset, geocode, OSRM, trip planning |
| `static/` | SPA (map, route, explore, foliage module) |
| `data/superchargers.json` | ~11k stations (bundled) |
| `Dockerfile` | Multi-stage **HI** Python 3.12 build |

## Tesla in-car

- **Canonical car entry:** `GET /tesla` — planner with car mode ON (map-first sheet). Bookmark this over a public HTTPS URL.
- **UA on `/`:** Tesla MCU browser (`QtCarBrowser` / `Tesla/<fw>`) → 302 `/tesla`. Phones/tablets → `/mobile`. Desktop UA stays on `/`.
- Optional force car chrome on desktop `/`: `?car=1`. Force desktop shell: `?desktop=1`.
- **Probe:** `GET /tesla-probe` — fingerprint (UA, DPR, touch, geolocation). Not the planner.
- Car cannot hit LAN/localhost — use public HTTPS in front of the container.
- Playwright: `node tests/verify_tesla_ui.js` hits `/tesla` at 773×601 / half-MCU / 1254×784.

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
Dockerfile HI bases are **pinned by digest** (refresh digests when bumping the HI stream).

## License & attribution

- **Application code:** [MIT](./LICENSE) — `Copyright (c) 2026 Contributors`
- **Bundled data / foliage cache:** not under MIT — see [ATTRIBUTION.md](./ATTRIBUTION.md)
  (supercharge.info station JSON; Explore Fall daily PNGs and `static/foliage/cache/`)

## Reverse proxy / rate limits

Geocode and plan-route limits key by client IP. Direct expose uses the TCP peer
address only. If you terminate TLS or load-balance in front of the container, set
`TRUST_PROXY=1` so limits honor `X-Forwarded-For` / `Forwarded` (left-most client).
**Only enable when the proxy overwrites untrusted client forwarded headers** —
otherwise clients can spoof IPs and evade or share buckets.

Tune with `PLAN_RATE_LIMIT`, `GEOCODE_RATE_LIMIT`, and `PLAN_RATE_WINDOW_SEC`.
For local E2E only, set `ALLOW_TEST_RATE_BYPASS` to a shared secret and send the
same value in `X-Test-Rate-Bypass`; that skips plan/geocode limits and can clear
windows via `GET /api/health?reset_rate_limit=1`. Never set the env var on a
public host (compose leaves it unset).

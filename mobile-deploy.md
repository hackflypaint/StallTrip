# Mobile HI publish — `/mobile` on Red Hat Hardened Images

Phone entry is the **web shell** at `/mobile` (same HI container as desktop). No Amplify, Lambda, S3 static hosting, or native wrappers.

## Run (preferred)

```bash
git checkout cursor/mobile
git pull --ff-only origin cursor/mobile
docker compose up -d --build
# Phone / bookmark:
curl -fsS http://localhost:8080/api/health | python3 -m json.tool
# → mobile_shell: "/mobile", cost_profile: "lean"
open http://localhost:8080/mobile
```

Podman-style:

```bash
podman build --format docker -t tesla-supercharger-planner:hi-3.12 .
podman run -d --name tesla-supercharger-planner -p 8080:8080 \
  -e COST_PROFILE=lean \
  --read-only --tmpfs /tmp:size=16m \
  --user 65532:65532 \
  --memory 512m --pids-limit 256 \
  tesla-supercharger-planner:hi-3.12
```

## What burns money / quota (and how we limit it)

| Burner | Who pays | Mitigation on this image |
| --- | --- | --- |
| **OSRM** public router | Upstream ToS / your egress to it | `PLAN_RATE_LIMIT`, `MAX_CONCURRENT_PLANS`, body caps |
| **Photon / Nominatim** geocode | Upstream ToS / egress | `GEOCODE_RATE_LIMIT` |
| **OSM / Topo tiles** | Browser→tile CDN (not our server) | Map-first UI; users still load tiles — expected |
| **ArcGIS foliage/airspace** | Browser→ArcGIS when Layers enabled | **Lazy-mounted on mobile** until Layers opens |
| **Our HI host egress** | Your VM/network bill | Static `max-age` cache; single small image; no S3 mirror |

`COST_PROFILE=lean` (compose default) tightens plan/geocode/concurrency. Do **not** set `MOBILE_UA_REDIRECT=1` in prod unless you intentionally want every phone hit on `/` to bounce to `/mobile` (extra round-trip, easy to mis-measure).

## Env knobs

| Variable | Lean default | Notes |
| --- | --- | --- |
| `COST_PROFILE` | `lean` | `lean`/`low`/`cheap` → tighter rate defaults |
| `GEOCODE_RATE_LIMIT` | 12 / min / IP | Raise only if users hit 429s |
| `PLAN_RATE_LIMIT` | 4 / min / IP | Each plan hits OSRM |
| `MAX_CONCURRENT_PLANS` | 2 | Caps CPU + upstream fan-out |
| `STATIC_CACHE_MAX_AGE` | 300 | Seconds for `.js`/`.css`/images |
| `MOBILE_UA_REDIRECT` | unset/off | Keep off for predictable traffic |
| `PORT` | 8080 | HI `EXPOSE` |

## Verify

```bash
python3 -m unittest tests.test_mobile tests.test_security -v
curl -fsSI http://localhost:8080/mobile | head -15
curl -fsS http://localhost:8080/api/health
# optional: npm install --no-save playwright && node tests/verify_mobile.js
```

## TLS / DNS (chris)

This image speaks **HTTP on 8080**. Put a reverse proxy (Caddy/nginx/OpenShift route) in front for HTTPS. No AWS Amplify/CloudFront required — any cheap VPS or existing HI/OpenShift route works.

# Mobile publish — `/mobile`

Phone entry is the **web shell** at `/mobile` (same stdlib / HI container as desktop). No Amplify, Lambda, S3 static hosting, or native wrappers.

## Separation

| Surface | Entry | Notes |
| --- | --- | --- |
| Desktop planner | `/` | Default SPA; also `/?desktop=1` escape |
| **Phone / tablet shell** | **`/mobile`** | Map-first; `body.ui-mobile` |
| Tesla car shell | **`/tesla`** | `body.car-shell` — not `/mobile` |
| Tesla probe | `/tesla-probe` | Fingerprint page |

### Platform User-Agent redirect (on by default)

Hitting **`/`** (GET/HEAD) may 302 before the SPA:

| User-Agent class | Redirect | Tokens / notes |
| --- | --- | --- |
| Tesla in-car browser | `/tesla` | `QtCarBrowser`, `Tesla/<firmware>` |
| Phone / tablet mobile | `/mobile` | Android (phone + tablet), iPhone, iPod, **iPad**, Windows Phone, generic `Mobile`, … |
| Desktop / unknown | _(none)_ | Stay on `/` |

- Already on `/mobile` or `/tesla` → no redirect (no loops). APIs/static never redirected.
- **iPad** → `/mobile` (tablet uses the phone shell). iPadOS “Request Desktop Website” often looks like Macintosh and stays on `/`.
- Escape hatch: **`/?desktop=1`** or **`/?ui=desktop`**.
- Disable entirely: `PLATFORM_UA_REDIRECT=0` (legacy alias: `MOBILE_UA_REDIRECT=0`).

Optional public URL: `./scripts/mobile-ngrok.sh` (local ngrok config / `NGROK_AUTHTOKEN` — never commit tokens).

## HI container (preferred host)

```bash
git checkout main && git pull --ff-only origin main
docker compose up -d --build
curl -fsS http://localhost:8080/api/health | python3 -m json.tool
# → mobile_shell: "/mobile", cost_profile: "lean"
# phones: http://<host>:8080/mobile
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

| Burner | Who pays | Mitigation |
| --- | --- | --- |
| **OSRM** public router | Upstream ToS / egress | `PLAN_RATE_LIMIT`, `MAX_CONCURRENT_PLANS` |
| **Photon / Nominatim** | Upstream ToS / egress | `GEOCODE_RATE_LIMIT` |
| **OSM / Topo tiles** | Browser→tile CDN | Expected on phones |
| **ArcGIS overlays** | Browser→ArcGIS when Layers on | Lazy-mounted on mobile |
| **HI / VPS egress** | Host bill | Static `max-age` cache; lean profile |
## Env knobs

| Variable | Lean default | Notes |
| --- | --- | --- |
| `COST_PROFILE` | `lean` | Tighter rate defaults |
| `GEOCODE_RATE_LIMIT` | 12 / min / IP | |
| `PLAN_RATE_LIMIT` | 4 / min / IP | Each plan hits OSRM |
| `MAX_CONCURRENT_PLANS` | 2 | |
| `STATIC_CACHE_MAX_AGE` | 300 | JS/CSS/images |
| `PLATFORM_UA_REDIRECT` | on (default) | Set `0` to disable `/` UA redirects |
| `MOBILE_UA_REDIRECT` | _(alias)_ | Legacy name for the same kill switch |
| `PORT` | 8080 | |
## Optional: ngrok (local only)

```bash
COST_PROFILE=lean python3 server.py 8080
./scripts/mobile-ngrok.sh   # uses local ngrok config / NGROK_AUTHTOKEN — never commit tokens
# phones → https://<ngrok-host>/mobile
```

## Verify

```bash
python3 -m unittest tests.test_platform_redirect tests.test_mobile tests.test_security tests.test_routing -v
curl -fsSI http://localhost:8080/mobile | head -15
curl -fsSI -A "Mozilla/5.0 (iPhone)" http://localhost:8080/ | head -15   # → Location: /mobile
curl -fsS http://localhost:8080/api/health
# optional: npm install --no-save playwright && node tests/verify_mobile.js
```

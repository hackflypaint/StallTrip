# Mobile publish — `/mobile`

Phone entry is the **web shell** at `/mobile` (same stdlib / HI container as desktop). No Amplify, Lambda, S3 static hosting, or native wrappers.

## Separation

| Surface | Entry | Notes |
| --- | --- | --- |
| Desktop planner | `/` | Default SPA |
| **Phone mobile shell** | **`/mobile`** | Map-first; `body.ui-mobile` |
| Tesla car shell | `/` + landscape heuristics / `?car=1` | `body.car-shell` — not `/mobile` |
| Tesla probe | `/tesla-probe` | Fingerprint page |

Agents **do not** start ngrok. You may optionally use `./scripts/mobile-ngrok.sh` himself for a public URL.

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
| `MOBILE_UA_REDIRECT` | unset/off | Keep off |
| `PORT` | 8080 | |
## Optional: ngrok (local only)

```bash
COST_PROFILE=lean python3 server.py 8080
./scripts/mobile-ngrok.sh   # uses local ngrok config / NGROK_AUTHTOKEN — never commit tokens
# phones → https://<ngrok-host>/mobile
```

## Verify

```bash
python3 -m unittest tests.test_mobile tests.test_security tests.test_routing -v
curl -fsSI http://localhost:8080/mobile | head -15
curl -fsS http://localhost:8080/api/health
# optional: npm install --no-save playwright && node tests/verify_mobile.js
```

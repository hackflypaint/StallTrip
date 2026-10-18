# Mobile publish — `/mobile`

Phone entry is the **web shell** at `/mobile` (same stdlib / HI container as desktop). No Amplify, Lambda, S3 static hosting, or native wrappers.

## Current public path: ngrok (chris)

Use this until HI TLS/DNS is ready.  already has ngrok set up on his machine — **do not put tokens in git**.

```bash
git checkout cursor/mobile && git pull --ff-only origin cursor/mobile

# 1) App locally (lean cost profile)
COST_PROFILE=lean python3 server.py 8080
# or: docker compose up -d --build

# 2) Tunnel (separate terminal) — uses local ngrok config / NGROK_AUTHTOKEN
./scripts/mobile-ngrok.sh
# equivalent: ngrok http 8080
```

Phones open: **`https://<ngrok-host>/mobile`**  
Health: `https://<ngrok-host>/api/health` → `mobile_shell: "/mobile"`, `cost_profile: "lean"`.

Auth (once per machine, never commit):

```bash
# Option A — config file (preferred)
ngrok config add-authtoken "$NGROK_AUTHTOKEN"

# Option B — env for this shell only
export NGROK_AUTHTOKEN=…   # from ngrok dashboard; not stored in this repo
ngrok http 8080
```

Keep `COST_PROFILE=lean`. Keep `MOBILE_UA_REDIRECT` **off** (ngrok already points people at `/mobile`).

## Long-term host: Red Hat HI container

Same image; later put a reverse proxy / OpenShift route in front for HTTPS instead of ngrok.

```bash
git checkout cursor/mobile
git pull --ff-only origin cursor/mobile
docker compose up -d --build
curl -fsS http://localhost:8080/api/health | python3 -m json.tool
# → mobile_shell: "/mobile", cost_profile: "lean"
# phones (LAN): http://<host>:8080/mobile
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
| **ngrok** | Your ngrok plan | Free tier OK for demos; don’t leave tunnels idle forever |

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
| `NGROK_AUTHTOKEN` | **local only** | Never commit |

## Verify

```bash
python3 -m unittest tests.test_mobile tests.test_security -v
curl -fsSI http://localhost:8080/mobile | head -15
curl -fsS http://localhost:8080/api/health
./scripts/mobile-ngrok.sh   # after app is up; needs ngrok on PATH
# optional: npm install --no-save playwright && node tests/verify_mobile.js
```

# Changelog

All notable StallTrip releases are listed here. Version strings are kept in sync
across `VERSION`, `server.py` (`APP_VERSION`), Dockerfile labels, and compose image tags.

## [1.0.7] — 2026-10-27

### Security

- `_read_json_body` catches `RecursionError` on pathologically nested JSON (400)
- `sanitize_log_text` strips unsafe controls before secret/geo redaction; expands Auth (any scheme), Cookie/Set-Cookie, JSON secrets, and lat/lng; mirrored in client `redact()`
- CSP `connect-src` narrowed to `leaflet@1.9.4/` and `font-awesome/6.5.1/` paths (no bare CDN hosts)
- Nominatim User-Agent is `StallTrip/{version}` with optional `NOMINATIM_CONTACT` (CR/LF stripped)

### Changed

- Release identity normalized to **v1.0.7** / `stalltrip:1.0.7`
- HI Python 3.12 builder/runtime digests refreshed; builder drops to `USER 65532` after `--chown`
- Expanded `.dockerignore`; compose publishes `127.0.0.1:8080` with `BIND_ADDR` docs
- Live-location unit tests assert against real `app.js` helpers

## [1.0.6] — 2026-10-27

### Fixed

- Honest destination / stop arrival SOC (no hidden 5% floor when range is insufficient)
- MIN_STOPS remaining-distance uses haversine consistently after forced stops (no OSRM/haversine mix that exited early)
- Failed live/one-shot replan restores the prior itinerary instead of leaving an empty UI
- Mobile location deny/unsupported no longer silently seeds San Francisco as origin
- Origin/destination field edits invalidate stale geocoded state so Plan matches visible text
- Airspace SUA/TFR fetch failure keeps last-good no-fly polygons (no false clear)
- `TRUST_PROXY_HOPS` longer than the XFF chain falls back to the TCP peer (no left-most spoof)

### Changed

- Docker image/container names aligned to `stalltrip:1.0.6`
- HI Python 3.12 builder/runtime digests refreshed to current registry tags
- Health + `Server` header advertise `StallTrip` / `1.0.6`
- Release identity normalized to **v1.0.6** across VERSION, Dockerfile, compose, docs, and scripts

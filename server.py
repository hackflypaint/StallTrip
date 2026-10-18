#!/usr/bin/env python3
"""
Tesla Supercharger Route Planner - Web Application & API Server.
Zero extra third-party dependencies: Built with Python's high performance standard library.
"""

import http.server
import json
import os
import re
import socketserver
import sys
import threading
import time
import traceback
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import routing

PORT = int(os.environ.get("PORT", 8080))
STATIC_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))

# Soft mobile UA redirect is OFF by default. Prefer explicit /mobile for tests & bookmarks.
# Enable with MOBILE_UA_REDIRECT=1 only when you want phones on / to land on the mobile shell.
_MOBILE_UA_RE = re.compile(r"Mobile|Android|iPhone|iPad|iPod", re.IGNORECASE)


def mobile_ua_redirect_enabled() -> bool:
    return os.environ.get("MOBILE_UA_REDIRECT", "").strip().lower() in ("1", "true", "yes")


def looks_like_mobile_ua(user_agent: str) -> bool:
    return bool(user_agent and _MOBILE_UA_RE.search(user_agent))


def cost_profile_lean() -> bool:
    """HI-friendly lean profile: tighter upstream geo/plan budgets."""
    return os.environ.get("COST_PROFILE", "").strip().lower() in ("lean", "low", "cheap")


def _clamp_int(value: Any, default: int, lo: int, hi: int) -> int:
    try:
        n = int(value)
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))


def _clamp_float(value: Any, default: float, lo: float, hi: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = default
    return max(lo, min(hi, n))


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return _clamp_int(default, default, lo, hi)
    return _clamp_int(raw, default, lo, hi)


# Request / response hardening limits
MAX_BODY_BYTES = 256 * 1024  # 256 KiB
MAX_SUPERCHARGER_LIMIT = 500
DEFAULT_SUPERCHARGER_LIMIT = 250
MAX_FORCED_CHARGERS = 100
MAX_ROUTE_COORDINATES = 2000
MAX_GEOCODE_QUERY_LEN = 200
MAX_CORRIDOR_BUFFER_KM = 100.0
MAX_GEOCODE_TRACKED_IPS = 10_000
REQUEST_SOCKET_TIMEOUT_SEC = 30

# Cost knobs (env-overridable). COST_PROFILE=lean tightens defaults for HI deploy.
_LEAN = cost_profile_lean()
GEOCODE_RATE_LIMIT = _env_int("GEOCODE_RATE_LIMIT", 12 if _LEAN else 30, 1, 120)
GEOCODE_RATE_WINDOW_SEC = float(_env_int("GEOCODE_RATE_WINDOW_SEC", 60, 10, 600))
PLAN_RATE_LIMIT = _env_int("PLAN_RATE_LIMIT", 4 if _LEAN else 10, 1, 60)
PLAN_RATE_WINDOW_SEC = float(_env_int("PLAN_RATE_WINDOW_SEC", 60, 10, 600))
MAX_CONCURRENT_PLANS = _env_int("MAX_CONCURRENT_PLANS", 2 if _LEAN else 4, 1, 16)
# Browser cache for static assets (seconds) — cuts repeat egress; APIs stay no-store.
STATIC_CACHE_MAX_AGE = _env_int("STATIC_CACHE_MAX_AGE", 300, 0, 86400)

# Simple in-memory rate limiters: ip -> (window_start, count)
_geocode_hits: Dict[str, Tuple[float, int]] = {}
_plan_hits: Dict[str, Tuple[float, int]] = {}
_geocode_lock = threading.Lock()
_plan_lock = threading.Lock()
_plan_semaphore = threading.Semaphore(MAX_CONCURRENT_PLANS)


class SuperchargerRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Handles static files and REST API endpoints for Tesla Supercharger planning."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def setup(self):
        super().setup()
        try:
            self.connection.settimeout(REQUEST_SOCKET_TIMEOUT_SEC)
        except OSError:
            pass

    def do_OPTIONS(self):
        """Same-origin app — reject cross-origin preflight abuse."""
        self.send_json_response({"error": "CORS not enabled"}, status=403)

    def do_GET(self):
        self._api_response = False
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path == "/api/superchargers":
            self.handle_get_superchargers(query)
            return
        if path == "/api/geocode":
            self.handle_geocode(query)
            return
        if path == "/api/stats":
            self.handle_stats()
            return
        if path == "/api/health":
            self.send_json_response({
                "status": "healthy",
                "service": "Tesla Supercharger Route Planner",
                "mobile_shell": "/mobile",
                "cost_profile": "lean" if cost_profile_lean() else "default",
                "limits": {
                    "geocode_per_min": GEOCODE_RATE_LIMIT,
                    "plan_per_min": PLAN_RATE_LIMIT,
                    "max_concurrent_plans": MAX_CONCURRENT_PLANS,
                    "static_cache_max_age": STATIC_CACHE_MAX_AGE,
                    "mobile_ua_redirect": mobile_ua_redirect_enabled(),
                },
            })
            return
        if path.startswith("/api/"):
            self.send_json_response({"error": "Endpoint not found"}, status=404)
            return

        if self._maybe_mobile_ua_redirect(path):
            return

        self._map_spa_path(path)
        return super().do_GET()

    def do_HEAD(self):
        """Same SPA mapping as GET so probes like `curl -I /mobile` succeed."""
        self._api_response = False
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/"):
            # JSON APIs are GET/POST oriented; HEAD → 405 keeps surface small.
            self.send_response(405)
            self.send_header("Allow", "GET, POST, OPTIONS")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if self._maybe_mobile_ua_redirect(path):
            return

        self._map_spa_path(path)
        return super().do_HEAD()

    def _maybe_mobile_ua_redirect(self, path: str) -> bool:
        """Optional soft UA redirect (HTML entry only). Returns True if response sent."""
        if (
            path == "/"
            and mobile_ua_redirect_enabled()
            and looks_like_mobile_ua(self.headers.get("User-Agent", ""))
        ):
            self.send_response(302)
            self.send_header("Location", "/mobile")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return True
        return False

    def _map_spa_path(self, path: str) -> None:
        """Rewrite mobile + unknown paths onto index.html (same SPA)."""
        if path in ("/mobile", "/mobile/", "/") or not self._static_file_exists(path):
            self.path = "/index.html"

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/plan-route":
            self.handle_plan_route()
            return
        if path == "/api/find-along-route":
            self.handle_find_along_route()
            return

        self.send_json_response({"error": "Endpoint not found"}, status=404)

    def _static_file_exists(self, url_path: str) -> bool:
        """True if url_path resolves to a real file under STATIC_DIR (no traversal)."""
        rel = urllib.parse.unquote(url_path.lstrip("/"))
        if not rel or ".." in rel.split("/"):
            return False
        candidate = os.path.realpath(os.path.join(STATIC_DIR, rel))
        if candidate != STATIC_DIR and not candidate.startswith(STATIC_DIR + os.sep):
            return False
        return os.path.isfile(candidate)

    def _discard_body(self, content_length: int) -> None:
        """Drain an oversized/unwanted body to avoid HTTP desync on keep-alive."""
        remaining = max(0, content_length)
        while remaining > 0:
            chunk = self.rfile.read(min(65536, remaining))
            if not chunk:
                break
            remaining -= len(chunk)

    def _read_json_body(self) -> Optional[Dict[str, Any]]:
        """Read POST body with a hard size cap. Returns None and sends error on failure."""
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.close_connection = True
            self.send_json_response({"error": "Invalid Content-Length"}, status=400)
            return None
        if content_length < 0:
            self.close_connection = True
            self.send_json_response({"error": "Invalid Content-Length"}, status=400)
            return None
        if content_length > MAX_BODY_BYTES:
            self._discard_body(content_length)
            self.close_connection = True
            self.send_json_response(
                {"error": f"Request body too large (max {MAX_BODY_BYTES} bytes)"},
                status=413,
            )
            return None
        raw = self.rfile.read(content_length)
        if not raw:
            self.send_json_response({"error": "Empty request body"}, status=400)
            return None
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json_response({"error": "Invalid JSON body"}, status=400)
            return None
        if not isinstance(data, dict):
            self.send_json_response({"error": "JSON body must be an object"}, status=400)
            return None
        return data

    def _client_ip(self) -> str:
        return self.client_address[0] if self.client_address else "unknown"

    def _rate_limit_allowed(
        self,
        hits: Dict[str, Tuple[float, int]],
        lock: threading.Lock,
        limit: int,
        window_sec: float,
    ) -> bool:
        now = time.monotonic()
        ip = self._client_ip()
        with lock:
            if len(hits) > MAX_GEOCODE_TRACKED_IPS:
                stale = [
                    key
                    for key, (start, _) in hits.items()
                    if now - start >= window_sec
                ]
                for key in stale:
                    del hits[key]
                # Evict oldest windows instead of wiping all (avoids RL burst)
                if len(hits) > MAX_GEOCODE_TRACKED_IPS:
                    overflow = len(hits) - (MAX_GEOCODE_TRACKED_IPS // 2)
                    oldest = sorted(hits.items(), key=lambda kv: kv[1][0])[:overflow]
                    for key, _ in oldest:
                        del hits[key]

            start, count = hits.get(ip, (now, 0))
            if now - start >= window_sec:
                hits[ip] = (now, 1)
                return True
            if count >= limit:
                return False
            hits[ip] = (start, count + 1)
            return True

    def _geocode_allowed(self) -> bool:
        return self._rate_limit_allowed(
            _geocode_hits, _geocode_lock, GEOCODE_RATE_LIMIT, GEOCODE_RATE_WINDOW_SEC
        )

    def _plan_allowed(self) -> bool:
        return self._rate_limit_allowed(
            _plan_hits, _plan_lock, PLAN_RATE_LIMIT, PLAN_RATE_WINDOW_SEC
        )

    def handle_get_superchargers(self, query: Dict[str, list]):
        """Filter superchargers by bounds, search text, or radius."""
        try:
            status = query.get("status", ["OPEN"])[0]
            limit = _clamp_int(
                query.get("limit", [DEFAULT_SUPERCHARGER_LIMIT])[0],
                DEFAULT_SUPERCHARGER_LIMIT,
                1,
                MAX_SUPERCHARGER_LIMIT,
            )
            min_power = _clamp_int(query["min_power"][0], 0, 0, 1000) if "min_power" in query else None
            min_stalls = _clamp_int(query["min_stalls"][0], 0, 0, 200) if "min_stalls" in query else None
            query_text = query.get("q", [None])[0]
            if isinstance(query_text, str) and len(query_text) > MAX_GEOCODE_QUERY_LEN:
                query_text = query_text[:MAX_GEOCODE_QUERY_LEN]

            bounds = None
            if "min_lat" in query and "max_lat" in query and "min_lng" in query and "max_lng" in query:
                min_lat = float(query["min_lat"][0])
                max_lat = float(query["max_lat"][0])
                min_lng = float(query["min_lng"][0])
                max_lng = float(query["max_lng"][0])
                if not (
                    -90 <= min_lat <= 90
                    and -90 <= max_lat <= 90
                    and -180 <= min_lng <= 180
                    and -180 <= max_lng <= 180
                    and min_lat <= max_lat
                ):
                    self.send_json_response({"error": "Invalid bounds"}, status=400)
                    return
                bounds = {
                    "min_lat": min_lat,
                    "max_lat": max_lat,
                    "min_lng": min_lng,
                    "max_lng": max_lng,
                }

            center_lat = float(query["lat"][0]) if "lat" in query else None
            center_lng = float(query["lng"][0]) if "lng" in query else None
            if center_lat is not None and not -90 <= center_lat <= 90:
                self.send_json_response({"error": "Invalid lat"}, status=400)
                return
            if center_lng is not None and not -180 <= center_lng <= 180:
                self.send_json_response({"error": "Invalid lng"}, status=400)
                return
            radius_km = float(query["radius_km"][0]) if "radius_km" in query else None
            if radius_km is not None:
                radius_km = max(0.1, min(500.0, radius_km))

            status = str(status)[:32]

            results = routing.query_superchargers(
                bounds=bounds,
                center_lat=center_lat,
                center_lng=center_lng,
                radius_km=radius_km,
                query_text=query_text,
                status_filter=status,
                min_power=min_power,
                min_stalls=min_stalls,
                limit=limit,
            )

            self.send_json_response({
                "count": len(results),
                "superchargers": results,
            })
        except Exception:
            traceback.print_exc()
            self.send_json_response({"error": "Invalid query parameters"}, status=400)

    def handle_geocode(self, query: Dict[str, list]):
        """Geocode query string to GPS coordinates."""
        if not self._geocode_allowed():
            self.send_json_response(
                {"error": "Geocode rate limit exceeded", "results": []},
                status=429,
            )
            return

        q = query.get("q", [""])[0].strip()
        if not q:
            self.send_json_response({"results": []})
            return
        if len(q) > MAX_GEOCODE_QUERY_LEN:
            self.send_json_response(
                {"error": "Query too long", "results": []},
                status=400,
            )
            return

        try:
            results = routing.geocode_address(q)
            self.send_json_response({"results": results})
        except Exception:
            traceback.print_exc()
            self.send_json_response({"error": "Geocoding failed", "results": []}, status=500)

    def handle_stats(self):
        """Return dataset statistics."""
        chargers = routing.load_superchargers()
        open_count = sum(1 for c in chargers if c.get("status") == "OPEN")
        powers = [c.get("power", 0) for c in chargers if c.get("power")]
        max_power = max(powers) if powers else 0
        countries = len(set(c.get("country") for c in chargers if c.get("country")))

        self.send_json_response({
            "total_superchargers": len(chargers),
            "open_superchargers": open_count,
            "max_power_kw": max_power,
            "countries_covered": countries,
        })

    def handle_plan_route(self):
        """Calculate optimal route and charging stops."""
        if not self._plan_allowed():
            self.send_json_response(
                {"error": "Plan-route rate limit exceeded"},
                status=429,
            )
            return

        data = self._read_json_body()
        if data is None:
            return

        try:
            origin = data.get("origin")
            destination = data.get("destination")
            if (
                not isinstance(origin, (list, tuple))
                or not isinstance(destination, (list, tuple))
                or len(origin) < 2
                or len(destination) < 2
            ):
                self.send_json_response(
                    {"error": "Missing origin or destination coordinates"},
                    status=400,
                )
                return

            try:
                origin_lat = float(origin[0])
                origin_lng = float(origin[1])
                dest_lat = float(destination[0])
                dest_lng = float(destination[1])
            except (TypeError, ValueError):
                self.send_json_response(
                    {"error": "Invalid origin or destination coordinates"},
                    status=400,
                )
                return
            if not (
                -90 <= origin_lat <= 90
                and -180 <= origin_lng <= 180
                and -90 <= dest_lat <= 90
                and -180 <= dest_lng <= 180
            ):
                self.send_json_response(
                    {"error": "Origin or destination out of range"},
                    status=400,
                )
                return

            initial_battery = _clamp_float(data.get("initial_battery", 90.0), 90.0, 0.0, 100.0)
            target_arrival = _clamp_float(data.get("target_arrival", 15.0), 15.0, 0.0, 100.0)
            max_range = _clamp_float(data.get("max_range_km", 450.0), 450.0, 50.0, 1000.0)
            corridor_buffer = _clamp_float(
                data.get("corridor_buffer_km", 30.0), 30.0, 1.0, MAX_CORRIDOR_BUFFER_KM
            )
            min_power = _clamp_int(data.get("min_power", 0), 0, 0, 1000)
            routing_mode = str(data.get("routing_mode", "MAXIMIZE"))[:32]
            max_stops = _clamp_int(data.get("max_stops", 20), 20, 1, 50)

            forced_chargers = data.get("forced_chargers", [])
            if not isinstance(forced_chargers, list):
                forced_chargers = []
            if len(forced_chargers) > MAX_FORCED_CHARGERS:
                self.send_json_response(
                    {"error": f"Too many forced_chargers (max {MAX_FORCED_CHARGERS})"},
                    status=400,
                )
                return

            forced_charger_ids = data.get("forced_charger_ids", [])
            if not isinstance(forced_charger_ids, list):
                forced_charger_ids = []
            if len(forced_charger_ids) > MAX_FORCED_CHARGERS:
                self.send_json_response(
                    {"error": f"Too many forced_charger_ids (max {MAX_FORCED_CHARGERS})"},
                    status=400,
                )
                return
        except Exception:
            traceback.print_exc()
            self.send_json_response({"error": "Invalid plan-route payload"}, status=400)
            return

        # Hold heavy-work slot only around OSRM / planning (not body read / validation)
        if not _plan_semaphore.acquire(blocking=False):
            self.send_json_response(
                {"error": "Server busy — too many concurrent route plans"},
                status=503,
            )
            return
        try:
            plan = routing.plan_trip(
                origin=(origin_lat, origin_lng),
                destination=(dest_lat, dest_lng),
                routing_mode=routing_mode,
                forced_chargers=forced_chargers,
                forced_charger_ids=forced_charger_ids,
                max_stops=max_stops,
                initial_battery_pct=initial_battery,
                target_arrival_pct=target_arrival,
                max_range_km=max_range,
                corridor_buffer_km=corridor_buffer,
                min_power=min_power,
            )
            self.send_json_response(plan)
        except ValueError as e:
            msg = str(e)
            if len(msg) > 200:
                msg = "Unable to plan route"
            self.send_json_response({"error": msg}, status=400)
        except Exception:
            traceback.print_exc()
            self.send_json_response({"error": "Route planning failed"}, status=500)
        finally:
            _plan_semaphore.release()

    def handle_find_along_route(self):
        """Find chargers along provided GeoJSON or coordinate list."""
        if not self._plan_allowed():
            self.send_json_response(
                {"error": "Corridor search rate limit exceeded"},
                status=429,
            )
            return

        data = self._read_json_body()
        if data is None:
            return

        try:
            coords = data.get("coordinates")
            buffer_km = _clamp_float(data.get("buffer_km", 25.0), 25.0, 1.0, MAX_CORRIDOR_BUFFER_KM)
            status = str(data.get("status", "OPEN"))[:32]

            if not isinstance(coords, list) or not coords:
                self.send_json_response({"error": "No coordinates provided"}, status=400)
                return
            if len(coords) > MAX_ROUTE_COORDINATES:
                self.send_json_response(
                    {"error": f"Too many coordinates (max {MAX_ROUTE_COORDINATES})"},
                    status=400,
                )
                return

            cleaned: List[Any] = []
            for pair in coords:
                if not isinstance(pair, (list, tuple)) or len(pair) < 2:
                    continue
                try:
                    lng = float(pair[0])
                    lat = float(pair[1])
                except (TypeError, ValueError):
                    continue
                if -180 <= lng <= 180 and -90 <= lat <= 90:
                    cleaned.append((lng, lat))
            if len(cleaned) < 2:
                self.send_json_response(
                    {"error": "At least two valid coordinates required"},
                    status=400,
                )
                return
        except Exception:
            traceback.print_exc()
            self.send_json_response({"error": "Invalid corridor search payload"}, status=400)
            return

        if not _plan_semaphore.acquire(blocking=False):
            self.send_json_response(
                {"error": "Server busy — too many concurrent corridor searches"},
                status=503,
            )
            return
        try:
            chargers = routing.find_superchargers_along_route(
                cleaned, corridor_buffer_km=buffer_km, status_filter=status
            )
            if len(chargers) > MAX_SUPERCHARGER_LIMIT:
                chargers = chargers[:MAX_SUPERCHARGER_LIMIT]
            self.send_json_response({
                "count": len(chargers),
                "superchargers": chargers,
            })
        except Exception:
            traceback.print_exc()
            self.send_json_response({"error": "Corridor search failed"}, status=500)
        finally:
            _plan_semaphore.release()

    def _send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        # Removable modules: foliage (Explore Fall) + airspace (FAA/NPS ArcGIS).
        # Same-origin UI — no Access-Control-Allow-Origin (prevents cross-site OSRM proxying).
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' https://unpkg.com; "
            "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com; "
            "font-src 'self' https://cdnjs.cloudflare.com https://fonts.gstatic.com data:; "
            # OSM uses bare tile.openstreetmap.org (wildcard *.tile. does not match that host).
            "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
            "https://*.tile.opentopomap.org https://unpkg.com https://www.explorefall.com; "
            "connect-src 'self' https://services6.arcgis.com https://services1.arcgis.com https://*.arcgis.com; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'",
        )
        self.send_header(
            "Permissions-Policy",
            "geolocation=(self), camera=(), microphone=(), payment=()",
        )

    def send_json_response(self, data: Any, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        if getattr(self, "close_connection", False):
            self.send_header("Connection", "close")
        self._api_response = True
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        if not getattr(self, "_api_response", False):
            path = urllib.parse.urlparse(getattr(self, "path", "") or "").path.lower()
            static_ext = (".js", ".css", ".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico")
            if STATIC_CACHE_MAX_AGE > 0 and path.endswith(static_ext):
                self.send_header(
                    "Cache-Control",
                    f"public, max-age={STATIC_CACHE_MAX_AGE}",
                )
            else:
                self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self._send_security_headers()
        super().end_headers()


def run_server(port: int = PORT):
    # Pre-load dataset
    routing.load_superchargers()

    class ThreadedReusableServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
        allow_reuse_address = True
        daemon_threads = True
        request_queue_size = 32
        timeout = REQUEST_SOCKET_TIMEOUT_SEC

    with ThreadedReusableServer(("", port), SuperchargerRequestHandler) as httpd:
        profile = "lean" if cost_profile_lean() else "default"
        print("============================================================")
        print(f"  Tesla Supercharger Route Planner on port {port}")
        print(f"  Desktop:  http://localhost:{port}/")
        print(f"  Mobile:   http://localhost:{port}/mobile")
        print(f"  Cost:     profile={profile}  plans={PLAN_RATE_LIMIT}/min  "
              f"geocode={GEOCODE_RATE_LIMIT}/min  concurrent={MAX_CONCURRENT_PLANS}")
        print("============================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run_server(port_arg)

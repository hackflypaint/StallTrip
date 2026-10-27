#!/usr/bin/env python3
"""HTTP hardening tests: body caps, path traversal, headers, validation, XSS helpers."""

from __future__ import annotations

import json
import os
import threading
import unittest
import urllib.error
import urllib.request

import routing
import server


class _ServerThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        routing.load_superchargers()

        class ThreadedReusableServer(server.socketserver.ThreadingMixIn, server.socketserver.TCPServer):
            allow_reuse_address = True
            daemon_threads = True

        self.httpd = ThreadedReusableServer(
            ("127.0.0.1", 0), server.SuperchargerRequestHandler
        )
        self.port = self.httpd.server_address[1]

    def run(self):
        self.httpd.serve_forever()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class TestSecurityHardening(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._thread = _ServerThread()
        cls._thread.start()
        cls.base = f"http://127.0.0.1:{cls._thread.port}"

    @classmethod
    def tearDownClass(cls):
        cls._thread.stop()
        cls._thread.join(timeout=5)

    def _get(self, path: str, headers: dict | None = None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def _post(self, path: str, body, content_type: str = "application/json"):
        if isinstance(body, (dict, list)):
            raw = json.dumps(body).encode("utf-8")
        elif isinstance(body, str):
            raw = body.encode("utf-8")
        else:
            raw = body
        req = urllib.request.Request(
            self.base + path,
            data=raw,
            headers={"Content-Type": content_type},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_health_and_security_headers(self):
        status, headers, body = self._get("/api/health")
        self.assertEqual(status, 200)
        lower = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(lower.get("x-content-type-options"), "nosniff")
        self.assertEqual(lower.get("x-frame-options"), "DENY")
        self.assertNotIn("access-control-allow-origin", lower)
        csp = lower.get("content-security-policy", "")
        self.assertIn("default-src 'self'", csp)
        self.assertIn("https://tile.openstreetmap.org", csp)
        self.assertIn("services6.arcgis.com", csp)
        self.assertIn("services1.arcgis.com", csp)
        self.assertIn("*.arcgis.com", csp)
        self.assertIn("explorefall.com", csp)
        # Pin Leaflet / FA paths — reject bare https://unpkg.com in script-src
        self.assertIn("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", csp)
        self.assertIn("https://unpkg.com/leaflet@1.9.4/dist/leaflet.css", csp)
        self.assertNotIn("script-src 'self' https://unpkg.com;", csp)
        self.assertNotRegex(csp, r"script-src[^;]*https://unpkg.com[;\s]")
        # Source maps (leaflet.js.map / FA) need host connect; not executable script hosts
        self.assertRegex(csp, r"connect-src[^;]*https://unpkg.com[\s;]")
        self.assertRegex(csp, r"connect-src[^;]*https://cdnjs.cloudflare.com[\s;]")
        data = json.loads(body)
        self.assertEqual(data["status"], "healthy")
        limits = data.get("limits") or {}
        self.assertIn("trust_proxy", limits)
        self.assertFalse(limits.get("trust_proxy"))

    def test_client_ip_ignores_xff_when_trust_proxy_off(self):
        prev = os.environ.pop("TRUST_PROXY", None)
        try:
            self.assertFalse(server.trust_proxy_enabled())
            ip = server.client_ip_from_headers(
                {"X-Forwarded-For": "203.0.113.9, 10.0.0.1"},
                "127.0.0.1",
            )
            self.assertEqual(ip, "127.0.0.1")
        finally:
            if prev is not None:
                os.environ["TRUST_PROXY"] = prev

    def test_client_ip_honors_xff_when_trust_proxy_on(self):
        prev = os.environ.get("TRUST_PROXY")
        prev_hops = os.environ.pop("TRUST_PROXY_HOPS", None)
        os.environ["TRUST_PROXY"] = "1"
        try:
            self.assertTrue(server.trust_proxy_enabled())
            # hops=1 (default): right-most hop — client-prepended left values ignored
            ip = server.client_ip_from_headers(
                {"X-Forwarded-For": "198.51.100.1, 203.0.113.9, 10.0.0.1"},
                "127.0.0.1",
            )
            self.assertEqual(ip, "10.0.0.1")
            os.environ["TRUST_PROXY_HOPS"] = "2"
            ip2 = server.client_ip_from_headers(
                {"X-Forwarded-For": "198.51.100.1, 203.0.113.9, 10.0.0.1"},
                "127.0.0.1",
            )
            self.assertEqual(ip2, "203.0.113.9")
            os.environ["TRUST_PROXY_HOPS"] = "1"
            ip6 = server.client_ip_from_headers(
                {"Forwarded": 'for="[2001:db8::1]";proto=https'},
                "127.0.0.1",
            )
            self.assertEqual(ip6, "2001:db8::1")
            # Garbage XFF falls back to peer
            bad = server.client_ip_from_headers(
                {"X-Forwarded-For": "not-an-ip"},
                "10.1.2.3",
            )
            self.assertEqual(bad, "10.1.2.3")
            # hops longer than chain → peer (never clamp to spoofable left-most)
            os.environ["TRUST_PROXY_HOPS"] = "5"
            short = server.client_ip_from_headers(
                {"X-Forwarded-For": "198.51.100.99, 10.0.0.1"},
                "127.0.0.1",
            )
            self.assertEqual(short, "127.0.0.1")
        finally:
            if prev is None:
                os.environ.pop("TRUST_PROXY", None)
            else:
                os.environ["TRUST_PROXY"] = prev
            if prev_hops is None:
                os.environ.pop("TRUST_PROXY_HOPS", None)
            else:
                os.environ["TRUST_PROXY_HOPS"] = prev_hops

    def test_options_rejects_cors_preflight(self):
        req = urllib.request.Request(
            self.base + "/api/plan-route",
            method="OPTIONS",
            headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                status = resp.status
                body = resp.read()
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read()
        self.assertEqual(status, 403)
        self.assertIn(b"CORS", body)

    def test_path_traversal_falls_back_to_spa(self):
        status, headers, body = self._get("/../../etc/passwd")
        self.assertEqual(status, 200)
        self.assertIn(b"Supercharge", body)
        self.assertNotIn(b"root:", body)

    def test_unknown_api_is_json_404(self):
        status, _, body = self._get("/api/not-a-real-endpoint")
        self.assertEqual(status, 404)
        data = json.loads(body)
        self.assertIn("error", data)

    def test_tesla_probe_route_serves_fingerprint_page(self):
        """Clean /tesla-probe URL must serve the probe HTML, not the SPA shell."""
        for path in ("/tesla-probe", "/tesla-probe/", "/tesla-probe.html"):
            status, headers, body = self._get(path)
            self.assertEqual(status, 200, path)
            lower = {k.lower(): v for k, v in headers.items()}
            self.assertIn("text/html", lower.get("content-type", ""))
            self.assertIn(b"Tesla browser probe", body)
            self.assertIn(b"/tesla-probe.js", body)
            # Must not be the main planner shell
            self.assertNotIn(b'id="btnPlanRoute"', body)
        # External script is reachable (CSP script-src 'self')
        status, headers, body = self._get("/tesla-probe.js")
        self.assertEqual(status, 200)
        self.assertIn(b"parseChromiumMajor", body)

    def test_tesla_path_serves_planner_spa(self):
        """Canonical /tesla car entry serves the planner SPA (not probe, not mobile)."""
        for path in ("/tesla", "/tesla/"):
            status, headers, body = self._get(path)
            self.assertEqual(status, 200, path)
            lower = {k.lower(): v for k, v in headers.items()}
            self.assertIn("text/html", lower.get("content-type", ""))
            self.assertIn(b'id="btnPlanRoute"', body)
            self.assertIn(b"carModeBadge", body)
            self.assertNotIn(b"Tesla browser probe", body)
        # Client helper lives in app.js (not inlined in HTML — CSP)
        status, _, js = self._get("/app.js")
        self.assertEqual(status, 200)
        self.assertIn(b"function isTeslaPath", js)
        self.assertIn(b'path === "/tesla"', js)
        # Health advertises the car entry
        status, _, body = self._get("/api/health")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data.get("tesla_shell"), "/tesla")
        self.assertEqual(data.get("mobile_shell"), "/mobile")

    def test_superchargers_limit_clamped(self):
        status, _, body = self._get("/api/superchargers?limit=99999&status=OPEN")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertLessEqual(data["count"], server.MAX_SUPERCHARGER_LIMIT)

    def test_invalid_bounds_rejected(self):
        status, _, body = self._get(
            "/api/superchargers?min_lat=100&max_lat=101&min_lng=0&max_lng=1"
        )
        self.assertEqual(status, 400)
        self.assertIn(b"Invalid bounds", body)

    def test_geocode_query_too_long(self):
        q = "a" * (server.MAX_GEOCODE_QUERY_LEN + 50)
        status, _, body = self._get(f"/api/geocode?q={q}")
        self.assertEqual(status, 400)
        data = json.loads(body)
        self.assertEqual(data.get("results"), [])

    def test_post_body_too_large(self):
        huge = b'{"origin":[1,2],"destination":[3,4],"pad":"' + (b"x" * (server.MAX_BODY_BYTES + 100)) + b'"}'
        status, _, body = self._post("/api/plan-route", huge)
        self.assertEqual(status, 413)
        self.assertIn(b"too large", body)

    def test_plan_route_rejects_bad_coords(self):
        status, _, body = self._post(
            "/api/plan-route",
            {"origin": [999, 0], "destination": [34.0, -118.0]},
        )
        self.assertEqual(status, 400)
        self.assertIn(b"out of range", body)

    def test_plan_route_rejects_too_many_forced(self):
        payload = {
            "origin": [37.77, -122.42],
            "destination": [34.05, -118.24],
            "forced_charger_ids": list(range(server.MAX_FORCED_CHARGERS + 5)),
        }
        status, _, body = self._post("/api/plan-route", payload)
        self.assertEqual(status, 400)
        self.assertIn(b"Too many forced_charger_ids", body)

    def test_find_along_route_coordinate_cap(self):
        coords = [[-122.4, 37.7]] * (server.MAX_ROUTE_COORDINATES + 10)
        status, _, body = self._post(
            "/api/find-along-route",
            {"coordinates": coords, "buffer_km": 10},
        )
        self.assertEqual(status, 400)
        self.assertIn(b"Too many coordinates", body)

    def test_find_along_route_requires_two_coords(self):
        status, _, body = self._post(
            "/api/find-along-route",
            {"coordinates": [[-122.4, 37.7]], "buffer_km": 10},
        )
        self.assertEqual(status, 400)
        self.assertIn(b"At least two", body)

    def test_corridor_response_capped_in_plan_trip(self):
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            routing_mode="MAXIMIZE",
            max_stops=4,
        )
        corridor = plan.get("all_corridor_chargers", [])
        self.assertLessEqual(len(corridor), 500)

    def test_forced_chargers_reject_invalid_lat(self):
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            routing_mode="MAXIMIZE",
            forced_chargers=[{"id": 1, "name": "bad", "lat": 999, "lng": 0}],
            max_stops=4,
        )
        self.assertEqual(plan["summary"]["forced_stops_count"], 0)

    def test_forced_chargers_sanitize_xss_fields(self):
        plan = routing.plan_trip(
            origin=(37.7749, -122.4194),
            destination=(34.0522, -118.2437),
            routing_mode="MAXIMIZE",
            forced_chargers=[{
                "id": 900001,
                "name": "<script>alert(1)</script>",
                "lat": 36.0,
                "lng": -120.0,
                "power": "<img onerror=1>",
                "stalls": None,
                "evil": "drop-me",
            }],
            max_stops=4,
        )
        forced = [s for s in plan["stops"] if s.get("forced")]
        self.assertEqual(len(forced), 1)
        self.assertEqual(forced[0]["name"], "<script>alert(1)</script>")
        self.assertIsInstance(forced[0]["power"], int)
        self.assertIsInstance(forced[0]["stalls"], int)
        self.assertNotIn("evil", forced[0])
        coords = plan["geometry"].get("coordinates") or []
        self.assertLessEqual(len(coords), routing.MAX_GEOMETRY_POINTS)

    def test_osrm_uses_https_by_default(self):
        self.assertTrue(routing.OSRM_BASE_URL.startswith("https://"))

    def test_favicon_is_icon_not_html(self):
        status, headers, body = self._get("/favicon.ico")
        self.assertEqual(status, 200)
        lower = {k.lower(): v for k, v in headers.items()}
        ctype = lower.get("content-type", "")
        self.assertTrue(
            "icon" in ctype or "octet-stream" in ctype or ctype.startswith("image/"),
            f"unexpected favicon content-type: {ctype}",
        )
        self.assertFalse(ctype.startswith("text/html"))
        self.assertGreater(len(body), 64)
        # ICO magic: reserved(0) + type(1)
        self.assertEqual(body[0:4], b"\x00\x00\x01\x00")

    def test_server_header_hides_python_version(self):
        status, headers, _ = self._get("/api/health")
        self.assertEqual(status, 200)
        lower = {k.lower(): v for k, v in headers.items()}
        server_hdr = lower.get("server", "")
        self.assertNotIn("python", server_hdr.lower())
        self.assertNotRegex(server_hdr, r"Python/\d")

    def test_rate_bypass_requires_matching_secret(self):
        """Wrong/missing secret must not clear limits; matching secret may."""
        prev = os.environ.pop("ALLOW_TEST_RATE_BYPASS", None)
        try:
            self.assertFalse(server.test_rate_bypass_enabled())
            # Header alone (env unset) → no clear; health must not advertise bypass
            status, _, body = self._get(
                "/api/health?reset_rate_limit=1",
                headers={"X-Test-Rate-Bypass": "nope"},
            )
            self.assertEqual(status, 200)
            data = json.loads(body)
            self.assertNotIn("test_rate_bypass", data.get("limits") or {})

            os.environ["ALLOW_TEST_RATE_BYPASS"] = "e2e-secret-token"
            server.clear_rate_limit_state()
            with server._plan_lock:
                server._plan_hits["10.0.0.1"] = (0.0, 99)
            # Wrong header → buckets remain
            self._get(
                "/api/health?reset_rate_limit=1",
                headers={"X-Test-Rate-Bypass": "wrong"},
            )
            with server._plan_lock:
                self.assertIn("10.0.0.1", server._plan_hits)
            # Matching secret → clear
            self._get(
                "/api/health?reset_rate_limit=1",
                headers={"X-Test-Rate-Bypass": "e2e-secret-token"},
            )
            with server._plan_lock:
                self.assertEqual(server._plan_hits, {})
        finally:
            if prev is None:
                os.environ.pop("ALLOW_TEST_RATE_BYPASS", None)
            else:
                os.environ["ALLOW_TEST_RATE_BYPASS"] = prev
            server.clear_rate_limit_state()


if __name__ == "__main__":
    unittest.main()

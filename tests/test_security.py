#!/usr/bin/env python3
"""HTTP hardening tests: body caps, path traversal, headers, validation, XSS helpers."""

from __future__ import annotations

import json
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
        data = json.loads(body)
        self.assertEqual(data["status"], "healthy")

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


if __name__ == "__main__":
    unittest.main()

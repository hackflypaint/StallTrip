#!/usr/bin/env python3
"""Tests for POST /api/client-logs: validation, size caps, rate limits."""

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


class TestClientLogs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._thread = _ServerThread()
        cls._thread.start()
        cls.base = f"http://127.0.0.1:{cls._thread.port}"

    @classmethod
    def tearDownClass(cls):
        cls._thread.stop()
        cls._thread.join(timeout=5)

    def setUp(self):
        server.clear_rate_limit_state()

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
            with urllib.request.urlopen(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def _get(self, path: str):
        req = urllib.request.Request(self.base + path)
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, dict(resp.headers), resp.read()

    def test_health_advertises_client_log_limits(self):
        status, _, body = self._get("/api/health")
        self.assertEqual(status, 200)
        data = json.loads(body)
        limits = data.get("limits") or {}
        self.assertIn("client_log_per_min", limits)
        self.assertIn("client_log_global_per_min", limits)
        self.assertEqual(limits["client_log_max_entries"], server.CLIENT_LOG_MAX_ENTRIES)
        self.assertEqual(
            limits["client_log_global_per_min"], server.CLIENT_LOG_GLOBAL_RATE_LIMIT
        )

    def test_accepts_valid_batch(self):
        status, _, body = self._post(
            "/api/client-logs",
            {
                "entries": [
                    {
                        "level": "error",
                        "message": "Routing error: boom",
                        "stack": "Error: boom\n  at planRoute",
                        "url": "/tesla",
                        "shell": "tesla",
                    },
                    {
                        "level": "warn",
                        "message": "Geolocation denied or error",
                        "url": "/mobile",
                        "shell": "mobile",
                    },
                    {
                        "level": "info",
                        "message": "Wake Lock unavailable: NotAllowedError",
                        "shell": "desktop",
                        "url": "/",
                    },
                ]
            },
        )
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data.get("ok"))
        self.assertEqual(data.get("accepted"), 3)
        self.assertEqual(data.get("rejected"), 0)

    def test_rejects_missing_entries(self):
        status, _, body = self._post("/api/client-logs", {"oops": True})
        self.assertEqual(status, 400)
        data = json.loads(body)
        self.assertEqual(data.get("accepted"), 0)

    def test_rejects_non_array_entries(self):
        status, _, body = self._post("/api/client-logs", {"entries": "nope"})
        self.assertEqual(status, 400)
        self.assertIn(b"array", body)

    def test_drops_debug_and_empty(self):
        status, _, body = self._post(
            "/api/client-logs",
            {
                "entries": [
                    {"level": "debug", "message": "noise"},
                    {"level": "error", "message": ""},
                    {"level": "error", "message": "keep me"},
                    {"level": "warning", "message": "alias to warn"},
                    42,
                ]
            },
        )
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data.get("accepted"), 2)
        self.assertEqual(data.get("rejected"), 3)

    def test_truncates_long_message_and_redacts_secrets(self):
        long_msg = "x" * (server.CLIENT_LOG_MAX_MESSAGE_LEN + 200)
        accepted, rejected = server.validate_client_log_entries(
            {
                "entries": [
                    {
                        "level": "error",
                        "message": f"token=supersecret {long_msg}",
                        "stack": "password=hunter2\n" + ("y" * 5000),
                        "url": "/" + ("u" * 500),
                        "shell": "evil-shell",
                    }
                ]
            }
        )
        self.assertEqual(rejected, 0)
        self.assertEqual(len(accepted), 1)
        entry = accepted[0]
        self.assertLessEqual(len(entry["message"]), server.CLIENT_LOG_MAX_MESSAGE_LEN)
        self.assertIn("[redacted]", entry["message"])
        self.assertNotIn("supersecret", entry["message"])
        self.assertLessEqual(len(entry["stack"]), server.CLIENT_LOG_MAX_STACK_LEN)
        self.assertIn("[redacted]", entry["stack"])
        self.assertEqual(entry["shell"], "unknown")
        self.assertLessEqual(len(entry["url"]), server.CLIENT_LOG_MAX_URL_LEN)

    def test_entry_cap_extra_rejected(self):
        entries = [
            {"level": "error", "message": f"msg-{i}"}
            for i in range(server.CLIENT_LOG_MAX_ENTRIES + 5)
        ]
        accepted, rejected = server.validate_client_log_entries({"entries": entries})
        self.assertEqual(len(accepted), server.CLIENT_LOG_MAX_ENTRIES)
        self.assertEqual(rejected, 5)

    def test_body_too_large(self):
        pad = "z" * (server.CLIENT_LOG_MAX_BODY_BYTES + 100)
        raw = json.dumps({"entries": [{"level": "error", "message": pad}]}).encode("utf-8")
        self.assertGreater(len(raw), server.CLIENT_LOG_MAX_BODY_BYTES)
        status, _, body = self._post("/api/client-logs", raw)
        self.assertEqual(status, 413)
        self.assertIn(b"too large", body)

    def test_rate_limit_returns_429(self):
        prev_limit = server.CLIENT_LOG_RATE_LIMIT
        # Monkeypatch module constant used by handler
        server.CLIENT_LOG_RATE_LIMIT = 3
        server.clear_rate_limit_state()
        try:
            payload = {"entries": [{"level": "error", "message": "rl"}]}
            codes = []
            for _ in range(5):
                status, _, _ = self._post("/api/client-logs", payload)
                codes.append(status)
            self.assertEqual(codes[:3], [200, 200, 200])
            self.assertTrue(any(c == 429 for c in codes[3:]), codes)
        finally:
            server.CLIENT_LOG_RATE_LIMIT = prev_limit
            server.clear_rate_limit_state()

    def test_no_auth_required(self):
        """AuthZ N/A — endpoint is intentionally open with rate/size limits only."""
        status, _, body = self._post(
            "/api/client-logs",
            {"entries": [{"level": "warn", "message": "anonymous ok"}]},
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body).get("accepted"), 1)

    def test_sanitize_log_text_strips_controls(self):
        out = server.sanitize_log_text("hi\x00there\napi_key=abc123", 200)
        self.assertNotIn("\x00", out)
        self.assertNotIn("\n", out)
        self.assertIn("[redacted]", out)
        self.assertNotIn("abc123", out)

    def test_sanitize_strips_unicode_c_and_line_separators(self):
        # Cf zero-width, U+2028 line sep, U+2029 para sep
        dirty = "ok\u200bmid\u2028line\u2029end"
        out = server.sanitize_log_text(dirty, 200)
        self.assertNotIn("\u200b", out)
        self.assertNotIn("\u2028", out)
        self.assertNotIn("\u2029", out)
        self.assertIn("ok", out)
        self.assertIn("end", out)

    def test_redacts_authorization_bearer_and_geo(self):
        accepted, rejected = server.validate_client_log_entries(
            {
                "entries": [
                    {
                        "level": "error",
                        "message": (
                            "Authorization: Bearer super-secret-token "
                            "lat=37.7749 lon=-122.4194"
                        ),
                        "stack": "bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
                    }
                ]
            }
        )
        self.assertEqual(rejected, 0)
        self.assertEqual(len(accepted), 1)
        msg = accepted[0]["message"]
        stack = accepted[0]["stack"]
        self.assertIn("[redacted]", msg)
        self.assertNotIn("super-secret-token", msg)
        self.assertNotIn("37.7749", msg)
        self.assertNotIn("-122.4194", msg)
        self.assertNotIn("eyJhbGciOiJIUzI1NiJ9", stack)

    def test_global_budget_returns_429(self):
        prev_global = server.CLIENT_LOG_GLOBAL_RATE_LIMIT
        prev_ip = server.CLIENT_LOG_RATE_LIMIT
        server.CLIENT_LOG_GLOBAL_RATE_LIMIT = 3
        server.CLIENT_LOG_RATE_LIMIT = 100  # per-IP must not mask global
        server.clear_rate_limit_state()
        try:
            payload = {"entries": [{"level": "error", "message": "global-rl"}]}
            codes = []
            for _ in range(5):
                status, _, _ = self._post("/api/client-logs", payload)
                codes.append(status)
            self.assertEqual(codes[:3], [200, 200, 200])
            self.assertTrue(any(c == 429 for c in codes[3:]), codes)
        finally:
            server.CLIENT_LOG_GLOBAL_RATE_LIMIT = prev_global
            server.CLIENT_LOG_RATE_LIMIT = prev_ip
            server.clear_rate_limit_state()

    def test_test_rate_bypass_excluded_from_client_logs(self):
        prev = os.environ.get("ALLOW_TEST_RATE_BYPASS")
        prev_limit = server.CLIENT_LOG_RATE_LIMIT
        os.environ["ALLOW_TEST_RATE_BYPASS"] = "e2e-secret-token"
        server.CLIENT_LOG_RATE_LIMIT = 2
        server.clear_rate_limit_state()
        try:
            payload = {"entries": [{"level": "error", "message": "bypass-probe"}]}
            codes = []
            for _ in range(4):
                raw = json.dumps(payload).encode("utf-8")
                req = urllib.request.Request(
                    self.base + "/api/client-logs",
                    data=raw,
                    headers={
                        "Content-Type": "application/json",
                        "X-Test-Rate-Bypass": "e2e-secret-token",
                    },
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        codes.append(resp.status)
                except urllib.error.HTTPError as e:
                    codes.append(e.code)
            self.assertEqual(codes[:2], [200, 200])
            self.assertTrue(any(c == 429 for c in codes[2:]), codes)
        finally:
            if prev is None:
                os.environ.pop("ALLOW_TEST_RATE_BYPASS", None)
            else:
                os.environ["ALLOW_TEST_RATE_BYPASS"] = prev
            server.CLIENT_LOG_RATE_LIMIT = prev_limit
            server.clear_rate_limit_state()


class TestAccessLogSampling(unittest.TestCase):
    def test_api_always_logged(self):
        self.assertTrue(server._should_log_access("/api/health", 200))
        self.assertTrue(server._should_log_access("/api/client-logs", 429))

    def test_errors_always_logged(self):
        self.assertTrue(server._should_log_access("/app.js", 404))
        self.assertTrue(server._should_log_access("/style.css", 500))

    def test_static_sampled(self):
        # Force deterministic: every Nth succeeds for sample rate N
        prev = server.ACCESS_LOG_STATIC_SAMPLE
        server.ACCESS_LOG_STATIC_SAMPLE = 5
        with server._access_static_lock:
            server._access_static_counter = 0
        try:
            hits = sum(
                1 for _ in range(20) if server._should_log_access("/app.js", 200)
            )
            self.assertEqual(hits, 4)  # counters 5,10,15,20
        finally:
            server.ACCESS_LOG_STATIC_SAMPLE = prev
            with server._access_static_lock:
                server._access_static_counter = 0


if __name__ == "__main__":
    unittest.main()

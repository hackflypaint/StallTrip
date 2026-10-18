#!/usr/bin/env python3
"""Mobile shell tests: /mobile entry, health hint, UA redirect flag (off by default)."""

from __future__ import annotations

import json
import os
import threading
import unittest
import urllib.error
import urllib.request

import routing
import server


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


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


class TestMobileShell(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._thread = _ServerThread()
        cls._thread.start()
        cls.base = f"http://127.0.0.1:{cls._thread.port}"
        cls._opener = urllib.request.build_opener(_NoRedirect)

    @classmethod
    def tearDownClass(cls):
        cls._thread.stop()
        cls._thread.join(timeout=5)

    def _get(self, path: str, headers: dict | None = None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with self._opener.open(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_health_advertises_mobile_shell(self):
        status, _, body = self._get("/api/health")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertEqual(data["mobile_shell"], "/mobile")

    def test_mobile_path_serves_spa(self):
        status, headers, body = self._get("/mobile")
        self.assertEqual(status, 200)
        lower = {k.lower(): v for k, v in headers.items()}
        self.assertIn("text/html", lower.get("content-type", ""))
        self.assertEqual(lower.get("x-frame-options"), "DENY")
        self.assertIn(b"btnMobileSheet", body)
        self.assertIn(b"/app.js", body)

    def test_mobile_head_ok(self):
        req = urllib.request.Request(self.base + "/mobile", method="HEAD")
        try:
            with self._opener.open(req, timeout=10) as resp:
                status = resp.status
                headers = dict(resp.headers)
        except urllib.error.HTTPError as e:
            status, headers = e.code, dict(e.headers)
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", headers.get("content-type", "")))

    def test_mobile_trailing_slash_serves_spa(self):
        status, _, body = self._get("/mobile/")
        self.assertEqual(status, 200)
        self.assertIn(b"Supercharge", body)

    def test_client_detects_mobile_shell_in_app_js(self):
        # Keep detection logic in app.js (CSP forbids inline scripts).
        status, _, body = self._get("/app.js")
        self.assertEqual(status, 200)
        self.assertIn(b"function isMobileShell", body)
        self.assertIn(b'path === "/mobile"', body)
        self.assertIn(b'ui-mobile', body)

    def test_no_ua_redirect_by_default(self):
        prev = os.environ.pop("MOBILE_UA_REDIRECT", None)
        try:
            self.assertFalse(server.mobile_ua_redirect_enabled())
            status, headers, body = self._get(
                "/",
                headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"},
            )
            self.assertEqual(status, 200)
            self.assertNotEqual(headers.get("Location"), "/mobile")
            self.assertIn(b"Supercharge", body)
        finally:
            if prev is not None:
                os.environ["MOBILE_UA_REDIRECT"] = prev

    def test_ua_redirect_when_enabled(self):
        prev = os.environ.get("MOBILE_UA_REDIRECT")
        os.environ["MOBILE_UA_REDIRECT"] = "1"
        try:
            self.assertTrue(server.mobile_ua_redirect_enabled())
            status, headers, body = self._get(
                "/",
                headers={"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"},
            )
            self.assertEqual(status, 302)
            self.assertEqual(headers.get("Location"), "/mobile")
            self.assertEqual(body, b"")
        finally:
            if prev is None:
                os.environ.pop("MOBILE_UA_REDIRECT", None)
            else:
                os.environ["MOBILE_UA_REDIRECT"] = prev

    def test_ua_helpers(self):
        self.assertTrue(server.looks_like_mobile_ua("iPhone"))
        self.assertTrue(server.looks_like_mobile_ua("Mozilla/5.0 (Linux; Android 14)"))
        self.assertFalse(server.looks_like_mobile_ua("Mozilla/5.0 (Macintosh; Intel Mac OS X)"))
        self.assertFalse(server.looks_like_mobile_ua(""))

    def test_api_never_ua_redirected(self):
        prev = os.environ.get("MOBILE_UA_REDIRECT")
        os.environ["MOBILE_UA_REDIRECT"] = "1"
        try:
            status, headers, body = self._get(
                "/api/health",
                headers={"User-Agent": "Mozilla/5.0 (iPhone)"},
            )
            self.assertEqual(status, 200)
            self.assertIsNone(headers.get("Location"))
            self.assertEqual(json.loads(body)["status"], "healthy")
        finally:
            if prev is None:
                os.environ.pop("MOBILE_UA_REDIRECT", None)
            else:
                os.environ["MOBILE_UA_REDIRECT"] = prev


if __name__ == "__main__":
    unittest.main()

#!/usr/bin/env python3
"""Platform User-Agent redirects: `/` → /tesla | /mobile | stay on desktop."""

from __future__ import annotations

import json
import os
import threading
import unittest
import urllib.error
import urllib.request

import routing
import server

# Representative User-Agents
UA_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
UA_IPOD = (
    "Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
)
UA_IPAD = (
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
UA_ANDROID_PHONE = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36"
)
UA_ANDROID_TABLET = (
    "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
UA_DESKTOP_MAC = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.0 Safari/605.1.15"
)
UA_DESKTOP_WIN = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
UA_TESLA_QT = (
    "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/601.1 (KHTML, like Gecko) "
    "Tesla QtCarBrowser Safari/601.1"
)
UA_TESLA_CHROMIUM = (
    "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chromium/79.0.3945.130 Chrome/79.0.3945.130 Safari/537.36 "
    "Tesla/2020.16.2.1-e99c70fff409"
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _ServerThread(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        routing.load_superchargers()

        class ThreadedReusableServer(
            server.socketserver.ThreadingMixIn, server.socketserver.TCPServer
        ):
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


class TestPlatformEntryMapping(unittest.TestCase):
    """Pure UA → entry mapping (no HTTP)."""

    def test_tesla_patterns(self):
        self.assertEqual(server.platform_entry_for_ua(UA_TESLA_QT), "/tesla")
        self.assertEqual(server.platform_entry_for_ua(UA_TESLA_CHROMIUM), "/tesla")
        self.assertTrue(server.looks_like_tesla_ua(UA_TESLA_QT))
        self.assertTrue(server.looks_like_tesla_ua(UA_TESLA_CHROMIUM))
        # Tesla wins over any incidental Mobile token
        mixed = UA_TESLA_CHROMIUM + " Mobile"
        self.assertEqual(server.platform_entry_for_ua(mixed), "/tesla")
        self.assertFalse(server.looks_like_mobile_ua(mixed))

    def test_phone_and_tablet_mobile(self):
        for ua in (UA_IPHONE, UA_IPOD, UA_IPAD, UA_ANDROID_PHONE, UA_ANDROID_TABLET):
            with self.subTest(ua=ua[:48]):
                self.assertEqual(server.platform_entry_for_ua(ua), "/mobile")
                self.assertTrue(server.looks_like_mobile_ua(ua))
                self.assertFalse(server.looks_like_tesla_ua(ua))

    def test_desktop_stays_none(self):
        for ua in (UA_DESKTOP_MAC, UA_DESKTOP_WIN, "", None):
            with self.subTest(ua=ua):
                self.assertIsNone(server.platform_entry_for_ua(ua or ""))
                self.assertFalse(server.looks_like_mobile_ua(ua or ""))
                self.assertFalse(server.looks_like_tesla_ua(ua or ""))

    def test_redirect_enabled_default_on(self):
        prev_p = os.environ.pop("PLATFORM_UA_REDIRECT", None)
        prev_m = os.environ.pop("MOBILE_UA_REDIRECT", None)
        try:
            self.assertTrue(server.platform_ua_redirect_enabled())
            self.assertTrue(server.mobile_ua_redirect_enabled())
        finally:
            if prev_p is not None:
                os.environ["PLATFORM_UA_REDIRECT"] = prev_p
            if prev_m is not None:
                os.environ["MOBILE_UA_REDIRECT"] = prev_m

    def test_redirect_kill_switch(self):
        prev_p = os.environ.get("PLATFORM_UA_REDIRECT")
        prev_m = os.environ.get("MOBILE_UA_REDIRECT")
        try:
            os.environ.pop("MOBILE_UA_REDIRECT", None)
            os.environ["PLATFORM_UA_REDIRECT"] = "0"
            self.assertFalse(server.platform_ua_redirect_enabled())
            os.environ["PLATFORM_UA_REDIRECT"] = "false"
            self.assertFalse(server.platform_ua_redirect_enabled())
            os.environ.pop("PLATFORM_UA_REDIRECT", None)
            os.environ["MOBILE_UA_REDIRECT"] = "0"
            self.assertFalse(server.platform_ua_redirect_enabled())
            os.environ["MOBILE_UA_REDIRECT"] = "1"
            self.assertTrue(server.platform_ua_redirect_enabled())
        finally:
            if prev_p is None:
                os.environ.pop("PLATFORM_UA_REDIRECT", None)
            else:
                os.environ["PLATFORM_UA_REDIRECT"] = prev_p
            if prev_m is None:
                os.environ.pop("MOBILE_UA_REDIRECT", None)
            else:
                os.environ["MOBILE_UA_REDIRECT"] = prev_m

    def test_desktop_escape_query(self):
        self.assertTrue(server._wants_desktop_escape({"desktop": ["1"]}))
        self.assertTrue(server._wants_desktop_escape({"desktop": ["true"]}))
        self.assertTrue(server._wants_desktop_escape({"ui": ["desktop"]}))
        self.assertFalse(server._wants_desktop_escape({}))
        self.assertFalse(server._wants_desktop_escape({"desktop": ["0"]}))
        self.assertFalse(server._wants_desktop_escape({"ui": ["mobile"]}))


class TestPlatformRedirectHTTP(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._env_prev = {
            "PLATFORM_UA_REDIRECT": os.environ.get("PLATFORM_UA_REDIRECT"),
            "MOBILE_UA_REDIRECT": os.environ.get("MOBILE_UA_REDIRECT"),
        }
        # Ensure default-on behavior for the live server process
        os.environ.pop("PLATFORM_UA_REDIRECT", None)
        os.environ.pop("MOBILE_UA_REDIRECT", None)
        cls._thread = _ServerThread()
        cls._thread.start()
        cls.base = f"http://127.0.0.1:{cls._thread.port}"
        cls._opener = urllib.request.build_opener(_NoRedirect)

    @classmethod
    def tearDownClass(cls):
        cls._thread.stop()
        cls._thread.join(timeout=5)
        for key, val in cls._env_prev.items():
            if val is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = val

    def _get(self, path: str, headers: dict | None = None):
        req = urllib.request.Request(self.base + path, headers=headers or {})
        try:
            with self._opener.open(req, timeout=10) as resp:
                return resp.status, dict(resp.headers), resp.read()
        except urllib.error.HTTPError as e:
            return e.code, dict(e.headers), e.read()

    def test_health_advertises_platform_redirect(self):
        status, _, body = self._get("/api/health")
        self.assertEqual(status, 200)
        data = json.loads(body)
        limits = data.get("limits") or {}
        self.assertTrue(limits.get("platform_ua_redirect"))
        self.assertTrue(limits.get("mobile_ua_redirect"))

    def test_iphone_redirects_to_mobile(self):
        status, headers, body = self._get("/", headers={"User-Agent": UA_IPHONE})
        self.assertEqual(status, 302)
        self.assertEqual(headers.get("Location"), "/mobile")
        self.assertEqual(body, b"")

    def test_android_phone_redirects_to_mobile(self):
        status, headers, _ = self._get("/", headers={"User-Agent": UA_ANDROID_PHONE})
        self.assertEqual(status, 302)
        self.assertEqual(headers.get("Location"), "/mobile")

    def test_android_tablet_redirects_to_mobile(self):
        status, headers, _ = self._get("/", headers={"User-Agent": UA_ANDROID_TABLET})
        self.assertEqual(status, 302)
        self.assertEqual(headers.get("Location"), "/mobile")

    def test_ipad_redirects_to_mobile(self):
        status, headers, _ = self._get("/", headers={"User-Agent": UA_IPAD})
        self.assertEqual(status, 302)
        self.assertEqual(headers.get("Location"), "/mobile")

    def test_tesla_redirects_to_tesla(self):
        for ua in (UA_TESLA_QT, UA_TESLA_CHROMIUM):
            with self.subTest(ua=ua[:40]):
                status, headers, body = self._get("/", headers={"User-Agent": ua})
                self.assertEqual(status, 302)
                self.assertEqual(headers.get("Location"), "/tesla")
                self.assertEqual(body, b"")

    def test_desktop_stays_on_root(self):
        status, headers, body = self._get("/", headers={"User-Agent": UA_DESKTOP_MAC})
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Location"))
        self.assertIn(b"Supercharge", body)

    def test_desktop_escape_hatch(self):
        status, headers, body = self._get(
            "/?desktop=1", headers={"User-Agent": UA_IPHONE}
        )
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Location"))
        self.assertIn(b"Supercharge", body)

        status, headers, body = self._get(
            "/?ui=desktop", headers={"User-Agent": UA_TESLA_CHROMIUM}
        )
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Location"))
        self.assertIn(b"Supercharge", body)

    def test_no_loop_on_mobile_or_tesla_paths(self):
        for path in ("/mobile", "/mobile/", "/tesla", "/tesla/"):
            with self.subTest(path=path):
                status, headers, body = self._get(
                    path, headers={"User-Agent": UA_IPHONE}
                )
                self.assertEqual(status, 200)
                self.assertIsNone(headers.get("Location"))
                self.assertIn(b"Supercharge", body)

    def test_api_never_redirected(self):
        status, headers, body = self._get(
            "/api/health", headers={"User-Agent": UA_IPHONE}
        )
        self.assertEqual(status, 200)
        self.assertIsNone(headers.get("Location"))
        self.assertEqual(json.loads(body)["status"], "healthy")

    def test_head_redirects(self):
        req = urllib.request.Request(
            self.base + "/",
            method="HEAD",
            headers={"User-Agent": UA_ANDROID_PHONE},
        )
        try:
            with self._opener.open(req, timeout=10) as resp:
                status = resp.status
                headers = dict(resp.headers)
        except urllib.error.HTTPError as e:
            status = e.code
            headers = dict(e.headers)
        self.assertEqual(status, 302)
        self.assertEqual(headers.get("Location"), "/mobile")

    def test_kill_switch_disables_redirect(self):
        prev = os.environ.get("PLATFORM_UA_REDIRECT")
        os.environ["PLATFORM_UA_REDIRECT"] = "0"
        try:
            self.assertFalse(server.platform_ua_redirect_enabled())
            status, headers, body = self._get("/", headers={"User-Agent": UA_IPHONE})
            self.assertEqual(status, 200)
            self.assertNotEqual(headers.get("Location"), "/mobile")
            self.assertIn(b"Supercharge", body)
        finally:
            if prev is None:
                os.environ.pop("PLATFORM_UA_REDIRECT", None)
            else:
                os.environ["PLATFORM_UA_REDIRECT"] = prev


if __name__ == "__main__":
    unittest.main()

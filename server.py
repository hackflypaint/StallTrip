#!/usr/bin/env python3
"""
Tesla Supercharger Route Planner - Web Application & API Server.
Zero extra third-party dependencies: Built with Python's high performance standard library.
"""

import hmac
import http.server
import ipaddress
import json
import logging
import os
import re
import socketserver
import sys
import threading
import time
import traceback
import unicodedata
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple

import routing

# ---------------------------------------------------------------------------
# Release identity — keep in sync with Dockerfile labels, compose image tag,
# VERSION, and CHANGELOG.md (current cut: v1.0.6).
# ---------------------------------------------------------------------------
APP_NAME = "StallTrip"
APP_VERSION = "1.0.6"

# ---------------------------------------------------------------------------
# Structured stdout logging (Docker / Lightsail capture stdout+stderr for free)
# ---------------------------------------------------------------------------
_LOG = logging.getLogger("stalltrip")
_ACCESS_LOG = logging.getLogger("stalltrip.access")
_CLIENT_LOG = logging.getLogger("stalltrip.client")


def configure_logging() -> None:
    """Idempotent stdout logging setup. LOG_LEVEL=DEBUG|INFO|WARNING|ERROR."""
    root = logging.getLogger()
    if getattr(configure_logging, "_done", False):
        level_name = os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
        root.setLevel(getattr(logging, level_name, logging.INFO))
        return
    level_name = os.environ.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
    level = getattr(logging, level_name, logging.INFO)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter(
            "%(asctime)s %(levelname)s [%(name)s] %(message)s",
            datefmt="%Y-%m-%dT%H:%M:%S",
        )
    )
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(level)
    # Keep third-party / stdlib http.server quieter; we own access lines.
    logging.getLogger("http.server").setLevel(logging.WARNING)
    configure_logging._done = True  # type: ignore[attr-defined]


configure_logging()

PORT = int(os.environ.get("PORT", 8080))
STATIC_DIR = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "static"))

# Platform UA redirect on GET/HEAD `/` (ON by default):
#   Tesla in-car browser → /tesla
#   Phone / tablet mobile → /mobile  (iPhone, Android phones/tablets, iPad, iPod, …)
#   Desktop / unknown     → stay on /
# Escape hatch: ?desktop=1 (or ?ui=desktop). Opt out entirely: PLATFORM_UA_REDIRECT=0
# (MOBILE_UA_REDIRECT still accepted as a legacy alias for the same kill switch.)
#
# iPad: treated as mobile shell (/mobile). Use ?desktop=1 for the classic sidebar.
# iPadOS “Request Desktop Website” often sends a Macintosh UA — server cannot see that;
# those clients stay on / unless they open /mobile explicitly.
_MOBILE_UA_RE = re.compile(
    r"Android|iPhone|iPad|iPod|Windows Phone|BlackBerry|BB10|webOS|"
    r"Mobile|Opera Mini|IEMobile|Kindle|Silk/",
    re.IGNORECASE,
)
# Known Tesla MCU browser tokens (QtCarBrowser legacy + Chromium Tesla/<fw>).
_TESLA_UA_RE = re.compile(r"QtCarBrowser|\bTesla/", re.IGNORECASE)


def platform_ua_redirect_enabled() -> bool:
    """ON by default; set PLATFORM_UA_REDIRECT=0 (or MOBILE_UA_REDIRECT=0) to disable."""
    for key in ("PLATFORM_UA_REDIRECT", "MOBILE_UA_REDIRECT"):
        raw = os.environ.get(key)
        if raw is not None and str(raw).strip() != "":
            return str(raw).strip().lower() in ("1", "true", "yes", "on")
    return True


def mobile_ua_redirect_enabled() -> bool:
    """Backward-compatible alias for platform_ua_redirect_enabled()."""
    return platform_ua_redirect_enabled()


def looks_like_tesla_ua(user_agent: str) -> bool:
    return bool(user_agent and _TESLA_UA_RE.search(user_agent))


def looks_like_mobile_ua(user_agent: str) -> bool:
    """Phone/tablet-class browsers. Tesla car UA is checked separately (and first)."""
    if not user_agent or looks_like_tesla_ua(user_agent):
        return False
    return bool(_MOBILE_UA_RE.search(user_agent))


def platform_entry_for_ua(user_agent: str) -> Optional[str]:
    """Return `/tesla`, `/mobile`, or None (desktop / unknown) for a User-Agent."""
    if looks_like_tesla_ua(user_agent):
        return "/tesla"
    if looks_like_mobile_ua(user_agent):
        return "/mobile"
    return None


def _wants_desktop_escape(query: Dict[str, List[str]]) -> bool:
    """True when the client asked to stay on the desktop entry (`/` )."""
    desktop = (query.get("desktop") or [""])[0].strip().lower()
    if desktop in ("1", "true", "yes", "on"):
        return True
    ui = (query.get("ui") or [""])[0].strip().lower()
    return ui == "desktop"


def cost_profile_lean() -> bool:
    """HI-friendly lean profile: tighter upstream geo/plan budgets."""
    return os.environ.get("COST_PROFILE", "").strip().lower() in ("lean", "low", "cheap")


def trust_proxy_enabled() -> bool:
    """Honor X-Forwarded-For / Forwarded only when explicitly enabled.

    Default OFF so a directly exposed process cannot have rate-limit keys
    spoofed via client-supplied forwarded headers. Set TRUST_PROXY=1 only
    behind a reverse proxy that overwrites/strips untrusted Forwarded values.
    """
    return os.environ.get("TRUST_PROXY", "").strip().lower() in ("1", "true", "yes", "on")


def trust_proxy_hops() -> int:
    """How many trusted proxy hops to peel from the right of XFF / Forwarded.

    Default 1: take the right-most address (the client as seen by the immediate
    proxy). Raise when multiple trusted proxies append to the chain. Clients can
    prepend spoofed left-most values; hop-count from the right avoids that.
    """
    return _env_int("TRUST_PROXY_HOPS", 1, 1, 10)


def _normalize_ip_token(raw: str) -> Optional[str]:
    """Return a canonical IP string, or None if raw is not a bare address."""
    if not raw:
        return None
    s = raw.strip().strip('"').strip("'")
    if not s or any(c in s for c in ("/", " ", "\t", "\r", "\n")):
        return None
    if s.startswith("["):
        end = s.find("]")
        if end <= 1:
            return None
        s = s[1:end]
    elif s.count(":") == 1 and "." in s:
        # IPv4:port from some proxies
        host, _, port = s.partition(":")
        if port.isdigit():
            s = host
    try:
        return str(ipaddress.ip_address(s))
    except ValueError:
        return None


def _pick_forwarded_ip(candidates: List[str], hops: int) -> Optional[str]:
    """Pick client IP from a left→right hop list using trusted hops from the right."""
    parsed: List[str] = []
    for raw in candidates:
        ip = _normalize_ip_token(raw)
        if ip:
            parsed.append(ip)
    if not parsed:
        return None
    # hops=1 → right-most; hops=2 → second from right, etc.
    idx = len(parsed) - hops
    if idx < 0:
        idx = 0
    return parsed[idx]


def client_ip_from_headers(headers, peer_ip: str) -> str:
    """Resolve rate-limit client identity from peer + optional proxy headers."""
    fallback = peer_ip or "unknown"
    if not trust_proxy_enabled():
        return fallback

    hops = trust_proxy_hops()
    xff = headers.get("X-Forwarded-For") or headers.get("x-forwarded-for")
    if xff:
        picked = _pick_forwarded_ip(xff.split(","), hops)
        if picked:
            return picked

    forwarded = headers.get("Forwarded") or headers.get("forwarded")
    if forwarded:
        for_values: List[str] = []
        for part in forwarded.split(","):
            for directive in part.split(";"):
                directive = directive.strip()
                if directive.lower().startswith("for="):
                    for_values.append(directive[4:].strip())
                    break
        picked = _pick_forwarded_ip(for_values, hops)
        if picked:
            return picked
    return fallback


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

# Client browser-console bridge (/api/client-logs)
CLIENT_LOG_MAX_BODY_BYTES = 32 * 1024  # 32 KiB per batch
CLIENT_LOG_MAX_ENTRIES = 20
CLIENT_LOG_MAX_MESSAGE_LEN = 500
CLIENT_LOG_MAX_STACK_LEN = 1500
CLIENT_LOG_MAX_URL_LEN = 300
CLIENT_LOG_ALLOWED_LEVELS = frozenset({"error", "warn", "info"})
# Prefer Authorization: Bearer <token> before bare authorization=/bearer= forms.
_CLIENT_SECRETISH_RE = re.compile(
    r"(?i)("
    r"authorization\s*[:=]\s*bearer\s+\S+"
    r"|authorization\s*[:=]\s*\S+"
    r"|bearer\s+[A-Za-z0-9\-._~+/]+=*"
    r"|api[_-]?key\s*[:=]\s*\S+"
    r"|token\s*[:=]\s*\S+"
    r"|password\s*[:=]\s*\S+"
    r"|secret\s*[:=]\s*\S+"
    r")"
)
# Live geolocation must stay client-side; scrub accidental lat/lon dumps in log text.
_CLIENT_GEO_RE = re.compile(
    r"(?i)\b(lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]\s*-?\d+(?:\.\d+)?"
)
_STATIC_ACCESS_EXTS = (
    ".js",
    ".css",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".svg",
    ".ico",
    ".woff",
    ".woff2",
    ".map",
    ".gif",
)

# Cost knobs (env-overridable). COST_PROFILE=lean tightens defaults for HI deploy.
_LEAN = cost_profile_lean()
GEOCODE_RATE_LIMIT = _env_int("GEOCODE_RATE_LIMIT", 12 if _LEAN else 30, 1, 120)
GEOCODE_RATE_WINDOW_SEC = float(_env_int("GEOCODE_RATE_WINDOW_SEC", 60, 10, 600))
PLAN_RATE_LIMIT = _env_int("PLAN_RATE_LIMIT", 4 if _LEAN else 10, 1, 60)
PLAN_RATE_WINDOW_SEC = float(_env_int("PLAN_RATE_WINDOW_SEC", 60, 10, 600))
MAX_CONCURRENT_PLANS = _env_int("MAX_CONCURRENT_PLANS", 2 if _LEAN else 4, 1, 16)
# Browser cache for static assets (seconds) — cuts repeat egress; APIs stay no-store.
STATIC_CACHE_MAX_AGE = _env_int("STATIC_CACHE_MAX_AGE", 300, 0, 86400)
# Client-log batches per IP per window (not individual console lines).
CLIENT_LOG_RATE_LIMIT = _env_int("CLIENT_LOG_RATE_LIMIT", 20 if _LEAN else 40, 1, 120)
CLIENT_LOG_RATE_WINDOW_SEC = float(_env_int("CLIENT_LOG_RATE_WINDOW_SEC", 60, 10, 600))
# Global client-log budget across all IPs (hardens distributed flood of /api/client-logs).
CLIENT_LOG_GLOBAL_RATE_LIMIT = _env_int(
    "CLIENT_LOG_GLOBAL_RATE_LIMIT", 200 if _LEAN else 400, 1, 5000
)
# Sample successful static asset access lines (1 = log all; 20 = ~5%). APIs/HTML/errors always log.
ACCESS_LOG_STATIC_SAMPLE = _env_int("ACCESS_LOG_STATIC_SAMPLE", 20, 1, 1000)


def test_rate_bypass_secret() -> Optional[str]:
    """Shared secret for E2E rate-limit bypass, or None when disabled.

    Set ALLOW_TEST_RATE_BYPASS to a non-empty secret (not 0/false/off). Requests
    must send the *same* value in X-Test-Rate-Bypass. Prefer a long random
    token; never set this on a public host. Docker compose leaves it unset.
    """
    raw = os.environ.get("ALLOW_TEST_RATE_BYPASS", "").strip()
    if not raw or raw.lower() in ("0", "false", "no", "off"):
        return None
    return raw


def test_rate_bypass_enabled() -> bool:
    """True when a bypass secret is configured (still requires matching header)."""
    return test_rate_bypass_secret() is not None


# Simple in-memory rate limiters: ip -> (window_start, count)
_geocode_hits: Dict[str, Tuple[float, int]] = {}
_plan_hits: Dict[str, Tuple[float, int]] = {}
_client_log_hits: Dict[str, Tuple[float, int]] = {}
_client_log_global: Tuple[float, int] = (0.0, 0)  # window_start, count
_geocode_lock = threading.Lock()
_plan_lock = threading.Lock()
_client_log_lock = threading.Lock()
_plan_semaphore = threading.Semaphore(MAX_CONCURRENT_PLANS)
_access_static_counter = 0
_access_static_lock = threading.Lock()


def clear_rate_limit_state() -> None:
    """Drop in-memory geocode/plan/client-log rate-limit windows (test harness only)."""
    global _client_log_global
    with _geocode_lock:
        _geocode_hits.clear()
    with _plan_lock:
        _plan_hits.clear()
    with _client_log_lock:
        _client_log_hits.clear()
        _client_log_global = (0.0, 0)


def _unsafe_log_char(ch: str) -> bool:
    """True for Unicode C* controls and U+2028/U+2029 line/paragraph separators."""
    if ch in "\t\n\r":
        return True
    o = ord(ch)
    if o in (0x2028, 0x2029):
        return True
    return unicodedata.category(ch).startswith("C")


def sanitize_log_text(value: Any, max_len: int) -> str:
    """Truncate and strip C*/U+2028/2029 / secretish pairs / lat-lon for safe logging."""
    if value is None:
        return ""
    text = str(value)
    text = _CLIENT_SECRETISH_RE.sub("[redacted]", text)
    text = _CLIENT_GEO_RE.sub(r"\1=[redacted]", text)
    text = "".join(" " if _unsafe_log_char(ch) else ch for ch in text)
    text = re.sub(r" {2,}", " ", text).strip()
    if len(text) > max_len:
        return text[: max_len - 1] + "…"
    return text


def normalize_client_log_level(raw: Any) -> Optional[str]:
    if not isinstance(raw, str):
        return None
    level = raw.strip().lower()
    if level == "warning":
        level = "warn"
    if level in CLIENT_LOG_ALLOWED_LEVELS:
        return level
    return None


def normalize_client_shell(raw: Any) -> str:
    if not isinstance(raw, str):
        return "unknown"
    shell = raw.strip().lower()[:32]
    if shell in ("desktop", "mobile", "tesla"):
        return shell
    return "unknown"


def validate_client_log_entries(payload: Dict[str, Any]) -> Tuple[List[Dict[str, str]], int]:
    """Return (accepted_entries, rejected_count). Does not mutate payload deeply."""
    raw_entries = payload.get("entries")
    if not isinstance(raw_entries, list):
        return [], 0
    accepted: List[Dict[str, str]] = []
    rejected = 0
    for item in raw_entries[:CLIENT_LOG_MAX_ENTRIES]:
        if not isinstance(item, dict):
            rejected += 1
            continue
        level = normalize_client_log_level(item.get("level"))
        message = sanitize_log_text(item.get("message"), CLIENT_LOG_MAX_MESSAGE_LEN)
        if not level or not message:
            rejected += 1
            continue
        entry = {
            "level": level,
            "message": message,
            "shell": normalize_client_shell(item.get("shell")),
            "url": sanitize_log_text(item.get("url"), CLIENT_LOG_MAX_URL_LEN),
            "stack": sanitize_log_text(item.get("stack"), CLIENT_LOG_MAX_STACK_LEN),
        }
        accepted.append(entry)
    # Extra entries beyond cap count as rejected
    if len(raw_entries) > CLIENT_LOG_MAX_ENTRIES:
        rejected += len(raw_entries) - CLIENT_LOG_MAX_ENTRIES
    return accepted, rejected


def _should_log_access(path: str, code: int) -> bool:
    """Always log APIs, HTML, and errors; sample hot successful static assets."""
    global _access_static_counter
    try:
        status = int(code)
    except (TypeError, ValueError):
        status = 0
    if status >= 400 or status < 200:
        return True
    clean = (path or "").split("?", 1)[0].lower()
    if clean.startswith("/api/"):
        return True
    if clean.endswith(_STATIC_ACCESS_EXTS):
        with _access_static_lock:
            _access_static_counter += 1
            return (_access_static_counter % ACCESS_LOG_STATIC_SAMPLE) == 0
    return True


class SuperchargerRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Handles static files and REST API endpoints for Tesla Supercharger planning."""

    # Do not leak Python version via the Server response header.
    server_version = f"{APP_NAME}/{APP_VERSION}"
    sys_version = ""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=STATIC_DIR, **kwargs)

    def setup(self):
        super().setup()
        try:
            self.connection.settimeout(REQUEST_SOCKET_TIMEOUT_SEC)
        except OSError:
            pass

    def version_string(self) -> str:
        return self.server_version

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
        if path == "/health":
            self.send_empty_ok()
            return
        if path == "/api/health":
            # E2E isolation: clear RL windows when secret header matches env.
            if self._test_rate_bypass_request() and (query.get("reset_rate_limit") or [""])[
                0
            ] in ("1", "true", "yes"):
                clear_rate_limit_state()
            redirect_on = platform_ua_redirect_enabled()
            self.send_json_response({
                "status": "healthy",
                "service": APP_NAME,
                "version": APP_VERSION,
                "mobile_shell": "/mobile",
                "tesla_shell": "/tesla",
                "cost_profile": "lean" if cost_profile_lean() else "default",
                "limits": {
                    "geocode_per_min": GEOCODE_RATE_LIMIT,
                    "plan_per_min": PLAN_RATE_LIMIT,
                    "max_concurrent_plans": MAX_CONCURRENT_PLANS,
                    "static_cache_max_age": STATIC_CACHE_MAX_AGE,
                    "client_log_per_min": CLIENT_LOG_RATE_LIMIT,
                    "client_log_global_per_min": CLIENT_LOG_GLOBAL_RATE_LIMIT,
                    "client_log_max_entries": CLIENT_LOG_MAX_ENTRIES,
                    "platform_ua_redirect": redirect_on,
                    # Legacy alias — same flag as platform_ua_redirect
                    "mobile_ua_redirect": redirect_on,
                    # Rate-limit key uses X-Forwarded-For only when TRUST_PROXY=1
                    "trust_proxy": trust_proxy_enabled(),
                    "trust_proxy_hops": trust_proxy_hops() if trust_proxy_enabled() else 0,
                },
            })
            return
        if path.startswith("/api/"):
            self.send_json_response({"error": "Endpoint not found"}, status=404)
            return

        # Clean URL for in-car fingerprint page (must work over public HTTPS later)
        if path in ("/tesla-probe", "/tesla-probe/"):
            self.path = "/tesla-probe.html"
            return super().do_GET()

        if self._maybe_platform_ua_redirect(path, query):
            return

        self._map_spa_path(path)
        return super().do_GET()

    def do_HEAD(self):
        """Same SPA mapping as GET so probes like `curl -I /mobile` succeed."""
        self._api_response = False
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        if path.startswith("/api/"):
            # JSON APIs are GET/POST oriented; HEAD → 405 keeps surface small.
            self.send_response(405)
            self.send_header("Allow", "GET, POST, OPTIONS")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path in ("/tesla-probe", "/tesla-probe/"):
            self.path = "/tesla-probe.html"
            return super().do_HEAD()

        if self._maybe_platform_ua_redirect(path, query):
            return

        self._map_spa_path(path)
        return super().do_HEAD()

    def _maybe_platform_ua_redirect(
        self, path: str, query: Optional[Dict[str, List[str]]] = None
    ) -> bool:
        """Redirect `/` by User-Agent to /tesla or /mobile. Returns True if response sent.

        Only applies to the desktop entry `/`. Already on `/mobile` or `/tesla` → no-op
        (no redirect loops). APIs and static assets are never redirected.
        """
        if path != "/":
            return False
        if not platform_ua_redirect_enabled():
            return False
        if _wants_desktop_escape(query or {}):
            return False
        target = platform_entry_for_ua(self.headers.get("User-Agent", ""))
        if not target:
            return False
        self.send_response(302)
        self.send_header("Location", target)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def _maybe_mobile_ua_redirect(self, path: str) -> bool:
        """Deprecated alias — prefer _maybe_platform_ua_redirect."""
        return self._maybe_platform_ua_redirect(path, {})

    def _map_spa_path(self, path: str) -> None:
        """Rewrite mobile / tesla + unknown paths onto index.html (same SPA)."""
        if path in ("/mobile", "/mobile/", "/tesla", "/tesla/", "/") or not self._static_file_exists(
            path
        ):
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
        if path == "/api/client-logs":
            self.handle_client_logs()
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

    def _read_json_body(self, max_bytes: Optional[int] = None) -> Optional[Dict[str, Any]]:
        """Read POST body with a hard size cap. Returns None and sends error on failure."""
        limit = MAX_BODY_BYTES if max_bytes is None else max_bytes
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
        if content_length > limit:
            self._discard_body(content_length)
            self.close_connection = True
            self.send_json_response(
                {"error": f"Request body too large (max {limit} bytes)"},
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
        peer = self.client_address[0] if self.client_address else "unknown"
        return client_ip_from_headers(self.headers, peer)

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

    def _test_rate_bypass_request(self) -> bool:
        secret = test_rate_bypass_secret()
        if not secret:
            return False
        provided = self.headers.get("X-Test-Rate-Bypass", "").strip()
        if not provided:
            return False
        try:
            return hmac.compare_digest(
                provided.encode("utf-8"), secret.encode("utf-8")
            )
        except (TypeError, ValueError):
            return False

    def _geocode_allowed(self) -> bool:
        if self._test_rate_bypass_request():
            return True
        return self._rate_limit_allowed(
            _geocode_hits, _geocode_lock, GEOCODE_RATE_LIMIT, GEOCODE_RATE_WINDOW_SEC
        )

    def _plan_allowed(self) -> bool:
        if self._test_rate_bypass_request():
            return True
        return self._rate_limit_allowed(
            _plan_hits, _plan_lock, PLAN_RATE_LIMIT, PLAN_RATE_WINDOW_SEC
        )

    def _client_log_allowed(self) -> bool:
        """Per-IP + global client-log budgets. No test-rate-bypass (open flood surface)."""
        global _client_log_global
        now = time.monotonic()
        window_sec = CLIENT_LOG_RATE_WINDOW_SEC
        per_ip_limit = CLIENT_LOG_RATE_LIMIT
        global_limit = CLIENT_LOG_GLOBAL_RATE_LIMIT
        ip = self._client_ip()
        with _client_log_lock:
            # Global budget first — refuse before mutating per-IP counters.
            g_start, g_count = _client_log_global
            if g_start <= 0.0 or now - g_start >= window_sec:
                g_start, g_count = now, 0
            if g_count >= global_limit:
                return False

            if len(_client_log_hits) > MAX_GEOCODE_TRACKED_IPS:
                stale = [
                    key
                    for key, (start, _) in _client_log_hits.items()
                    if now - start >= window_sec
                ]
                for key in stale:
                    del _client_log_hits[key]
                if len(_client_log_hits) > MAX_GEOCODE_TRACKED_IPS:
                    overflow = len(_client_log_hits) - (MAX_GEOCODE_TRACKED_IPS // 2)
                    oldest = sorted(
                        _client_log_hits.items(), key=lambda kv: kv[1][0]
                    )[:overflow]
                    for key, _ in oldest:
                        del _client_log_hits[key]

            start, count = _client_log_hits.get(ip, (now, 0))
            if now - start >= window_sec:
                start, count = now, 0
            if count >= per_ip_limit:
                return False

            _client_log_hits[ip] = (start, count + 1)
            _client_log_global = (g_start, g_count + 1)
            return True

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

    def handle_client_logs(self):
        """Accept batched browser console lines (error/warn/selective info). No auth.

        Rate-limited per IP; payload size and per-entry text capped. Writes to
        stdout as structured CLIENT_* lines for Docker/Lightsail log capture.
        """
        if not self._client_log_allowed():
            self.send_json_response(
                {"error": "Client-log rate limit exceeded", "accepted": 0},
                status=429,
            )
            return

        data = self._read_json_body(max_bytes=CLIENT_LOG_MAX_BODY_BYTES)
        if data is None:
            return

        if "entries" not in data:
            self.send_json_response(
                {"error": "Missing entries array", "accepted": 0},
                status=400,
            )
            return
        if not isinstance(data.get("entries"), list):
            self.send_json_response(
                {"error": "entries must be an array", "accepted": 0},
                status=400,
            )
            return

        accepted, rejected = validate_client_log_entries(data)
        ip = self._client_ip()
        for entry in accepted:
            level = entry["level"]
            line = (
                f"ip={ip} shell={entry['shell']} url={entry['url'] or '-'} "
                f"msg={entry['message']}"
            )
            if entry["stack"]:
                line += f" stack={entry['stack']}"
            if level == "error":
                _CLIENT_LOG.error(line)
            elif level == "warn":
                _CLIENT_LOG.warning(line)
            else:
                _CLIENT_LOG.info(line)

        self.send_json_response({
            "ok": True,
            "accepted": len(accepted),
            "rejected": rejected,
        })

    def _send_security_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        # Removable modules: foliage (Explore Fall) + airspace (FAA/NPS ArcGIS).
        # Same-origin UI — no Access-Control-Allow-Origin (prevents cross-site OSRM proxying).
        # CDN allowlists pin exact Leaflet / Font Awesome paths (SRI in index.html).
        # script-src stays path-pinned (no bare unpkg host). connect-src allows https://unpkg.com
        # so DevTools can fetch leaflet.js.map without widening executable script hosts.
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; "
            "script-src 'self' https://unpkg.com/leaflet@1.9.4/dist/leaflet.js; "
            "style-src 'self' 'unsafe-inline' https://unpkg.com/leaflet@1.9.4/dist/leaflet.css "
            "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css "
            "https://fonts.googleapis.com; "
            "font-src 'self' https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/ "
            "https://fonts.gstatic.com data:; "
            # OSM uses bare tile.openstreetmap.org (wildcard *.tile. does not match that host).
            "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org "
            "https://*.tile.opentopomap.org https://unpkg.com/leaflet@1.9.4/dist/images/ "
            "https://www.explorefall.com "
            "https://tilecache.rainviewer.com https://*.rainviewer.com; "
            "connect-src 'self' https://unpkg.com https://cdnjs.cloudflare.com "
            "https://services6.arcgis.com https://services1.arcgis.com https://*.arcgis.com "
            "https://api.rainviewer.com https://api.open-meteo.com; "
            "frame-ancestors 'none'; "
            "base-uri 'self'; "
            "form-action 'self'",
        )
        self.send_header(
            "Permissions-Policy",
            "geolocation=(self), camera=(), microphone=(), payment=()",
        )

    def send_empty_ok(self):
        """Bare probe: HTTP 200, empty body (status-code-only health checks)."""
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self._api_response = True
        self.end_headers()

    def send_json_response(self, data: Any, status: int = 200):
        body = json.dumps(data).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            if getattr(self, "close_connection", False):
                self.send_header("Connection", "close")
            self._api_response = True
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            # Browser navigated away / closed mid-response (common on long plan-route).
            self.close_connection = True

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

    def copyfile(self, source, outputfile):
        """Serve static files; ignore client disconnect mid-stream."""
        try:
            super().copyfile(source, outputfile)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True

    def log_request(self, code: Any = "-", size: Any = "-") -> None:
        """One-line access log: method path status duration ua (static assets sampled)."""
        try:
            path = urllib.parse.urlparse(getattr(self, "path", "") or "").path or "/"
            try:
                status = int(code)
            except (TypeError, ValueError):
                status = 0
            if not _should_log_access(path, status):
                return
            started = getattr(self, "_req_started", None)
            if started is not None:
                duration_ms = max(0, int((time.monotonic() - started) * 1000))
            else:
                duration_ms = -1
            method = sanitize_log_text(getattr(self, "command", None) or "-", 16)
            safe_path = sanitize_log_text(path, 200)
            ua = sanitize_log_text(self.headers.get("User-Agent", ""), 80)
            ip = self._client_ip()
            _ACCESS_LOG.info(
                '%s "%s %s" %s %sms ua="%s"',
                ip,
                method or "-",
                safe_path or "/",
                code,
                duration_ms if duration_ms >= 0 else "-",
                ua or "-",
            )
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            # Never let access logging break a response.
            pass

    def log_message(self, fmt: str, *args) -> None:
        # Base handler uses this for misc messages; route through app logger quietly.
        try:
            try:
                raw = fmt % args if args else str(fmt)
            except Exception:
                raw = str(fmt)
            _LOG.info(
                "%s - %s",
                sanitize_log_text(self.address_string(), 64),
                sanitize_log_text(raw, 500),
            )
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception:
            pass

    def log_error(self, fmt: str, *args) -> None:
        # Quiet expected client disconnect noise; keep real errors.
        try:
            msg = fmt % args if args else str(fmt)
        except Exception:
            msg = str(fmt)
        lower = msg.lower()
        if any(
            token in lower
            for token in (
                "broken pipe",
                "connection reset",
                "connection aborted",
                "timed out",
            )
        ):
            _LOG.debug("client disconnect: %s", sanitize_log_text(msg, 300))
            return
        _LOG.error(
            "%s - %s",
            sanitize_log_text(self.address_string(), 64),
            sanitize_log_text(msg, 500),
        )

    def handle_one_request(self) -> None:
        """Same as base, but treat client disconnect as a quiet close; time requests."""
        self._req_started = time.monotonic()
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            self.close_connection = True
            _LOG.debug("client disconnected mid-request")

    def finish(self) -> None:
        try:
            super().finish()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def run_server(port: int = PORT):
    configure_logging()
    # Pre-load dataset
    routing.load_superchargers()

    class ThreadedReusableServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
        allow_reuse_address = True
        daemon_threads = True
        request_queue_size = 32
        timeout = REQUEST_SOCKET_TIMEOUT_SEC

    with ThreadedReusableServer(("", port), SuperchargerRequestHandler) as httpd:
        profile = "lean" if cost_profile_lean() else "default"
        ua_mode = "on" if platform_ua_redirect_enabled() else "off"
        proxy_mode = "on" if trust_proxy_enabled() else "off"
        _LOG.info("============================================================")
        _LOG.info("Tesla Supercharger Route Planner on port %s", port)
        _LOG.info("Desktop:  http://localhost:%s/", port)
        _LOG.info("Mobile:   http://localhost:%s/mobile", port)
        _LOG.info("Tesla:    http://localhost:%s/tesla", port)
        _LOG.info("Probe:    http://localhost:%s/tesla-probe", port)
        _LOG.info(
            "UA / →    platform redirect %s (Tesla→/tesla, mobile→/mobile; ?desktop=1 escape)",
            ua_mode,
        )
        _LOG.info(
            "Cost:     profile=%s  plans=%s/min  geocode=%s/min  concurrent=%s  "
            "client_logs=%s/min/ip global=%s/min",
            profile,
            PLAN_RATE_LIMIT,
            GEOCODE_RATE_LIMIT,
            MAX_CONCURRENT_PLANS,
            CLIENT_LOG_RATE_LIMIT,
            CLIENT_LOG_GLOBAL_RATE_LIMIT,
        )
        _LOG.info(
            "Proxy:    TRUST_PROXY=%s hops=%s (XFF right-most untrusted when on)",
            proxy_mode,
            trust_proxy_hops() if trust_proxy_enabled() else 0,
        )
        _LOG.info(
            "Logging:  stdout structured; static access sample 1/%s; POST /api/client-logs",
            ACCESS_LOG_STATIC_SAMPLE,
        )
        _LOG.info("============================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            _LOG.info("Shutting down server.")


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    run_server(port_arg)

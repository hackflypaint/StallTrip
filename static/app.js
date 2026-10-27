/**
 * Tesla Supercharger Route Planner - Client Application
 * Includes Visit Maximizer routing, map area drag-selection for force-included chargers,
 * Streets / Topographic basemap switching via the Layers button, and multi-stop itinerary generation.
 * Optional Fall Foliage: see static/foliage/ (FoliageModule) — removable.
 * Optional drone flight constraints: see static/airspace/ (AirspaceModule) — removable.
 */

/**
 * Destination arrival SOC tone vs min-arrival reserve (slider).
 * ok ≥ target · warn ≥ half target (floor 5) · danger below that.
 * Exported on window for unit tests.
 */
function destinationBatteryTone(pct, targetPct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return "unknown";
  const tRaw = Number(targetPct);
  const target = Number.isFinite(tRaw) && tRaw > 0 ? tRaw : 15;
  if (p >= target) return "ok";
  if (p >= Math.max(5, target * 0.5)) return "warn";
  return "danger";
}
if (typeof window !== "undefined") {
  window.destinationBatteryTone = destinationBatteryTone;
}

// Application State
const state = {
  origin: null,        // { name, lat, lng }
  destination: null,   // { name, lat, lng }
  activePlan: null,
  /** Prior plan kept across clearActivePlan({ snapshotForRestore }) for failed replan restore. */
  planRestoreSnapshot: null,
  map: null,
  markersLayer: null,
  corridorLayer: null,
  routeLayer: null,
  forcedMarkersLayer: null,
  allSuperchargers: [],
  selectedCharger: null,
  routingMode: "MAXIMIZE", // "MAXIMIZE" (default) or "MIN_STOPS"
  forcedChargers: new Map(), // Map<id, charger>
  /** Charger IDs last added via box/freehand area select (not individual drawer/map toggles). */
  areaForcedIds: new Set(),
  areaSelectMode: false,
  areaDrawMode: "box", // "box" | "freehand"
  dragStartLatLng: null,
  selectionShape: null, // rectangle, polyline, or finished polygon
  freehandPoints: [],
  baseLayers: null,
  activeBasemap: "streets",
  layersPanelOpen: false,
  /** Monotonic token so overlapping planRoute calls discard stale responses. */
  planRouteSeq: 0,
  /** True while a /api/plan-route request is in flight (blocks live auto-replan). */
  planInFlight: false,
  /** Foliage/airspace mounted (lazy on mobile until Layers opens). */
  optionalOverlaysMounted: false,
  /** Explore bounds fetch sequencing / debounce. */
  exploreFetchSeq: 0,
  exploreDebounceTimer: null,
  invalidateSizeTimer: null,
  /** True while live-follow setView/panTo runs — zoomstart must not pause follow. */
  livePanInProgress: false,
  /** Tesla landscape bottom-sheet mode (not phone /mobile). */
  carShell: false,
  /** peek | plan | itinerary — default peek so map dominates on load */
  sheetMode: "peek",
  /** Map tap hid the bottom chrome (full-bleed map + Plan FAB). */
  carChromeHidden: false,
  /**
   * Client-side live location (browser Geolocation only — never POSTed to our server).
   * Shared by /mobile, /tesla, and desktop SPA.
   */
  liveLocation: {
    watching: false,
    follow: false,
    watchId: null,
    lat: null,
    lng: null,
    accuracy: null,
    heading: null,
    speedMps: null,
    nextStop: null,
    offCorridor: false,
    wakeLock: null,
    startedAt: 0,
    /** Last origin committed into a plan (or first GPS seed). */
    plannedOriginLat: null,
    plannedOriginLng: null,
    lastAutoReplanAt: 0,
    lastFixAt: 0,
    /** Supercharger stop ids already treated as passed this watch session. */
    passedStopIds: null,
    lastReplanReason: null,
    /**
     * Set when the user taps Locate (start/resume). Next accepted GPS fix must
     * overwrite trip origin even if a typed/geocoded start was already set.
     */
    forceOriginOnNextFix: false,
  },
  userLocationLayer: null,
  /** Reused blue-dot layers (avoid clearLayers every GPS tick — flicker). */
  userLocationMarker: null,
  userAccuracyCircle: null,
};

// Expose for Playwright / debugging (cloud verification)
window.appState = state;

/**
 * Mobile shell detection: explicit /mobile path or ?ui=mobile.
 * Do not rely on User-Agent here — server redirects `/` by UA to /mobile or /tesla
 * (see server.py platform_entry_for_ua); ?desktop=1 keeps the desktop entry.
 */
function isMobileShell() {
  const path = (location.pathname || "/").replace(/\/+$/, "") || "/";
  const params = new URLSearchParams(location.search || "");
  return path === "/mobile" || params.get("ui") === "mobile";
}

window.isMobileShell = isMobileShell;

/**
 * Canonical in-car entry: /tesla (bookmark-friendly; car mode ON by default).
 * Distinct from /tesla-probe (fingerprint page).
 */
function isTeslaPath() {
  const path = (location.pathname || "/").replace(/\/+$/, "") || "/";
  return path === "/tesla";
}

window.isTeslaPath = isTeslaPath;

/**
 * Browser console → server bridge (Lightsail-friendly).
 * Patches console.error / warn (+ selective info), batches POST /api/client-logs.
 * Failures never break the UI; identical lines are deduped briefly.
 */
(function installClientLogBridge() {
  if (typeof window === "undefined" || window.__stalltripClientLogInstalled) return;
  window.__stalltripClientLogInstalled = true;

  const MAX_BATCH = 12;
  const MAX_MESSAGE = 500;
  const MAX_STACK = 1500;
  const FLUSH_MS = 2000;
  const DEDUPE_MS = 8000;
  const ENDPOINT = "/api/client-logs";

  const orig = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
  };

  let queue = [];
  let flushTimer = null;
  let posting = false;
  const recent = new Map(); // key -> timestamp

  function currentShell() {
    try {
      if (typeof isTeslaPath === "function" && isTeslaPath()) return "tesla";
      if (typeof isMobileShell === "function" && isMobileShell()) return "mobile";
    } catch (_) { /* ignore */ }
    return "desktop";
  }

  function truncate(text, max) {
    const s = String(text == null ? "" : text);
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  function redact(text) {
    return String(text || "")
      .replace(
        /authorization\s*[:=]\s*bearer\s+\S+/gi,
        "[redacted]"
      )
      .replace(
        /(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*\S+/gi,
        "$1=[redacted]"
      )
      .replace(/\bbearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "bearer=[redacted]")
      .replace(
        /\b(lat(?:itude)?|lon(?:gitude)?|lng)\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
        "$1=[redacted]"
      );
  }

  function serializeArg(arg) {
    if (arg == null) return String(arg);
    if (typeof arg === "string") return arg;
    if (arg instanceof Error) {
      return arg.message || String(arg);
    }
    try {
      return JSON.stringify(arg);
    } catch (_) {
      return String(arg);
    }
  }

  function stackFromArgs(args) {
    for (const a of args) {
      if (a instanceof Error && a.stack) return truncate(redact(a.stack), MAX_STACK);
    }
    return "";
  }

  function shouldCaptureInfo(message) {
    // Keep signal, drop chatty noise. Wake Lock / similar are useful on Tesla.
    const m = message.toLowerCase();
    if (m.includes("wake lock")) return true;
    if (m.includes("geolocation") || m.includes("watchposition")) return true;
    return false;
  }

  function enqueue(level, args, extraStack) {
    try {
      const message = truncate(
        redact(Array.from(args).map(serializeArg).join(" ")),
        MAX_MESSAGE
      );
      if (!message) return;
      if (level === "info" && !shouldCaptureInfo(message)) return;

      const key = level + "|" + message;
      const now = Date.now();
      const last = recent.get(key) || 0;
      if (now - last < DEDUPE_MS) return;
      recent.set(key, now);
      if (recent.size > 80) {
        for (const [k, t] of recent) {
          if (now - t > DEDUPE_MS) recent.delete(k);
        }
      }

      queue.push({
        level,
        message,
        stack: extraStack || stackFromArgs(args),
        url: truncate(location.pathname + location.search, 300),
        shell: currentShell(),
        ts: now / 1000,
      });
      if (queue.length >= MAX_BATCH) {
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flush, FLUSH_MS);
      }
    } catch (_) {
      // Never throw from logging.
    }
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (posting || queue.length === 0) return;
    const entries = queue.splice(0, MAX_BATCH);
    posting = true;
    const body = JSON.stringify({ entries });
    // Prefer sendBeacon on unload; fetch otherwise (keepalive for pagehide).
    const send = () => {
      if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function" && document.visibilityState === "hidden") {
        try {
          const blob = new Blob([body], { type: "application/json" });
          if (navigator.sendBeacon(ENDPOINT, blob)) {
            posting = false;
            if (queue.length) flush();
            return;
          }
        } catch (_) { /* fall through */ }
      }
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
        credentials: "same-origin",
      })
        .catch(() => { /* swallow — logging must not break UI */ })
        .finally(() => {
          posting = false;
          if (queue.length) flush();
        });
    };
    try {
      send();
    } catch (_) {
      posting = false;
    }
  }

  console.error = function bridgedError(...args) {
    try { enqueue("error", args); } catch (_) { /* ignore */ }
    return orig.error(...args);
  };
  console.warn = function bridgedWarn(...args) {
    try { enqueue("warn", args); } catch (_) { /* ignore */ }
    return orig.warn(...args);
  };
  console.info = function bridgedInfo(...args) {
    try { enqueue("info", args); } catch (_) { /* ignore */ }
    return orig.info(...args);
  };

  window.addEventListener("error", (ev) => {
    const msg = ev && ev.message ? ev.message : "window.onerror";
    const stack = ev && ev.error && ev.error.stack ? String(ev.error.stack) : "";
    enqueue("error", [msg], truncate(redact(stack), MAX_STACK));
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev && ev.reason;
    if (reason instanceof Error) {
      enqueue("error", ["unhandledrejection", reason.message], truncate(redact(reason.stack || ""), MAX_STACK));
    } else {
      enqueue("error", ["unhandledrejection", reason]);
    }
  });
  window.addEventListener("pagehide", () => { try { flush(); } catch (_) { /* ignore */ } });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      try { flush(); } catch (_) { /* ignore */ }
    }
  });

  window.__stalltripFlushClientLogs = flush;
})();

/** Escape text for safe interpolation into HTML / Leaflet popups. */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** True while the user is pinching, scroll-zooming, or dragging the map. */
function isMapUserGesturing() {
  const map = state.map;
  if (!map) return false;
  if (map._animatingZoom) return true;
  if (map.touchZoom && map.touchZoom._zooming) return true;
  if (map.boxZoom && map.boxZoom._moved) return true;
  if (map.dragging && typeof map.dragging.moving === "function" && map.dragging.moving()) {
    return true;
  }
  return false;
}

window.isMapUserGesturing = isMapUserGesturing;

/**
 * Pause auto-follow on user pan/pinch/zoom so live GPS panTo cannot fight the gesture.
 * Programmatic live pans set state.livePanInProgress and are ignored here.
 */
function pauseLiveFollowForUserGesture() {
  if (state.livePanInProgress) return false;
  const live = state.liveLocation;
  if (!live.watching || !live.follow) return false;
  live.follow = false;
  syncLiveLocationUi();
  showToast("Follow paused — tap locate to resume.", 2400);
  return true;
}

window.pauseLiveFollowForUserGesture = pauseLiveFollowForUserGesture;

/** Coalesce Leaflet invalidateSize — sheet toggles can fire back-to-back. */
function scheduleMapInvalidate(delayMs) {
  if (!state.map) return;
  const delay = delayMs == null ? 80 : delayMs;
  if (state.invalidateSizeTimer) clearTimeout(state.invalidateSizeTimer);
  state.invalidateSizeTimer = setTimeout(() => {
    state.invalidateSizeTimer = null;
    if (!state.map) return;
    // Never invalidate mid-pinch/zoom — resets tile transforms and looks like flicker.
    if (isMapUserGesturing()) return;
    state.map.invalidateSize({ animate: false });
  }, delay);
}

window.scheduleMapInvalidate = scheduleMapInvalidate;

/**
 * Safari (and similar) overlays a bottom toolbar on the layout viewport.
 * Measure visualViewport gap → --vv-bottom so Plan / sheet clear the chrome.
 * Mobile shell only; desktop and car-shell ignore these vars.
 */
function updateMobileViewportInsets() {
  if (!document.body.classList.contains("ui-mobile")) return;
  let overlay = 0;
  const vv = window.visualViewport;
  if (vv) {
    overlay = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  }
  // Set on body — body.ui-mobile owns --vv-bottom; html inheritance loses to that rule.
  document.body.style.setProperty("--vv-bottom", `${overlay}px`);
}

window.updateMobileViewportInsets = updateMobileViewportInsets;

function setMobileSheetOpen(open) {
  if (!document.body.classList.contains("ui-mobile")) return;
  const wasOpen = document.body.classList.contains("sheet-open");
  const next = !!open;
  if (wasOpen === next) return;
  document.body.classList.toggle("sheet-open", next);
  const toggle = document.getElementById("btnMobileSheet");
  if (toggle) {
    toggle.setAttribute("aria-expanded", next ? "true" : "false");
    const label = next ? "Hide planner" : "Show planner";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    const text = toggle.querySelector("span");
    if (text) text.textContent = next ? "Map" : "Plan";
  }
  updateMobileViewportInsets();
  scheduleMapInvalidate(80);
}

function openMobileSheet() {
  setMobileSheetOpen(true);
}

function closeMobileSheet() {
  setMobileSheetOpen(false);
}

window.setMobileSheetOpen = setMobileSheetOpen;

/**
 * Normalize geolocation success into an origin place.
 * On error / missing coords returns null (never silently seeds San Francisco).
 */
function resolveGeolocationPlace(position, error) {
  if (!error && position && position.coords) {
    const { latitude, longitude } = position.coords;
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      return {
        name: "Current Location",
        lat: latitude,
        lng: longitude,
        source: "geolocation",
      };
    }
  }
  // Never silently seed San Francisco — callers toast and let the user choose.
  return null;
}

window.resolveGeolocationPlace = resolveGeolocationPlace;

/**
 * Explore API limit — desktop fixed; mobile drops further when zoomed out.
 * Pure zoom/mobile inputs kept testable via exploreFetchLimitFor(zoom, mobile).
 */
function exploreFetchLimitFor(zoom, mobileShell) {
  if (!mobileShell) return 120;
  const z = Number.isFinite(zoom) ? zoom : 6;
  if (z < 7) return 25;
  if (z < 9) return 40;
  return 60;
}

function exploreFetchLimit() {
  const zoom = state.map ? state.map.getZoom() : 6;
  return exploreFetchLimitFor(zoom, isMobileShell());
}

window.exploreFetchLimit = exploreFetchLimit;
window.exploreFetchLimitFor = exploreFetchLimitFor;

/** Cap corridor yellow dots on mobile so plan renders stay light at low zoom. */
function corridorMarkerCapFor(zoom, mobileShell) {
  if (!mobileShell) return 500;
  const z = Number.isFinite(zoom) ? zoom : 6;
  if (z < 7) return 40;
  if (z < 9) return 80;
  return 120;
}

function corridorMarkerCap() {
  const zoom = state.map ? state.map.getZoom() : 6;
  return corridorMarkerCapFor(zoom, isMobileShell());
}

window.corridorMarkerCapFor = corridorMarkerCapFor;

/** Evenly subsample a list down to `cap` (keeps first/last when possible). */
function subsampleMarkers(items, cap) {
  if (!Array.isArray(items) || items.length <= cap) return items || [];
  if (cap <= 0) return [];
  if (cap === 1) return [items[0]];
  const out = [];
  const last = items.length - 1;
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * last) / (cap - 1));
    out.push(items[idx]);
  }
  return out;
}

window.subsampleMarkers = subsampleMarkers;

function initMobileShell() {
  if (!isMobileShell()) return;

  document.body.classList.add("ui-mobile");
  document.documentElement.dataset.ui = "mobile";

  const toggle = document.getElementById("btnMobileSheet");
  if (toggle) {
    toggle.hidden = false;
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => {
      setMobileSheetOpen(!document.body.classList.contains("sheet-open"));
    });
  }

  updateMobileViewportInsets();
  const onViewportChange = () => updateMobileViewportInsets();
  window.addEventListener("resize", onViewportChange);
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", onViewportChange);
    vv.addEventListener("scroll", onViewportChange);
  }

  // Demo / QA: /mobile?sheet=1 opens the planner sheet on load
  const params = new URLSearchParams(location.search || "");
  if (params.get("sheet") === "1") {
    setMobileSheetOpen(true);
  }

  if (state.map) {
    scheduleMapInvalidate(100);
  }
}

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  initMobileShell();
  setupEventListeners();
  setupCarShell();
  loadStats();
  updateAreaToolDrawingState();
  updateMapLegendVisibility();
  // Mobile: skip eager nearby list until Explore is opened (saves a boot fetch)
  if (!isMobileShell()) {
    loadNearbyChargers();
  }
});

/**
 * Tesla / half-MCU car shell: map-first + bottom plan sheet.
 *
 * Canonical entry: /tesla (car mode ON; no query needed).
 * Optional on `/`: ?car=1 / ?tesla=1 / #car. Disable: ?car=0
 *
 * CRITICAL (2026-10-18 incar): browser is the RIGHT HALF of the MCU.
 * At DPR~1.53, CSS width is often ~600–650 — NOT ≥700. The v1 detector
 * required w>=700 and never engaged; ≤860px stack crushed the map.
 * Fail OPEN for short/narrow landscape panes when not on an explicit path.
 */
function shouldUseCarShell() {
  // Phone /mobile shell is a separate product path — never mix with car-shell
  if (isMobileShell()) return false;
  const params = new URLSearchParams(window.location.search);
  const forced = params.get("car") || params.get("tesla");
  if (forced === "0" || forced === "false") {
    try {
      window.localStorage.setItem("teslaCarShell", "0");
    } catch (_) {
      /* ignore */
    }
    return false;
  }
  // Bookmark path: /tesla always enables car shell (unless ?car=0 above)
  if (isTeslaPath()) return true;
  if (forced === "1" || forced === "true") {
    try {
      window.localStorage.setItem("teslaCarShell", "1");
    } catch (_) {
      /* ignore */
    }
    return true;
  }
  if (/#(?:car|tesla)\b/i.test(window.location.hash || "")) return true;
  try {
    const ls = window.localStorage.getItem("teslaCarShell");
    if (ls === "1") return true;
    if (ls === "0") return false;
  } catch (_) {
    /* ignore */
  }

  const w = window.innerWidth;
  const h = window.innerHeight;
  const touchy = (navigator.maxTouchPoints || 0) > 0;

  // Phone portrait only — keep existing narrow stack / not this shell
  if (w < 480 && h > w * 1.15) return false;

  // Large desktop canvases keep the classic left sidebar
  if (w >= 1280 && h >= 800) return false;

  // FAIL OPEN: half-MCU (~600×650), windowed Tesla (~773×601), short panes.
  // Matches ngrok half-screen reference photos.
  if (h <= 900 && w >= 480 && w < 1280) return true;

  // Touch + short height (fullscreen-ish car) even if slightly wider
  if (touchy && h <= 850 && w <= 1400) return true;

  return false;
}

function setupCarShell() {
  applyCarShell();
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => applyCarShell(), 150);
  });

  const handle = document.getElementById("btnCarSheetHandle");
  const planBtn = document.getElementById("btnCarSheetPlan");
  const itinBtn = document.getElementById("btnCarSheetItinerary");
  const locateBtn = document.getElementById("btnCarSheetLocate");
  const showSheetBtn = document.getElementById("btnCarShowSheet");
  const peekRoute = document.getElementById("btnCarTabRoute");
  const peekExplore = document.getElementById("btnCarTabExplore");
  if (handle) {
    // Tap/drag owned by setupCarSheetDrag (pointer events). Click is a fallback
    // for keyboard / non-pointer activation only.
    handle.addEventListener("click", (e) => {
      if (handle.dataset.pointerHandled === "1") {
        handle.dataset.pointerHandled = "0";
        e.preventDefault();
        return;
      }
      setCarChromeHidden(false);
      cycleCarSheet();
    });
    setupCarSheetDrag(handle);
  }
  if (planBtn) {
    planBtn.addEventListener("click", () => {
      setCarChromeHidden(false);
      switchTab("route-tab");
      syncCarPeekTabs("route-tab");
      setCarSheet("plan");
    });
  }
  if (itinBtn) {
    itinBtn.addEventListener("click", () => {
      setCarChromeHidden(false);
      switchTab("route-tab");
      syncCarPeekTabs("route-tab");
      setCarSheet("itinerary");
    });
  }
  if (locateBtn) {
    locateBtn.addEventListener("click", () => toggleLiveLocation());
  }
  if (showSheetBtn) {
    showSheetBtn.addEventListener("click", () => {
      setCarChromeHidden(false);
      setCarSheet("peek");
    });
  }
  if (peekRoute) {
    peekRoute.addEventListener("click", () => activateCarPeekTab("route-tab"));
  }
  if (peekExplore) {
    peekExplore.addEventListener("click", () => activateCarPeekTab("explore-tab"));
  }
}

/** Peek bar Route | Explore — expand sheet and show that panel. */
function activateCarPeekTab(tabId) {
  if (!state.carShell) return;
  setCarChromeHidden(false);
  switchTab(tabId);
  syncCarPeekTabs(tabId);
  if (tabId === "explore-tab") {
    scheduleLoadMapBoundsChargers(0);
  }
  if (state.sheetMode === "peek") {
    setCarSheet("plan");
  }
}

function syncCarPeekTabs(tabId) {
  const routeBtn = document.getElementById("btnCarTabRoute");
  const exploreBtn = document.getElementById("btnCarTabExplore");
  const isRoute = tabId === "route-tab";
  if (routeBtn) {
    routeBtn.classList.toggle("active", isRoute);
    routeBtn.setAttribute("aria-selected", isRoute ? "true" : "false");
  }
  if (exploreBtn) {
    exploreBtn.classList.toggle("active", !isRoute);
    exploreBtn.setAttribute("aria-selected", !isRoute ? "true" : "false");
  }
}

/** Hide/show bottom chrome after map tap. Leaflet click does not fire after a pan/drag. */
function setCarChromeHidden(hidden) {
  if (!state.carShell && hidden) return;
  state.carChromeHidden = !!hidden;
  document.body.classList.toggle("car-chrome-hidden", state.carChromeHidden);
  const fab = document.getElementById("btnCarShowSheet");
  if (fab) {
    if (state.carChromeHidden) fab.removeAttribute("hidden");
    else fab.setAttribute("hidden", "");
  }
  scheduleMapInvalidate(80);
}

window.setCarChromeHidden = setCarChromeHidden;

/**
 * Drag the sheet handle: swipe up expands (peek→half→full), down collapses.
 * Short press (tap) cycles the same way — don't rely on click alone (Tesla touch).
 * Intentional limit: max ~88vh so a map strip + Tesla browser chrome stay visible.
 */
function setupCarSheetDrag(handle) {
  let startY = 0;
  let tracking = false;
  const THRESH = 36;

  const onDown = (e) => {
    if (!state.carShell) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    tracking = true;
    startY = e.clientY;
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  };
  const onUp = (e) => {
    if (!tracking) return;
    tracking = false;
    handle.dataset.pointerHandled = "1";
    const dy = e.clientY - startY;
    if (dy < -THRESH) {
      if (state.sheetMode === "peek") setCarSheet("plan");
      else if (state.sheetMode === "plan") setCarSheet("itinerary");
    } else if (dy > THRESH) {
      if (state.sheetMode === "itinerary") setCarSheet("plan");
      else if (state.sheetMode === "plan") setCarSheet("peek");
    } else {
      // Tap → cycle peek → half → full → peek
      cycleCarSheet();
    }
  };

  handle.addEventListener("pointerdown", onDown);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", () => {
    tracking = false;
  });
}

function applyCarShell() {
  const enable = shouldUseCarShell();
  const was = state.carShell;
  state.carShell = enable;
  document.body.classList.toggle("car-shell", enable);
  const chrome = document.getElementById("carSheetChrome");
  if (chrome) {
    if (enable) chrome.removeAttribute("hidden");
    else chrome.setAttribute("hidden", "");
  }
  const badge = document.getElementById("carModeBadge");
  if (badge) {
    if (enable) {
      // Keep CAR MODE proof for Tesla G1 tests — no WxH clutter on the map.
      badge.hidden = false;
      badge.textContent = "CAR MODE";
    } else {
      badge.hidden = true;
    }
  }
  if (enable && was) {
    // Already in car-shell: do not re-enter setCarSheet / force-unhide chrome.
    // Spurious resize during pinch would invalidateSize and fight the gesture.
    if (!isMapUserGesturing()) scheduleMapInvalidate(160);
    return;
  }
  if (enable) {
    setCarSheet("peek");
    syncCarPeekTabs("route-tab");
  } else {
    state.carChromeHidden = false;
    document.body.classList.remove("car-chrome-hidden");
    document.body.removeAttribute("data-sheet");
    document.documentElement.removeAttribute("data-plan-stops");
    document.documentElement.removeAttribute("data-forced-count");
    const fab = document.getElementById("btnCarShowSheet");
    if (fab) fab.setAttribute("hidden", "");
  }
  syncCarTestHooks();
  requestAnimationFrame(() => {
    if (state.map && !isMapUserGesturing()) {
      state.map.invalidateSize({ animate: false });
    }
  });
}

function syncCarTestHooks() {
  const root = document.documentElement;
  const stops = state.activePlan && state.activePlan.summary
    ? state.activePlan.summary.supercharger_stops_count
    : null;
  if (stops != null) root.setAttribute("data-plan-stops", String(stops));
  else root.removeAttribute("data-plan-stops");
  root.setAttribute("data-forced-count", String(state.forcedChargers.size));
}

function setCarSheet(mode) {
  if (!state.carShell) return;
  setCarChromeHidden(false);
  const next = mode === "peek" || mode === "plan" || mode === "itinerary" ? mode : "peek";
  state.sheetMode = next;
  document.body.setAttribute("data-sheet", next);
  if (next === "itinerary") {
    switchTab("route-tab");
    syncCarPeekTabs("route-tab");
  }
  if (next === "itinerary" && state.activePlan) {
    const results = document.getElementById("routeResults");
    if (results && results.style.display !== "none") {
      setTimeout(() => {
        results.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 80);
    }
  }
  updateCarPeek();
  syncCarTestHooks();
  scheduleMapInvalidate(80);
}

/** Always peek → half(plan) → nearly-full(itinerary) → peek. */
function cycleCarSheet() {
  if (!state.carShell) return;
  if (state.sheetMode === "peek") setCarSheet("plan");
  else if (state.sheetMode === "plan") setCarSheet("itinerary");
  else setCarSheet("peek");
}

function updateCarPeek() {
  const summary = document.getElementById("carPeekSummary");
  const itinBtn = document.getElementById("btnCarSheetItinerary");
  const hint = document.getElementById("carSheetHint");
  const handle = document.getElementById("btnCarSheetHandle");
  if (summary) {
    if (state.activePlan && state.activePlan.summary) {
      const s = state.activePlan.summary;
      summary.textContent = `${s.supercharger_stops_count} stops · ${s.distance_miles} mi`;
    } else if (state.origin && state.destination) {
      summary.textContent = "Ready to plan";
    } else if (state.origin) {
      summary.textContent = "Set destination";
    } else {
      summary.textContent = "Tap map to hide";
    }
  }
  if (itinBtn) itinBtn.hidden = !(state.activePlan && state.activePlan.summary);
  if (hint) {
    if (state.sheetMode === "peek") hint.textContent = "Expand";
    else if (state.sheetMode === "plan") hint.textContent = "Full";
    else hint.textContent = "Collapse";
  }
  if (handle) {
    handle.setAttribute("aria-expanded", state.sheetMode === "peek" ? "false" : "true");
    const label =
      state.sheetMode === "peek"
        ? "Expand plan sheet"
        : state.sheetMode === "plan"
          ? "Expand sheet to full"
          : "Collapse plan sheet";
    handle.setAttribute("aria-label", label);
  }
}

let _toastTimer = null;
function showToast(message, ms = 4200) {
  const el = document.getElementById("appToast");
  if (!el) return;
  el.textContent = message;
  el.hidden = false;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function initMap() {
  // Center roughly on US/Continental view or default SF
  state.map = L.map("map", {
    center: [37.7749, -122.4194],
    zoom: 6,
    zoomControl: false,
  });

  L.control.zoom({ position: "topright" }).addTo(state.map);

  // Base layers: Streets (OSM) and Topographic (OpenTopoMap) — switched via Layers button
  const streetsLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  });

  const topoLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    attribution:
      'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, ' +
      '<a href="http://viewfinderpanoramas.org">SRTM</a> | Map style: &copy; ' +
      '<a href="https://opentopomap.org">OpenTopoMap</a> ' +
      '(<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)',
    maxZoom: 17,
    subdomains: ["a", "b", "c"],
  });

  streetsLayer.addTo(state.map);
  state.baseLayers = { streets: streetsLayer, topo: topoLayer };
  state.activeBasemap = "streets";

  state.routeLayer = L.featureGroup().addTo(state.map);
  state.corridorLayer = L.featureGroup().addTo(state.map);
  state.forcedMarkersLayer = L.featureGroup().addTo(state.map);
  state.markersLayer = L.featureGroup().addTo(state.map);
  // Blue-dot / accuracy sit above route markers; never cleared by updateMapMarkers.
  state.userLocationLayer = L.featureGroup().addTo(state.map);

  // User pan / pinch / scroll-zoom pauses auto-follow (watch continues; tap locate to resume).
  // zoomstart also covers two-finger pinch — dragstart alone does not.
  state.map.on("dragstart", () => pauseLiveFollowForUserGesture());
  state.map.on("zoomstart", () => pauseLiveFollowForUserGesture());

  // Desktop: mount optional overlays eagerly. Mobile: wait until Layers opens.
  if (!isMobileShell()) {
    mountOptionalOverlays();
  }
  if (window.ElevationModule) {
    window.ElevationModule.mount({ map: state.map });
  }

  setupLiveLocationLifecycle();

  // Map click: car shell → hide bottom chrome (Leaflet skips click after pan/drag).
  // When chrome already hidden, same tap sets origin/destination as before.
  state.map.on("click", (e) => {
    if (state.areaSelectMode) return;

    if (state.carShell && !state.carChromeHidden) {
      setCarChromeHidden(true);
      return;
    }

    if (!state.origin) {
      setOrigin({
        name: `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`,
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      });
    } else if (!state.destination) {
      setDestination({
        name: `${e.latlng.lat.toFixed(4)}, ${e.latlng.lng.toFixed(4)}`,
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      });
    }
  });

  // Re-query chargers when map moves in explore mode (debounced)
  state.map.on("moveend", () => {
    const exploreTab = document.getElementById("explore-tab");
    if (exploreTab && exploreTab.style.display !== "none") {
      scheduleLoadMapBoundsChargers();
    }
  });

  // Setup Map Area Selection Drawing Handlers
  setupMapAreaSelection();
}

/** Mount foliage + airspace once (lazy on mobile). */
function mountOptionalOverlays() {
  if (state.optionalOverlaysMounted) return;

  const foliageSlot = document.getElementById("foliageSlot");
  if (window.FoliageModule && foliageSlot) {
    window.FoliageModule.mount({ map: state.map, slotEl: foliageSlot });
  }

  const airspaceSlot = document.getElementById("airspaceSlot");
  if (window.AirspaceModule && airspaceSlot) {
    window.AirspaceModule.mount({ map: state.map, slotEl: airspaceSlot });
  }

  const weatherSlot = document.getElementById("weatherSlot");
  if (window.WeatherModule) {
    window.WeatherModule.mount({ map: state.map, slotEl: weatherSlot });
  }

  state.optionalOverlaysMounted = true;
}

window.mountOptionalOverlays = mountOptionalOverlays;

function setBasemap(name) {
  if (!state.baseLayers || !state.map) return;
  const next = name === "topo" ? "topo" : "streets";
  if (state.activeBasemap === next) return;

  const current = state.baseLayers[state.activeBasemap];
  const target = state.baseLayers[next];
  if (current) state.map.removeLayer(current);
  if (target) state.map.addLayer(target);
  state.activeBasemap = next;

  const mapEl = document.getElementById("map");
  if (mapEl) mapEl.classList.toggle("basemap-topo", next === "topo");

  document.querySelectorAll('input[name="basemapRadio"]').forEach((el) => {
    el.checked = el.value === next;
  });
}

function toggleLayersPanel(force) {
  const panel = document.getElementById("layersPanel");
  const btn = document.getElementById("btnToggleLayers");
  if (!panel) return;
  const open = typeof force === "boolean" ? force : !state.layersPanelOpen;
  state.layersPanelOpen = open;
  panel.style.display = open ? "block" : "none";
  panel.setAttribute("aria-hidden", open ? "false" : "true");
  if (btn) {
    btn.classList.toggle("is-active", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  }
  // Mobile: first open of Layers mounts heavy optional overlays
  if (open) mountOptionalOverlays();
}

function setupEventListeners() {
  // Tab switching
  document.getElementById("tabRoute").addEventListener("click", () => switchTab("route-tab"));
  document.getElementById("tabExplore").addEventListener("click", () => {
    switchTab("explore-tab");
    scheduleLoadMapBoundsChargers(0);
  });

  // Autocomplete for Origin
  setupAutocomplete("originInput", "originSuggestions", (place) => {
    setOrigin(place);
  });

  // Autocomplete for Destination
  setupAutocomplete("destInput", "destSuggestions", (place) => {
    setDestination(place);
  });

  // One-shot: set Origin from current GPS (sidebar form only).
  document.getElementById("btnUseCurrentLocation").addEventListener("click", () => {
    detectCurrentLocation();
  });
  // Continuous follow-me while driving (map + car peek) — same SPA path everywhere.
  document.getElementById("btnLocateMe").addEventListener("click", () => {
    if (state.areaSelectMode) {
      clearSelectionShape();
      deactivateAreaSelectMode();
    }
    toggleLiveLocation();
  });
  document.getElementById("btnLiveRecenter")?.addEventListener("click", () => {
    resumeLiveFollow();
  });
  document.getElementById("btnLiveReplanHere")?.addEventListener("click", () => {
    replanFromLiveLocation();
  });

  // Swap Locations
  document.getElementById("btnSwapLocations").addEventListener("click", () => {
    const temp = state.origin;
    state.origin = state.destination;
    state.destination = temp;

    const origInput = document.getElementById("originInput");
    const destInput = document.getElementById("destInput");
    origInput.value = state.origin ? state.origin.name : "";
    destInput.value = state.destination ? state.destination.name : "";

    updateMapMarkers();
    if (state.origin && state.destination) {
      planRoute();
    }
  });

  // Clear buttons — also drop stale itinerary so empty inputs never show an old plan
  setupClearBtn("clearOrigin", "originInput", () => {
    state.origin = null;
    clearActivePlan();
    updateMapMarkers();
  });
  setupClearBtn("clearDest", "destInput", () => {
    state.destination = null;
    clearActivePlan();
    updateMapMarkers();
  });

  document.getElementById("toggleNearbyStations")?.addEventListener("change", () => {
    updateMapLegendVisibility();
  });

  // Strategy Mode Toggles — always replan when origin/destination are set
  document.getElementById("btnModeMaximize").addEventListener("click", () => {
    setRoutingMode("MAXIMIZE");
  });
  document.getElementById("btnModeMinStops").addEventListener("click", () => {
    setRoutingMode("MIN_STOPS");
  });

  // Max stops / corridor / vehicle — replan on change when endpoints exist
  document.getElementById("maxStopsSelect").addEventListener("change", () => {
    maybeReplan();
  });
  document.getElementById("corridorBuffer").addEventListener("change", () => {
    maybeReplan();
  });
  document.getElementById("vehicleModel").addEventListener("change", () => {
    maybeReplan();
  });

  // Sliders: update label live; replan on commit (change) to avoid request storms
  const initBatterySlider = document.getElementById("initialBattery");
  initBatterySlider.addEventListener("input", (e) => {
    document.getElementById("initialBatteryVal").innerText = `${e.target.value}%`;
  });
  initBatterySlider.addEventListener("change", () => {
    maybeReplan();
  });

  const targetArrivalSlider = document.getElementById("targetArrival");
  targetArrivalSlider.addEventListener("input", (e) => {
    document.getElementById("targetArrivalVal").innerText = `${e.target.value}%`;
  });
  targetArrivalSlider.addEventListener("change", () => {
    maybeReplan();
  });

  // Area tools (top-right map toolbar): Box / Freehand start draw; Clear selection nearby
  document.getElementById("btnCancelAreaSelect").addEventListener("click", () => {
    // Banner Cancel: abort in-progress draw and restore pan/zoom (keep finished overlays / forced stops)
    clearSelectionShape();
    deactivateAreaSelectMode();
  });
  document.getElementById("btnClearSelection")?.addEventListener("click", clearSelection);
  document.getElementById("btnAreaModeBox")?.addEventListener("click", () => {
    selectAreaTool("box");
  });
  document.getElementById("btnAreaModeFreehand")?.addEventListener("click", () => {
    selectAreaTool("freehand");
  });
  updateClearSelectionButton();

  // Plan Route button
  document.getElementById("btnPlanRoute").addEventListener("click", () => {
    planRoute();
  });

  // Preset buttons
  document.querySelectorAll(".preset-tag").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (state.carShell) setCarSheet("plan");
      const origText = btn.dataset.orig;
      const destText = btn.dataset.dest;

      document.getElementById("originInput").value = origText;
      document.getElementById("destInput").value = destText;

      const origRes = await geocodeText(origText);
      const destRes = await geocodeText(destText);

      if (origRes) setOrigin(origRes);
      if (destRes) setDestination(destRes);
      updateCarPeek();

      if (origRes && destRes) {
        planRoute();
      }
    });
  });

  // Map Controls — leave area-draw mode first so the instruction banner never steals hits
  document.getElementById("btnMapReset").addEventListener("click", () => {
    if (state.areaSelectMode) {
      clearSelectionShape();
      deactivateAreaSelectMode();
    }
    if (state.routeLayer.getLayers().length > 0) {
      state.map.fitBounds(state.routeLayer.getBounds(), { padding: [50, 50] });
    } else if (state.markersLayer.getLayers().length > 0) {
      state.map.fitBounds(state.markersLayer.getBounds(), { padding: [50, 50] });
    } else {
      state.map.setView([37.7749, -122.4194], 6);
    }
  });

  document.getElementById("btnToggleLayers").addEventListener("click", () => {
    if (state.areaSelectMode) {
      clearSelectionShape();
      deactivateAreaSelectMode();
    }
    toggleLayersPanel();
  });

  document.querySelectorAll('input[name="basemapRadio"]').forEach((el) => {
    el.addEventListener("change", () => {
      if (el.checked) setBasemap(el.value);
    });
  });

  const nearbyToggle = document.getElementById("toggleNearbyStations");
  if (nearbyToggle) {
    nearbyToggle.checked = state.map.hasLayer(state.corridorLayer);
    nearbyToggle.addEventListener("change", () => {
      if (nearbyToggle.checked) {
        state.map.addLayer(state.corridorLayer);
      } else {
        state.map.removeLayer(state.corridorLayer);
      }
    });
  }

  document.addEventListener("click", (e) => {
    const panel = document.getElementById("layersPanel");
    const btn = document.getElementById("btnToggleLayers");
    if (!state.layersPanelOpen || !panel) return;
    if (panel.contains(e.target) || (btn && btn.contains(e.target))) return;
    toggleLayersPanel(false);
  });

  // Charger Drawer Close
  document.getElementById("btnCloseDrawer").addEventListener("click", () => {
    document.getElementById("chargerDrawer").style.display = "none";
  });

  // Add / Force-Include stop to route from drawer
  document.getElementById("btnAddStopToRoute").addEventListener("click", () => {
    if (!state.selectedCharger) return;
    toggleForcedCharger(state.selectedCharger);
    updateDrawerButton(state.selectedCharger);
    maybeReplan();
  });

  // Explore search & filters (shared debounced loader)
  const chargerSearchInput = document.getElementById("chargerSearchInput");
  chargerSearchInput.addEventListener("input", () => {
    scheduleLoadMapBoundsChargers(isMobileShell() ? 350 : 280);
  });

  document.getElementById("filterStatus").addEventListener("change", () => scheduleLoadMapBoundsChargers(0));
  document.getElementById("filterMinPower").addEventListener("change", () => scheduleLoadMapBoundsChargers(0));
  document.getElementById("filterMinStalls").addEventListener("change", () => scheduleLoadMapBoundsChargers(0));
  document.getElementById("btnFilterMapArea").addEventListener("click", () => scheduleLoadMapBoundsChargers(0));

  // Global ESC: abort in-progress draw (same as banner Cancel); use Clear selection to drop finished area
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.areaSelectMode) {
      clearSelectionShape();
      deactivateAreaSelectMode();
    }
  });
}

/** Replan when both endpoints are set (does not require an existing activePlan). */
function maybeReplan() {
  if (state.origin && state.destination) {
    planRoute();
  }
}

function setRoutingMode(mode) {
  const next = mode === "MIN_STOPS" ? "MIN_STOPS" : "MAXIMIZE";
  const changed = state.routingMode !== next;
  state.routingMode = next;
  document.getElementById("btnModeMaximize").classList.toggle("active", next === "MAXIMIZE");
  document.getElementById("btnModeMinStops").classList.toggle("active", next === "MIN_STOPS");
  document.getElementById("maximizeParams").style.display = next === "MAXIMIZE" ? "flex" : "none";

  // Always replan on mode change when endpoints exist (fixes missed refresh when
  // activePlan was null / stale, or handlers gated on activePlan incorrectly).
  if (changed) {
    maybeReplan();
  }
}

/** Ray-casting point-in-polygon (Leaflet LatLng ring). */
function pointInPolygon(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat;
    const xi = ring[i].lng;
    const yj = ring[j].lat;
    const xj = ring[j].lng;
    if (yi === yj) continue;
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function clearSelectionShape() {
  if (state.selectionShape) {
    state.map.removeLayer(state.selectionShape);
    state.selectionShape = null;
  }
  state.freehandPoints = [];
  state.dragStartLatLng = null;
  updateClearSelectionButton();
}

async function applyForcedChargersFromSelection(chargers, emptyMessage) {
  if (!chargers.length) {
    showToast(emptyMessage, 5200);
    clearSelectionShape();
  } else {
    // Replace prior area-select batch so Clear selection undoes this draw only
    state.areaForcedIds.forEach((id) => {
      state.forcedChargers.delete(id);
    });
    state.areaForcedIds.clear();
    chargers.forEach((c) => {
      state.forcedChargers.set(c.id, c);
      state.areaForcedIds.add(c.id);
    });
    updateForcedChargersUI();
    // Drop the draw overlay — forced markers are the lasting affordance
    clearSelectionShape();
  }
  deactivateAreaSelectMode();
  updateClearSelectionButton();
  if (chargers.length && state.origin && state.destination) {
    planRoute();
  }
}

async function finishBoxSelection(bounds) {
  const minLat = Math.min(bounds.getSouth(), bounds.getNorth());
  const maxLat = Math.max(bounds.getSouth(), bounds.getNorth());
  const minLng = Math.min(bounds.getWest(), bounds.getEast());
  const maxLng = Math.max(bounds.getWest(), bounds.getEast());

  if (Math.abs(maxLat - minLat) < 0.005 && Math.abs(maxLng - minLng) < 0.005) {
    clearSelectionShape();
    return;
  }

  try {
    const resp = await fetch(
      `/api/superchargers?min_lat=${minLat}&max_lat=${maxLat}&min_lng=${minLng}&max_lng=${maxLng}&status=OPEN&limit=500`
    );
    const data = await resp.json();
    await applyForcedChargersFromSelection(
      data.superchargers || [],
      "No open Superchargers found inside the selected rectangle. Try selecting a wider area."
    );
  } catch (err) {
    console.error("Box area selection query error:", err);
    deactivateAreaSelectMode();
  }
}

async function finishFreehandSelection(ring) {
  state.map.removeLayer(state.selectionShape);
  state.selectionShape = L.polygon(ring, {
    color: "#00b4d8",
    weight: 2,
    dashArray: "6, 6",
    fillColor: "#00b4d8",
    fillOpacity: 0.18,
  }).addTo(state.map);

  const bounds = state.selectionShape.getBounds();
  try {
    const resp = await fetch(
      `/api/superchargers?min_lat=${bounds.getSouth()}&max_lat=${bounds.getNorth()}` +
        `&min_lng=${bounds.getWest()}&max_lng=${bounds.getEast()}&status=OPEN&limit=500`
    );
    const data = await resp.json();
    const chargers = (data.superchargers || []).filter((c) =>
      pointInPolygon(c.lat, c.lng, ring)
    );
    await applyForcedChargersFromSelection(
      chargers,
      "No open Superchargers found inside the drawn outline. Try a larger freehand area."
    );
  } catch (err) {
    console.error("Freehand area selection query error:", err);
    deactivateAreaSelectMode();
  }
}

function _areaPointerLatLng(e) {
  if (e && e.latlng) return e.latlng;
  return null;
}

function beginAreaPointer(latlng, originalEvent) {
  if (!state.areaSelectMode || !latlng) return;
  if (originalEvent && originalEvent.button != null && originalEvent.button !== 0) return;

  // Prevent the page from scrolling while drawing on touch devices
  if (originalEvent && originalEvent.cancelable && originalEvent.pointerType === "touch") {
    originalEvent.preventDefault();
  }

  clearSelectionShape();
  state.dragStartLatLng = latlng;

  if (state.areaDrawMode === "freehand") {
    state.freehandPoints = [latlng];
    state.selectionShape = L.polyline(state.freehandPoints, {
      color: "#00b4d8",
      weight: 3,
      dashArray: "4, 6",
      opacity: 0.95,
    }).addTo(state.map);
  } else {
    state.selectionShape = L.rectangle([latlng, latlng], {
      color: "#00b4d8",
      weight: 2,
      dashArray: "6, 6",
      fillColor: "#00b4d8",
      fillOpacity: 0.18,
    }).addTo(state.map);
  }
  updateClearSelectionButton();
}

function moveAreaPointer(latlng) {
  if (!state.areaSelectMode || !state.dragStartLatLng || !state.selectionShape || !latlng) return;

  if (state.areaDrawMode === "freehand") {
    const last = state.freehandPoints[state.freehandPoints.length - 1];
    // Slightly looser threshold on mobile so touch samples still build a ring
    const thresh = isMobileShell() ? 0.0004 : 0.001;
    if (last && Math.abs(last.lat - latlng.lat) < thresh && Math.abs(last.lng - latlng.lng) < thresh) {
      return;
    }
    state.freehandPoints.push(latlng);
    state.selectionShape.setLatLngs(state.freehandPoints);
  } else {
    state.selectionShape.setBounds(L.latLngBounds(state.dragStartLatLng, latlng));
  }
}

async function endAreaPointer(latlng) {
  if (!state.areaSelectMode || !state.dragStartLatLng || !state.selectionShape) return;

  if (state.areaDrawMode === "freehand") {
    if (latlng) state.freehandPoints.push(latlng);
    // Mobile freehand often has fewer samples — allow a shorter ring
    const minPts = isMobileShell() ? 4 : 6;
    if (state.freehandPoints.length < minPts) {
      clearSelectionShape();
      return;
    }
    const ring = state.freehandPoints.slice();
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (first.lat !== last.lat || first.lng !== last.lng) {
      ring.push(L.latLng(first.lat, first.lng));
    }
    await finishFreehandSelection(ring);
  } else {
    await finishBoxSelection(state.selectionShape.getBounds());
  }
}

function _latLngFromTouchEvent(ev) {
  if (!state.map || !ev) return null;
  const t = (ev.touches && ev.touches[0]) || (ev.changedTouches && ev.changedTouches[0]);
  if (!t) return null;
  return state.map.mouseEventToLatLng(t);
}

// Box rectangle + freehand outline force-include (mouse + touch)
function setupMapAreaSelection() {
  state.map.on("mousedown", (e) => {
    beginAreaPointer(_areaPointerLatLng(e), e.originalEvent);
  });

  state.map.on("mousemove", (e) => {
    moveAreaPointer(_areaPointerLatLng(e));
  });

  state.map.on("mouseup", async (e) => {
    await endAreaPointer(_areaPointerLatLng(e));
  });

  // Touch on the map container (Leaflet does not emit map 'touch*' events)
  const container = state.map.getContainer();
  L.DomEvent.on(container, "touchstart", (ev) => {
    if (!state.areaSelectMode) return;
    beginAreaPointer(_latLngFromTouchEvent(ev), ev);
  });
  L.DomEvent.on(container, "touchmove", (ev) => {
    if (!state.areaSelectMode || !state.dragStartLatLng) return;
    if (ev.cancelable) ev.preventDefault();
    moveAreaPointer(_latLngFromTouchEvent(ev));
  });
  L.DomEvent.on(container, "touchend", async (ev) => {
    if (!state.areaSelectMode || !state.dragStartLatLng) return;
    await endAreaPointer(_latLngFromTouchEvent(ev));
  });
}

/**
 * Top-right area tool: set Box/Freehand mode and enter draw mode.
 * Clicking the already-active mode while drawing cancels draw (toggle off).
 */
function selectAreaTool(mode) {
  const next = mode === "freehand" ? "freehand" : "box";
  const sameMode = state.areaDrawMode === next;
  if (sameMode && state.areaSelectMode) {
    clearSelectionShape();
    deactivateAreaSelectMode();
    return;
  }
  setAreaDrawMode(next);
  if (!state.areaSelectMode) {
    activateAreaSelectMode();
  } else {
    updateAreaSelectActiveCopy();
  }
}

function setAreaDrawMode(mode) {
  state.areaDrawMode = mode === "freehand" ? "freehand" : "box";
  if (state.areaSelectMode) {
    updateAreaSelectActiveCopy();
  }
  updateAreaToolDrawingState();
}

/**
 * Area tool chrome: quiet at rest. Only the tool currently drawing gets
 * active/drawing — Box must not look "on" before the user taps it (m3).
 */
function updateAreaToolDrawingState() {
  const boxBtn = document.getElementById("btnAreaModeBox");
  const freeBtn = document.getElementById("btnAreaModeFreehand");
  const drawing = !!state.areaSelectMode;
  const boxOn = drawing && state.areaDrawMode === "box";
  const freeOn = drawing && state.areaDrawMode === "freehand";
  boxBtn?.classList.toggle("active", boxOn);
  freeBtn?.classList.toggle("active", freeOn);
  boxBtn?.classList.toggle("drawing", boxOn);
  freeBtn?.classList.toggle("drawing", freeOn);
  boxBtn?.setAttribute("aria-pressed", boxOn ? "true" : "false");
  freeBtn?.setAttribute("aria-pressed", freeOn ? "true" : "false");
}

function updateAreaSelectActiveCopy() {
  const isFreehand = state.areaDrawMode === "freehand";
  const banner = document.getElementById("mapModeBannerText");
  const bannerIcon = document.querySelector("#mapModeBanner .pulse-icon");
  const touchCopy = isMobileShell();
  if (banner) {
    if (isFreehand) {
      banner.textContent = touchCopy
        ? "Drag with one finger to outline Superchargers. Lift to force-include stations inside."
        : "Click and drag to freehand-draw an outline around Superchargers. Release to force-include stations inside.";
    } else {
      banner.textContent = touchCopy
        ? "Drag with one finger to draw a selection box around Superchargers."
        : "Click and drag on the map to draw a selection box around Superchargers.";
    }
  }
  if (bannerIcon) {
    bannerIcon.className = isFreehand
      ? "fa-solid fa-draw-polygon pulse-icon"
      : "fa-solid fa-vector-square pulse-icon";
  }
  updateAreaToolDrawingState();
}

function activateAreaSelectMode() {
  state.areaSelectMode = true;
  state.map.dragging.disable();
  // Full map while drawing on mobile; body class also drives Clear-btn visibility
  document.body.classList.add("area-drawing");
  if (isMobileShell()) {
    closeMobileSheet();
  }
  document.getElementById("map").style.cursor = "crosshair";
  document.getElementById("mapModeBanner").style.display = "flex";
  updateAreaSelectActiveCopy();
  updateClearSelectionButton();
}

function deactivateAreaSelectMode() {
  state.areaSelectMode = false;
  state.map.dragging.enable();
  state.dragStartLatLng = null;
  document.body.classList.remove("area-drawing");
  document.getElementById("map").style.cursor = "";
  document.getElementById("mapModeBanner").style.display = "none";
  updateAreaToolDrawingState();
  updateClearSelectionButton();
}

function toggleForcedCharger(charger) {
  if (state.forcedChargers.has(charger.id)) {
    state.forcedChargers.delete(charger.id);
    state.areaForcedIds.delete(charger.id);
  } else {
    // Individual pin / drawer include — not tied to area geometry
    state.forcedChargers.set(charger.id, charger);
    state.areaForcedIds.delete(charger.id);
  }
  updateForcedChargersUI();
  syncCarTestHooks();
}

/**
 * Clear selection: cancel in-progress box/freehand draw, remove selection overlay,
 * drop chargers added by the last area select, restore map pan/zoom.
 * Individually force-included stops (drawer / station click) are kept.
 */
function clearSelection() {
  const hadAreaForced = state.areaForcedIds.size > 0;
  clearSelectionShape();
  state.areaForcedIds.forEach((id) => {
    state.forcedChargers.delete(id);
  });
  state.areaForcedIds.clear();
  deactivateAreaSelectMode();
  syncCarTestHooks();
  updateForcedChargersUI();
  if (hadAreaForced) {
    maybeReplan();
  }
}

function updateClearSelectionButton() {
  const btn = document.getElementById("btnClearSelection");
  if (!btn) return;
  const hasWork =
    state.areaSelectMode ||
    !!state.selectionShape ||
    state.areaForcedIds.size > 0;
  btn.disabled = !hasWork;
  btn.setAttribute("aria-disabled", hasWork ? "false" : "true");
  btn.title = hasWork
    ? "Clear drawn area and chargers added by area select; restore map pan/zoom"
    : "No active area selection to clear";
}

function updateMapLegendVisibility() {
  const forcedEl = document.querySelector("#mapLegend .legend-forced");
  const corridorEl = document.querySelector("#mapLegend .legend-corridor");
  if (forcedEl) {
    forcedEl.hidden = state.forcedChargers.size === 0;
  }
  if (corridorEl) {
    const nearbyOn = document.getElementById("toggleNearbyStations")?.checked !== false;
    corridorEl.hidden = !nearbyOn;
  }
}

/**
 * Drop stale itinerary when endpoints are cleared (M6) or before a live replan.
 * @param {{ keepMapGeometry?: boolean, snapshotForRestore?: boolean }} [opts]
 *   keepMapGeometry — leave route/corridor polylines on the map until the next
 *   successful renderRoutePlan (live GPS replan: no blank → fitBounds flicker).
 *   snapshotForRestore — stash prior plan so a failed replan can restore it.
 */
function clearActivePlan(opts = {}) {
  const keepMapGeometry = !!opts.keepMapGeometry;
  if (opts.snapshotForRestore && state.activePlan) {
    state.planRestoreSnapshot = state.activePlan;
  } else if (!opts.snapshotForRestore) {
    state.planRestoreSnapshot = null;
  }
  state.activePlan = null;
  if (!keepMapGeometry) {
    if (state.routeLayer) state.routeLayer.clearLayers();
    if (state.corridorLayer) state.corridorLayer.clearLayers();
  }
  const results = document.getElementById("routeResults");
  if (results) results.style.display = "none";
  const itinBtn = document.getElementById("btnCarSheetItinerary");
  if (itinBtn) itinBtn.hidden = true;
  updateCarPeek();
  syncCarTestHooks();
  updateMapLegendVisibility();
  try {
    if (window.WeatherModule && typeof window.WeatherModule.analyzeRoutePlan === "function") {
      window.WeatherModule.analyzeRoutePlan(null);
    }
  } catch (_) {
    /* optional module */
  }
}

/** Restore itinerary after a failed replan that cleared the active plan. */
function restorePlanSnapshotIfNeeded() {
  if (state.activePlan || !state.planRestoreSnapshot) return false;
  state.activePlan = state.planRestoreSnapshot;
  state.planRestoreSnapshot = null;
  try {
    renderRoutePlan(state.activePlan);
  } catch (_) {
    /* map may not be ready */
  }
  return true;
}

window.restorePlanSnapshotIfNeeded = restorePlanSnapshotIfNeeded;

/** True when live follow owns the camera — skip fitBounds that fight panTo GPS. */
function shouldSkipFitBoundsForLiveFollow() {
  const live = state.liveLocation;
  return !!(live && live.watching && live.follow);
}

window.shouldSkipFitBoundsForLiveFollow = shouldSkipFitBoundsForLiveFollow;

function updateForcedChargersUI() {
  updateClearSelectionButton();
  updateMapLegendVisibility();

  // Cyan map markers for force-included stops (sidebar chips removed)
  state.forcedMarkersLayer.clearLayers();
  state.forcedChargers.forEach((c) => {
    const forcedMarker = L.circleMarker([c.lat, c.lng], {
      radius: 9,
      fillColor: "#00b4d8",
      color: "#ffffff",
      weight: 2.5,
      opacity: 1.0,
      fillOpacity: 0.9,
    });
    forcedMarker.bindTooltip(`⭐ <b>FORCE-INCLUDED:</b> ${escapeHtml(c.name)}<br>${escapeHtml(c.power || 250)} kW • ${escapeHtml(c.stalls || 8)} stalls`, {
      direction: "top",
      offset: [0, -8],
    });
    forcedMarker.on("click", () => showChargerDrawer(c));
    state.forcedMarkersLayer.addLayer(forcedMarker);
  });
}

function switchTab(tabId) {
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
  document.querySelectorAll(".tab-content").forEach((c) => {
    c.classList.remove("active");
    c.style.display = "none";
  });

  if (tabId === "route-tab") {
    document.getElementById("tabRoute").classList.add("active");
    document.getElementById("route-tab").classList.add("active");
    document.getElementById("route-tab").style.display = "flex";
  } else {
    document.getElementById("tabExplore").classList.add("active");
    document.getElementById("explore-tab").classList.add("active");
    document.getElementById("explore-tab").style.display = "flex";
  }
}

function setupClearBtn(btnId, inputId, onClear) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  input.addEventListener("input", () => {
    btn.style.display = input.value ? "block" : "none";
  });
  btn.addEventListener("click", () => {
    input.value = "";
    btn.style.display = "none";
    onClear();
  });
}

function applyOriginFromGeolocation(place) {
  setOrigin(place);
  markLivePlannedOrigin(place.lat, place.lng, "one_shot");
  if (state.map) {
    state.map.setView([place.lat, place.lng], 12);
  }
  // On mobile, open the planner so the user can set a destination next
  if (isMobileShell()) openMobileSheet();
  if (state.activePlan) clearActivePlan();
  if (state.destination) {
    planRoute();
  }
  return place;
}

window.applyOriginFromGeolocation = applyOriginFromGeolocation;

/** Geolocation requires a secure context (HTTPS or localhost). */
function isSecureGeoContext() {
  if (typeof window.isSecureContext === "boolean") return window.isSecureContext;
  const host = (location.hostname || "").toLowerCase();
  return location.protocol === "https:" || host === "localhost" || host === "127.0.0.1";
}

/**
 * watchPosition options tuned for driving: GPS preferred, short cache, patient timeout
 * (Tesla Chromium often needs more than 1s; Autopylot uses ~1s which is aggressive).
 */
function liveLocationWatchOptions() {
  return {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 1500,
  };
}

/** One-shot getCurrentPosition options (origin form). */
function oneShotLocationOptions(mobileShell) {
  return {
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: mobileShell ? 60_000 : 0,
  };
}

/** Human-readable geolocation errors for toast / a11y. */
function formatLiveLocationError(err) {
  if (!err) return "Location unavailable.";
  const code = err.code;
  if (code === 1 || /denied/i.test(String(err.message || ""))) {
    return "Location denied — allow location for this site, then tap locate again.";
  }
  if (code === 2) return "Location unavailable — GPS signal weak. Try again outdoors.";
  if (code === 3) return "Location timed out — tap locate to retry.";
  if (code === 0 || /unsupported/i.test(String(err.message || ""))) {
    return "Location unsupported in this browser.";
  }
  return "Location unavailable — use a preset or type an address.";
}

/**
 * Pure client-side Haversine distance in miles between two coordinates.
 * Used for live distance-to-next-Supercharger HUD & off-corridor check (zero server calls).
 */
function haversineDistanceMiles(lat1, lng1, lat2, lng2) {
  if (
    !Number.isFinite(lat1) ||
    !Number.isFinite(lng1) ||
    !Number.isFinite(lat2) ||
    !Number.isFinite(lng2)
  ) {
    return null;
  }
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R_MILES = 3958.7613;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
  return R_MILES * c;
}

/** Convert compass heading in degrees (0-360) to 8-wind cardinal label. */
function headingToCardinal(headingDeg) {
  if (!Number.isFinite(headingDeg) || headingDeg < 0) return null;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const normalized = ((headingDeg % 360) + 360) % 360;
  return dirs[Math.round(normalized / 45) % 8];
}

/** Format GPS speed (m/s) + heading (deg) into a compact HUD label. */
function formatLiveTelemetryLabel(speedMps, headingDeg) {
  const parts = [];
  if (Number.isFinite(speedMps) && speedMps >= 0) {
    const mph = Math.round(speedMps * 2.236936);
    parts.push(`${mph} mph`);
  }
  const card = headingToCardinal(headingDeg);
  if (card) {
    parts.push(`${card} ${Math.round(((headingDeg % 360) + 360) % 360)}°`);
  }
  return parts.length > 0 ? parts.join(" · ") : "LIVE GPS";
}

/**
 * Find the nearest planned Supercharger stop (or destination fallback) and distance in miles.
 * Pure function over (lat, lng, plan) for easy unit testing.
 */
function computeNextPlannedStopTelemetry(lat, lng, plan) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !plan || !Array.isArray(plan.stops)) {
    return null;
  }
  let best = null;
  for (const stop of plan.stops) {
    if (!stop || (stop.type !== "SUPERCHARGER" && stop.type !== "DESTINATION")) continue;
    const d = haversineDistanceMiles(lat, lng, Number(stop.lat), Number(stop.lng));
    if (d == null) continue;
    if (stop.type === "SUPERCHARGER") {
      if (!best || best.type !== "SUPERCHARGER" || d < best.distanceMiles) {
        best = {
          name: stop.name || `Stop #${stop.stop_index || ""}`,
          stopIndex: stop.stop_index || null,
          type: "SUPERCHARGER",
          distanceMiles: Math.round(d * 10) / 10,
          lat: Number(stop.lat),
          lng: Number(stop.lng),
        };
      }
    } else if (!best) {
      best = {
        name: stop.name || "Destination",
        stopIndex: null,
        type: "DESTINATION",
        distanceMiles: Math.round(d * 10) / 10,
        lat: Number(stop.lat),
        lng: Number(stop.lng),
      };
    }
  }
  return best;
}

/**
 * Check if the vehicle is significantly off the planned route corridor (> thresholdMiles from any
 * corridor polyline point or stop). Used for the manual "Replan from here" pill (default 25 mi)
 * and for smarter auto-replan at a tighter threshold.
 */
function isOffRouteCorridor(lat, lng, plan, thresholdMiles = 25) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !plan) return false;
  let minMiles = Infinity;
  const geom = plan.geometry;
  const coords =
    geom && geom.type === "LineString" && Array.isArray(geom.coordinates)
      ? geom.coordinates
      : geom &&
          geom.type === "Feature" &&
          geom.geometry &&
          Array.isArray(geom.geometry.coordinates)
        ? geom.geometry.coordinates
        : null;
  if (coords && coords.length > 0) {
    const step = Math.max(1, Math.floor(coords.length / 80));
    for (let i = 0; i < coords.length; i += step) {
      const pt = coords[i];
      if (Array.isArray(pt) && pt.length >= 2) {
        const d = haversineDistanceMiles(lat, lng, Number(pt[1]), Number(pt[0]));
        if (d != null && d < minMiles) minMiles = d;
      }
    }
  } else if (Array.isArray(plan.stops)) {
    for (const s of plan.stops) {
      const d = haversineDistanceMiles(lat, lng, Number(s.lat), Number(s.lng));
      if (d != null && d < minMiles) minMiles = d;
    }
  }
  return Number.isFinite(minMiles) && minMiles > thresholdMiles;
}

/**
 * Smart live-follow replan thresholds.
 * Marker updates every accepted fix; route origin/replan only when these fire.
 * Tuned for highway EV trips: avoid spinner thrash without stranding a coastal origin
 * while LIVE GPS is hundreds of miles inland.
 */
function liveFollowReplanDefaults() {
  return {
    /** Miles from last planned origin before auto-replan (~4 min @ 70 mph). */
    minOriginDriftMiles: 5,
    /** Within this radius of a planned Supercharger → treat as passed → replan. */
    passStopRadiusMiles: 0.6,
    /** Auto-replan off-corridor sooner than the 25 mi manual pill. */
    offCorridorAutoMiles: 12,
    /** Hard floor between auto-replans (ms). */
    cooldownMs: 45_000,
    /** Ignore fuzzy fixes for replan decisions (marker still updates). */
    maxAccuracyM: 100,
    /** Reject single-tick teleports unless the gap since last fix is long. */
    maxJumpMiles: 5,
    /** After this gap, a large jump is treated as recovery, not a spike. */
    jumpGraceMs: 30_000,
  };
}

/**
 * Whether a new GPS sample is trustworthy enough to drive origin/replan logic.
 * Always returns true for the first fix. Spikes and awful accuracy are rejected.
 */
function shouldAcceptLiveFixForReplan(ctx) {
  const opts = { ...liveFollowReplanDefaults(), ...(ctx && ctx.opts) };
  const {
    firstFix,
    prevLat,
    prevLng,
    prevAt,
    lat,
    lng,
    accuracy,
    now,
  } = ctx || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (firstFix) return true;
  if (Number.isFinite(accuracy) && accuracy > opts.maxAccuracyM) return false;
  if (
    Number.isFinite(prevLat) &&
    Number.isFinite(prevLng) &&
    Number.isFinite(prevAt) &&
    Number.isFinite(now)
  ) {
    const jump = haversineDistanceMiles(prevLat, prevLng, lat, lng);
    const dt = now - prevAt;
    if (jump != null && jump > opts.maxJumpMiles && dt >= 0 && dt < opts.jumpGraceMs) {
      return false;
    }
  }
  return true;
}

/** Stable id for a planned Supercharger stop (session-local). */
function plannedStopKey(stop) {
  if (!stop) return null;
  if (stop.id != null && stop.id !== "") return String(stop.id);
  if (stop.stop_index != null) return `idx:${stop.stop_index}`;
  if (Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
    return `ll:${Number(stop.lat).toFixed(4)},${Number(stop.lng).toFixed(4)}`;
  }
  return null;
}

/**
 * Nearest not-yet-passed SUPERCHARGER within radiusMiles, or null.
 */
function findNewlyPassedStop(lat, lng, plan, passedIds, radiusMiles) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !plan || !Array.isArray(plan.stops)) {
    return null;
  }
  const radius = Number.isFinite(radiusMiles) ? radiusMiles : liveFollowReplanDefaults().passStopRadiusMiles;
  const seen = passedIds instanceof Set ? passedIds : new Set();
  let best = null;
  for (const stop of plan.stops) {
    if (!stop || stop.type !== "SUPERCHARGER") continue;
    const key = plannedStopKey(stop);
    if (!key || seen.has(key)) continue;
    const d = haversineDistanceMiles(lat, lng, Number(stop.lat), Number(stop.lng));
    if (d == null || d > radius) continue;
    if (
      !best ||
      (Number(stop.stop_index) || 0) < (Number(best.stop_index) || 0) ||
      (stop.stop_index === best.stop_index && d < best.distanceMiles)
    ) {
      best = {
        key,
        name: stop.name || `Stop #${stop.stop_index || ""}`,
        stop_index: stop.stop_index,
        distanceMiles: d,
      };
    }
  }
  return best;
}

/**
 * Decide whether live GPS should commit origin + replan.
 * Returns { replan: boolean, reason: string|null }.
 * firstFix always commits origin; replan when a destination exists.
 */
function shouldAutoReplanLiveMove(ctx) {
  const opts = { ...liveFollowReplanDefaults(), ...(ctx && ctx.opts) };
  const {
    firstFix,
    lat,
    lng,
    plannedOriginLat,
    plannedOriginLng,
    lastAutoReplanAt,
    now,
    plan,
    hasDestination,
    planInFlight,
    accuracy,
    passedStop,
  } = ctx || {};

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { replan: false, reason: null };
  }

  if (firstFix) {
    return {
      replan: !!hasDestination,
      reason: hasDestination ? "first_fix" : "first_fix_origin_only",
    };
  }

  if (!hasDestination) return { replan: false, reason: null };
  if (planInFlight) return { replan: false, reason: null };
  if (Number.isFinite(accuracy) && accuracy > opts.maxAccuracyM) {
    return { replan: false, reason: null };
  }

  const since = Number.isFinite(lastAutoReplanAt) ? now - lastAutoReplanAt : Infinity;
  if (Number.isFinite(since) && since < opts.cooldownMs) {
    return { replan: false, reason: null };
  }

  if (passedStop) return { replan: true, reason: "passed_stop" };

  if (Number.isFinite(plannedOriginLat) && Number.isFinite(plannedOriginLng)) {
    const drift = haversineDistanceMiles(plannedOriginLat, plannedOriginLng, lat, lng);
    if (drift != null && drift >= opts.minOriginDriftMiles) {
      return { replan: true, reason: "origin_drift" };
    }
  }

  if (plan && isOffRouteCorridor(lat, lng, plan, opts.offCorridorAutoMiles)) {
    return { replan: true, reason: "off_corridor" };
  }

  return { replan: false, reason: null };
}

window.isSecureGeoContext = isSecureGeoContext;
window.liveLocationWatchOptions = liveLocationWatchOptions;
window.oneShotLocationOptions = oneShotLocationOptions;
window.formatLiveLocationError = formatLiveLocationError;
window.haversineDistanceMiles = haversineDistanceMiles;
window.headingToCardinal = headingToCardinal;
window.formatLiveTelemetryLabel = formatLiveTelemetryLabel;
window.computeNextPlannedStopTelemetry = computeNextPlannedStopTelemetry;
window.isOffRouteCorridor = isOffRouteCorridor;
window.liveFollowReplanDefaults = liveFollowReplanDefaults;
window.shouldAcceptLiveFixForReplan = shouldAcceptLiveFixForReplan;
window.plannedStopKey = plannedStopKey;
window.findNewlyPassedStop = findNewlyPassedStop;
window.shouldAutoReplanLiveMove = shouldAutoReplanLiveMove;

function setLocateBusy(busy) {
  const mapBtn = document.getElementById("btnLocateMe");
  const carBtn = document.getElementById("btnCarSheetLocate");
  const formBtn = document.getElementById("btnUseCurrentLocation");
  [mapBtn, carBtn].forEach((el) => {
    if (!el) return;
    el.classList.toggle("is-locating", !!busy);
    el.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) {
      if (!el.dataset.prevHtml) el.dataset.prevHtml = el.innerHTML;
      el.innerHTML = '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>';
    } else if (el.dataset.prevHtml && !state.liveLocation.watching) {
      el.innerHTML = el.dataset.prevHtml;
      delete el.dataset.prevHtml;
    }
  });
  if (formBtn) {
    formBtn.innerHTML = busy
      ? '<i class="fa-solid fa-spinner fa-spin"></i> Locating...'
      : '<i class="fa-solid fa-location-crosshairs"></i> Use Current Location';
  }
}

function syncLiveLocationUi() {
  const live = state.liveLocation;
  const mapBtn = document.getElementById("btnLocateMe");
  const carBtn = document.getElementById("btnCarSheetLocate");
  const following = !!(live.watching && live.follow);
  const paused = !!(live.watching && !live.follow);
  const awaitingFix = !!(live.watching && live.lat == null);
  const title = !live.watching
    ? "Follow my location while driving"
    : awaitingFix
      ? "Acquiring GPS…"
      : following
        ? "Stop following location"
        : "Resume follow";
  const icon = awaitingFix
    ? '<i class="fa-solid fa-spinner fa-spin" aria-hidden="true"></i>'
    : following
      ? '<i class="fa-solid fa-location-crosshairs" aria-hidden="true"></i>'
      : paused
        ? '<i class="fa-solid fa-location-arrow" aria-hidden="true"></i>'
        : '<i class="fa-solid fa-crosshairs" aria-hidden="true"></i>';
  [mapBtn, carBtn].forEach((el) => {
    if (!el) return;
    el.classList.toggle("is-active", following && !awaitingFix);
    el.classList.toggle("is-live-follow", following && !awaitingFix);
    el.classList.toggle("is-live-paused", paused);
    el.classList.toggle("is-locating", awaitingFix);
    el.setAttribute("aria-pressed", following ? "true" : "false");
    el.setAttribute("aria-busy", awaitingFix ? "true" : "false");
    el.title = title;
    el.setAttribute("aria-label", title);
    el.innerHTML = icon;
    delete el.dataset.prevHtml;
  });

  // Update floating Live Driving HUD (speed/heading, next stop distance, Re-center & off-corridor Replan pills)
  const hud = document.getElementById("liveDriveHud");
  const speedEl = document.getElementById("liveHudSpeed");
  const sepEl = document.getElementById("liveHudSep");
  const nextEl = document.getElementById("liveHudNextStop");
  const recenterBtn = document.getElementById("btnLiveRecenter");
  const replanBtn = document.getElementById("btnLiveReplanHere");
  if (!hud) return;

  if (!live.watching) {
    hud.hidden = true;
    document.body.classList.remove("live-hud-visible");
    return;
  }

  hud.hidden = false;
  document.body.classList.add("live-hud-visible");
  if (speedEl) {
    speedEl.textContent = awaitingFix
      ? "Acquiring GPS…"
      : formatLiveTelemetryLabel(live.speedMps, live.heading);
  }

  const nextInfo =
    !awaitingFix && live.lat != null && live.lng != null
      ? computeNextPlannedStopTelemetry(live.lat, live.lng, state.activePlan)
      : null;
  live.nextStop = nextInfo;

  if (nextEl && sepEl) {
    if (nextInfo) {
      const prefix = nextInfo.stopIndex ? `Stop #${nextInfo.stopIndex}` : "Next";
      nextEl.textContent = `${prefix} ${nextInfo.name}: ${nextInfo.distanceMiles} mi`;
      nextEl.hidden = false;
      sepEl.hidden = false;
    } else {
      nextEl.textContent = "";
      nextEl.hidden = true;
      sepEl.hidden = true;
    }
  }

  if (recenterBtn) {
    recenterBtn.hidden = !(paused && !awaitingFix);
  }

  const offCorridor =
    !awaitingFix &&
    live.lat != null &&
    live.lng != null &&
    isOffRouteCorridor(live.lat, live.lng, state.activePlan, 25);
  live.offCorridor = offCorridor;
  if (replanBtn) {
    replanBtn.hidden = !offCorridor;
  }
}

function buildUserLocationIcon(headingDeg) {
  const rotate =
    headingDeg != null ? ` style="transform:rotate(${headingDeg}deg)"` : "";
  return L.divIcon({
    className: "user-location-icon",
    html:
      `<div class="user-location-pulse" aria-hidden="true"></div>` +
      `<div class="user-location-dot"${rotate}>` +
      (headingDeg != null
        ? '<span class="user-location-heading" aria-hidden="true"></span>'
        : "") +
      `</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

/**
 * Update the blue-dot + accuracy ring in place (no clearLayers every GPS tick).
 * Pure client-side; coords never leave the browser for this feature.
 */
function updateUserLocationMarker(lat, lng, accuracyM, heading) {
  if (!state.userLocationLayer || !state.map) return;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

  const acc = Number.isFinite(accuracyM) && accuracyM > 0 ? Math.min(accuracyM, 500) : null;
  const headingDeg = Number.isFinite(heading) ? heading : null;
  const ll = L.latLng(lat, lng);

  if (acc != null) {
    if (state.userAccuracyCircle) {
      state.userAccuracyCircle.setLatLng(ll);
      state.userAccuracyCircle.setRadius(acc);
    } else {
      state.userAccuracyCircle = L.circle(ll, {
        radius: acc,
        className: "user-location-accuracy",
        color: "#38bdf8",
        weight: 1,
        opacity: 0.55,
        fillColor: "#38bdf8",
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(state.userLocationLayer);
    }
  } else if (state.userAccuracyCircle) {
    state.userLocationLayer.removeLayer(state.userAccuracyCircle);
    state.userAccuracyCircle = null;
  }

  if (state.userLocationMarker) {
    state.userLocationMarker.setLatLng(ll);
    // Heading / cone presence can change — cheap setIcon keeps pulse DOM stable otherwise.
    const prevHeading = state.userLocationMarker._liveHeading;
    const hadCone = Number.isFinite(prevHeading);
    const wantCone = headingDeg != null;
    if (hadCone !== wantCone || (wantCone && prevHeading !== headingDeg)) {
      state.userLocationMarker.setIcon(buildUserLocationIcon(headingDeg));
      state.userLocationMarker._liveHeading = headingDeg;
    }
  } else {
    const marker = L.marker(ll, {
      icon: buildUserLocationIcon(headingDeg),
      zIndexOffset: 1200,
      interactive: false,
      keyboard: false,
    });
    marker._liveHeading = headingDeg;
    marker.addTo(state.userLocationLayer);
    state.userLocationMarker = marker;
  }
}

function clearUserLocationMarker() {
  if (state.userLocationLayer) state.userLocationLayer.clearLayers();
  state.userLocationMarker = null;
  state.userAccuracyCircle = null;
}

function panMapToLiveLocation(lat, lng, { initial } = {}) {
  if (!state.map || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  // Never fight an in-progress pinch / drag / scroll-zoom.
  if (isMapUserGesturing()) return;
  const zoom = state.map.getZoom();
  const targetZoom = initial && zoom < 13 ? Math.max(zoom, 14) : zoom;
  state.livePanInProgress = true;
  try {
    if (initial || targetZoom !== zoom) {
      state.map.setView([lat, lng], targetZoom, { animate: true });
    } else {
      state.map.panTo([lat, lng], { animate: true, duration: 0.35 });
    }
  } finally {
    // Keep flag through Leaflet zoom/pan animation so zoomstart does not pause follow.
    window.setTimeout(() => {
      state.livePanInProgress = false;
    }, 450);
  }
}

async function requestLiveWakeLock() {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== "function") return null;
  try {
    const lock = await nav.wakeLock.request("screen");
    state.liveLocation.wakeLock = lock;
    lock.addEventListener("release", () => {
      if (state.liveLocation.wakeLock === lock) state.liveLocation.wakeLock = null;
    });
    return lock;
  } catch (err) {
    // Tesla / older Chromium often lack Wake Lock — degrade silently.
    console.info("Wake Lock unavailable:", err && err.message ? err.message : err);
    state.liveLocation.wakeLock = null;
    return null;
  }
}

async function releaseLiveWakeLock() {
  const lock = state.liveLocation.wakeLock;
  state.liveLocation.wakeLock = null;
  if (!lock) return;
  try {
    await lock.release();
  } catch (_) {
    /* ignore */
  }
}

function setupLiveLocationLifecycle() {
  if (setupLiveLocationLifecycle._bound) return;
  setupLiveLocationLifecycle._bound = true;

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.liveLocation.watching) {
      // Re-acquire wake lock after tab/app returns (Wake Lock auto-releases on hide).
      requestLiveWakeLock();
    }
  });

  window.addEventListener("pagehide", () => {
    // Keep watch if the browser allows background GPS; still drop wake lock.
    releaseLiveWakeLock();
  });
}

/**
 * Record the origin that the current itinerary (or seed) is planned from.
 * Clears passed-stop memory — a new origin/plan starts a fresh pass cycle.
 */
function markLivePlannedOrigin(lat, lng, reason) {
  const live = state.liveLocation;
  live.plannedOriginLat = lat;
  live.plannedOriginLng = lng;
  live.lastAutoReplanAt = Date.now();
  live.lastReplanReason = reason || null;
  live.passedStopIds = new Set();
}

/**
 * Commit GPS as trip origin; replan when destination exists.
 * Always overwrites a pre-set typed/geocoded/preset origin (no stale coastal start).
 * Soft-clears the itinerary identity but keeps prior polyline until the new plan
 * paints — avoids blank→fitBounds→panTo flicker while live-following.
 * Preserves destination, strategy, max stops, forced chargers (via planRoute).
 */
function commitGpsAsTripOrigin(lat, lng, { name, reason, toast } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  const live = state.liveLocation;
  live.forceOriginOnNextFix = false;
  setOrigin({
    name: name || "Current Location",
    lat,
    lng,
    source: "geolocation",
  });
  markLivePlannedOrigin(lat, lng, reason || "gps");
  if (typeof updateCarPeek === "function") updateCarPeek();

  const willReplan = !!state.destination;
  if (state.activePlan) {
    // Drop coastal itinerary identity; keep map geometry while replan is in flight.
    // Snapshot so a failed plan can restore the prior itinerary (no empty UI).
    clearActivePlan({ keepMapGeometry: willReplan, snapshotForRestore: willReplan });
  }
  if (willReplan) {
    planRoute();
  }
  if (toast) showToast(toast, 2400);
  return willReplan;
}

/**
 * User tapped Locate / resume follow: GPS must become trip origin.
 * If a fix is already available, commit immediately; otherwise arm the next fix.
 */
function armLocateOriginCommit(reason) {
  const live = state.liveLocation;
  live.forceOriginOnNextFix = true;
  if (Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
    const hasDest = !!state.destination;
    commitGpsAsTripOrigin(live.lat, live.lng, {
      name: "Current Location",
      reason: reason || "locate",
      toast: hasDest
        ? "Updating route from your location…"
        : "Starting point set to your location.",
    });
    return true;
  }
  return false;
}

window.armLocateOriginCommit = armLocateOriginCommit;

window.markLivePlannedOrigin = markLivePlannedOrigin;
window.commitGpsAsTripOrigin = commitGpsAsTripOrigin;

function onLivePositionSuccess(pos) {
  if (!state.liveLocation.watching) return;
  if (!pos || !pos.coords) return;
  const { latitude, longitude, accuracy, heading, speed } = pos.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  const live = state.liveLocation;
  const now = Date.now();
  const firstFix = live.lat == null;
  const prevLat = live.lat;
  const prevLng = live.lng;
  const prevAt = live.lastFixAt || 0;
  const acc = Number.isFinite(accuracy) ? accuracy : null;

  // Blue-dot always tracks the latest raw fix (nav-app feel).
  live.lat = latitude;
  live.lng = longitude;
  live.accuracy = acc;
  live.heading = Number.isFinite(heading) ? heading : null;
  live.speedMps = Number.isFinite(speed) && speed >= 0 ? speed : null;
  live.lastFixAt = now;

  updateUserLocationMarker(latitude, longitude, live.accuracy, live.heading);

  if (live.follow) {
    panMapToLiveLocation(latitude, longitude, { initial: firstFix });
  }

  // Locate arm / first fix always accepted for origin commit (ignore spike/accuracy gates).
  const forceOrigin = !!(live.forceOriginOnNextFix || firstFix);
  const acceptForReplan =
    forceOrigin ||
    shouldAcceptLiveFixForReplan({
      firstFix,
      prevLat,
      prevLng,
      prevAt,
      lat: latitude,
      lng: longitude,
      accuracy: acc,
      now,
    });

  if (acceptForReplan) {
    if (!live.passedStopIds) live.passedStopIds = new Set();
    const passedStop = findNewlyPassedStop(
      latitude,
      longitude,
      state.activePlan,
      live.passedStopIds,
      liveFollowReplanDefaults().passStopRadiusMiles
    );

    const decision = shouldAutoReplanLiveMove({
      firstFix: forceOrigin ? true : firstFix,
      lat: latitude,
      lng: longitude,
      plannedOriginLat: live.plannedOriginLat,
      plannedOriginLng: live.plannedOriginLng,
      lastAutoReplanAt: live.lastAutoReplanAt,
      now,
      plan: state.activePlan,
      hasDestination: !!state.destination,
      planInFlight: !!state.planInFlight && !forceOrigin,
      accuracy: forceOrigin ? null : acc,
      passedStop: forceOrigin ? null : passedStop,
    });

    if (forceOrigin || decision.replan) {
      // Only mark passed after we commit — if planInFlight blocked us, retry next tick.
      if (passedStop && decision.replan && !forceOrigin) {
        live.passedStopIds.add(passedStop.key);
      }
      const reason = forceOrigin
        ? firstFix
          ? "first_fix"
          : "locate_override"
        : decision.reason || "auto";
      let toastMsg = null;
      if (forceOrigin && state.destination) {
        toastMsg = "Updating route from your location…";
      } else if (forceOrigin) {
        toastMsg = "Starting point set to your location.";
      } else if (decision.reason === "passed_stop") {
        toastMsg = "Passed a stop — updating route…";
      } else if (decision.reason === "off_corridor") {
        toastMsg = "Off corridor — updating route…";
      } else if (decision.replan) {
        toastMsg = "Updating route from your location…";
      }
      // Always overwrites a pre-set typed/geocoded/preset origin.
      commitGpsAsTripOrigin(latitude, longitude, {
        name: forceOrigin ? "Current Location" : "Current Location (Live)",
        reason,
        toast: toastMsg,
      });
    }
  }

  setLocateBusy(false);
  syncLiveLocationUi();
}

function onLivePositionError(err) {
  // Transient timeout / position-unavailable: keep watching; only hard-stop on deny/unsupported.
  const code = err && err.code;
  // Permission denied is expected UX — toast only; skip noisy console in prod.
  if (code !== 1) {
    console.warn("Live geolocation error:", err);
  }
  if (code === 1) {
    stopLiveLocation({ silent: true });
    showToast(formatLiveLocationError(err));
    return;
  }
  if (!state.liveLocation.lat) {
    // Never got a fix — surface the error but leave follow armed for retry taps.
    setLocateBusy(false);
    syncLiveLocationUi();
    showToast(formatLiveLocationError(err), 3600);
  }
}

function startLiveLocation() {
  if (state.liveLocation.watching) {
    state.liveLocation.follow = true;
    syncLiveLocationUi();
    if (Number.isFinite(state.liveLocation.lat) && Number.isFinite(state.liveLocation.lng)) {
      panMapToLiveLocation(state.liveLocation.lat, state.liveLocation.lng, { initial: false });
    }
    // Already watching: still force GPS → trip origin (typed start must not win).
    armLocateOriginCommit("locate_resume");
    return;
  }

  if (!isSecureGeoContext()) {
    showToast("Location needs HTTPS (or localhost). Open this app over a secure link.");
    return;
  }
  if (!navigator.geolocation || typeof navigator.geolocation.watchPosition !== "function") {
    showToast(formatLiveLocationError({ code: 0, message: "unsupported" }));
    return;
  }

  state.liveLocation.watching = true;
  state.liveLocation.follow = true;
  state.liveLocation.startedAt = Date.now();
  state.liveLocation.lat = null;
  state.liveLocation.lng = null;
  state.liveLocation.plannedOriginLat = null;
  state.liveLocation.plannedOriginLng = null;
  state.liveLocation.lastAutoReplanAt = 0;
  state.liveLocation.lastFixAt = 0;
  state.liveLocation.passedStopIds = new Set();
  state.liveLocation.lastReplanReason = null;
  // Next fix must overwrite any pre-set origin (order: type start → Locate Me).
  state.liveLocation.forceOriginOnNextFix = true;
  setLocateBusy(true);
  syncLiveLocationUi();
  showToast("Following your location…", 2200);
  requestLiveWakeLock();

  try {
    state.liveLocation.watchId = navigator.geolocation.watchPosition(
      onLivePositionSuccess,
      onLivePositionError,
      liveLocationWatchOptions()
    );
  } catch (err) {
    console.warn("watchPosition threw:", err);
    stopLiveLocation({ silent: true });
    showToast(formatLiveLocationError(err));
  }
}

function stopLiveLocation({ silent } = {}) {
  const id = state.liveLocation.watchId;
  if (id != null && navigator.geolocation && typeof navigator.geolocation.clearWatch === "function") {
    try {
      navigator.geolocation.clearWatch(id);
    } catch (_) {
      /* ignore */
    }
  }
  state.liveLocation.watchId = null;
  state.liveLocation.watching = false;
  state.liveLocation.follow = false;
  state.liveLocation.lat = null;
  state.liveLocation.lng = null;
  state.liveLocation.accuracy = null;
  state.liveLocation.heading = null;
  state.liveLocation.speedMps = null;
  state.liveLocation.nextStop = null;
  state.liveLocation.offCorridor = false;
  state.liveLocation.startedAt = 0;
  state.liveLocation.plannedOriginLat = null;
  state.liveLocation.plannedOriginLng = null;
  state.liveLocation.lastAutoReplanAt = 0;
  state.liveLocation.lastFixAt = 0;
  state.liveLocation.passedStopIds = null;
  state.liveLocation.lastReplanReason = null;
  state.liveLocation.forceOriginOnNextFix = false;
  clearUserLocationMarker();
  releaseLiveWakeLock();
  setLocateBusy(false);
  syncLiveLocationUi();
  if (!silent) showToast("Stopped following location.", 2000);
}

/**
 * Map / car locate control: start follow → (drag pauses) → tap resumes → tap stops.
 * Start and resume always make GPS the trip origin (even if origin was typed first).
 * Shared implementation for phone browsers and Tesla in-car browser.
 */
function toggleLiveLocation() {
  const live = state.liveLocation;
  if (!live.watching) {
    startLiveLocation();
    return;
  }
  if (!live.follow) {
    live.follow = true;
    syncLiveLocationUi();
    if (Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
      panMapToLiveLocation(live.lat, live.lng, { initial: false });
    }
    armLocateOriginCommit("locate_resume");
    return;
  }
  stopLiveLocation();
}

function resumeLiveFollow() {
  const live = state.liveLocation;
  if (!live.watching) {
    startLiveLocation();
    return;
  }
  live.follow = true;
  syncLiveLocationUi();
  if (Number.isFinite(live.lat) && Number.isFinite(live.lng)) {
    panMapToLiveLocation(live.lat, live.lng, { initial: false });
  }
  armLocateOriginCommit("locate_resume");
}

/**
 * Explicit "Replan from here" (off-corridor pill). Always commits live GPS as origin.
 * Auto-replan while driving uses shouldAutoReplanLiveMove — this bypasses cooldown.
 */
function replanFromLiveLocation() {
  const live = state.liveLocation;
  if (!Number.isFinite(live.lat) || !Number.isFinite(live.lng)) return;
  live.follow = true;
  syncLiveLocationUi();
  commitGpsAsTripOrigin(live.lat, live.lng, {
    name: "Current Location (Live)",
    reason: "manual",
    toast: state.destination ? "Replanning from your location…" : "Starting point set to your location.",
  });
}

window.toggleLiveLocation = toggleLiveLocation;
window.startLiveLocation = startLiveLocation;
window.stopLiveLocation = stopLiveLocation;
window.syncLiveLocationUi = syncLiveLocationUi;
window.resumeLiveFollow = resumeLiveFollow;
window.replanFromLiveLocation = replanFromLiveLocation;

/** One-shot GPS → Origin (sidebar "Use Current Location"). Does not start follow-me. */
function detectCurrentLocation() {
  if (!isSecureGeoContext()) {
    showToast("Location needs HTTPS (or localhost). Open this app over a secure link.");
    return;
  }
  if (!navigator.geolocation) {
    showToast("Location unavailable. Use a preset or type a starting address.");
    return;
  }

  setLocateBusy(true);

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      setLocateBusy(false);
      syncLiveLocationUi();
      if (isMobileShell()) {
        const place = resolveGeolocationPlace(pos, null);
        if (place) applyOriginFromGeolocation(place);
        else showToast("Location unavailable. Use a preset or type a starting address.");
        return;
      }
      const coords = {
        name: "Current Location",
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        source: "geolocation",
      };
      setOrigin(coords);
      markLivePlannedOrigin(coords.lat, coords.lng, "one_shot");
      if (state.map) state.map.setView([coords.lat, coords.lng], 12);
      // Also show a static blue-dot for this one-shot (no watch).
      updateUserLocationMarker(coords.lat, coords.lng, pos.coords.accuracy, pos.coords.heading);
      if (typeof updateCarPeek === "function") updateCarPeek();
      if (state.activePlan) {
        clearActivePlan({
          keepMapGeometry: !!state.destination,
          snapshotForRestore: !!state.destination,
        });
      }
      if (state.destination) {
        showToast("Updating route from your location…", 2800);
        planRoute();
      } else {
        showToast("Location set — pick a destination or preset.", 2800);
      }
    },
    (err) => {
      setLocateBusy(false);
      syncLiveLocationUi();
      // Permission denied is expected — toast only; never silently seed SF as origin.
      if (err && err.code !== 1) {
        console.warn("Geolocation denied or error:", err);
      }
      showToast(formatLiveLocationError(err));
    },
    oneShotLocationOptions(isMobileShell())
  );
}

function setOrigin(place) {
  state.origin = place;
  const input = document.getElementById("originInput");
  input.value = place.name;
  document.getElementById("clearOrigin").style.display = "block";
  updateMapMarkers();
}

function setDestination(place) {
  state.destination = place;
  const input = document.getElementById("destInput");
  input.value = place.name;
  document.getElementById("clearDest").style.display = "block";
  updateMapMarkers();
  // Both ends set on mobile → keep sheet open so Plan Route is one tap away
  if (isMobileShell() && state.origin) openMobileSheet();
}

function setupAutocomplete(inputId, suggestionsId, onSelect) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(suggestionsId);
  let timer = null;
  let geocodeSeq = 0;
  const isOrigin = inputId === "originInput";

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    // Typing away from a selected place invalidates coords so Plan cannot
    // silently use stale geocoded/map-click state that no longer matches the field.
    const selected = isOrigin ? state.origin : state.destination;
    if (selected && selected.name && query !== String(selected.name).trim()) {
      if (isOrigin) {
        state.origin = null;
        state.planRestoreSnapshot = null;
        if (state.activePlan) clearActivePlan();
      } else {
        state.destination = null;
        state.planRestoreSnapshot = null;
        if (state.activePlan) clearActivePlan();
      }
      updateMapMarkers();
      const clearBtn = document.getElementById(isOrigin ? "clearOrigin" : "clearDest");
      if (clearBtn && !query) clearBtn.style.display = "none";
    }
    if (query.length < 3) {
      list.style.display = "none";
      return;
    }

    timer = setTimeout(async () => {
      const seq = ++geocodeSeq;
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        if (seq !== geocodeSeq) return; // stale response
        list.innerHTML = "";

        if (data.results && data.results.length > 0) {
          data.results.forEach((item) => {
            const el = document.createElement("div");
            el.className = "suggestion-item";
            el.innerHTML = `<i class="fa-solid fa-location-dot"></i><span>${escapeHtml(item.name)}</span>`;
            el.addEventListener("click", () => {
              input.value = item.name;
              list.style.display = "none";
              onSelect(item);
            });
            list.appendChild(el);
          });
          list.style.display = "block";
        } else {
          list.style.display = "none";
        }
      } catch (err) {
        if (seq !== geocodeSeq) return;
        console.error("Geocode error", err);
      }
    }, 300);
  });

  // Hide suggestions when clicking outside
  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !list.contains(e.target)) {
      list.style.display = "none";
    }
  });
}

async function geocodeText(text) {
  try {
    const res = await fetch(`/api/geocode?q=${encodeURIComponent(text)}`);
    const data = await res.json();
    if (data.results && data.results.length > 0) {
      return data.results[0];
    }
  } catch (err) {
    console.error(err);
  }
  return null;
}

function updateMapMarkers() {
  state.markersLayer.clearLayers();

  if (state.origin) {
    const origIcon = L.divIcon({
      className: "custom-div-icon",
      html: `<div style="background:#10b981; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 3px 10px rgba(0,0,0,0.5);"><i class="fa-solid fa-play" style="font-size:11px; margin-left:2px;"></i></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = L.marker([state.origin.lat, state.origin.lng], { icon: origIcon })
      .bindPopup(`<b>Starting Location</b><br>${escapeHtml(state.origin.name)}`);
    state.markersLayer.addLayer(marker);
  }

  if (state.destination) {
    const destIcon = L.divIcon({
      className: "custom-div-icon",
      html: `<div style="background:#e82127; width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; color:#fff; border:2px solid #fff; box-shadow:0 3px 10px rgba(0,0,0,0.5);"><i class="fa-solid fa-flag-checkered" style="font-size:12px;"></i></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    const marker = L.marker([state.destination.lat, state.destination.lng], { icon: destIcon })
      .bindPopup(`<b>Destination</b><br>${escapeHtml(state.destination.name)}`);
    state.markersLayer.addLayer(marker);
  }

  if (
    state.origin &&
    state.destination &&
    !state.activePlan &&
    !shouldSkipFitBoundsForLiveFollow()
  ) {
    const bounds = L.latLngBounds([
      [state.origin.lat, state.origin.lng],
      [state.destination.lat, state.destination.lng],
    ]);
    state.map.fitBounds(bounds, { padding: [60, 60] });
  }
}

async function planRoute() {
  if (!state.origin || !state.destination) {
    showToast("Add both a starting location and a destination (or pick a popular route).");
    return;
  }

  const seq = ++state.planRouteSeq;
  state.planInFlight = true;
  const btn = document.getElementById("btnPlanRoute");
  const origBtnText = btn.innerHTML;
  const busyLabel =
    state.routingMode === "MIN_STOPS"
      ? '<i class="fa-solid fa-spinner fa-spin"></i> Minimizing stops...'
      : '<i class="fa-solid fa-spinner fa-spin"></i> Maximizing Superchargers...';
  btn.innerHTML = busyLabel;
  btn.disabled = true;

  const rawMaxStops = parseInt(document.getElementById("maxStopsSelect").value, 10);
  const maxStops = Number.isFinite(rawMaxStops)
    ? Math.max(1, Math.min(50, rawMaxStops))
    : 15;

  const payload = {
    origin: [state.origin.lat, state.origin.lng],
    destination: [state.destination.lat, state.destination.lng],
    routing_mode: state.routingMode,
    forced_chargers: Array.from(state.forcedChargers.values()),
    max_stops: maxStops,
    initial_battery: parseFloat(document.getElementById("initialBattery").value),
    target_arrival: parseFloat(document.getElementById("targetArrival").value),
    max_range_km: parseFloat(document.getElementById("vehicleModel").value),
    corridor_buffer_km: parseFloat(document.getElementById("corridorBuffer").value),
  };

  try {
    const resp = await fetch("/api/plan-route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const plan = await resp.json();
    // Discard stale responses from overlapping strategy/param changes
    if (seq !== state.planRouteSeq) {
      return;
    }
    if (plan.error) {
      showToast(`Routing error: ${plan.error}`, 5600);
      restorePlanSnapshotIfNeeded();
      return;
    }

    state.planRestoreSnapshot = null;
    state.activePlan = plan;
    if (window.WeatherModule && !state.optionalOverlaysMounted) {
      mountOptionalOverlays();
    }
    renderRoutePlan(plan);
    syncCarTestHooks();
    // Phone: show route on the map. Car: collapse sheet to peek.
    if (isMobileShell()) {
      closeMobileSheet();
    } else if (state.carShell) {
      updateCarPeek();
      setCarSheet("peek");
    }
  } catch (err) {
    if (seq !== state.planRouteSeq) return;
    console.error("Routing error:", err);
    showToast("Failed to compute route. Check network connection.", 5600);
    restorePlanSnapshotIfNeeded();
  } finally {
    if (seq === state.planRouteSeq) {
      state.planInFlight = false;
      btn.innerHTML = origBtnText;
      btn.disabled = false;
    }
  }
}

function renderRoutePlan(plan) {
  // 1. Update stats
  document.getElementById("routeResults").style.display = "flex";
  document.getElementById("statDistance").innerText = `${plan.summary.distance_miles} mi`;
  document.getElementById("statTotalTime").innerText = plan.summary.total_trip_duration_formatted;
  document.getElementById("statStops").innerText = `${plan.summary.supercharger_stops_count}`;
  document.getElementById("statChargeTime").innerText = `${plan.summary.charge_duration_minutes} min`;
  updateCarPeek();
  
  let forcedNotice = "";
  if (plan.summary.forced_stops_count > 0) {
    forcedNotice = ` (${plan.summary.forced_stops_count} from forced area/selection)`;
  }
  const stopCount = plan.summary.supercharger_stops_count;
  const stopLabel = stopCount === 1 ? "Supercharger" : "Superchargers";
  document.getElementById("corridorCountText").innerText =
    `Visited ${stopCount} ${stopLabel}${forcedNotice} • ${plan.summary.chargers_along_corridor_count} stations along corridor`;
  updateMapLegendVisibility();

  // 2. Render Map Geometry
  state.routeLayer.clearLayers();
  state.corridorLayer.clearLayers();

  if (plan.geometry) {
    const geojsonLayer = L.geoJSON(plan.geometry, {
      style: {
        color: "#e82127",
        weight: 5,
        opacity: 0.85,
        lineCap: "round",
        lineJoin: "round",
      },
    });
    state.routeLayer.addLayer(geojsonLayer);
    // Live follow owns the camera (panTo GPS) — fitBounds full corridor fights it.
    if (!shouldSkipFitBoundsForLiveFollow()) {
      state.map.fitBounds(geojsonLayer.getBounds(), { padding: [50, 50] });
    }
  }

  // 3. Render Corridor Chargers (Yellow dots) — capped/subsampled on mobile
  if (plan.all_corridor_chargers) {
    const capped = subsampleMarkers(plan.all_corridor_chargers, corridorMarkerCap());
    capped.forEach((c) => {
      const circle = L.circleMarker([c.lat, c.lng], {
        radius: 5,
        fillColor: "#ffaa00",
        color: "#ffffff",
        weight: 1.5,
        opacity: 0.9,
        fillOpacity: 0.8,
      });

      circle.bindTooltip(`<b>${escapeHtml(c.name)}</b><br>${escapeHtml(c.power)} kW • ${escapeHtml(c.stalls)} stalls<br>Detour: ${escapeHtml(c.detour_miles)} mi`, {
        direction: "top",
        offset: [0, -5],
      });

      circle.on("click", () => showChargerDrawer(c));
      state.corridorLayer.addLayer(circle);
    });
  }

  // 4. Render Selected Supercharger Stops on Map
  const stops = plan.stops || [];
  stops.forEach((stop) => {
    if (stop.type === "SUPERCHARGER") {
      const isForced = stop.forced;
      const markerColor = isForced ? "#00b4d8" : "#e82127";
      const iconClass = isForced ? "fa-solid fa-star" : "fa-solid fa-bolt";

      const stopIcon = L.divIcon({
        className: "custom-div-icon",
        html: `<div style="background:#ffffff; border:3px solid ${markerColor}; color:${markerColor}; width:34px; height:34px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(0,0,0,0.5); font-weight:800; font-size:11px;">
                 <i class="${iconClass}" style="font-size:11px;"></i>
                 <span style="font-size:9px; margin-top:-2px;">#${escapeHtml(stop.stop_index)}</span>
               </div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const marker = L.marker([stop.lat, stop.lng], { icon: stopIcon, zIndexOffset: isForced ? 600 : 500 });
      marker.bindPopup(`
        <div style="min-width:180px;">
          <h4 style="margin:0 0 4px 0; color:${markerColor};">${isForced ? '⭐ [FORCED] ' : ''}Stop #${escapeHtml(stop.stop_index)}: ${escapeHtml(stop.name)}</h4>
          <p style="margin:2px 0; font-size:12px;"><b>Power:</b> ${escapeHtml(stop.power)} kW (${escapeHtml(stop.stalls)} stalls)</p>
          <p style="margin:2px 0; font-size:12px;"><b>Arrive:</b> ${escapeHtml(stop.arrival_battery_pct)}% &rarr; <b>Leave:</b> ${escapeHtml(stop.departure_battery_pct)}%</p>
          <p style="margin:2px 0; font-size:12px; color:#10b981;"><b>Charge time:</b> ${escapeHtml(stop.charge_duration_min)} min</p>
        </div>
      `);
      marker.on("click", () => showChargerDrawer(stop));
      state.routeLayer.addLayer(marker);
    }
  });

  // 5. Render Timeline Itinerary
  renderTimeline(stops);
  syncLiveLocationUi();

  // 6. Notify optional modules (e.g. Elevation & Grade Profile Strip)
  window.dispatchEvent(new CustomEvent("routePlanned", { detail: { plan } }));
}

function renderTimeline(stops) {
  const container = document.getElementById("stopsTimeline");
  container.innerHTML = "";

  stops.forEach((s) => {
    const item = document.createElement("div");

    if (s.type === "ORIGIN") {
      item.className = "timeline-item origin";
      item.innerHTML = `
        <div class="timeline-marker"><i class="fa-solid fa-play"></i></div>
        <div class="timeline-content">
          <div class="item-top">
            <span class="item-name">${escapeHtml(state.origin.name)}</span>
            <span class="item-badge" style="background:rgba(16,185,129,0.15); color:var(--accent-green);"><i class="fa-solid fa-battery-full"></i> ${s.battery_pct}%</span>
          </div>
          <div class="item-details">
            <span>Trip origin</span>
          </div>
        </div>
      `;
      item.querySelector(".timeline-content").addEventListener("click", () => {
        state.map.setView([s.lat, s.lng], 14);
      });
    } else if (s.type === "DESTINATION") {
      item.className = "timeline-item dest";
      const targetArrival = parseFloat(
        document.getElementById("targetArrival")?.value || "15"
      );
      const tone = destinationBatteryTone(s.battery_pct, targetArrival);
      const toneClass =
        tone === "ok"
          ? "battery-ok"
          : tone === "warn"
            ? "battery-warn"
            : "battery-danger";
      const toneIcon =
        tone === "ok"
          ? "fa-battery-full"
          : tone === "warn"
            ? "fa-battery-half"
            : "fa-battery-quarter";
      item.innerHTML = `
        <div class="timeline-marker"><i class="fa-solid fa-flag-checkered"></i></div>
        <div class="timeline-content">
          <div class="item-top">
            <span class="item-name">${escapeHtml(state.destination.name)}</span>
            <span class="item-badge ${toneClass}" title="Arrival reserve target ${escapeHtml(targetArrival)}%"><i class="fa-solid ${toneIcon}"></i> ~${escapeHtml(s.battery_pct)}%</span>
          </div>
          <div class="item-details">
            <span>Trip destination</span>
          </div>
        </div>
      `;
      item.querySelector(".timeline-content").addEventListener("click", () => {
        state.map.setView([s.lat, s.lng], 14);
      });
    } else if (s.type === "SUPERCHARGER") {
      const isForced = s.forced;
      item.className = `timeline-item supercharger ${isForced ? 'forced' : ''}`;
      item.innerHTML = `
        <div class="timeline-marker">${isForced ? '<i class="fa-solid fa-star"></i>' : escapeHtml(s.stop_index)}</div>
        <div class="timeline-content">
          <div class="item-top">
            <span class="item-name">${escapeHtml(s.name)}</span>
            <span class="item-badge ${isForced ? 'badge-forced' : 'badge-charge'}">
              ${isForced ? '⭐ FORCED STOP' : `<i class="fa-solid fa-bolt"></i> +${escapeHtml(s.charge_duration_min)} min`}
            </span>
          </div>
          <div class="item-details">
            <span class="battery-tag"><i class="fa-solid fa-battery-quarter" style="color:var(--accent-orange)"></i> ${escapeHtml(s.arrival_battery_pct)}% &rarr; ${escapeHtml(s.departure_battery_pct)}%</span>
            <span>${escapeHtml(s.power)} kW</span>
            <span>${escapeHtml(s.stalls)} stalls</span>
            <span>${escapeHtml(s.detour_miles)} mi detour</span>
          </div>
        </div>
      `;
      item.querySelector(".timeline-content").addEventListener("click", () => {
        state.map.setView([s.lat, s.lng], 15);
        showChargerDrawer(s);
      });
    }

    container.appendChild(item);
  });
}

function showChargerDrawer(c) {
  state.selectedCharger = c;
  const drawer = document.getElementById("chargerDrawer");

  document.getElementById("drawerStatusBadge").innerText = c.status || "OPEN";
  document.getElementById("drawerTitle").innerText = c.name;
  
  const addressParts = [c.street, c.city, c.state, c.zip, c.country].filter(Boolean);
  document.getElementById("drawerAddress").innerText = addressParts.join(", ") || "Address available on map";

  document.getElementById("drawerPower").innerText = c.power ? `${c.power} kW` : "150 kW";
  document.getElementById("drawerStalls").innerText = c.stalls || "--";

  // Plugs
  let plugsText = "NACS";
  if (c.plugTypes) {
    const list = [];
    if (c.plugTypes.nacs) list.push(`NACS (${c.plugTypes.nacs})`);
    if (c.plugTypes.ccs) list.push(`CCS (${c.plugTypes.ccs})`);
    if (list.length) plugsText = list.join(", ");
  }
  document.getElementById("drawerPlugs").innerText = plugsText;
  document.getElementById("drawerOtherEVs").innerText = c.otherEVs ? "Supported" : "Tesla Only";

  // Amenities
  const amenitiesContainer = document.getElementById("drawerAmenities");
  amenitiesContainer.innerHTML = "";
  if (c.facility) {
    amenitiesContainer.innerHTML += `<span class="chip"><i class="fa-solid fa-store"></i> ${escapeHtml(c.facility)}</span>`;
  }
  if (c.solar) {
    amenitiesContainer.innerHTML += `<span class="chip green"><i class="fa-solid fa-solar-panel"></i> Solar Canopy</span>`;
  }
  if (c.battery) {
    amenitiesContainer.innerHTML += `<span class="chip green"><i class="fa-solid fa-car-battery"></i> Megapack Backup</span>`;
  }
  if (c.otherEVs) {
    amenitiesContainer.innerHTML += `<span class="chip red"><i class="fa-solid fa-bolt"></i> Open to Non-Tesla</span>`;
  }

  // Update button text and state
  updateDrawerButton(c);

  // Google Maps link
  const gmapsBtn = document.getElementById("btnOpenGoogleMaps");
  gmapsBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`;

  drawer.style.display = "flex";
}

function updateDrawerButton(c) {
  const btn = document.getElementById("btnAddStopToRoute");
  const isForced = state.forcedChargers.has(c.id);
  if (isForced) {
    btn.innerHTML = `<i class="fa-solid fa-check"></i> Force-Included (Click to Remove)`;
    btn.style.background = "#00b4d8";
  } else {
    btn.innerHTML = `<i class="fa-solid fa-star"></i> Force-Include in Route`;
    btn.style.background = "";
  }
}

async function loadStats() {
  try {
    const res = await fetch("/api/stats");
    const data = await res.json();
    if (data.total_superchargers) {
      document.getElementById("totalChargersBadge").innerText = data.total_superchargers.toLocaleString();
    }
  } catch (e) {
    console.error("Failed to load stats", e);
  }
}

async function loadNearbyChargers() {
  try {
    const res = await fetch("/api/superchargers?lat=37.7749&lng=-122.4194&radius_km=30&limit=30");
    const data = await res.json();
    renderExploreList(data.superchargers || []);
  } catch (e) {
    console.error(e);
  }
}

/** Debounce explore bounds fetches (pan/zoom spam). delayMs=0 runs ASAP. */
function scheduleLoadMapBoundsChargers(delayMs) {
  const delay =
    delayMs != null
      ? delayMs
      : isMobileShell()
        ? 280
        : 150;
  if (state.exploreDebounceTimer) clearTimeout(state.exploreDebounceTimer);
  state.exploreDebounceTimer = setTimeout(() => {
    state.exploreDebounceTimer = null;
    loadMapBoundsChargers();
  }, delay);
}

window.scheduleLoadMapBoundsChargers = scheduleLoadMapBoundsChargers;

async function loadMapBoundsChargers() {
  if (!state.map) return;
  const seq = ++state.exploreFetchSeq;
  const bounds = state.map.getBounds();
  const status = document.getElementById("filterStatus").value;
  const minPower = document.getElementById("filterMinPower").value;
  const minStalls = document.getElementById("filterMinStalls").value;
  const text = document.getElementById("chargerSearchInput").value.trim();

  let url =
    `/api/superchargers?min_lat=${bounds.getSouth()}&max_lat=${bounds.getNorth()}` +
    `&min_lng=${bounds.getWest()}&max_lng=${bounds.getEast()}` +
    `&status=${status}&min_power=${minPower}&min_stalls=${minStalls}&limit=${exploreFetchLimit()}`;
  if (text) {
    url += `&q=${encodeURIComponent(text)}`;
  }

  try {
    const res = await fetch(url);
    const data = await res.json();
    // Drop stale responses from overlapping pans
    if (seq !== state.exploreFetchSeq) return;
    renderExploreList(data.superchargers || []);
  } catch (e) {
    if (seq !== state.exploreFetchSeq) return;
    console.error("Failed to query map chargers", e);
  }
}

function renderExploreList(chargers) {
  const container = document.getElementById("exploreChargerList");
  container.innerHTML = "";
  document.getElementById("chargerListCount").innerText = `Found ${chargers.length} Superchargers in area`;

  if (chargers.length === 0) {
    container.innerHTML = `<div style="text-align:center; padding:30px; color:var(--text-dim);">No Superchargers match the filters in this area. Zoom out or pan map.</div>`;
    return;
  }

  chargers.forEach((c) => {
    const isForced = state.forcedChargers.has(c.id);
    const card = document.createElement("div");
    card.className = "charger-list-item";
    card.innerHTML = `
      <div class="charger-list-title">
        <span>${isForced ? '⭐ ' : ''}${escapeHtml(c.name)}</span>
        <span class="chip ${c.status === 'OPEN' ? 'green' : 'red'}">${escapeHtml(c.status)}</span>
      </div>
      <div class="charger-list-sub">
        ${escapeHtml([c.street, c.city, c.state].filter(Boolean).join(", "))}
      </div>
      <div class="charger-list-tags">
        <span class="chip red"><i class="fa-solid fa-bolt"></i> ${escapeHtml(c.power || 150)} kW</span>
        <span class="chip"><i class="fa-solid fa-charging-station"></i> ${escapeHtml(c.stalls || 8)} stalls</span>
        ${c.otherEVs ? '<span class="chip green">All EVs</span>' : ''}
        ${isForced ? '<span class="chip" style="background:#00b4d8; color:#fff;">Force-Included</span>' : ''}
        ${c.distance_km !== undefined ? `<span class="chip">${c.distance_km} km away</span>` : ''}
      </div>
    `;

    card.addEventListener("click", () => {
      state.map.setView([c.lat, c.lng], 15);
      showChargerDrawer(c);
    });

    container.appendChild(card);
  });
}

/**
 * Tesla Supercharger Route Planner - Client Application
 * Includes Visit Maximizer routing, map area drag-selection for force-included chargers,
 * Streets / Topographic basemap switching via the Layers button, and multi-stop itinerary generation.
 * Optional Fall Foliage: see static/foliage/ (FoliageModule) — removable.
 * Optional drone flight constraints: see static/airspace/ (AirspaceModule) — removable.
 */

// Application State
const state = {
  origin: null,        // { name, lat, lng }
  destination: null,   // { name, lat, lng }
  activePlan: null,
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
  /** Foliage/airspace mounted (lazy on mobile until Layers opens). */
  optionalOverlaysMounted: false,
  /** Explore bounds fetch sequencing / debounce. */
  exploreFetchSeq: 0,
  exploreDebounceTimer: null,
  invalidateSizeTimer: null,
  /** Tesla landscape bottom-sheet mode (not phone /mobile). */
  carShell: false,
  /** peek | plan | itinerary — default peek so map dominates on load */
  sheetMode: "peek",
};

// Expose for Playwright / debugging (cloud verification)
window.appState = state;

/**
 * Mobile shell detection: explicit /mobile path or ?ui=mobile.
 * Do not rely on User-Agent here — server may soft-redirect UA→/mobile behind an env flag.
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

/** Escape text for safe interpolation into HTML / Leaflet popups. */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Coalesce Leaflet invalidateSize — sheet toggles can fire back-to-back. */
function scheduleMapInvalidate(delayMs) {
  if (!state.map) return;
  const delay = delayMs == null ? 80 : delayMs;
  if (state.invalidateSizeTimer) clearTimeout(state.invalidateSizeTimer);
  state.invalidateSizeTimer = setTimeout(() => {
    state.invalidateSizeTimer = null;
    if (state.map) state.map.invalidateSize();
  }, delay);
}

window.scheduleMapInvalidate = scheduleMapInvalidate;

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
 * Normalize geolocation success / error into an origin place.
 * On error (or missing coords), use the SF Ferry Building demo fallback.
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
  return {
    name: "San Francisco, CA (Default)",
    lat: 37.7955,
    lng: -122.3937,
    source: "fallback",
  };
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
  if (handle) {
    handle.addEventListener("click", () => cycleCarSheet());
  }
  if (planBtn) {
    planBtn.addEventListener("click", () => setCarSheet("plan"));
  }
  if (itinBtn) {
    itinBtn.addEventListener("click", () => {
      if (state.activePlan) setCarSheet("itinerary");
      else setCarSheet("plan");
    });
  }
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
      badge.hidden = false;
      badge.textContent = `CAR MODE · ${window.innerWidth}×${window.innerHeight}`;
    } else {
      badge.hidden = true;
    }
  }
  if (enable) {
    if (!was) setCarSheet("peek");
    else setCarSheet(state.sheetMode || "peek");
  } else {
    document.body.removeAttribute("data-sheet");
    document.documentElement.removeAttribute("data-plan-stops");
    document.documentElement.removeAttribute("data-forced-count");
  }
  syncCarTestHooks();
  requestAnimationFrame(() => {
    if (state.map) state.map.invalidateSize({ animate: false });
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
  const next = mode === "peek" || mode === "plan" || mode === "itinerary" ? mode : "peek";
  state.sheetMode = next;
  document.body.setAttribute("data-sheet", next);
  if (next === "plan" || next === "itinerary") {
    switchTab("route-tab");
  }
  if (next === "itinerary") {
    const results = document.getElementById("routeResults");
    if (results && results.style.display !== "none") {
      setTimeout(() => {
        results.scrollIntoView({ block: "start", behavior: "smooth" });
      }, 80);
    }
  }
  updateCarPeek();
  syncCarTestHooks();
  requestAnimationFrame(() => {
    if (state.map) state.map.invalidateSize({ animate: false });
  });
}

function cycleCarSheet() {
  if (!state.carShell) return;
  if (state.sheetMode === "peek") {
    setCarSheet(state.activePlan ? "itinerary" : "plan");
  } else if (state.sheetMode === "plan") {
    setCarSheet(state.activePlan ? "itinerary" : "peek");
  } else {
    setCarSheet("peek");
  }
}

function updateCarPeek() {
  const summary = document.getElementById("carPeekSummary");
  const itinBtn = document.getElementById("btnCarSheetItinerary");
  if (!summary) return;
  if (state.activePlan && state.activePlan.summary) {
    const s = state.activePlan.summary;
    summary.textContent = `${s.supercharger_stops_count} stops · ${s.distance_miles} mi · ${s.total_trip_duration_formatted}`;
    if (itinBtn) itinBtn.hidden = false;
  } else if (state.origin && state.destination) {
    summary.textContent = "Ready — tap Plan Tesla Route";
    if (itinBtn) itinBtn.hidden = true;
  } else {
    summary.textContent = "Tap a preset or enter places";
    if (itinBtn) itinBtn.hidden = true;
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

  // Desktop: mount optional overlays eagerly. Mobile: wait until Layers opens.
  if (!isMobileShell()) {
    mountOptionalOverlays();
  }

  // Map click handler for origin/destination when not in area selection mode
  state.map.on("click", (e) => {
    if (state.areaSelectMode) return;

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

  // Current Location Button
  document.getElementById("btnUseCurrentLocation").addEventListener("click", () => {
    detectCurrentLocation();
  });
  document.getElementById("btnLocateMe").addEventListener("click", () => {
    detectCurrentLocation();
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

  // Clear buttons
  setupClearBtn("clearOrigin", "originInput", () => { state.origin = null; updateMapMarkers(); });
  setupClearBtn("clearDest", "destInput", () => { state.destination = null; updateMapMarkers(); });

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

  // Map Controls
  document.getElementById("btnMapReset").addEventListener("click", () => {
    if (state.routeLayer.getLayers().length > 0) {
      state.map.fitBounds(state.routeLayer.getBounds(), { padding: [50, 50] });
    } else if (state.markersLayer.getLayers().length > 0) {
      state.map.fitBounds(state.markersLayer.getBounds(), { padding: [50, 50] });
    } else {
      state.map.setView([37.7749, -122.4194], 6);
    }
  });

  document.getElementById("btnToggleLayers").addEventListener("click", () => {
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
    alert(emptyMessage);
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
  }
  deactivateAreaSelectMode();
  updateClearSelectionButton();
  if (state.origin && state.destination) {
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
  const boxBtn = document.getElementById("btnAreaModeBox");
  const freeBtn = document.getElementById("btnAreaModeFreehand");
  boxBtn?.classList.toggle("active", state.areaDrawMode === "box");
  freeBtn?.classList.toggle("active", state.areaDrawMode === "freehand");
  boxBtn?.setAttribute("aria-pressed", state.areaDrawMode === "box" ? "true" : "false");
  freeBtn?.setAttribute("aria-pressed", state.areaDrawMode === "freehand" ? "true" : "false");
  if (state.areaSelectMode) {
    updateAreaSelectActiveCopy();
  }
  updateAreaToolDrawingState();
}

function updateAreaToolDrawingState() {
  const boxBtn = document.getElementById("btnAreaModeBox");
  const freeBtn = document.getElementById("btnAreaModeFreehand");
  boxBtn?.classList.toggle("drawing", state.areaSelectMode && state.areaDrawMode === "box");
  freeBtn?.classList.toggle("drawing", state.areaSelectMode && state.areaDrawMode === "freehand");
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
  // Full map while drawing on mobile
  if (isMobileShell()) {
    closeMobileSheet();
    document.body.classList.add("area-drawing");
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

function updateForcedChargersUI() {
  updateClearSelectionButton();

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
  if (state.map) {
    state.map.setView([place.lat, place.lng], 12);
  }
  // On mobile, open the planner so the user can set a destination next
  if (isMobileShell()) openMobileSheet();
  return place;
}

window.applyOriginFromGeolocation = applyOriginFromGeolocation;

function detectCurrentLocation() {
  const resetLocateBtns = () => {
    const label = '<i class="fa-solid fa-location-crosshairs"></i> Use Current Location';
    const btn = document.getElementById("btnUseCurrentLocation");
    if (btn) btn.innerHTML = label;
  };

  if (!navigator.geolocation) {
    if (isMobileShell()) {
      // Phone shell: keep demo fallback so trip UX stays testable without GPS
      applyOriginFromGeolocation(resolveGeolocationPlace(null, { code: 0, message: "unsupported" }));
    } else {
      showToast("Location unavailable in this browser. Use a preset or type an address.");
      if (state.carShell) setCarSheet("plan");
    }
    return;
  }

  const btn = document.getElementById("btnUseCurrentLocation");
  if (btn) btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Locating...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      resetLocateBtns();
      if (isMobileShell()) {
        applyOriginFromGeolocation(resolveGeolocationPlace(pos, null));
        return;
      }
      const coords = {
        name: "Current Location",
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      };
      setOrigin(coords);
      state.map.setView([coords.lat, coords.lng], 12);
      showToast("Location set — pick a destination or preset.", 2800);
      if (typeof updateCarPeek === "function") updateCarPeek();
    },
    (err) => {
      resetLocateBtns();
      console.warn("Geolocation denied or error:", err);
      if (isMobileShell()) {
        applyOriginFromGeolocation(resolveGeolocationPlace(null, err));
        return;
      }
      // Desktop / car: fail soft — do NOT silently overwrite origin with a demo city.
      showToast("Location unavailable in this browser. Use a preset or type an address.");
      if (state.carShell) setCarSheet("plan");
    },
    { enableHighAccuracy: false, timeout: 8000, maximumAge: isMobileShell() ? 60_000 : 0 }
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

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
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

  if (state.origin && state.destination && !state.activePlan) {
    const bounds = L.latLngBounds([
      [state.origin.lat, state.origin.lng],
      [state.destination.lat, state.destination.lng],
    ]);
    state.map.fitBounds(bounds, { padding: [60, 60] });
  }
}

async function planRoute() {
  if (!state.origin || !state.destination) {
    alert("Please provide both starting location and destination.");
    return;
  }

  const seq = ++state.planRouteSeq;
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
      alert(`Routing error: ${plan.error}`);
      return;
    }

    state.activePlan = plan;
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
    alert("Failed to compute route. Check network connection.");
  } finally {
    if (seq === state.planRouteSeq) {
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
  document.getElementById("corridorCountText").innerText = 
    `Visited ${plan.summary.supercharger_stops_count} Superchargers${forcedNotice} • ${plan.summary.chargers_along_corridor_count} stations along corridor`;

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
    state.map.fitBounds(geojsonLayer.getBounds(), { padding: [50, 50] });
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
      item.innerHTML = `
        <div class="timeline-marker"><i class="fa-solid fa-flag-checkered"></i></div>
        <div class="timeline-content">
          <div class="item-top">
            <span class="item-name">${escapeHtml(state.destination.name)}</span>
            <span class="item-badge" style="background:rgba(232,33,39,0.15); color:var(--tesla-red);"><i class="fa-solid fa-battery-half"></i> ~${s.battery_pct}%</span>
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

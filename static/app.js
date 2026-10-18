/**
 * Tesla Supercharger Route Planner - Client Application
 * Includes Visit Maximizer routing, map area drag-selection for force-included chargers,
 * Streets / Topographic basemap switching via the Layers button, and multi-stop itinerary generation.
 * Optional Fall Foliage: see static/foliage/ (FoliageModule) — removable.
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
  areaSelectMode: false,
  areaDrawMode: "box", // "box" | "freehand"
  dragStartLatLng: null,
  selectionShape: null, // rectangle, polyline, or finished polygon
  freehandPoints: [],
  baseLayers: null,
  activeBasemap: "streets",
  layersPanelOpen: false,
};

// Expose for Playwright / debugging (cloud verification)
window.appState = state;

// Initialize Application
document.addEventListener("DOMContentLoaded", () => {
  initMap();
  setupEventListeners();
  loadStats();
  loadNearbyChargers();
});

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

  // Optional removable foliage module (static/foliage/)
  const foliageSlot = document.getElementById("foliageSlot");
  if (window.FoliageModule && foliageSlot) {
    window.FoliageModule.mount({ map: state.map, slotEl: foliageSlot });
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

  // Re-query chargers when map moves in explore mode
  state.map.on("moveend", () => {
    const exploreTab = document.getElementById("explore-tab");
    if (exploreTab.style.display !== "none") {
      loadMapBoundsChargers();
    }
  });

  // Setup Map Area Selection Drawing Handlers
  setupMapAreaSelection();
}

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
}

function setupEventListeners() {
  // Tab switching
  document.getElementById("tabRoute").addEventListener("click", () => switchTab("route-tab"));
  document.getElementById("tabExplore").addEventListener("click", () => {
    switchTab("explore-tab");
    loadMapBoundsChargers();
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

  // Strategy Mode Toggles
  document.getElementById("btnModeMaximize").addEventListener("click", () => {
    setRoutingMode("MAXIMIZE");
  });
  document.getElementById("btnModeMinStops").addEventListener("click", () => {
    setRoutingMode("MIN_STOPS");
  });

  // Max stops dropdown
  document.getElementById("maxStopsSelect").addEventListener("change", () => {
    if (state.origin && state.destination && state.activePlan) {
      planRoute();
    }
  });

  // Sliders display
  const initBatterySlider = document.getElementById("initialBattery");
  initBatterySlider.addEventListener("input", (e) => {
    document.getElementById("initialBatteryVal").innerText = `${e.target.value}%`;
  });

  const targetArrivalSlider = document.getElementById("targetArrival");
  targetArrivalSlider.addEventListener("input", (e) => {
    document.getElementById("targetArrivalVal").innerText = `${e.target.value}%`;
  });

  // Area Selection Buttons
  document.getElementById("btnSelectArea").addEventListener("click", toggleAreaSelectMode);
  document.getElementById("btnMapSelectArea").addEventListener("click", toggleAreaSelectMode);
  document.getElementById("btnCancelAreaSelect").addEventListener("click", deactivateAreaSelectMode);
  document.getElementById("btnClearForced").addEventListener("click", clearForcedChargers);
  document.getElementById("btnAreaModeBox")?.addEventListener("click", () => setAreaDrawMode("box"));
  document.getElementById("btnAreaModeFreehand")?.addEventListener("click", () => setAreaDrawMode("freehand"));
  updateAreaSelectIdleCopy();

  // Plan Route button
  document.getElementById("btnPlanRoute").addEventListener("click", () => {
    planRoute();
  });

  // Preset buttons
  document.querySelectorAll(".preset-tag").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const origText = btn.dataset.orig;
      const destText = btn.dataset.dest;

      document.getElementById("originInput").value = origText;
      document.getElementById("destInput").value = destText;

      const origRes = await geocodeText(origText);
      const destRes = await geocodeText(destText);

      if (origRes) setOrigin(origRes);
      if (destRes) setDestination(destRes);

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
    if (state.origin && state.destination) {
      planRoute();
    }
  });

  // Explore search & filters
  const chargerSearchInput = document.getElementById("chargerSearchInput");
  let debounceTimeout = null;
  chargerSearchInput.addEventListener("input", () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      loadMapBoundsChargers();
    }, 350);
  });

  document.getElementById("filterStatus").addEventListener("change", loadMapBoundsChargers);
  document.getElementById("filterMinPower").addEventListener("change", loadMapBoundsChargers);
  document.getElementById("filterMinStalls").addEventListener("change", loadMapBoundsChargers);
  document.getElementById("btnFilterMapArea").addEventListener("click", loadMapBoundsChargers);

  // Global ESC key to cancel area select
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.areaSelectMode) {
      deactivateAreaSelectMode();
    }
  });
}

function setRoutingMode(mode) {
  state.routingMode = mode;
  document.getElementById("btnModeMaximize").classList.toggle("active", mode === "MAXIMIZE");
  document.getElementById("btnModeMinStops").classList.toggle("active", mode === "MIN_STOPS");
  document.getElementById("maximizeParams").style.display = mode === "MAXIMIZE" ? "flex" : "none";

  if (state.origin && state.destination && state.activePlan) {
    planRoute();
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
}

async function applyForcedChargersFromSelection(chargers, emptyMessage) {
  if (!chargers.length) {
    alert(emptyMessage);
  } else {
    chargers.forEach((c) => {
      state.forcedChargers.set(c.id, c);
    });
    updateForcedChargersUI();
  }
  deactivateAreaSelectMode();
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

// Box rectangle + freehand outline force-include (user picks mode)
function setupMapAreaSelection() {
  state.map.on("mousedown", (e) => {
    if (!state.areaSelectMode) return;
    if (e.originalEvent.button !== 0) return;

    clearSelectionShape();
    state.dragStartLatLng = e.latlng;

    if (state.areaDrawMode === "freehand") {
      state.freehandPoints = [e.latlng];
      state.selectionShape = L.polyline(state.freehandPoints, {
        color: "#00b4d8",
        weight: 2.5,
        dashArray: "4, 6",
        opacity: 0.95,
      }).addTo(state.map);
    } else {
      state.selectionShape = L.rectangle([e.latlng, e.latlng], {
        color: "#00b4d8",
        weight: 2,
        dashArray: "6, 6",
        fillColor: "#00b4d8",
        fillOpacity: 0.18,
      }).addTo(state.map);
    }
  });

  state.map.on("mousemove", (e) => {
    if (!state.areaSelectMode || !state.dragStartLatLng || !state.selectionShape) return;

    if (state.areaDrawMode === "freehand") {
      const last = state.freehandPoints[state.freehandPoints.length - 1];
      if (last && Math.abs(last.lat - e.latlng.lat) < 0.001 && Math.abs(last.lng - e.latlng.lng) < 0.001) {
        return;
      }
      state.freehandPoints.push(e.latlng);
      state.selectionShape.setLatLngs(state.freehandPoints);
    } else {
      state.selectionShape.setBounds(L.latLngBounds(state.dragStartLatLng, e.latlng));
    }
  });

  state.map.on("mouseup", async (e) => {
    if (!state.areaSelectMode || !state.dragStartLatLng || !state.selectionShape) return;

    if (state.areaDrawMode === "freehand") {
      if (e.latlng) state.freehandPoints.push(e.latlng);
      if (state.freehandPoints.length < 6) {
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
  });
}

function setAreaDrawMode(mode) {
  state.areaDrawMode = mode === "freehand" ? "freehand" : "box";
  document.getElementById("btnAreaModeBox")?.classList.toggle("active", state.areaDrawMode === "box");
  document.getElementById("btnAreaModeFreehand")?.classList.toggle("active", state.areaDrawMode === "freehand");
  updateAreaSelectIdleCopy();
  if (state.areaSelectMode) {
    // Refresh banner while drawing if mode changed mid-session
    updateAreaSelectActiveCopy();
  }
}

function updateAreaSelectIdleCopy() {
  const isFreehand = state.areaDrawMode === "freehand";
  const btnText = document.getElementById("btnSelectAreaText");
  const btnIcon = document.querySelector("#btnSelectArea i");
  const mapBtn = document.getElementById("btnMapSelectArea");
  const mapIcon = mapBtn?.querySelector("i");
  if (btnText) btnText.innerText = isFreehand ? "Draw Outline on Map" : "Select Area on Map";
  if (btnIcon) btnIcon.className = isFreehand ? "fa-solid fa-draw-polygon" : "fa-solid fa-vector-square";
  if (mapBtn) {
    mapBtn.title = isFreehand
      ? "Draw freehand outline to force-include Superchargers"
      : "Select rectangle area to force-include Superchargers";
  }
  if (mapIcon) mapIcon.className = isFreehand ? "fa-solid fa-draw-polygon" : "fa-solid fa-vector-square";
}

function updateAreaSelectActiveCopy() {
  const isFreehand = state.areaDrawMode === "freehand";
  const btnText = document.getElementById("btnSelectAreaText");
  const banner = document.getElementById("mapModeBannerText");
  const bannerIcon = document.querySelector("#mapModeBanner .pulse-icon");
  if (btnText) btnText.innerText = isFreehand ? "Drawing Outline..." : "Drawing Box...";
  if (banner) {
    banner.textContent = isFreehand
      ? "Click and drag to freehand-draw an outline around Superchargers. Release to force-include stations inside."
      : "Click and drag on the map to draw a selection box around Superchargers.";
  }
  if (bannerIcon) {
    bannerIcon.className = isFreehand
      ? "fa-solid fa-draw-polygon pulse-icon"
      : "fa-solid fa-vector-square pulse-icon";
  }
}

function toggleAreaSelectMode() {
  if (state.areaSelectMode) {
    deactivateAreaSelectMode();
  } else {
    activateAreaSelectMode();
  }
}

function activateAreaSelectMode() {
  state.areaSelectMode = true;
  state.map.dragging.disable();
  document.getElementById("map").style.cursor = "crosshair";
  document.getElementById("mapModeBanner").style.display = "flex";
  updateAreaSelectActiveCopy();
  document.getElementById("btnMapSelectArea").style.background = "#00b4d8";
  document.getElementById("btnMapSelectArea").style.color = "#fff";
}

function deactivateAreaSelectMode() {
  state.areaSelectMode = false;
  state.map.dragging.enable();
  state.dragStartLatLng = null;
  document.getElementById("map").style.cursor = "";
  document.getElementById("mapModeBanner").style.display = "none";
  updateAreaSelectIdleCopy();
  document.getElementById("btnMapSelectArea").style.background = "";
  document.getElementById("btnMapSelectArea").style.color = "";
}

function toggleForcedCharger(charger) {
  if (state.forcedChargers.has(charger.id)) {
    state.forcedChargers.delete(charger.id);
  } else {
    state.forcedChargers.set(charger.id, charger);
  }
  updateForcedChargersUI();
}

function clearForcedChargers() {
  state.forcedChargers.clear();
  clearSelectionShape();
  updateForcedChargersUI();
  if (state.origin && state.destination && state.activePlan) {
    planRoute();
  }
}

function updateForcedChargersUI() {
  const count = state.forcedChargers.size;
  document.getElementById("forcedCountBadge").innerText = `${count} selected`;
  document.getElementById("btnClearForced").style.display = count > 0 ? "inline-flex" : "none";

  const chipsList = document.getElementById("forcedChipsList");
  chipsList.innerHTML = "";

  if (count === 0) {
    chipsList.innerHTML = `<div class="empty-forced-notice">No area selected. Choose Box or Freehand, then draw on the map — or click any station to force-include it.</div>`;
  } else {
    state.forcedChargers.forEach((c) => {
      const chip = document.createElement("div");
      chip.className = "forced-chip";
      chip.innerHTML = `
        <i class="fa-solid fa-star text-cyan" style="font-size:10px;"></i>
        <span>${c.name}</span>
        <button type="button" class="forced-chip-remove" title="Remove stop"><i class="fa-solid fa-xmark"></i></button>
      `;
      chip.querySelector(".forced-chip-remove").addEventListener("click", (e) => {
        e.stopPropagation();
        toggleForcedCharger(c);
        if (state.origin && state.destination && state.activePlan) {
          planRoute();
        }
      });
      chip.addEventListener("click", () => {
        state.map.setView([c.lat, c.lng], 15);
        showChargerDrawer(c);
      });
      chipsList.appendChild(chip);
    });
  }

  // Render visual forced markers on the map
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
    forcedMarker.bindTooltip(`⭐ <b>FORCE-INCLUDED:</b> ${c.name}<br>${c.power || 250} kW • ${c.stalls || 8} stalls`, {
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

function detectCurrentLocation() {
  if (!navigator.geolocation) {
    alert("Geolocation is not supported by your browser.");
    return;
  }
  const btn = document.getElementById("btnUseCurrentLocation");
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Locating...';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      btn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Use Current Location';
      const coords = {
        name: "Current Location",
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      };
      setOrigin(coords);
      state.map.setView([coords.lat, coords.lng], 12);
    },
    (err) => {
      btn.innerHTML = '<i class="fa-solid fa-location-crosshairs"></i> Use Current Location';
      console.warn("Geolocation denied or error:", err);
      // Fallback demo location: San Francisco Ferry Building
      const fallback = {
        name: "San Francisco, CA (Default)",
        lat: 37.7955,
        lng: -122.3937,
      };
      setOrigin(fallback);
      state.map.setView([fallback.lat, fallback.lng], 12);
    },
    { timeout: 8000 }
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
}

function setupAutocomplete(inputId, suggestionsId, onSelect) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(suggestionsId);
  let timer = null;

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (query.length < 3) {
      list.style.display = "none";
      return;
    }

    timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        list.innerHTML = "";

        if (data.results && data.results.length > 0) {
          data.results.forEach((item) => {
            const el = document.createElement("div");
            el.className = "suggestion-item";
            el.innerHTML = `<i class="fa-solid fa-location-dot"></i><span>${item.name}</span>`;
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
      .bindPopup(`<b>Starting Location</b><br>${state.origin.name}`);
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
      .bindPopup(`<b>Destination</b><br>${state.destination.name}`);
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

  const btn = document.getElementById("btnPlanRoute");
  const origBtnText = btn.innerHTML;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Maximizing Superchargers...';
  btn.disabled = true;

  const payload = {
    origin: [state.origin.lat, state.origin.lng],
    destination: [state.destination.lat, state.destination.lng],
    routing_mode: state.routingMode,
    forced_chargers: Array.from(state.forcedChargers.values()),
    max_stops: parseInt(document.getElementById("maxStopsSelect").value),
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
    if (plan.error) {
      alert(`Routing error: ${plan.error}`);
      return;
    }

    state.activePlan = plan;
    renderRoutePlan(plan);
  } catch (err) {
    console.error("Routing error:", err);
    alert("Failed to compute route. Check network connection.");
  } finally {
    btn.innerHTML = origBtnText;
    btn.disabled = false;
  }
}

function renderRoutePlan(plan) {
  // 1. Update stats
  document.getElementById("routeResults").style.display = "flex";
  document.getElementById("statDistance").innerText = `${plan.summary.distance_miles} mi`;
  document.getElementById("statTotalTime").innerText = plan.summary.total_trip_duration_formatted;
  document.getElementById("statStops").innerText = `${plan.summary.supercharger_stops_count}`;
  document.getElementById("statChargeTime").innerText = `${plan.summary.charge_duration_minutes} min`;
  
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

  // 3. Render Corridor Chargers (Yellow dots)
  if (plan.all_corridor_chargers) {
    plan.all_corridor_chargers.forEach((c) => {
      const circle = L.circleMarker([c.lat, c.lng], {
        radius: 5,
        fillColor: "#ffaa00",
        color: "#ffffff",
        weight: 1.5,
        opacity: 0.9,
        fillOpacity: 0.8,
      });

      circle.bindTooltip(`<b>${c.name}</b><br>${c.power} kW • ${c.stalls} stalls<br>Detour: ${c.detour_miles} mi`, {
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
                 <span style="font-size:9px; margin-top:-2px;">#${stop.stop_index}</span>
               </div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const marker = L.marker([stop.lat, stop.lng], { icon: stopIcon, zIndexOffset: isForced ? 600 : 500 });
      marker.bindPopup(`
        <div style="min-width:180px;">
          <h4 style="margin:0 0 4px 0; color:${markerColor};">${isForced ? '⭐ [FORCED] ' : ''}Stop #${stop.stop_index}: ${stop.name}</h4>
          <p style="margin:2px 0; font-size:12px;"><b>Power:</b> ${stop.power} kW (${stop.stalls} stalls)</p>
          <p style="margin:2px 0; font-size:12px;"><b>Arrive:</b> ${stop.arrival_battery_pct}% &rarr; <b>Leave:</b> ${stop.departure_battery_pct}%</p>
          <p style="margin:2px 0; font-size:12px; color:#10b981;"><b>Charge time:</b> ${stop.charge_duration_min} min</p>
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
            <span class="item-name">${state.origin.name}</span>
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
            <span class="item-name">${state.destination.name}</span>
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
        <div class="timeline-marker">${isForced ? '<i class="fa-solid fa-star"></i>' : s.stop_index}</div>
        <div class="timeline-content">
          <div class="item-top">
            <span class="item-name">${s.name}</span>
            <span class="item-badge ${isForced ? 'badge-forced' : 'badge-charge'}">
              ${isForced ? '⭐ FORCED STOP' : `<i class="fa-solid fa-bolt"></i> +${s.charge_duration_min} min`}
            </span>
          </div>
          <div class="item-details">
            <span class="battery-tag"><i class="fa-solid fa-battery-quarter" style="color:var(--accent-orange)"></i> ${s.arrival_battery_pct}% &rarr; ${s.departure_battery_pct}%</span>
            <span>${s.power} kW</span>
            <span>${s.stalls} stalls</span>
            <span>${s.detour_miles} mi detour</span>
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
    amenitiesContainer.innerHTML += `<span class="chip"><i class="fa-solid fa-store"></i> ${c.facility}</span>`;
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

async function loadMapBoundsChargers() {
  if (!state.map) return;
  const bounds = state.map.getBounds();
  const status = document.getElementById("filterStatus").value;
  const minPower = document.getElementById("filterMinPower").value;
  const minStalls = document.getElementById("filterMinStalls").value;
  const text = document.getElementById("chargerSearchInput").value.trim();

  let url = `/api/superchargers?min_lat=${bounds.getSouth()}&max_lat=${bounds.getNorth()}&min_lng=${bounds.getWest()}&max_lng=${bounds.getEast()}&status=${status}&min_power=${minPower}&min_stalls=${minStalls}&limit=120`;
  if (text) {
    url += `&q=${encodeURIComponent(text)}`;
  }

  try {
    const res = await fetch(url);
    const data = await res.json();
    renderExploreList(data.superchargers || []);
  } catch (e) {
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
        <span>${isForced ? '⭐ ' : ''}${c.name}</span>
        <span class="chip ${c.status === 'OPEN' ? 'green' : 'red'}">${c.status}</span>
      </div>
      <div class="charger-list-sub">
        ${[c.street, c.city, c.state].filter(Boolean).join(", ")}
      </div>
      <div class="charger-list-tags">
        <span class="chip red"><i class="fa-solid fa-bolt"></i> ${c.power || 150} kW</span>
        <span class="chip"><i class="fa-solid fa-charging-station"></i> ${c.stalls || 8} stalls</span>
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

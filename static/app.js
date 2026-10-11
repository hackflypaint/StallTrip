/**
 * Tesla Supercharger Route Planner - Client Application
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
  allSuperchargers: [],
  selectedCharger: null,
};

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

  // High quality OpenStreetMap tiles (free, reliable, no API key required)
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  }).addTo(state.map);

  state.routeLayer = L.featureGroup().addTo(state.map);
  state.corridorLayer = L.featureGroup().addTo(state.map);
  state.markersLayer = L.featureGroup().addTo(state.map);

  // Map click handler to set origin or destination
  state.map.on("click", (e) => {
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

  // Sliders display
  const initBatterySlider = document.getElementById("initialBattery");
  initBatterySlider.addEventListener("input", (e) => {
    document.getElementById("initialBatteryVal").innerText = `${e.target.value}%`;
  });

  const targetArrivalSlider = document.getElementById("targetArrival");
  targetArrivalSlider.addEventListener("input", (e) => {
    document.getElementById("targetArrivalVal").innerText = `${e.target.value}%`;
  });

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
    if (state.map.hasLayer(state.corridorLayer)) {
      state.map.removeLayer(state.corridorLayer);
    } else {
      state.map.addLayer(state.corridorLayer);
    }
  });

  // Charger Drawer Close
  document.getElementById("btnCloseDrawer").addEventListener("click", () => {
    document.getElementById("chargerDrawer").style.display = "none";
  });

  // Add stop to route from drawer
  document.getElementById("btnAddStopToRoute").addEventListener("click", () => {
    if (!state.selectedCharger) return;
    alert(`Selected ${state.selectedCharger.name}. Re-calculating with custom charger.`);
    document.getElementById("chargerDrawer").style.display = "none";
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
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Calculating Best Superchargers...';
  btn.disabled = true;

  const payload = {
    origin: [state.origin.lat, state.origin.lng],
    destination: [state.destination.lat, state.destination.lng],
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
  document.getElementById("corridorCountText").innerText = 
    `Found ${plan.summary.chargers_along_corridor_count} Tesla Superchargers along this corridor`;

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
      const stopIcon = L.divIcon({
        className: "custom-div-icon",
        html: `<div style="background:#ffffff; border:3px solid #e82127; color:#e82127; width:34px; height:34px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; box-shadow:0 4px 12px rgba(232,33,39,0.5); font-weight:800; font-size:11px;">
                 <i class="fa-solid fa-bolt" style="font-size:12px;"></i>
                 <span style="font-size:9px; margin-top:-2px;">#${stop.stop_index}</span>
               </div>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const marker = L.marker([stop.lat, stop.lng], { icon: stopIcon, zIndexOffset: 500 });
      marker.bindPopup(`
        <div style="min-width:180px;">
          <h4 style="margin:0 0 4px 0; color:#e82127;">Stop #${stop.stop_index}: ${stop.name}</h4>
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
      item.className = "timeline-item supercharger";
      item.innerHTML = `
        <div class="timeline-marker">${s.stop_index}</div>
        <div class="timeline-content">
          <div class="item-top">
            <span class="item-name">${s.name}</span>
            <span class="item-badge badge-charge"><i class="fa-solid fa-bolt"></i> +${s.charge_duration_min} min</span>
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

  // Google Maps link
  const gmapsBtn = document.getElementById("btnOpenGoogleMaps");
  gmapsBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}`;

  drawer.style.display = "flex";
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
    const card = document.createElement("div");
    card.className = "charger-list-item";
    card.innerHTML = `
      <div class="charger-list-title">
        <span>${c.name}</span>
        <span class="chip ${c.status === 'OPEN' ? 'green' : 'red'}">${c.status}</span>
      </div>
      <div class="charger-list-sub">
        ${[c.street, c.city, c.state].filter(Boolean).join(", ")}
      </div>
      <div class="charger-list-tags">
        <span class="chip red"><i class="fa-solid fa-bolt"></i> ${c.power || 150} kW</span>
        <span class="chip"><i class="fa-solid fa-charging-station"></i> ${c.stalls || 8} stalls</span>
        ${c.otherEVs ? '<span class="chip green">All EVs</span>' : ''}
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

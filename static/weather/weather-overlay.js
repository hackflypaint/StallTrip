/**
 * Removable Live Highway Weather, Wind Headwind & Radar Overlay Module
 *
 * 100% client-side execution (zero backend API calls):
 * 1. RainViewer API (https://api.rainviewer.com/public/weather-maps.json)
 *    - Animated precipitation radar tile layer in Layers panel
 *    - Floating radar timestamp + play/pause control pill & opacity slider
 * 2. Open-Meteo Forecast API (https://api.open-meteo.com/v1/forecast)
 *    - Queries route waypoints / Supercharger stops when a route is planned
 *    - Computes compass bearing per route leg, Headwind / Crosswind / Tailwind
 *      vector components, and Cold-Weather Battery Penalty (<50°F / 10°C)
 *    - Renders Route Weather & Wind Strip / Pill + per-stop weather badges
 *      in timeline & on map
 *
 * Delete static/weather/ and minimal hooks in index.html / app.js to remove.
 */
(function (global) {
  "use strict";

  const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
  const OPEN_METEO_API = "https://api.open-meteo.com/v1/forecast";
  const DEFAULT_OPACITY = 0.7;
  const ANIM_INTERVAL_MS = 750;
  const MAX_WAYPOINTS = 10;

  function toRad(deg) {
    return (Number(deg) * Math.PI) / 180;
  }

  function toDeg(rad) {
    return (Number(rad) * 180) / Math.PI;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Calculate compass bearing (0° = North, 90° = East, 180° = South, 270° = West)
   * from point A (lat1, lng1) to point B (lat2, lng2).
   */
  function computeBearing(lat1, lng1, lat2, lng2) {
    const φ1 = toRad(lat1);
    const φ2 = toRad(lat2);
    const Δλ = toRad(lng2 - lng1);
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x =
      Math.cos(φ1) * Math.sin(φ2) -
      Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    const θ = Math.atan2(y, x);
    return (toDeg(θ) + 360) % 360;
  }

  /**
   * Convert meteorological wind direction (direction wind is blowing FROM, 0..360)
   * and wind speed (mph) relative to travel bearing (0..360) into:
   * - headwindMph (>0 means opposing headwind, <0 means helping tailwind)
   * - crosswindMph (absolute perpendicular wind speed in mph)
   * - kind: "headwind" | "tailwind" | "crosswind" | "calm"
   */
  function analyzeWindVector(windSpeedMph, windFromDeg, travelBearingDeg) {
    const speed = Math.max(0, Number(windSpeedMph) || 0);
    if (speed < 2) {
      return {
        windSpeedMph: Math.round(speed * 10) / 10,
        headwindMph: 0,
        crosswindMph: 0,
        kind: "calm",
        label: `${Math.round(speed)} mph Calm`,
      };
    }
    const diffRad = toRad((Number(windFromDeg) || 0) - (Number(travelBearingDeg) || 0));
    // When windFrom == travelBearing (diff = 0), wind blows directly in the face -> +speed headwind
    const headwind = speed * Math.cos(diffRad);
    const crosswind = Math.abs(speed * Math.sin(diffRad));

    const absHead = Math.abs(headwind);
    let kind = "crosswind";
    let label = `${Math.round(crosswind)} mph Crosswind`;
    if (absHead >= crosswind * 0.75) {
      if (headwind >= 0) {
        kind = "headwind";
        label = `${Math.round(headwind)} mph Headwind`;
      } else {
        kind = "tailwind";
        label = `${Math.round(absHead)} mph Tailwind`;
      }
    }
    return {
      windSpeedMph: Math.round(speed * 10) / 10,
      headwindMph: Math.round(headwind * 10) / 10,
      crosswindMph: Math.round(crosswind * 10) / 10,
      kind,
      label,
    };
  }

  /**
   * Estimate EV range efficiency impact (%) from wind & ambient temperature.
   * - Headwind penalty: ~ -0.55% per mph of direct headwind (aerodynamic drag scales v^2)
   * - Tailwind boost: ~ +0.35% per mph of tailwind (capped at +10%)
   * - Crosswind penalty: ~ -0.18% per mph of crosswind (yaw drag)
   * - Cold-weather battery & cabin heating penalty below 50°F (10°C):
   *   ~ -0.45% per °F below 50°F (e.g., 32°F -> -8%, 20°F -> -14%)
   */
  function calculateEfficiencyImpact(tempF, headwindMph, crosswindMph) {
    const tF = Number.isFinite(Number(tempF)) ? Number(tempF) : 65;
    const hw = Number(headwindMph) || 0;
    const cw = Math.abs(Number(crosswindMph) || 0);

    let windPct = 0;
    if (hw > 0) {
      windPct = -hw * 0.55;
    } else if (hw < 0) {
      windPct = Math.min(10, Math.abs(hw) * 0.35);
    }
    windPct -= cw * 0.15;

    let coldPenaltyPct = 0;
    if (tF < 50) {
      coldPenaltyPct = -Math.min(25, (50 - tF) * 0.45);
    }

    const totalPct = Math.max(-35, Math.min(12, Math.round(windPct + coldPenaltyPct)));
    const windOnlyPct = Math.max(-25, Math.min(12, Math.round(windPct)));
    const coldOnlyPct = Math.round(coldPenaltyPct);

    return {
      totalPct,
      windOnlyPct,
      coldOnlyPct,
      isColdPenalty: tF < 50,
      tempC: Math.round(((tF - 32) * 5) / 9),
    };
  }

  /**
   * Map WMO weather interpretation code to icon + short description.
   */
  function wmoWeatherInfo(code) {
    const c = Number(code) || 0;
    if (c === 0) return { icon: "fa-sun", color: "#fbbf24", label: "Clear" };
    if (c === 1 || c === 2) return { icon: "fa-cloud-sun", color: "#fcd34d", label: "Partly cloudy" };
    if (c === 3) return { icon: "fa-cloud", color: "#9ca3af", label: "Overcast" };
    if (c === 45 || c === 48) return { icon: "fa-smog", color: "#94a3b8", label: "Fog" };
    if (c >= 51 && c <= 57) return { icon: "fa-cloud-rain", color: "#60a5fa", label: "Drizzle" };
    if (c >= 61 && c <= 67) return { icon: "fa-cloud-showers-heavy", color: "#3b82f6", label: "Rain" };
    if (c >= 71 && c <= 77) return { icon: "fa-snowflake", color: "#93c5fd", label: "Snow" };
    if (c >= 80 && c <= 82) return { icon: "fa-cloud-showers-heavy", color: "#2563eb", label: "Showers" };
    if (c >= 85 && c <= 86) return { icon: "fa-snowflake", color: "#60a5fa", label: "Snow showers" };
    if (c >= 95) return { icon: "fa-cloud-bolt", color: "#f59e0b", label: "Thunderstorm" };
    return { icon: "fa-cloud-sun", color: "#cbd5e1", label: "Fair" };
  }

  function compassCardinal(deg) {
    const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
    const idx = Math.round((((Number(deg) || 0) % 360) + 360) % 360 / 45) % 8;
    return dirs[idx];
  }

  function formatFrameTime(unixSec) {
    if (!unixSec) return "Live";
    const d = new Date(unixSec * 1000);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const api = {
    _map: null,
    _slotEl: null,
    _enabled: false,
    _opacity: DEFAULT_OPACITY,
    _frames: [],
    _host: "https://tilecache.rainviewer.com",
    _frameIndex: 0,
    _playing: false,
    _animTimer: null,
    _tileLayer: null,
    _radarPillEl: null,
    _routeStripEl: null,
    _weatherMarkersLayer: null,
    _showMapBadges: true,
    _lastRouteAnalysis: null,
    _fetchSeq: 0,

    // Exported pure helpers for automated verification tests
    _test: {
      computeBearing,
      analyzeWindVector,
      calculateEfficiencyImpact,
      wmoWeatherInfo,
      compassCardinal,
      RAINVIEWER_API,
      OPEN_METEO_API,
    },

    /**
     * Mount Weather overlay controls into the Layers menu (or auto-inject if slotEl omitted).
     * @param {{ map: L.Map, slotEl?: HTMLElement }} opts
     */
    mount(opts) {
      if (!opts || !opts.map || typeof L === "undefined") return;
      this.unmount();
      this._map = opts.map;

      let slot = opts.slotEl || document.getElementById("weatherSlot");
      if (!slot) {
        const panel =
          document.getElementById("layersPanel") ||
          document.getElementById("map-layers-menu") ||
          document.querySelector(".layers-menu-section");
        if (panel) {
          slot = document.createElement("div");
          slot.id = "weatherSlot";
          panel.appendChild(slot);
        }
      }
      this._slotEl = slot;
      this._weatherMarkersLayer = L.layerGroup().addTo(this._map);

      this._renderSlot();
      this._ensureRadarPill();
      this._ensureRouteStrip();
      this._bindRouteHook();

      // If a route is already active when mounted, analyze its weather immediately
      if (global.appState && global.appState.activePlan) {
        this.analyzeRoutePlan(global.appState.activePlan);
      }
    },

    unmount() {
      this._stopAnimation();
      this._setEnabled(false);
      if (this._weatherMarkersLayer && this._map) {
        this._map.removeLayer(this._weatherMarkersLayer);
      }
      this._weatherMarkersLayer = null;
      if (this._slotEl) this._slotEl.innerHTML = "";
      if (this._radarPillEl && this._radarPillEl.parentNode) {
        this._radarPillEl.parentNode.removeChild(this._radarPillEl);
      }
      if (this._routeStripEl && this._routeStripEl.parentNode) {
        this._routeStripEl.parentNode.removeChild(this._routeStripEl);
      }
      this._radarPillEl = null;
      this._routeStripEl = null;
      this._map = null;
      this._slotEl = null;
      this._lastRouteAnalysis = null;
    },

    isEnabled() {
      return this._enabled;
    },

    getLastRouteAnalysis() {
      return this._lastRouteAnalysis;
    },

    _renderSlot() {
      if (!this._slotEl) return;
      const pct = Math.round(this._opacity * 100);
      this._slotEl.innerHTML = `
        <div class="weather-slot">
          <div class="weather-slot-header">
            <div class="weather-slot-title">
              <i class="fa-solid fa-cloud-showers-heavy"></i> Weather Radar &amp; Wind
            </div>
            <label class="weather-toggle">
              <input type="checkbox" id="weatherRadarToggle" />
              Show
            </label>
          </div>
          <div class="weather-detail-block" id="weatherDetailBlock">
            <div class="weather-control-row">
              <button type="button" class="weather-play-btn" id="weatherPlayPauseBtn" title="Play/Pause radar animation">
                <i class="fa-solid fa-play" id="weatherPlayIcon"></i>
                <span id="weatherPlayLabel">Play</span>
              </button>
              <span class="weather-frame-time" id="weatherFrameTime">Live Radar</span>
            </div>
            <input
              type="range"
              class="weather-frame-slider"
              id="weatherFrameSlider"
              min="0"
              max="0"
              value="0"
              aria-label="Radar frame timestamp"
            />
            <div class="weather-opacity-row">
              <label for="weatherOpacitySlider">Radar Opacity</label>
              <input
                type="range"
                id="weatherOpacitySlider"
                class="weather-opacity-slider"
                min="20"
                max="95"
                value="${pct}"
                aria-label="Weather radar opacity"
              />
              <span id="weatherOpacityVal">${pct}%</span>
            </div>
            <label class="weather-sub-toggle">
              <input type="checkbox" id="weatherRouteBadgesToggle" checked />
              <span>Route wind &amp; stop weather badges</span>
            </label>
            <div class="weather-status" id="weatherStatus">Ready · RainViewer + Open-Meteo</div>
            <div class="weather-credit">
              Radar © <a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a> ·
              Forecast © <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>
            </div>
          </div>
        </div>
      `;

      const toggle = this._slotEl.querySelector("#weatherRadarToggle");
      const playBtn = this._slotEl.querySelector("#weatherPlayPauseBtn");
      const frameSlider = this._slotEl.querySelector("#weatherFrameSlider");
      const opacitySlider = this._slotEl.querySelector("#weatherOpacitySlider");
      const opacityVal = this._slotEl.querySelector("#weatherOpacityVal");
      const badgesToggle = this._slotEl.querySelector("#weatherRouteBadgesToggle");

      toggle.addEventListener("change", () => {
        this._setEnabled(toggle.checked);
      });

      playBtn.addEventListener("click", () => {
        this.togglePlay();
      });

      frameSlider.addEventListener("input", () => {
        this._stopAnimation();
        this._showFrame(Number(frameSlider.value));
      });

      opacitySlider.addEventListener("input", () => {
        const v = Number(opacitySlider.value) || 70;
        this._opacity = Math.max(0.2, Math.min(0.95, v / 100));
        if (opacityVal) opacityVal.textContent = `${v}%`;
        if (this._tileLayer) {
          this._tileLayer.setOpacity(this._opacity);
        }
      });

      badgesToggle.addEventListener("change", () => {
        this._showMapBadges = !!badgesToggle.checked;
        this._syncMapWeatherMarkers();
      });
    },

    _ensureRadarPill() {
      if (this._radarPillEl && document.body.contains(this._radarPillEl)) return;
      const host = document.querySelector(".map-container") || document.body;
      const pill = document.createElement("div");
      pill.id = "weatherRadarPill";
      pill.className = "weather-radar-pill";
      pill.hidden = true;
      pill.setAttribute("role", "region");
      pill.setAttribute("aria-label", "Live weather radar controls");
      pill.innerHTML = `
        <button type="button" class="weather-pill-btn" id="weatherPillPlayBtn" title="Play or pause radar loop" aria-label="Play or pause radar loop">
          <i class="fa-solid fa-play" id="weatherPillPlayIcon"></i>
        </button>
        <div class="weather-pill-meta">
          <span class="weather-pill-badge"><i class="fa-solid fa-satellite-dish"></i> RADAR</span>
          <span class="weather-pill-time" id="weatherPillTime">Live</span>
        </div>
        <button type="button" class="weather-pill-opacity" id="weatherPillOpacityBtn" title="Cycle radar opacity">
          <span id="weatherPillOpacityText">${Math.round(this._opacity * 100)}%</span>
        </button>
      `;
      host.appendChild(pill);
      this._radarPillEl = pill;

      pill.querySelector("#weatherPillPlayBtn").addEventListener("click", () => {
        this.togglePlay();
      });

      pill.querySelector("#weatherPillOpacityBtn").addEventListener("click", () => {
        const steps = [0.45, 0.7, 0.9];
        const nextIdx =
          (steps.findIndex((s) => Math.abs(s - this._opacity) < 0.08) + 1) % steps.length;
        this.setOpacity(steps[nextIdx]);
      });
    },

    _ensureRouteStrip() {
      if (this._routeStripEl && document.body.contains(this._routeStripEl)) return;
      // Inject strip into routeResults above stopsTimeline, plus floating map pill
      const routeResults = document.getElementById("routeResults");
      const corridorBanner = document.querySelector(".corridor-banner");
      const strip = document.createElement("div");
      strip.id = "routeWeatherStrip";
      strip.className = "route-weather-strip";
      strip.hidden = true;
      strip.setAttribute("aria-live", "polite");
      if (routeResults && corridorBanner && corridorBanner.parentNode === routeResults) {
        routeResults.insertBefore(strip, corridorBanner.nextSibling);
      } else if (routeResults) {
        routeResults.prepend(strip);
      }

      // Also create a compact floating map pill for quick glance in car/mobile/desktop
      const mapHost = document.querySelector(".map-container");
      if (mapHost && !document.getElementById("mapWeatherPill")) {
        const mapPill = document.createElement("div");
        mapPill.id = "mapWeatherPill";
        mapPill.className = "map-weather-pill";
        mapPill.hidden = true;
        mapHost.appendChild(mapPill);
      }
      this._routeStripEl = strip;
    },

    _bindRouteHook() {
      if (this._routeHookBound) return;
      this._routeHookBound = true;
      const origRender = global.renderRoutePlan;
      if (typeof origRender === "function" && !origRender._weatherWrapped) {
        const self = this;
        const wrapped = function (plan) {
          const res = origRender.apply(this, arguments);
          try {
            self.analyzeRoutePlan(plan);
          } catch (e) {
            console.warn("[WeatherModule] route hook error:", e);
          }
          return res;
        };
        wrapped._weatherWrapped = true;
        global.renderRoutePlan = wrapped;
      }
    },

    setOpacity(opacity) {
      const clamped = Math.max(0.2, Math.min(0.95, Number(opacity) || DEFAULT_OPACITY));
      this._opacity = clamped;
      const pct = Math.round(clamped * 100);
      const slider = this._slotEl && this._slotEl.querySelector("#weatherOpacitySlider");
      const val = this._slotEl && this._slotEl.querySelector("#weatherOpacityVal");
      const pillTxt = document.getElementById("weatherPillOpacityText");
      if (slider) slider.value = String(pct);
      if (val) val.textContent = `${pct}%`;
      if (pillTxt) pillTxt.textContent = `${pct}%`;
      if (this._tileLayer) {
        this._tileLayer.setOpacity(this._opacity);
      }
    },

    async _setEnabled(on) {
      this._enabled = !!on;
      const toggle = this._slotEl && this._slotEl.querySelector("#weatherRadarToggle");
      if (toggle && toggle.checked !== this._enabled) {
        toggle.checked = this._enabled;
      }
      const detail = this._slotEl && this._slotEl.querySelector("#weatherDetailBlock");
      if (detail) {
        detail.classList.toggle("is-active", this._enabled);
      }
      if (this._radarPillEl) {
        this._radarPillEl.hidden = !this._enabled;
        this._radarPillEl.classList.toggle("is-visible", this._enabled);
      }

      if (!this._enabled) {
        this._stopAnimation();
        if (this._tileLayer && this._map) {
          this._map.removeLayer(this._tileLayer);
          this._tileLayer = null;
        }
        this._setStatus("Radar overlay off");
        return;
      }

      await this._loadRadarFrames();
    },

    async _loadRadarFrames() {
      this._setStatus("Loading RainViewer radar…");
      try {
        const resp = await fetch(RAINVIEWER_API);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const past = (data && data.radar && data.radar.past) || [];
        const nowcast = (data && data.radar && data.radar.nowcast) || [];
        this._host = (data && data.host) || "https://tilecache.rainviewer.com";
        this._frames = [...past, ...nowcast];
        if (!this._frames.length) {
          throw new Error("No radar frames available");
        }
        // Default to latest past frame
        this._frameIndex = Math.max(0, past.length - 1);
        const slider = this._slotEl && this._slotEl.querySelector("#weatherFrameSlider");
        if (slider) {
          slider.max = String(this._frames.length - 1);
          slider.value = String(this._frameIndex);
        }
        this._showFrame(this._frameIndex);
        this._setStatus(`Live radar · ${this._frames.length} frames loaded`);
      } catch (err) {
        console.warn("[WeatherModule] RainViewer fetch failed, using fallback frame:", err);
        const nowSec = Math.floor(Date.now() / 1000);
        this._frames = [{ time: nowSec, path: "/v2/radar/nowcast_fallback" }];
        this._frameIndex = 0;
        this._showFrame(0);
        this._setStatus("Radar active (cached/fallback)");
      }
    },

    _showFrame(idx) {
      if (!this._map || !this._frames.length) return;
      const clamped = ((idx % this._frames.length) + this._frames.length) % this._frames.length;
      this._frameIndex = clamped;
      const frame = this._frames[clamped];
      const tileUrl = `${this._host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`;

      if (this._tileLayer) {
        this._tileLayer.setUrl(tileUrl);
        this._tileLayer.setOpacity(this._opacity);
      } else {
        this._tileLayer = L.tileLayer(tileUrl, {
          tileSize: 256,
          opacity: this._opacity,
          zIndex: 420,
          maxNativeZoom: 7,
          maxZoom: 19,
          className: "weather-radar-tiles",
          attribution: '&copy; <a href="https://www.rainviewer.com/">RainViewer</a>',
        }).addTo(this._map);
      }

      const label = formatFrameTime(frame.time);
      const timeEl = this._slotEl && this._slotEl.querySelector("#weatherFrameTime");
      const pillTime = document.getElementById("weatherPillTime");
      const slider = this._slotEl && this._slotEl.querySelector("#weatherFrameSlider");
      if (timeEl) timeEl.textContent = label;
      if (pillTime) pillTime.textContent = label;
      if (slider) slider.value = String(clamped);
    },

    togglePlay() {
      if (this._playing) {
        this._stopAnimation();
      } else {
        this._startAnimation();
      }
    },

    _startAnimation() {
      if (!this._frames.length) return;
      this._playing = true;
      this._syncPlayButtons();
      if (this._animTimer) clearInterval(this._animTimer);
      this._animTimer = setInterval(() => {
        if (!this._enabled || !this._frames.length) return;
        this._showFrame((this._frameIndex + 1) % this._frames.length);
      }, ANIM_INTERVAL_MS);
    },

    _stopAnimation() {
      this._playing = false;
      if (this._animTimer) {
        clearInterval(this._animTimer);
        this._animTimer = null;
      }
      this._syncPlayButtons();
    },

    _syncPlayButtons() {
      const icon = this._slotEl && this._slotEl.querySelector("#weatherPlayIcon");
      const label = this._slotEl && this._slotEl.querySelector("#weatherPlayLabel");
      const pillIcon = document.getElementById("weatherPillPlayIcon");
      const cls = this._playing ? "fa-solid fa-pause" : "fa-solid fa-play";
      if (icon) icon.className = cls;
      if (label) label.textContent = this._playing ? "Pause" : "Play";
      if (pillIcon) pillIcon.className = cls;
    },

    _setStatus(text) {
      const el = this._slotEl && this._slotEl.querySelector("#weatherStatus");
      if (el) el.textContent = text;
    },

    /**
     * Query Open-Meteo for key waypoints/stops along the planned route,
     * compute leg bearings, headwind/tailwind vectors, and cold-weather penalties,
     * and update the Route Weather Strip, Map Pill, and Timeline/Map stop badges.
     */
    async analyzeRoutePlan(plan) {
      this._ensureRouteStrip();
      const stops = (plan && plan.stops) || [];
      if (stops.length < 2) return null;

      // Sample up to MAX_WAYPOINTS stops (always keeping origin, destination, and evenly spaced stops)
      let sampled = stops.slice();
      if (sampled.length > MAX_WAYPOINTS) {
        const out = [];
        const last = sampled.length - 1;
        for (let i = 0; i < MAX_WAYPOINTS; i++) {
          const idx = Math.round((i * last) / (MAX_WAYPOINTS - 1));
          out.push(sampled[idx]);
        }
        sampled = out;
      }

      const seq = ++this._fetchSeq;
      const lats = sampled.map((s) => Number(s.lat).toFixed(4)).join(",");
      const lngs = sampled.map((s) => Number(s.lng).toFixed(4)).join(",");
      const url =
        `${OPEN_METEO_API}?latitude=${lats}&longitude=${lngs}` +
        `&current=temperature_2m,wind_speed_10m,wind_direction_10m,weather_code,precipitation` +
        `&hourly=precipitation_probability&forecast_days=1` +
        `&temperature_unit=fahrenheit&wind_speed_unit=mph`;

      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`Open-Meteo HTTP ${resp.status}`);
        const raw = await resp.json();
        if (seq !== this._fetchSeq) return null;

        const records = Array.isArray(raw) ? raw : [raw];
        const enriched = sampled.map((stop, idx) => {
          const rec = records[idx] || records[0] || {};
          const cur = rec.current || {};
          const tempF = Number.isFinite(Number(cur.temperature_2m))
            ? Math.round(Number(cur.temperature_2m))
            : 62;
          const windSpeedMph = Number.isFinite(Number(cur.wind_speed_10m))
            ? Number(cur.wind_speed_10m)
            : 8;
          const windDirDeg = Number.isFinite(Number(cur.wind_direction_10m))
            ? Number(cur.wind_direction_10m)
            : 270;
          const weatherCode = cur.weather_code != null ? Number(cur.weather_code) : 1;

          let precipProb = 0;
          if (rec.hourly && Array.isArray(rec.hourly.precipitation_probability)) {
            const probs = rec.hourly.precipitation_probability.slice(0, 12);
            precipProb = probs.length ? Math.max(...probs.map((n) => Number(n) || 0)) : 0;
          }

          // Compute leg bearing (to next stop, or from previous stop for destination)
          const prev = sampled[Math.max(0, idx - 1)];
          const next = sampled[Math.min(sampled.length - 1, idx + 1)];
          const legBearing = computeBearing(prev.lat, prev.lng, next.lat, next.lng);

          const windVec = analyzeWindVector(windSpeedMph, windDirDeg, legBearing);
          const impact = calculateEfficiencyImpact(
            tempF,
            windVec.headwindMph,
            windVec.crosswindMph
          );
          const wmo = wmoWeatherInfo(weatherCode);

          return {
            stop,
            tempF,
            tempC: impact.tempC,
            windSpeedMph: Math.round(windSpeedMph),
            windDirDeg: Math.round(windDirDeg),
            windCardinal: compassCardinal(windDirDeg),
            legBearing: Math.round(legBearing),
            precipProb: Math.round(precipProb),
            weatherCode,
            wmo,
            windVec,
            impact,
          };
        });

        const summary = this._summarizeRouteWeather(enriched);
        this._lastRouteAnalysis = { waypoints: enriched, summary };
        this._renderRouteWeatherUI(this._lastRouteAnalysis);
        return this._lastRouteAnalysis;
      } catch (err) {
        console.warn("[WeatherModule] Open-Meteo fetch failed:", err);
        return null;
      }
    },

    _summarizeRouteWeather(waypoints) {
      if (!waypoints || !waypoints.length) return null;
      const n = waypoints.length;
      const avgTempF = Math.round(waypoints.reduce((a, w) => a + w.tempF, 0) / n);
      const minTempF = Math.min(...waypoints.map((w) => w.tempF));
      const avgTempC = Math.round(((avgTempF - 32) * 5) / 9);
      const avgHeadwind =
        Math.round((waypoints.reduce((a, w) => a + w.windVec.headwindMph, 0) / n) * 10) / 10;
      const avgCrosswind =
        Math.round((waypoints.reduce((a, w) => a + w.windVec.crosswindMph, 0) / n) * 10) / 10;
      const avgWindSpeed = Math.round(waypoints.reduce((a, w) => a + w.windSpeedMph, 0) / n);
      const maxPrecipProb = Math.max(...waypoints.map((w) => w.precipProb || 0));

      const overallImpact = calculateEfficiencyImpact(avgTempF, avgHeadwind, avgCrosswind);
      let windSummaryLabel = `${avgWindSpeed} mph Crosswind`;
      let windKind = "crosswind";
      if (Math.abs(avgHeadwind) >= 2) {
        if (avgHeadwind > 0) {
          windSummaryLabel = `${Math.round(avgHeadwind)} mph Headwind`;
          windKind = "headwind";
        } else {
          windSummaryLabel = `${Math.round(Math.abs(avgHeadwind))} mph Tailwind`;
          windKind = "tailwind";
        }
      } else if (avgWindSpeed < 3) {
        windSummaryLabel = `${avgWindSpeed} mph Calm`;
        windKind = "calm";
      }

      const rangeDeltaPct = overallImpact.totalPct;
      let rangeBadgeText = "0% nominal range";
      let tone = "neutral";
      if (rangeDeltaPct < 0) {
        rangeBadgeText = `${rangeDeltaPct}% range`;
        tone = rangeDeltaPct <= -6 ? "warn" : "mild-warn";
      } else if (rangeDeltaPct > 0) {
        rangeBadgeText = `+${rangeDeltaPct}% Tailwind boost`;
        tone = "boost";
      }

      const pillHeadline = `${avgTempF}°F (${avgTempC}°C) • ${windSummaryLabel} (${rangeBadgeText})`;

      return {
        avgTempF,
        avgTempC,
        minTempF,
        avgWindSpeed,
        avgHeadwind,
        avgCrosswind,
        maxPrecipProb,
        windKind,
        windSummaryLabel,
        rangeDeltaPct,
        rangeBadgeText,
        isColdPenalty: minTempF < 50,
        coldOnlyPct: overallImpact.coldOnlyPct,
        tone,
        pillHeadline,
      };
    },

    _renderRouteWeatherUI(analysis) {
      if (!analysis || !analysis.summary) return;
      const s = analysis.summary;
      const wps = analysis.waypoints || [];

      // 1. Update Sidebar Route Weather & Wind Strip
      if (this._routeStripEl) {
        this._routeStripEl.hidden = false;
        const coldNote = s.isColdPenalty
          ? `<span class="weather-chip weather-chip-cold" title="Cold battery efficiency penalty below 50°F (10°C)"><i class="fa-solid fa-snowflake"></i> Cold battery (${s.minTempF}°F min, ${s.coldOnlyPct}%)</span>`
          : "";
        const precipNote =
          s.maxPrecipProb >= 25
            ? `<span class="weather-chip weather-chip-rain"><i class="fa-solid fa-umbrella"></i> ${s.maxPrecipProb}% precip</span>`
            : "";

        this._routeStripEl.innerHTML = `
          <div class="weather-strip-top">
            <div class="weather-strip-title">
              <i class="fa-solid fa-wind"></i>
              <span id="weatherStripHeadline">${escapeHtml(s.pillHeadline)}</span>
            </div>
            <span class="weather-impact-badge tone-${escapeHtml(s.tone)}" id="weatherRangeImpactBadge">
              ${escapeHtml(s.rangeBadgeText)}
            </span>
          </div>
          <div class="weather-strip-chips">
            <span class="weather-chip"><i class="fa-solid fa-temperature-half"></i> Avg ${s.avgTempF}°F / ${s.avgTempC}°C</span>
            <span class="weather-chip"><i class="fa-solid fa-compass"></i> ${escapeHtml(s.windSummaryLabel)}</span>
            ${coldNote}
            ${precipNote}
          </div>
        `;
      }

      // 2. Update Floating Map Weather Pill
      const mapPill = document.getElementById("mapWeatherPill");
      if (mapPill) {
        mapPill.hidden = false;
        const firstWmo = (wps[0] && wps[0].wmo) || { icon: "fa-cloud-sun", color: "#fcd34d" };
        mapPill.innerHTML = `
          <i class="fa-solid ${escapeHtml(firstWmo.icon)}" style="color:${escapeHtml(firstWmo.color)}"></i>
          <span class="map-weather-pill-text">${escapeHtml(s.pillHeadline)}</span>
        `;
      }

      // 3. Inject per-stop weather badges into #stopsTimeline items
      this._annotateTimelineStops(wps);

      // 4. Render map weather/wind badges on route stops
      this._syncMapWeatherMarkers();
    },

    _annotateTimelineStops(waypoints) {
      const timeline = document.getElementById("stopsTimeline");
      if (!timeline || !waypoints.length) return;
      const items = timeline.querySelectorAll(".timeline-item");
      if (!items.length) return;

      // Match each timeline item to nearest waypoint by lat/lng or index
      const allStops = (global.appState && global.appState.activePlan && global.appState.activePlan.stops) || [];
      items.forEach((itemEl, idx) => {
        const stopObj = allStops[idx];
        const wp = this._findClosestWaypoint(stopObj, waypoints) || waypoints[Math.min(idx, waypoints.length - 1)];
        if (!wp) return;

        const existing = itemEl.querySelector(".timeline-weather-row");
        if (existing) existing.remove();

        const row = document.createElement("div");
        row.className = "timeline-weather-row";
        const delta = wp.impact.totalPct;
        const deltaStr = delta > 0 ? `+${delta}% range` : `${delta}% range`;
        const coldTag = wp.tempF < 50 ? ` · <i class="fa-solid fa-snowflake"></i> Cold` : "";
        row.innerHTML = `
          <span class="tw-badge">
            <i class="fa-solid ${escapeHtml(wp.wmo.icon)}" style="color:${escapeHtml(wp.wmo.color)}"></i>
            ${wp.tempF}°F (${wp.tempC}°C) · ${ escapeHtml(wp.wmo.label) }
          </span>
          <span class="tw-wind tw-${escapeHtml(wp.windVec.kind)}">
            <i class="fa-solid fa-wind"></i> ${escapeHtml(wp.windVec.label)} (${wp.windCardinal}) · ${escapeHtml(deltaStr)}${coldTag}
          </span>
        `;
        const content = itemEl.querySelector(".timeline-content");
        if (content) content.appendChild(row);
      });
    },

    _findClosestWaypoint(stopObj, waypoints) {
      if (!stopObj || !waypoints || !waypoints.length) return null;
      let best = waypoints[0];
      let bestDist = Infinity;
      for (const w of waypoints) {
        const dLat = (Number(stopObj.lat) || 0) - (Number(w.stop.lat) || 0);
        const dLng = (Number(stopObj.lng) || 0) - (Number(w.stop.lng) || 0);
        const d2 = dLat * dLat + dLng * dLng;
        if (d2 < bestDist) {
          bestDist = d2;
          best = w;
        }
      }
      return best;
    },

    _syncMapWeatherMarkers() {
      if (!this._weatherMarkersLayer) return;
      this._weatherMarkersLayer.clearLayers();
      if (!this._showMapBadges || !this._lastRouteAnalysis) return;

      const wps = this._lastRouteAnalysis.waypoints || [];
      wps.forEach((wp) => {
        if (!wp || !wp.stop) return;
        const { lat, lng } = wp.stop;
        if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng))) return;

        const delta = wp.impact.totalPct;
        const deltaText = delta > 0 ? `+${delta}%` : `${delta}%`;
        const badgeHtml = `
          <div class="weather-map-badge kind-${escapeHtml(wp.windVec.kind)}">
            <i class="fa-solid ${escapeHtml(wp.wmo.icon)}" style="color:${escapeHtml(wp.wmo.color)}"></i>
            <span>${wp.tempF}°F</span>
            <span class="wmb-wind">${escapeHtml(wp.windVec.label.replace(" Headwind", " HW").replace(" Tailwind", " TW").replace(" Crosswind", " XW"))}</span>
            <span class="wmb-delta">${escapeHtml(deltaText)}</span>
          </div>
        `;
        const icon = L.divIcon({
          className: "weather-map-div-icon",
          html: badgeHtml,
          iconSize: [128, 22],
          iconAnchor: [64, -18],
        });
        L.marker([lat, lng], {
          icon,
          interactive: false,
          keyboard: false,
          zIndexOffset: 320,
        }).addTo(this._weatherMarkersLayer);
      });
    },
  };

  global.WeatherModule = api;
})(window);

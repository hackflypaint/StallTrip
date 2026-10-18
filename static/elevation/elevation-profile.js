/**
 * Removable Elevation-Aware Battery & Grade Profile Strip.
 *
 * 100% client-side route elevation & grade profiling:
 * - Samples ~48 equidistant points along the planned route geometry (or stop coordinates).
 * - Queries the free, no-key Open-Meteo Elevation API directly from the browser
 *   (https://api.open-meteo.com/v1/elevation?latitude=...&longitude=...),
 *   with a deterministic synthetic terrain fallback when offline.
 * - Renders a collapsible bottom strip over the map (desktop, mobile, and Tesla car-shell):
 *   - Interactive SVG area chart with Supercharger stop pins plotted on the terrain curve.
 *   - Hover / touch scrubbing along the profile highlights the exact location on the Leaflet map
 *     and displays elevation (ft/m), % grade, cumulative distance, and active leg energy impact.
 *   - Computes EV Elevation Energy Impact per leg and overall trip:
 *     climbing penalty (+kWh for ascent) vs. regenerative braking recovery (-kWh on descent),
 *     displaying net elevation kWh and Wh/mi badges in the strip header.
 *
 * See static/elevation/README.md for formulas and removal steps.
 */
(function (global) {
  "use strict";

  const OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation";
  const DEFAULT_SAMPLE_COUNT = 50;
  const MAX_COORDS_PER_REQUEST = 90;
  const METERS_TO_FEET = 3.28084;
  const KM_TO_MILES = 0.621371;

  /**
   * EV physics & energy constants (representative Tesla Model Y/3 Long Range + pack scaling):
   * - Mass m ≈ 2,050 kg (curb weight + passengers/cargo)
   * - Gravity g = 9.80665 m/s²
   * - Potential energy per meter of elevation: m * g / 3,600,000 ≈ 0.005585 kWh/m
   * - Drivetrain climb factor: 1 / 0.87 ≈ 1.15 → ~0.00642 kWh per meter climbed
   *   (~6.42 kWh per 1,000 m / ~1.96 kWh per 1,000 ft gained)
   * - Regenerative braking recovery on net descent segments: ~64% of potential energy
   *   returned to battery (~0.00357 kWh per meter descended, ~1.09 kWh per 1,000 ft lost)
   * - Noise deadband: ignore micro-undulations < 1.5 m per sample segment.
   */
  const PHYSICS = {
    vehicleMassKg: 2050,
    gravityMps2: 9.80665,
    climbEfficiency: 0.87,
    regenEfficiency: 0.64,
    deadbandMeters: 1.5,
    nominalWhPerKm: 168,
  };

  function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371.0088;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) *
        Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
    return R * c;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Extract route coordinate sequence [[lng, lat], ...] from plan data.
   * Supports plan.geometry.coordinates, plan.route.geometry.coordinates, or plan.stops fallback.
   */
  function extractRouteCoordinates(plan) {
    if (!plan || typeof plan !== "object") return [];
    const geom =
      (plan.geometry && Array.isArray(plan.geometry.coordinates) && plan.geometry) ||
      (plan.route &&
        plan.route.geometry &&
        Array.isArray(plan.route.geometry.coordinates) &&
        plan.route.geometry) ||
      null;

    if (geom && geom.coordinates.length >= 2) {
      const cleaned = [];
      for (const pt of geom.coordinates) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        const lng = Number(pt[0]);
        const lat = Number(pt[1]);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          cleaned.push([lng, lat]);
        }
      }
      if (cleaned.length >= 2) return cleaned;
    }

    if (Array.isArray(plan.stops) && plan.stops.length >= 2) {
      const fromStops = [];
      for (const s of plan.stops) {
        if (!s) continue;
        const lat = Number(s.lat);
        const lng = Number(s.lng);
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
          fromStops.push([lng, lat]);
        }
      }
      if (fromStops.length >= 2) return fromStops;
    }

    return [];
  }

  /**
   * Sample `targetCount` equidistant points along a polyline [[lng, lat], ...].
   * Returns [{ index, lat, lng, distKm, distMi }].
   */
  function sampleRouteGeometry(coords, targetCount = DEFAULT_SAMPLE_COUNT) {
    if (!Array.isArray(coords) || coords.length === 0) return [];
    const valid = coords.filter(
      (c) => Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]))
    );
    if (valid.length === 0) return [];
    if (valid.length === 1) {
      return [
        {
          index: 0,
          lat: Number(valid[0][1]),
          lng: Number(valid[0][0]),
          distKm: 0,
          distMi: 0,
        },
      ];
    }

    const count = Math.max(2, Math.min(100, Math.round(targetCount || DEFAULT_SAMPLE_COUNT)));
    const cumKm = [0];
    for (let i = 0; i < valid.length - 1; i++) {
      const [lng1, lat1] = valid[i];
      const [lng2, lat2] = valid[i + 1];
      const d = haversineKm(Number(lat1), Number(lng1), Number(lat2), Number(lng2));
      cumKm.push(cumKm[cumKm.length - 1] + d);
    }

    const totalKm = cumKm[cumKm.length - 1];
    if (totalKm <= 1e-6) {
      return [
        {
          index: 0,
          lat: Number(valid[0][1]),
          lng: Number(valid[0][0]),
          distKm: 0,
          distMi: 0,
        },
        {
          index: 1,
          lat: Number(valid[valid.length - 1][1]),
          lng: Number(valid[valid.length - 1][0]),
          distKm: 0,
          distMi: 0,
        },
      ];
    }

    const samples = [];
    let segIdx = 0;

    for (let s = 0; s < count; s++) {
      const targetDist = s === count - 1 ? totalKm : (s / (count - 1)) * totalKm;
      while (segIdx < cumKm.length - 2 && cumKm[segIdx + 1] < targetDist) {
        segIdx++;
      }
      const d0 = cumKm[segIdx];
      const d1 = cumKm[segIdx + 1];
      const segLen = d1 - d0;
      const t = segLen > 1e-9 ? Math.max(0, Math.min(1, (targetDist - d0) / segLen)) : 0;

      const [lng1, lat1] = valid[segIdx];
      const [lng2, lat2] = valid[segIdx + 1];
      const lat = Number(lat1) + t * (Number(lat2) - Number(lat1));
      const lng = Number(lng1) + t * (Number(lng2) - Number(lng1));

      samples.push({
        index: s,
        lat: Number(lat.toFixed(5)),
        lng: Number(lng.toFixed(5)),
        distKm: Number(targetDist.toFixed(2)),
        distMi: Number((targetDist * KM_TO_MILES).toFixed(2)),
      });
    }

    return samples;
  }

  /**
   * Build Open-Meteo Elevation GET URL for a batch of points (<= 100 coordinates).
   */
  function buildOpenMeteoUrl(samples) {
    const lats = samples.map((p) => Number(p.lat).toFixed(4)).join(",");
    const lngs = samples.map((p) => Number(p.lng).toFixed(4)).join(",");
    return `${OPEN_METEO_ELEVATION_URL}?latitude=${lats}&longitude=${lngs}`;
  }

  /**
   * Deterministic, realistic synthetic elevation model (meters) when offline or upstream fails.
   * Models major North American / global topographic features + ridge/pass undulations.
   */
  function generateSyntheticElevations(samples) {
    if (!Array.isArray(samples) || !samples.length) return [];
    const n = samples.length;
    return samples.map((pt, i) => {
      const lat = Number(pt.lat) || 0;
      const lng = Number(pt.lng) || 0;
      const frac = n > 1 ? i / (n - 1) : 0;

      // Regional base elevation (higher in Western US interior / mountain longitudes)
      let baseM = 65;
      if (lng > -120.5 && lng < -104.0 && lat > 31 && lat < 49) {
        const interiorFactor = Math.sin(((lng + 120.5) / 16.5) * Math.PI);
        baseM += Math.max(0, interiorFactor) * 950;
      } else if (lng >= -84.0 && lng <= -76.0 && lat >= 34 && lat <= 45) {
        // Appalachian / Blue Ridge wave
        baseM += 260 * Math.sin(((lng + 84) / 8) * Math.PI);
      }

      // Mountain pass / ridge profile along the trip (e.g., Grapevine / Cajon / Baker pass)
      const passPeak1 = 420 * Math.exp(-Math.pow((frac - 0.36) / 0.14, 2));
      const passPeak2 = 580 * Math.exp(-Math.pow((frac - 0.72) / 0.12, 2));
      const valleyDip = -140 * Math.exp(-Math.pow((frac - 0.54) / 0.09, 2));
      const microTopo =
        65 * Math.sin(lat * 4.2 + lng * 3.1) + 40 * Math.cos(frac * Math.PI * 5);

      const elev = Math.max(5, Math.round(baseM + passPeak1 + passPeak2 + valleyDip + microTopo));
      return elev;
    });
  }

  /**
   * Attach elevations (m & ft) and local grade (%) to sampled points.
   */
  function enrichSamplesWithGrade(samples, elevationsM) {
    if (!Array.isArray(samples) || !samples.length) return [];
    const enriched = samples.map((s, idx) => {
      const rawM =
        Array.isArray(elevationsM) && Number.isFinite(Number(elevationsM[idx]))
          ? Number(elevationsM[idx])
          : 0;
      const elevM = Math.round(rawM);
      const elevFt = Math.round(rawM * METERS_TO_FEET);
      return Object.assign({}, s, {
        elevM,
        elevFt,
        gradePct: 0,
      });
    });

    for (let i = 0; i < enriched.length; i++) {
      const prev = enriched[Math.max(0, i - 1)];
      const next = enriched[Math.min(enriched.length - 1, i + 1)];
      const horizKm = next.distKm - prev.distKm;
      const dElevM = next.elevM - prev.elevM;
      if (horizKm > 0.05) {
        const rawGrade = (dElevM / (horizKm * 1000)) * 100;
        // Clamp extreme DEM step artifacts to realistic highway bounds [-15%, +15%]
        const clamped = Math.max(-15, Math.min(15, rawGrade));
        enriched[i].gradePct = Number(clamped.toFixed(1));
      } else {
        enriched[i].gradePct = 0;
      }
    }
    return enriched;
  }

  /**
   * Project stops (ORIGIN, SUPERCHARGER, DESTINATION) onto the sampled route profile.
   * Ensures monotonic progression along the route.
   */
  function projectStopsToProfile(stops, enrichedSamples) {
    if (!Array.isArray(stops) || !Array.isArray(enrichedSamples) || !enrichedSamples.length) {
      return [];
    }
    const lastSample = enrichedSamples[enrichedSamples.length - 1];
    let minSampleIdx = 0;

    return stops.map((stop, idx) => {
      if (stop.type === "ORIGIN" || idx === 0) {
        const s0 = enrichedSamples[0];
        return Object.assign({}, stop, {
          sampleIndex: 0,
          distKm: s0.distKm,
          distMi: s0.distMi,
          elevM: s0.elevM,
          elevFt: s0.elevFt,
          gradePct: s0.gradePct,
        });
      }
      if (stop.type === "DESTINATION" || idx === stops.length - 1) {
        return Object.assign({}, stop, {
          sampleIndex: enrichedSamples.length - 1,
          distKm: lastSample.distKm,
          distMi: lastSample.distMi,
          elevM: lastSample.elevM,
          elevFt: lastSample.elevFt,
          gradePct: lastSample.gradePct,
        });
      }

      // Find closest sample point at or after minSampleIdx
      let bestIdx = minSampleIdx;
      let bestDist = Infinity;
      const sLat = Number(stop.lat);
      const sLng = Number(stop.lng);

      for (let i = minSampleIdx; i < enrichedSamples.length; i++) {
        const p = enrichedSamples[i];
        const d = haversineKm(sLat, sLng, p.lat, p.lng);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      minSampleIdx = bestIdx;
      const matched = enrichedSamples[bestIdx];
      return Object.assign({}, stop, {
        sampleIndex: bestIdx,
        distKm: matched.distKm,
        distMi: matched.distMi,
        elevM: matched.elevM,
        elevFt: matched.elevFt,
        gradePct: matched.gradePct,
      });
    });
  }

  /**
   * Compute climb penalty (+kWh), regenerative braking recovery (-kWh), and net delta
   * for a slice of enriched samples [startIdx .. endIdx].
   */
  function computeSegmentEnergy(enrichedSamples, startIdx, endIdx) {
    if (!Array.isArray(enrichedSamples) || enrichedSamples.length < 2) {
      return {
        ascentM: 0,
        descentM: 0,
        ascentFt: 0,
        descentFt: 0,
        climbPenaltyKwh: 0,
        regenRecoveryKwh: 0,
        netElevationKwh: 0,
        netWhPerMi: 0,
        distKm: 0,
        distMi: 0,
      };
    }
    const lo = Math.max(0, Math.min(enrichedSamples.length - 1, startIdx || 0));
    const hi = Math.max(lo, Math.min(enrichedSamples.length - 1, endIdx ?? enrichedSamples.length - 1));

    const pePerMeterKwh = (PHYSICS.vehicleMassKg * PHYSICS.gravityMps2) / 3600000;
    const climbFactorKwhPerM = pePerMeterKwh / PHYSICS.climbEfficiency;
    const regenFactorKwhPerM = pePerMeterKwh * PHYSICS.regenEfficiency;

    let ascentM = 0;
    let descentM = 0;

    for (let i = lo; i < hi; i++) {
      const dh = enrichedSamples[i + 1].elevM - enrichedSamples[i].elevM;
      if (dh > PHYSICS.deadbandMeters) {
        ascentM += dh;
      } else if (dh < -PHYSICS.deadbandMeters) {
        descentM += Math.abs(dh);
      }
    }

    const climbPenaltyKwh = ascentM * climbFactorKwhPerM;
    const regenRecoveryKwh = descentM * regenFactorKwhPerM;
    const netElevationKwh = climbPenaltyKwh - regenRecoveryKwh;

    const distKm = Math.max(0, enrichedSamples[hi].distKm - enrichedSamples[lo].distKm);
    const distMi = distKm * KM_TO_MILES;
    const netWhPerMi = distMi > 0.5 ? Math.round((netElevationKwh * 1000) / distMi) : 0;

    return {
      ascentM: Math.round(ascentM),
      descentM: Math.round(descentM),
      ascentFt: Math.round(ascentM * METERS_TO_FEET),
      descentFt: Math.round(descentM * METERS_TO_FEET),
      climbPenaltyKwh: Number(climbPenaltyKwh.toFixed(2)),
      regenRecoveryKwh: Number(regenRecoveryKwh.toFixed(2)),
      netElevationKwh: Number(netElevationKwh.toFixed(2)),
      netWhPerMi,
      distKm: Number(distKm.toFixed(1)),
      distMi: Number(distMi.toFixed(1)),
    };
  }

  /**
   * Compute full-trip + per-leg elevation energy summary.
   */
  function computeElevationEnergyImpact(enrichedSamples, projectedStops) {
    const overall = computeSegmentEnergy(
      enrichedSamples,
      0,
      Math.max(0, (enrichedSamples || []).length - 1)
    );

    let minElevM = Infinity;
    let maxElevM = -Infinity;
    let maxGradePct = 0;
    for (const s of enrichedSamples || []) {
      if (s.elevM < minElevM) minElevM = s.elevM;
      if (s.elevM > maxElevM) maxElevM = s.elevM;
      if (Math.abs(s.gradePct) > Math.abs(maxGradePct)) {
        maxGradePct = s.gradePct;
      }
    }
    if (!Number.isFinite(minElevM)) minElevM = 0;
    if (!Number.isFinite(maxElevM)) maxElevM = 0;

    const legs = [];
    const stops =
      Array.isArray(projectedStops) && projectedStops.length >= 2
        ? projectedStops
        : enrichedSamples && enrichedSamples.length >= 2
          ? [
              {
                type: "ORIGIN",
                name: "Origin",
                sampleIndex: 0,
              },
              {
                type: "DESTINATION",
                name: "Destination",
                sampleIndex: enrichedSamples.length - 1,
              },
            ]
          : [];

    for (let i = 0; i < stops.length - 1; i++) {
      const fromStop = stops[i];
      const toStop = stops[i + 1];
      const seg = computeSegmentEnergy(
        enrichedSamples,
        fromStop.sampleIndex,
        toStop.sampleIndex
      );
      legs.push(
        Object.assign({}, seg, {
          legIndex: i + 1,
          fromName: fromStop.name || (i === 0 ? "Origin" : `Stop #${i}`),
          toName:
            toStop.name ||
            (i + 1 === stops.length - 1 ? "Destination" : `Stop #${i + 1}`),
          toStopType: toStop.type,
          toStopIndex: toStop.stop_index || null,
          startSampleIndex: fromStop.sampleIndex,
          endSampleIndex: toStop.sampleIndex,
        })
      );
    }

    return {
      overall: Object.assign({}, overall, {
        minElevM,
        maxElevM,
        minElevFt: Math.round(minElevM * METERS_TO_FEET),
        maxElevFt: Math.round(maxElevM * METERS_TO_FEET),
        maxGradePct,
      }),
      legs,
    };
  }

  function formatSignedKwh(val) {
    const n = Number(val) || 0;
    const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
    return `${sign}${Math.abs(n).toFixed(1)} kWh`;
  }

  function formatSignedWhMi(val) {
    const n = Math.round(Number(val) || 0);
    const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
    return `${sign}${Math.abs(n)} Wh/mi`;
  }

  const ElevationModule = {
    _map: null,
    _containerEl: null,
    _stripEl: null,
    _collapsed: false,
    _unit: "ft", // 'ft' | 'm'
    _profile: null,
    _hoverMarker: null,
    _activeSampleIdx: null,
    _fetchSeq: 0,
    _abortCtrl: null,
    _boundRoutePlanned: null,

    _test: {
      OPEN_METEO_ELEVATION_URL,
      DEFAULT_SAMPLE_COUNT,
      PHYSICS,
      haversineKm,
      escapeHtml,
      extractRouteCoordinates,
      sampleRouteGeometry,
      buildOpenMeteoUrl,
      generateSyntheticElevations,
      enrichSamplesWithGrade,
      projectStopsToProfile,
      computeSegmentEnergy,
      computeElevationEnergyImpact,
      formatSignedKwh,
      formatSignedWhMi,
    },

    mount(opts = {}) {
      const map = opts.map || (global.appState && global.appState.map) || null;
      const host =
        opts.containerEl ||
        (typeof document !== "undefined" && document.querySelector(".map-container")) ||
        null;
      if (!host) return;

      this._map = map;
      this._containerEl = host;
      this._ensureStripDom();

      if (!this._boundRoutePlanned && typeof window !== "undefined") {
        this._boundRoutePlanned = (ev) => {
          const plan = (ev && ev.detail && ev.detail.plan) || (ev && ev.detail) || null;
          if (plan) this.renderForPlan(plan);
        };
        window.addEventListener("routePlanned", this._boundRoutePlanned);
      }

      // If a plan is already active on mount, render immediately
      if (global.appState && global.appState.activePlan) {
        this.renderForPlan(global.appState.activePlan);
      }
    },

    unmount() {
      if (this._boundRoutePlanned && typeof window !== "undefined") {
        window.removeEventListener("routePlanned", this._boundRoutePlanned);
        this._boundRoutePlanned = null;
      }
      this._clearHoverMarker();
      if (this._abortCtrl) {
        this._abortCtrl.abort();
        this._abortCtrl = null;
      }
      if (this._stripEl && this._stripEl.parentNode) {
        this._stripEl.parentNode.removeChild(this._stripEl);
      }
      if (typeof document !== "undefined" && document.body) {
        document.body.classList.remove("elevation-strip-visible", "elevation-strip-collapsed");
      }
      this._stripEl = null;
      this._profile = null;
    },

    getProfileData() {
      return this._profile;
    },

    _ensureStripDom() {
      if (this._stripEl && this._containerEl.contains(this._stripEl)) return;
      const existing =
        typeof document !== "undefined" ? document.getElementById("elevationStrip") : null;
      if (existing) {
        this._stripEl = existing;
        return;
      }

      const el = document.createElement("section");
      el.id = "elevationStrip";
      el.className = "elevation-strip";
      el.setAttribute("aria-label", "Route elevation and grade profile");
      el.hidden = true;

      el.innerHTML = `
        <div class="elevation-strip-header" id="elevationStripHeader">
          <div class="elevation-title-group">
            <span class="elevation-title-icon"><i class="fa-solid fa-mountain-sun" aria-hidden="true"></i></span>
            <span class="elevation-title-text">Elevation &amp; Grade</span>
            <span class="elevation-source-pill" id="elevationSourcePill" title="Elevation data source">DEM</span>
          </div>

          <div class="elevation-badges" id="elevationBadges">
            <span class="elev-badge elev-badge-climb" id="elevBadgeClimb" title="Climbing energy penalty (ascent)">
              <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
              <span id="elevClimbText">+0.0 kWh</span>
            </span>
            <span class="elev-badge elev-badge-regen" id="elevBadgeRegen" title="Regenerative braking energy recovery (descent)">
              <i class="fa-solid fa-bolt" aria-hidden="true"></i>
              <span id="elevRegenText">−0.0 kWh</span>
            </span>
            <span class="elev-badge elev-badge-net" id="elevBadgeNet" title="Net elevation battery impact">
              <span id="elevNetKwhText">±0.0 kWh</span>
              <span class="elev-badge-sep">·</span>
              <span id="elevNetWhMiText">±0 Wh/mi</span>
            </span>
          </div>

          <div class="elevation-controls">
            <button type="button" class="elev-unit-btn" id="btnElevUnit" title="Toggle feet / meters" aria-label="Toggle elevation units">
              ft
            </button>
            <button type="button" class="elev-collapse-btn" id="btnElevCollapse" title="Collapse or expand elevation profile" aria-expanded="true" aria-controls="elevationStripBody">
              <i class="fa-solid fa-chevron-down" aria-hidden="true"></i>
            </button>
          </div>
        </div>

        <div class="elevation-strip-body" id="elevationStripBody">
          <div class="elevation-scrub-bar" id="elevationScrubBar">
            <span class="elev-scrub-stat" id="elevScrubDist">Dist: -- mi</span>
            <span class="elev-scrub-stat" id="elevScrubAlt">Elev: -- ft</span>
            <span class="elev-scrub-stat" id="elevScrubGrade">Grade: 0.0%</span>
            <span class="elev-scrub-leg" id="elevScrubLeg">Hover or drag chart to inspect route grade &amp; stops</span>
          </div>
          <div class="elevation-chart-wrap" id="elevationChartWrap">
            <svg class="elevation-svg" id="elevationSvg" viewBox="0 0 680 112" preserveAspectRatio="none" role="img" aria-label="Elevation area chart with Supercharger stops"></svg>
          </div>
        </div>
      `;

      this._containerEl.appendChild(el);
      this._stripEl = el;

      const unitBtn = el.querySelector("#btnElevUnit");
      if (unitBtn) {
        unitBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this._unit = this._unit === "ft" ? "m" : "ft";
          unitBtn.textContent = this._unit;
          this._renderProfileView();
        });
      }

      const collapseBtn = el.querySelector("#btnElevCollapse");
      if (collapseBtn) {
        collapseBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          this.setCollapsed(!this._collapsed);
        });
      }

      const header = el.querySelector("#elevationStripHeader");
      if (header) {
        header.addEventListener("click", (e) => {
          if (e.target.closest("button")) return;
          if (this._collapsed) this.setCollapsed(false);
        });
      }

      this._bindChartInteractions();
    },

    setCollapsed(collapsed) {
      this._collapsed = !!collapsed;
      if (!this._stripEl) return;
      this._stripEl.classList.toggle("is-collapsed", this._collapsed);
      if (typeof document !== "undefined" && document.body) {
        document.body.classList.toggle("elevation-strip-collapsed", this._collapsed);
      }
      const btn = this._stripEl.querySelector("#btnElevCollapse");
      if (btn) {
        btn.setAttribute("aria-expanded", this._collapsed ? "false" : "true");
        const icon = btn.querySelector("i");
        if (icon) {
          icon.className = this._collapsed
            ? "fa-solid fa-chevron-up"
            : "fa-solid fa-chevron-down";
        }
      }
      if (!this._collapsed && this._profile) {
        this._renderProfileView();
      }
    },

    async _fetchElevations(samples, signal) {
      const elevations = [];
      for (let i = 0; i < samples.length; i += MAX_COORDS_PER_REQUEST) {
        const chunk = samples.slice(i, i + MAX_COORDS_PER_REQUEST);
        const url = buildOpenMeteoUrl(chunk);
        const resp = await fetch(url, {
          method: "GET",
          signal,
          headers: { Accept: "application/json" },
        });
        if (!resp.ok) {
          throw new Error(`Open-Meteo HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (!data || !Array.isArray(data.elevation) || data.elevation.length !== chunk.length) {
          throw new Error("Invalid Open-Meteo elevation payload");
        }
        for (const v of data.elevation) {
          elevations.push(Number.isFinite(Number(v)) ? Number(v) : 0);
        }
      }
      return elevations;
    },

    async renderForPlan(plan) {
      this._ensureStripDom();
      if (!this._stripEl) return null;

      const coords = extractRouteCoordinates(plan);
      if (coords.length < 2) {
        this._stripEl.hidden = true;
        if (typeof document !== "undefined" && document.body) {
          document.body.classList.remove("elevation-strip-visible");
        }
        return null;
      }

      const seq = ++this._fetchSeq;
      if (this._abortCtrl) this._abortCtrl.abort();
      this._abortCtrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const signal = this._abortCtrl ? this._abortCtrl.signal : undefined;

      this._stripEl.hidden = false;
      if (typeof document !== "undefined" && document.body) {
        document.body.classList.add("elevation-strip-visible");
      }

      const samples = sampleRouteGeometry(coords, DEFAULT_SAMPLE_COUNT);
      let elevationsM = null;
      let source = "open-meteo";

      try {
        elevationsM = await this._fetchElevations(samples, signal);
      } catch (err) {
        if (err && err.name === "AbortError") return null;
        elevationsM = generateSyntheticElevations(samples);
        source = "synthetic-fallback";
      }

      if (seq !== this._fetchSeq) return null;

      const enrichedSamples = enrichSamplesWithGrade(samples, elevationsM);
      const projectedStops = projectStopsToProfile(plan.stops || [], enrichedSamples);
      const energy = computeElevationEnergyImpact(enrichedSamples, projectedStops);

      this._profile = {
        source,
        samples: enrichedSamples,
        stops: projectedStops,
        energy,
        planSummary: plan.summary || {},
      };
      this._activeSampleIdx = null;
      this._clearHoverMarker();
      this._renderProfileView();
      return this._profile;
    },

    _renderProfileView() {
      if (!this._stripEl || !this._profile) return;
      const { source, samples, stops, energy } = this._profile;
      const overall = energy.overall;
      const isFt = this._unit === "ft";

      const sourcePill = this._stripEl.querySelector("#elevationSourcePill");
      if (sourcePill) {
        sourcePill.textContent = source === "open-meteo" ? "Open-Meteo DEM" : "Terrain Est.";
        sourcePill.classList.toggle("is-fallback", source !== "open-meteo");
      }

      const climbEl = this._stripEl.querySelector("#elevClimbText");
      if (climbEl) {
        const gainStr = isFt ? `+${overall.ascentFt.toLocaleString()} ft` : `+${overall.ascentM.toLocaleString()} m`;
        climbEl.textContent = `+${overall.climbPenaltyKwh.toFixed(1)} kWh (${gainStr})`;
      }

      const regenEl = this._stripEl.querySelector("#elevRegenText");
      if (regenEl) {
        const lossStr = isFt ? `−${overall.descentFt.toLocaleString()} ft` : `−${overall.descentM.toLocaleString()} m`;
        regenEl.textContent = `−${overall.regenRecoveryKwh.toFixed(1)} kWh (${lossStr})`;
      }

      const netKwhEl = this._stripEl.querySelector("#elevNetKwhText");
      const netWhMiEl = this._stripEl.querySelector("#elevNetWhMiText");
      const netBadge = this._stripEl.querySelector("#elevBadgeNet");
      if (netKwhEl) netKwhEl.textContent = `Net ${formatSignedKwh(overall.netElevationKwh)}`;
      if (netWhMiEl) netWhMiEl.textContent = formatSignedWhMi(overall.netWhPerMi);
      if (netBadge) {
        netBadge.classList.toggle("is-penalty", overall.netElevationKwh > 0.25);
        netBadge.classList.toggle("is-saving", overall.netElevationKwh < -0.25);
      }

      // Default scrub bar summary when not hovering
      if (this._activeSampleIdx == null) {
        this._updateScrubReadout(null);
      } else {
        this._updateScrubReadout(this._activeSampleIdx);
      }

      this._renderSvgChart(samples, stops, overall);
    },

    _renderSvgChart(samples, stops, overall) {
      const svg = this._stripEl && this._stripEl.querySelector("#elevationSvg");
      if (!svg || !samples || samples.length < 2) return;

      const W = 680;
      const H = 112;
      const padL = 42;
      const padR = 14;
      const padT = 16;
      const padB = 20;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;

      const isFt = this._unit === "ft";
      const vals = samples.map((s) => (isFt ? s.elevFt : s.elevM));
      const rawMin = Math.min(...vals);
      const rawMax = Math.max(...vals);
      const span = Math.max(isFt ? 200 : 60, rawMax - rawMin);
      const yMin = Math.max(0, Math.floor((rawMin - span * 0.08) / 10) * 10);
      const yMax = Math.ceil((rawMax + span * 0.12) / 10) * 10;
      const yRange = Math.max(1, yMax - yMin);

      const totalDistKm = Math.max(0.1, samples[samples.length - 1].distKm);

      const xFor = (distKm) => padL + Math.max(0, Math.min(1, distKm / totalDistKm)) * plotW;
      const yFor = (val) => padT + (1 - (val - yMin) / yRange) * plotH;

      const pts = samples.map((s, idx) => ({
        idx,
        x: Number(xFor(s.distKm).toFixed(1)),
        y: Number(yFor(isFt ? s.elevFt : s.elevM).toFixed(1)),
        s,
      }));

      const linePath = pts
        .map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`)
        .join(" ");
      const baselineY = (padT + plotH).toFixed(1);
      const areaPath = `${linePath} L${pts[pts.length - 1].x},${baselineY} L${pts[0].x},${baselineY} Z`;

      // Horizontal reference lines (min / mid / max)
      const yMidVal = Math.round((yMin + yMax) / 2);
      const yTop = padT;
      const yMid = Math.round(padT + plotH / 2);
      const yBot = padT + plotH;

      // Supercharger pins plotted right on the ridge/valley curve
      const chargerPins = (stops || [])
        .filter((st) => st.type === "SUPERCHARGER")
        .map((st) => {
          const sample = samples[st.sampleIndex] || samples[0];
          const cx = Number(xFor(sample.distKm).toFixed(1));
          const cy = Number(yFor(isFt ? sample.elevFt : sample.elevM).toFixed(1));
          const isForced = !!st.forced;
          const color = isForced ? "#00b4d8" : "#e82127";
          const label = st.stop_index ? `#${st.stop_index}` : "SC";
          const title = `${st.name || "Supercharger"} (${isFt ? sample.elevFt + " ft" : sample.elevM + " m"})`;
          return `
            <g class="elev-stop-pin ${isForced ? "is-forced" : ""}" data-sample-index="${st.sampleIndex}" data-stop-index="${escapeHtml(st.stop_index || "")}">
              <title>${escapeHtml(title)}</title>
              <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${yBot}" stroke="${color}" stroke-width="1" stroke-dasharray="2,2" opacity="0.55" />
              <circle cx="${cx}" cy="${cy}" r="5.5" fill="${color}" stroke="#ffffff" stroke-width="1.6" />
              <text x="${cx}" y="${Math.max(10, cy - 8)}" text-anchor="middle" class="elev-pin-label">${escapeHtml(label)}</text>
            </g>
          `;
        })
        .join("");

      const totalMi = (totalDistKm * KM_TO_MILES).toFixed(0);
      const midMi = ((totalDistKm * KM_TO_MILES) / 2).toFixed(0);

      svg.innerHTML = `
        <defs>
          <linearGradient id="elevAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#e82127" stop-opacity="0.48" />
            <stop offset="55%" stop-color="#00b4d8" stop-opacity="0.22" />
            <stop offset="100%" stop-color="#10b981" stop-opacity="0.05" />
          </linearGradient>
        </defs>

        <!-- Grid lines & Y-axis labels -->
        <line x1="${padL}" y1="${yTop}" x2="${W - padR}" y2="${yTop}" class="elev-grid-line" />
        <line x1="${padL}" y1="${yMid}" x2="${W - padR}" y2="${yMid}" class="elev-grid-line" />
        <line x1="${padL}" y1="${yBot}" x2="${W - padR}" y2="${yBot}" class="elev-grid-line" />

        <text x="${padL - 5}" y="${yTop + 4}" text-anchor="end" class="elev-axis-label">${yMax}${this._unit}</text>
        <text x="${padL - 5}" y="${yMid + 3}" text-anchor="end" class="elev-axis-label">${yMidVal}${this._unit}</text>
        <text x="${padL - 5}" y="${yBot + 3}" text-anchor="end" class="elev-axis-label">${yMin}${this._unit}</text>

        <!-- X-axis distance labels -->
        <text x="${padL}" y="${H - 4}" text-anchor="start" class="elev-axis-label">0 mi</text>
        <text x="${(padL + plotW / 2).toFixed(0)}" y="${H - 4}" text-anchor="middle" class="elev-axis-label">${midMi} mi</text>
        <text x="${W - padR}" y="${H - 4}" text-anchor="end" class="elev-axis-label">${totalMi} mi</text>

        <!-- Terrain Area & Ridge Curve -->
        <path d="${areaPath}" fill="url(#elevAreaGrad)" class="elev-area-path" />
        <path d="${linePath}" fill="none" stroke="#f87171" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="elev-line-path" />

        <!-- Origin & Destination endpoints -->
        <circle cx="${pts[0].x}" cy="${pts[0].y}" r="4.5" fill="#10b981" stroke="#fff" stroke-width="1.5" class="elev-endpoint-origin" />
        <circle cx="${pts[pts.length - 1].x}" cy="${pts[pts.length - 1].y}" r="4.5" fill="#e82127" stroke="#fff" stroke-width="1.5" class="elev-endpoint-dest" />

        <!-- Supercharger Stop Pins -->
        <g id="elevStopPinsGroup">${chargerPins}</g>

        <!-- Interactive Scrub Cursor -->
        <g id="elevCursorGroup" style="display:none;">
          <line id="elevCursorLine" x1="0" y1="${yTop}" x2="0" y2="${yBot}" stroke="#38bdf8" stroke-width="1.5" stroke-dasharray="3,2" />
          <circle id="elevCursorDot" cx="0" cy="0" r="5.5" fill="#38bdf8" stroke="#ffffff" stroke-width="2" />
        </g>
      `;

      this._chartGeometry = { W, H, padL, padR, padT, padB, plotW, plotH, pts };
      if (this._activeSampleIdx != null) {
        this._updateCursorVisual(this._activeSampleIdx);
      }
    },

    _bindChartInteractions() {
      const wrap = this._stripEl && this._stripEl.querySelector("#elevationChartWrap");
      if (!wrap) return;

      const handlePointer = (clientX) => {
        if (!this._profile || !this._chartGeometry) return;
        const svg = this._stripEl.querySelector("#elevationSvg");
        if (!svg) return;
        const rect = svg.getBoundingClientRect();
        if (!rect || rect.width <= 0) return;

        const relX = ((clientX - rect.left) / rect.width) * this._chartGeometry.W;
        const { padL, plotW, pts } = this._chartGeometry;
        const frac = Math.max(0, Math.min(1, (relX - padL) / plotW));
        const idx = Math.round(frac * (pts.length - 1));
        this.highlightSampleIndex(idx);
      };

      wrap.addEventListener("mousemove", (e) => {
        handlePointer(e.clientX);
      });

      wrap.addEventListener("click", (e) => {
        const pin = e.target && e.target.closest ? e.target.closest(".elev-stop-pin") : null;
        if (pin && pin.dataset.sampleIndex != null) {
          const idx = Number(pin.dataset.sampleIndex);
          if (Number.isFinite(idx)) {
            this.highlightSampleIndex(idx, { panMap: true });
            return;
          }
        }
        handlePointer(e.clientX);
      });

      wrap.addEventListener("mouseleave", () => {
        this.clearHighlight();
      });

      wrap.addEventListener(
        "touchstart",
        (e) => {
          if (e.touches && e.touches[0]) {
            handlePointer(e.touches[0].clientX);
          }
        },
        { passive: true }
      );

      wrap.addEventListener(
        "touchmove",
        (e) => {
          if (e.touches && e.touches[0]) {
            handlePointer(e.touches[0].clientX);
          }
        },
        { passive: true }
      );
    },

    highlightSampleIndex(idx, opts = {}) {
      if (!this._profile || !Array.isArray(this._profile.samples)) return null;
      const samples = this._profile.samples;
      const clamped = Math.max(0, Math.min(samples.length - 1, Math.round(idx)));
      this._activeSampleIdx = clamped;

      this._updateCursorVisual(clamped);
      this._updateScrubReadout(clamped);
      this._updateMapHoverMarker(samples[clamped], opts);
      return samples[clamped];
    },

    clearHighlight() {
      this._activeSampleIdx = null;
      if (this._stripEl) {
        const cursorGroup = this._stripEl.querySelector("#elevCursorGroup");
        if (cursorGroup) cursorGroup.style.display = "none";
      }
      this._updateScrubReadout(null);
      this._clearHoverMarker();
    },

    _updateCursorVisual(idx) {
      if (!this._stripEl || !this._chartGeometry) return;
      const pt = this._chartGeometry.pts[idx];
      if (!pt) return;
      const cursorGroup = this._stripEl.querySelector("#elevCursorGroup");
      const line = this._stripEl.querySelector("#elevCursorLine");
      const dot = this._stripEl.querySelector("#elevCursorDot");
      if (cursorGroup && line && dot) {
        cursorGroup.style.display = "block";
        line.setAttribute("x1", String(pt.x));
        line.setAttribute("x2", String(pt.x));
        dot.setAttribute("cx", String(pt.x));
        dot.setAttribute("cy", String(pt.y));
      }
    },

    _findLegForSample(idx) {
      if (!this._profile || !this._profile.energy || !Array.isArray(this._profile.energy.legs)) {
        return null;
      }
      const legs = this._profile.energy.legs;
      for (const leg of legs) {
        if (idx >= leg.startSampleIndex && idx <= leg.endSampleIndex) {
          return leg;
        }
      }
      return legs[legs.length - 1] || null;
    },

    _updateScrubReadout(idx) {
      if (!this._stripEl || !this._profile) return;
      const distEl = this._stripEl.querySelector("#elevScrubDist");
      const altEl = this._stripEl.querySelector("#elevScrubAlt");
      const gradeEl = this._stripEl.querySelector("#elevScrubGrade");
      const legEl = this._stripEl.querySelector("#elevScrubLeg");
      const isFt = this._unit === "ft";
      const overall = this._profile.energy.overall;

      if (idx == null || !this._profile.samples[idx]) {
        const minVal = isFt ? `${overall.minElevFt.toLocaleString()} ft` : `${overall.minElevM.toLocaleString()} m`;
        const maxVal = isFt ? `${overall.maxElevFt.toLocaleString()} ft` : `${overall.maxElevM.toLocaleString()} m`;
        if (distEl) distEl.textContent = `Span: ${overall.distMi} mi`;
        if (altEl) altEl.textContent = `Range: ${minVal} – ${maxVal}`;
        if (gradeEl) {
          const sign = overall.maxGradePct > 0 ? "+" : "";
          gradeEl.textContent = `Peak grade: ${sign}${overall.maxGradePct.toFixed(1)}%`;
          gradeEl.className = "elev-scrub-stat";
        }
        if (legEl) {
          const legCount = (this._profile.energy.legs || []).length;
          legEl.textContent = `${legCount} leg${legCount === 1 ? "" : "s"} · Hover/tap chart to scrub grade & stops`;
        }
        return;
      }

      const s = this._profile.samples[idx];
      if (distEl) distEl.textContent = `Dist: ${s.distMi.toFixed(1)} mi`;
      if (altEl) {
        altEl.textContent = isFt
          ? `Elev: ${s.elevFt.toLocaleString()} ft`
          : `Elev: ${s.elevM.toLocaleString()} m`;
      }
      if (gradeEl) {
        const g = s.gradePct;
        const sign = g > 0 ? "+" : "";
        gradeEl.textContent = `Grade: ${sign}${g.toFixed(1)}%`;
        gradeEl.className =
          "elev-scrub-stat " +
          (g >= 2.0 ? "is-uphill" : g <= -2.0 ? "is-downhill" : "is-flat");
      }

      const leg = this._findLegForSample(idx);
      if (legEl && leg) {
        legEl.textContent = `Leg #${leg.legIndex} (→ ${leg.toName}): ${formatSignedKwh(leg.netElevationKwh)} net (+${leg.climbPenaltyKwh.toFixed(1)} climb / −${leg.regenRecoveryKwh.toFixed(1)} regen)`;
      }
    },

    _updateMapHoverMarker(sample, opts = {}) {
      const map = this._map || (global.appState && global.appState.map);
      if (!map || typeof L === "undefined" || !sample) return;

      const isFt = this._unit === "ft";
      const elevStr = isFt ? `${sample.elevFt.toLocaleString()} ft` : `${sample.elevM.toLocaleString()} m`;
      const gradeSign = sample.gradePct > 0 ? "+" : "";
      const labelHtml = `${elevStr} · ${gradeSign}${sample.gradePct.toFixed(1)}% · ${sample.distMi.toFixed(1)} mi`;

      if (!this._hoverMarker) {
        this._hoverMarker = L.circleMarker([sample.lat, sample.lng], {
          radius: 7,
          color: "#ffffff",
          weight: 2.5,
          fillColor: "#38bdf8",
          fillOpacity: 0.95,
          interactive: false,
          pane: "markerPane",
        }).addTo(map);
        this._hoverMarker.bindTooltip(labelHtml, {
          permanent: true,
          direction: "top",
          offset: [0, -10],
          className: "elevation-map-tooltip",
        });
      } else {
        this._hoverMarker.setLatLng([sample.lat, sample.lng]);
        this._hoverMarker.setTooltipContent(labelHtml);
        if (!map.hasLayer(this._hoverMarker)) {
          this._hoverMarker.addTo(map);
        }
      }

      if (opts && opts.panMap && typeof map.panTo === "function") {
        map.panTo([sample.lat, sample.lng], { animate: true });
      }
    },

    _clearHoverMarker() {
      const map = this._map || (global.appState && global.appState.map);
      if (this._hoverMarker && map && typeof map.removeLayer === "function") {
        try {
          map.removeLayer(this._hoverMarker);
        } catch (_) {
          /* ignore */
        }
      }
      this._hoverMarker = null;
    },
  };

  global.ElevationModule = ElevationModule;
})(typeof window !== "undefined" ? window : globalThis);

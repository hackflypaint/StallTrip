/**
 * Removable Elevation-Aware Battery & Grade Profile Strip.
 *
 * 100% client-side route elevation & grade profiling using the
 * Tesla in-car Navigation / Energy App longitudinal vehicle dynamics model:
 * - Samples ~50 equidistant points along the planned route geometry (or stop coordinates).
 * - Queries the free, no-key Open-Meteo Elevation API directly from the browser
 *   (https://api.open-meteo.com/v1/elevation?latitude=...&longitude=...),
 *   with a deterministic synthetic terrain fallback when offline.
 * - Longitudinal EV Dynamics & Potential Energy Model:
 *   - Gravitational potential energy: ΔE_pot = m * g * Δh / 3,600,000 (kWh), g = 9.80665 m/s²
 *   - Vehicle mass presets (m = m_curb + m_payload):
 *     Model 3 LR (1,980 kg), Model Y LR (2,130 kg), Model S/X (2,350 kg), Cybertruck (3,150 kg)
 *   - Climbing (Δh > 0): Tractive motor + SiC inverter efficiency η_drive ≈ 0.90
 *     with high-power I²R derating on steep grades (>3%):
 *       ΔE_climb = (m * g * Δh) / (3,600,000 * η_climb(G))
 *   - Descent (Δh < 0): Two physical regimes (matching Tesla Energy App):
 *     1. Gentle descent (0 > G >= G_coast ≈ -2.2%): Gravity offsets forward tractive motor
 *        draw required to overcome aerodynamic + rolling resistance (no battery inversion
 *        loop required; effective draw savings η_shallow ≈ 0.85).
 *     2. Steep descent (G < G_coast): Gravity exceeds road load; excess mechanical power
 *        drives the motor as a generator through the inverter into the pack at round-trip
 *        regenerative efficiency η_regen ≈ 0.75, capped by pack max regen power (65–85 kW).
 *   - Computes Net kWh, Net Wh/mi, and Net SoC % impact relative to active battery capacity.
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
  const JOULES_PER_KWH = 3600000;

  /**
   * Tesla Vehicle Mass & Longitudinal Aero/Rolling Presets
   * Mass m includes curb weight + ~150 kg typical occupants & luggage payload.
   */
  const VEHICLE_MASS_PRESETS = {
    model3_lr: {
      id: "model3_lr",
      label: "Model 3 LR",
      shortLabel: "M3 LR (1,980 kg)",
      massKg: 1980,
      defaultPackKwh: 75,
      dragAreaCdA: 0.48,
      crr: 0.0085,
      maxRegenKw: 65,
    },
    modely_lr: {
      id: "modely_lr",
      label: "Model Y LR",
      shortLabel: "MY LR (2,130 kg)",
      massKg: 2130,
      defaultPackKwh: 75,
      dragAreaCdA: 0.56,
      crr: 0.009,
      maxRegenKw: 70,
    },
    models_x: {
      id: "models_x",
      label: "Model S / X",
      shortLabel: "MS/X (2,350 kg)",
      massKg: 2350,
      defaultPackKwh: 100,
      dragAreaCdA: 0.51,
      crr: 0.009,
      maxRegenKw: 75,
    },
    cybertruck: {
      id: "cybertruck",
      label: "Cybertruck",
      shortLabel: "CT (3,150 kg)",
      massKg: 3150,
      defaultPackKwh: 123,
      dragAreaCdA: 0.92,
      crr: 0.011,
      maxRegenKw: 85,
    },
  };

  /**
   * Tesla in-car Navigation / Energy App longitudinal physics constants:
   * - Gravity g = 9.80665 m/s²
   * - Tractive drivetrain efficiency η_drive = 0.90 (SiC inverter ~0.97 * PM motor ~0.94 * gear ~0.985)
   * - Steep-grade round-trip regenerative efficiency η_regen = 0.75
   *   (wheel -> gear -> motor generator -> SiC inverter -> Li-ion charge acceptance)
   * - Gentle-grade tractive offset efficiency η_shallow = 0.85
   *   (gravity reduces forward motor current draw without battery charge inversion)
   * - Highway reference speed v = 29.0576 m/s (65 mph)
   */
  const PHYSICS = {
    vehicleMassKg: VEHICLE_MASS_PRESETS.modely_lr.massKg,
    defaultPresetId: "modely_lr",
    gravityMps2: 9.80665,
    airDensityKgM3: 1.204,
    cruiseSpeedMps: 29.0576, // 65 mph
    driveEfficiency: 0.9,
    climbEfficiency: 0.9,
    regenEfficiency: 0.75,
    shallowDescentEfficiency: 0.85,
    steepGradeThresholdPct: -2.2,
    deadbandMeters: 1.0,
    defaultPackKwh: 75,
  };

  /**
   * Infer or resolve the Tesla vehicle preset from preset ID or battery capacity (kWh).
   */
  function resolveVehiclePreset(opts = {}) {
    if (opts && opts.vehiclePresetId && VEHICLE_MASS_PRESETS[opts.vehiclePresetId]) {
      return VEHICLE_MASS_PRESETS[opts.vehiclePresetId];
    }
    const cap = Number(opts && opts.batteryCapacityKwh);
    if (Number.isFinite(cap) && cap > 0) {
      if (cap <= 65) return VEHICLE_MASS_PRESETS.model3_lr;
      if (cap <= 85) return VEHICLE_MASS_PRESETS.modely_lr;
      if (cap <= 110) return VEHICLE_MASS_PRESETS.models_x;
      return VEHICLE_MASS_PRESETS.cybertruck;
    }
    return VEHICLE_MASS_PRESETS.modely_lr;
  }

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

      let baseM = 65;
      if (lng > -120.5 && lng < -104.0 && lat > 31 && lat < 49) {
        const interiorFactor = Math.sin(((lng + 120.5) / 16.5) * Math.PI);
        baseM += Math.max(0, interiorFactor) * 950;
      } else if (lng >= -84.0 && lng <= -76.0 && lat >= 34 && lat <= 45) {
        baseM += 260 * Math.sin(((lng + 84) / 8) * Math.PI);
      }

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
   * Tesla in-car Navigation / Energy App segment-by-segment longitudinal energy physics.
   *
   * Computes:
   * - Potential energy: ΔE_pot = m * g * Δh / 3,600,000 (kWh)
   * - Ascent tractive battery penalty (+kWh):
   *     ΔE_climb = ΔE_pot / η_climb(G), where η_drive = 0.90 with high-current I²R derating on grades >3%
   * - Descent battery recovery (-kWh):
   *     Splits downhill segments at the zero-torque coasting grade G_coast = -(F_aero + F_roll)/(m*g):
   *     - Gentle descent (0 > G >= G_coast): Gravity directly reduces tractive motor draw (η_shallow = 0.85)
   *     - Steep descent (G < G_coast): Excess potential energy drives active regenerative braking into the
   *       battery pack at round-trip efficiency η_regen = 0.75, capped by pack max regen power (kW).
   * - Net elevation battery delta (kWh), Wh/mi impact, and Net SoC % impact.
   */
  function computeSegmentEnergy(enrichedSamples, startIdx, endIdx, opts = {}) {
    const preset = resolveVehiclePreset(opts);
    const massKg =
      Number.isFinite(Number(opts.vehicleMassKg)) && Number(opts.vehicleMassKg) > 500
        ? Number(opts.vehicleMassKg)
        : preset.massKg;
    const packKwh =
      Number.isFinite(Number(opts.batteryCapacityKwh)) && Number(opts.batteryCapacityKwh) > 10
        ? Number(opts.batteryCapacityKwh)
        : preset.defaultPackKwh || PHYSICS.defaultPackKwh;
    const vMps =
      Number.isFinite(Number(opts.cruiseSpeedMps)) && Number(opts.cruiseSpeedMps) > 5
        ? Number(opts.cruiseSpeedMps)
        : PHYSICS.cruiseSpeedMps;
    const maxRegenKw =
      Number.isFinite(Number(opts.maxRegenKw)) && Number(opts.maxRegenKw) > 10
        ? Number(opts.maxRegenKw)
        : preset.maxRegenKw || 70;

    if (!Array.isArray(enrichedSamples) || enrichedSamples.length < 2) {
      return {
        ascentM: 0,
        descentM: 0,
        ascentFt: 0,
        descentFt: 0,
        potentialEnergyAscentKwh: 0,
        potentialEnergyDescentKwh: 0,
        climbPenaltyKwh: 0,
        regenRecoveryKwh: 0,
        activeRegenKwh: 0,
        shallowGravityOffsetKwh: 0,
        netElevationKwh: 0,
        netWhPerMi: 0,
        netSocDeltaPct: 0,
        vehicleMassKg: massKg,
        vehiclePresetId: preset.id,
        vehicleLabel: preset.label,
        batteryCapacityKwh: packKwh,
        distKm: 0,
        distMi: 0,
      };
    }

    const lo = Math.max(0, Math.min(enrichedSamples.length - 1, startIdx || 0));
    const hi = Math.max(lo, Math.min(enrichedSamples.length - 1, endIdx ?? enrichedSamples.length - 1));

    const g = PHYSICS.gravityMps2;
    const pePerMeterKwh = (massKg * g) / JOULES_PER_KWH;

    // Aerodynamic + rolling resistance flat force at reference cruise speed
    const fAeroN = 0.5 * PHYSICS.airDensityKgM3 * (preset.dragAreaCdA || 0.56) * vMps * vMps;
    const fRollN = massKg * g * (preset.crr || 0.009);
    const fFlatN = fAeroN + fRollN;
    // Zero-torque coasting grade (%) where gravity balances road load
    const coastGradePct = -((fFlatN / (massKg * g)) * 100); // ~ -2.1% to -2.3%

    let ascentM = 0;
    let descentM = 0;
    let potentialEnergyAscentKwh = 0;
    let potentialEnergyDescentKwh = 0;
    let climbPenaltyKwh = 0;
    let regenRecoveryKwh = 0;
    let activeRegenKwh = 0;
    let shallowGravityOffsetKwh = 0;

    for (let i = lo; i < hi; i++) {
      const s0 = enrichedSamples[i];
      const s1 = enrichedSamples[i + 1];
      const dh = s1.elevM - s0.elevM;
      const dHorizM = Math.max(100, (s1.distKm - s0.distKm) * 1000);
      const segGradePct = (dh / dHorizM) * 100;

      if (dh > PHYSICS.deadbandMeters) {
        ascentM += dh;
        const dPeKwh = dh * pePerMeterKwh;
        potentialEnergyAscentKwh += dPeKwh;

        // Tractive motor + SiC inverter efficiency with high-load I²R stator/pack derating on steep climbs
        const steepOver3 = Math.max(0, Math.min(12, segGradePct - 3));
        const effClimb = Math.max(0.84, PHYSICS.driveEfficiency - 0.004 * steepOver3);
        climbPenaltyKwh += dPeKwh / effClimb;
      } else if (dh < -PHYSICS.deadbandMeters) {
        const dropM = Math.abs(dh);
        descentM += dropM;
        const dPeKwh = dropM * pePerMeterKwh;
        potentialEnergyDescentKwh += dPeKwh;

        const absGrade = Math.abs(segGradePct);
        const absCoast = Math.abs(coastGradePct);

        if (segGradePct >= coastGradePct) {
          // Regime 2A: Gentle descent (0 > G >= G_coast)
          // Gravity directly offsets tractive motor draw without battery charge inversion loop
          const savedKwh = dPeKwh * PHYSICS.shallowDescentEfficiency;
          shallowGravityOffsetKwh += savedKwh;
          regenRecoveryKwh += savedKwh;
        } else {
          // Regime 2B: Steep descent (G < G_coast)
          // Coasting fraction eliminates motor draw; excess steep grade actively regenerates into battery pack
          const coastFrac = Math.max(0, Math.min(1, absCoast / Math.max(0.1, absGrade)));
          const steepFrac = 1 - coastFrac;

          const offsetPartKwh = dPeKwh * coastFrac * PHYSICS.shallowDescentEfficiency;
          const rawRegenPartKwh = dPeKwh * steepFrac * PHYSICS.regenEfficiency;

          // Cap active regenerative charging energy by maxRegenKw over segment duration Δt = Δd / v
          const segHours = (dHorizM / vMps) / 3600;
          const maxRegenCapKwh = segHours > 0 ? maxRegenKw * segHours : rawRegenPartKwh;
          const cappedRegenPartKwh = Math.min(rawRegenPartKwh, maxRegenCapKwh);

          shallowGravityOffsetKwh += offsetPartKwh;
          activeRegenKwh += cappedRegenPartKwh;
          regenRecoveryKwh += offsetPartKwh + cappedRegenPartKwh;
        }
      }
    }

    const netElevationKwh = climbPenaltyKwh - regenRecoveryKwh;
    const distKm = Math.max(0, enrichedSamples[hi].distKm - enrichedSamples[lo].distKm);
    const distMi = distKm * KM_TO_MILES;
    const netWhPerMi = distMi > 0.5 ? Math.round((netElevationKwh * 1000) / distMi) : 0;
    // Positive netElevationKwh means extra battery consumed -> negative SoC delta %
    const netSocDeltaPct =
      packKwh > 0 ? Number(((-netElevationKwh / packKwh) * 100).toFixed(1)) : 0;

    return {
      ascentM: Math.round(ascentM),
      descentM: Math.round(descentM),
      ascentFt: Math.round(ascentM * METERS_TO_FEET),
      descentFt: Math.round(descentM * METERS_TO_FEET),
      potentialEnergyAscentKwh: Number(potentialEnergyAscentKwh.toFixed(2)),
      potentialEnergyDescentKwh: Number(potentialEnergyDescentKwh.toFixed(2)),
      climbPenaltyKwh: Number(climbPenaltyKwh.toFixed(2)),
      regenRecoveryKwh: Number(regenRecoveryKwh.toFixed(2)),
      activeRegenKwh: Number(activeRegenKwh.toFixed(2)),
      shallowGravityOffsetKwh: Number(shallowGravityOffsetKwh.toFixed(2)),
      netElevationKwh: Number(netElevationKwh.toFixed(2)),
      netWhPerMi,
      netSocDeltaPct,
      vehicleMassKg: massKg,
      vehiclePresetId: preset.id,
      vehicleLabel: preset.label,
      batteryCapacityKwh: packKwh,
      distKm: Number(distKm.toFixed(1)),
      distMi: Number(distMi.toFixed(1)),
    };
  }

  /**
   * Compute full-trip + per-leg elevation energy summary using Tesla longitudinal physics.
   */
  function computeElevationEnergyImpact(enrichedSamples, projectedStops, opts = {}) {
    const overall = computeSegmentEnergy(
      enrichedSamples,
      0,
      Math.max(0, (enrichedSamples || []).length - 1),
      opts
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
        toStop.sampleIndex,
        opts
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

  function formatSignedSocPct(val) {
    const n = Number(val) || 0;
    const sign = n > 0 ? "+" : n < 0 ? "−" : "±";
    return `${sign}${Math.abs(n).toFixed(1)}% SoC`;
  }

  const ElevationModule = {
    _map: null,
    _containerEl: null,
    _stripEl: null,
    _collapsed: false,
    _unit: "ft", // 'ft' | 'm'
    _vehiclePresetId: "modely_lr",
    _userSelectedPreset: false,
    _profile: null,
    _hoverMarker: null,
    _activeSampleIdx: null,
    _fetchSeq: 0,
    _abortCtrl: null,
    _boundRoutePlanned: null,
    _boundBatteryCapChange: null,

    _test: {
      OPEN_METEO_ELEVATION_URL,
      DEFAULT_SAMPLE_COUNT,
      VEHICLE_MASS_PRESETS,
      PHYSICS,
      resolveVehiclePreset,
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
      formatSignedSocPct,
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

      if (!this._boundBatteryCapChange && typeof document !== "undefined") {
        const capInput = document.getElementById("batteryCapacity");
        if (capInput) {
          this._boundBatteryCapChange = () => {
            if (!this._userSelectedPreset) {
              const inferred = resolveVehiclePreset({
                batteryCapacityKwh: Number(capInput.value),
              });
              this._vehiclePresetId = inferred.id;
              const sel = this._stripEl && this._stripEl.querySelector("#elevVehicleSelect");
              if (sel) sel.value = this._vehiclePresetId;
            }
            this._recomputeEnergyIfLoaded();
          };
          capInput.addEventListener("input", this._boundBatteryCapChange);
          capInput.addEventListener("change", this._boundBatteryCapChange);
        }
      }

      if (global.appState && global.appState.activePlan) {
        this.renderForPlan(global.appState.activePlan);
      }
    },

    unmount() {
      if (this._boundRoutePlanned && typeof window !== "undefined") {
        window.removeEventListener("routePlanned", this._boundRoutePlanned);
        this._boundRoutePlanned = null;
      }
      if (this._boundBatteryCapChange && typeof document !== "undefined") {
        const capInput = document.getElementById("batteryCapacity");
        if (capInput) {
          capInput.removeEventListener("input", this._boundBatteryCapChange);
          capInput.removeEventListener("change", this._boundBatteryCapChange);
        }
        this._boundBatteryCapChange = null;
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

    _getActivePhysicsOptions() {
      let batteryCapacityKwh = null;
      if (typeof document !== "undefined") {
        const capInput = document.getElementById("batteryCapacity");
        if (capInput && Number.isFinite(Number(capInput.value)) && Number(capInput.value) > 10) {
          batteryCapacityKwh = Number(capInput.value);
        }
      }
      if (!this._userSelectedPreset && batteryCapacityKwh) {
        const inferred = resolveVehiclePreset({ batteryCapacityKwh });
        this._vehiclePresetId = inferred.id;
      }
      const preset = VEHICLE_MASS_PRESETS[this._vehiclePresetId] || VEHICLE_MASS_PRESETS.modely_lr;
      return {
        vehiclePresetId: preset.id,
        vehicleMassKg: preset.massKg,
        batteryCapacityKwh: batteryCapacityKwh || preset.defaultPackKwh,
      };
    },

    _recomputeEnergyIfLoaded() {
      if (!this._profile || !this._profile.samples) return;
      const physOpts = this._getActivePhysicsOptions();
      this._profile.energy = computeElevationEnergyImpact(
        this._profile.samples,
        this._profile.stops,
        physOpts
      );
      this._renderProfileView();
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
            <span class="elev-badge elev-badge-climb" id="elevBadgeClimb" title="Tesla longitudinal climb penalty: ΔE = m·g·Δh / η_drive (η_drive ≈ 90%)">
              <i class="fa-solid fa-arrow-trend-up" aria-hidden="true"></i>
              <span id="elevClimbText">+0.0 kWh</span>
            </span>
            <span class="elev-badge elev-badge-regen" id="elevBadgeRegen" title="Downhill gravity offset + steep-grade regenerative braking recovery (η_regen ≈ 75%)">
              <i class="fa-solid fa-bolt" aria-hidden="true"></i>
              <span id="elevRegenText">−0.0 kWh</span>
            </span>
            <span class="elev-badge elev-badge-net" id="elevBadgeNet" title="Net elevation battery impact (kWh, SoC %, and Wh/mi)">
              <span id="elevNetKwhText">±0.0 kWh</span>
              <span class="elev-badge-sep">·</span>
              <span id="elevNetSocText">±0.0% SoC</span>
              <span class="elev-badge-sep">·</span>
              <span id="elevNetWhMiText">±0 Wh/mi</span>
            </span>
          </div>

          <div class="elevation-controls">
            <select class="elev-vehicle-select" id="elevVehicleSelect" title="Tesla vehicle mass preset for potential energy ΔE = m·g·Δh" aria-label="Tesla vehicle mass preset">
              <option value="model3_lr">M3 LR · 1,980 kg</option>
              <option value="modely_lr" selected>MY LR · 2,130 kg</option>
              <option value="models_x">MS/X · 2,350 kg</option>
              <option value="cybertruck">CT · 3,150 kg</option>
            </select>
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

      const vehicleSelect = el.querySelector("#elevVehicleSelect");
      if (vehicleSelect) {
        vehicleSelect.addEventListener("click", (e) => e.stopPropagation());
        vehicleSelect.addEventListener("change", (e) => {
          e.stopPropagation();
          this._vehiclePresetId = vehicleSelect.value;
          this._userSelectedPreset = true;
          this._recomputeEnergyIfLoaded();
        });
      }

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
          if (e.target.closest("button") || e.target.closest("select")) return;
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
      const physOpts = this._getActivePhysicsOptions();
      const energy = computeElevationEnergyImpact(enrichedSamples, projectedStops, physOpts);

      const sel = this._stripEl.querySelector("#elevVehicleSelect");
      if (sel && sel.value !== physOpts.vehiclePresetId) {
        sel.value = physOpts.vehiclePresetId;
      }

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
      const netSocEl = this._stripEl.querySelector("#elevNetSocText");
      const netWhMiEl = this._stripEl.querySelector("#elevNetWhMiText");
      const netBadge = this._stripEl.querySelector("#elevBadgeNet");
      if (netKwhEl) netKwhEl.textContent = `Net ${formatSignedKwh(overall.netElevationKwh)}`;
      if (netSocEl) netSocEl.textContent = formatSignedSocPct(overall.netSocDeltaPct);
      if (netWhMiEl) netWhMiEl.textContent = formatSignedWhMi(overall.netWhPerMi);
      if (netBadge) {
        netBadge.classList.toggle("is-penalty", overall.netElevationKwh > 0.25);
        netBadge.classList.toggle("is-saving", overall.netElevationKwh < -0.25);
      }

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

      const yMidVal = Math.round((yMin + yMax) / 2);
      const yTop = padT;
      const yMid = Math.round(padT + plotH / 2);
      const yBot = padT + plotH;

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
          legEl.textContent = `${overall.vehicleLabel} (${overall.vehicleMassKg.toLocaleString()} kg) · η_drive 90% · η_regen 75% · ${legCount} leg${legCount === 1 ? "" : "s"}`;
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
        legEl.textContent = `Leg #${leg.legIndex} (→ ${leg.toName}): ${formatSignedKwh(leg.netElevationKwh)} (${formatSignedSocPct(leg.netSocDeltaPct)}) · +${leg.climbPenaltyKwh.toFixed(1)} climb / −${leg.regenRecoveryKwh.toFixed(1)} regen`;
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

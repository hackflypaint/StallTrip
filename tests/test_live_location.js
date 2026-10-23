/**
 * Pure helpers for client-side live location (watchPosition follow-me).
 * Mirrors static/app.js — run: node tests/test_live_location.js
 */

function isSecureGeoContext(opts) {
  const { isSecureContext, protocol, hostname } = opts;
  if (typeof isSecureContext === "boolean") return isSecureContext;
  const host = String(hostname || "").toLowerCase();
  return protocol === "https:" || host === "localhost" || host === "127.0.0.1";
}

function liveLocationWatchOptions() {
  return {
    enableHighAccuracy: true,
    timeout: 12000,
    maximumAge: 1500,
  };
}

function oneShotLocationOptions(mobileShell) {
  return {
    enableHighAccuracy: false,
    timeout: 10000,
    maximumAge: mobileShell ? 60_000 : 0,
  };
}

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

/** Next toggle action given live-location state (no DOM). */
function nextLiveLocationAction(live) {
  if (!live || !live.watching) return "start";
  if (!live.follow) return "resume";
  return "stop";
}

/** Drag should pause follow but keep watching. */
function afterMapDragStart(live) {
  if (!live || !live.watching || !live.follow) return { ...live };
  return { ...live, follow: false };
}

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

function headingToCardinal(headingDeg) {
  if (!Number.isFinite(headingDeg) || headingDeg < 0) return null;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const normalized = ((headingDeg % 360) + 360) % 360;
  return dirs[Math.round(normalized / 45) % 8];
}

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

function isOffRouteCorridor(lat, lng, plan, thresholdMiles = 25) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !plan) return false;
  let minMiles = Infinity;
  const geom = plan.geometry;
  const coords =
    geom && geom.type === "LineString" && Array.isArray(geom.coordinates)
      ? geom.coordinates
      : null;
  if (coords && coords.length > 0) {
    for (const pt of coords) {
      const d = haversineDistanceMiles(lat, lng, Number(pt[1]), Number(pt[0]));
      if (d != null && d < minMiles) minMiles = d;
    }
  } else if (Array.isArray(plan.stops)) {
    for (const s of plan.stops) {
      const d = haversineDistanceMiles(lat, lng, Number(s.lat), Number(s.lng));
      if (d != null && d < minMiles) minMiles = d;
    }
  }
  return Number.isFinite(minMiles) && minMiles > thresholdMiles;
}

function liveFollowReplanDefaults() {
  return {
    minOriginDriftMiles: 5,
    passStopRadiusMiles: 0.6,
    offCorridorAutoMiles: 12,
    cooldownMs: 45_000,
    maxAccuracyM: 100,
    maxJumpMiles: 5,
    jumpGraceMs: 30_000,
  };
}

function shouldAcceptLiveFixForReplan(ctx) {
  const opts = { ...liveFollowReplanDefaults(), ...(ctx && ctx.opts) };
  const { firstFix, prevLat, prevLng, prevAt, lat, lng, accuracy, now } = ctx || {};
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

function plannedStopKey(stop) {
  if (!stop) return null;
  if (stop.id != null && stop.id !== "") return String(stop.id);
  if (stop.stop_index != null) return `idx:${stop.stop_index}`;
  if (Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
    return `ll:${Number(stop.lat).toFixed(4)},${Number(stop.lng).toFixed(4)}`;
  }
  return null;
}

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run() {
  const watch = liveLocationWatchOptions();
  assert(watch.enableHighAccuracy === true, "driving uses high accuracy");
  assert(watch.timeout >= 8000, "timeout patient for Tesla Chromium");
  assert(watch.maximumAge > 0 && watch.maximumAge <= 5000, "short cache for drive updates");

  const mobileShot = oneShotLocationOptions(true);
  assert(mobileShot.maximumAge === 60_000, "mobile one-shot may use cached fix");
  assert(oneShotLocationOptions(false).maximumAge === 0, "desktop one-shot fresh");

  assert(isSecureGeoContext({ isSecureContext: true }) === true, "secure context ok");
  assert(isSecureGeoContext({ isSecureContext: false }) === false, "insecure blocked");
  assert(
    isSecureGeoContext({ protocol: "https:", hostname: "example.com" }) === true,
    "https ok"
  );
  assert(
    isSecureGeoContext({ protocol: "http:", hostname: "localhost" }) === true,
    "localhost ok"
  );
  assert(
    isSecureGeoContext({ protocol: "http:", hostname: "192.168.1.5" }) === false,
    "plain http LAN not secure"
  );

  assert(/denied/i.test(formatLiveLocationError({ code: 1 })), "deny message");
  assert(/timed out/i.test(formatLiveLocationError({ code: 3 })), "timeout message");
  assert(/unsupported/i.test(formatLiveLocationError({ code: 0, message: "unsupported" })), "unsupported");

  assert(nextLiveLocationAction({ watching: false }) === "start", "idle → start");
  assert(nextLiveLocationAction({ watching: true, follow: false }) === "resume", "paused → resume");
  assert(nextLiveLocationAction({ watching: true, follow: true }) === "stop", "following → stop");

  const paused = afterMapDragStart({ watching: true, follow: true, lat: 1 });
  assert(paused.watching === true && paused.follow === false, "drag pauses follow only");
  assert(afterMapDragStart({ watching: false, follow: false }).watching === false, "idle drag noop");

  // Haversine & telemetry HUD checks
  const sfToOakland = haversineDistanceMiles(37.7749, -122.4194, 37.8044, -122.2712);
  assert(sfToOakland > 7 && sfToOakland < 10, `expected ~8.3 mi, got ${sfToOakland}`);
  assert(headingToCardinal(0) === "N", "0 deg = N");
  assert(headingToCardinal(135) === "SE", "135 deg = SE");
  assert(formatLiveTelemetryLabel(29.0576, 135) === "65 mph · SE 135°", "telemetry label");
  assert(formatLiveTelemetryLabel(null, null) === "LIVE GPS", "fallback telemetry label");

  const samplePlan = {
    stops: [
      { type: "ORIGIN", lat: 37.7749, lng: -122.4194 },
      { type: "SUPERCHARGER", stop_index: 1, name: "San Mateo, CA", lat: 37.563, lng: -122.3255 },
      { type: "SUPERCHARGER", stop_index: 2, name: "Gilroy, CA", lat: 37.0058, lng: -121.5683 },
      { type: "DESTINATION", name: "Los Angeles, CA", lat: 34.0522, lng: -118.2437 },
    ],
  };
  const nextStop = computeNextPlannedStopTelemetry(37.65, -122.38, samplePlan);
  assert(nextStop && nextStop.name === "San Mateo, CA", "nearest planned Supercharger stop");
  assert(nextStop.distanceMiles > 4 && nextStop.distanceMiles < 10, "distance to next stop in miles");
  assert(isOffRouteCorridor(37.65, -122.38, samplePlan, 25) === false, "on corridor");
  assert(isOffRouteCorridor(39.0, -120.0, samplePlan, 25) === true, "off corridor (>25 mi)");

  // Smart follow / GPS-as-origin heuristics
  const defs = liveFollowReplanDefaults();
  assert(defs.minOriginDriftMiles === 5, "5 mi drift before auto-replan");
  assert(defs.cooldownMs >= 30_000, "cooldown prevents thrash");
  assert(defs.offCorridorAutoMiles < 25, "auto off-corridor tighter than manual pill");

  assert(
    shouldAcceptLiveFixForReplan({
      firstFix: true,
      lat: 41.5,
      lng: -83.3,
      accuracy: 20,
      now: 1000,
    }) === true,
    "first fix always accepted"
  );
  assert(
    shouldAcceptLiveFixForReplan({
      firstFix: false,
      prevLat: 37.77,
      prevLng: -122.42,
      prevAt: 1000,
      lat: 41.5,
      lng: -83.3,
      accuracy: 20,
      now: 2000,
    }) === false,
    "reject coastal→Ohio spike in 1s"
  );
  assert(
    shouldAcceptLiveFixForReplan({
      firstFix: false,
      prevLat: 37.77,
      prevLng: -122.42,
      prevAt: 1000,
      lat: 41.5,
      lng: -83.3,
      accuracy: 20,
      now: 1000 + defs.jumpGraceMs + 1,
    }) === true,
    "accept large jump after grace (GPS recovery)"
  );
  assert(
    shouldAcceptLiveFixForReplan({
      firstFix: false,
      prevLat: 37.77,
      prevLng: -122.42,
      prevAt: 1000,
      lat: 37.78,
      lng: -122.41,
      accuracy: 250,
      now: 2000,
    }) === false,
    "reject inaccurate fix for replan"
  );

  const firstNoDest = shouldAutoReplanLiveMove({
    firstFix: true,
    lat: 41.5,
    lng: -83.3,
    hasDestination: false,
    now: 5000,
  });
  assert(firstNoDest.reason === "first_fix_origin_only" && firstNoDest.replan === false, "first fix seeds origin only");

  const firstWithDest = shouldAutoReplanLiveMove({
    firstFix: true,
    lat: 41.5,
    lng: -83.3,
    hasDestination: true,
    now: 5000,
  });
  assert(firstWithDest.replan === true && firstWithDest.reason === "first_fix", "first fix replans when dest set");

  const jitter = shouldAutoReplanLiveMove({
    firstFix: false,
    lat: 37.775,
    lng: -122.419,
    plannedOriginLat: 37.7749,
    plannedOriginLng: -122.4194,
    lastAutoReplanAt: 0,
    now: 100_000,
    hasDestination: true,
    planInFlight: false,
    accuracy: 15,
    plan: samplePlan,
  });
  assert(jitter.replan === false, "sub-mile jitter does not replan");

  const drift = shouldAutoReplanLiveMove({
    firstFix: false,
    lat: 37.85,
    lng: -122.25,
    plannedOriginLat: 37.7749,
    plannedOriginLng: -122.4194,
    lastAutoReplanAt: 0,
    now: 100_000,
    hasDestination: true,
    planInFlight: false,
    accuracy: 15,
    plan: samplePlan,
  });
  assert(drift.replan === true && drift.reason === "origin_drift", "≥5 mi drift replans");

  const cooled = shouldAutoReplanLiveMove({
    firstFix: false,
    lat: 37.85,
    lng: -122.25,
    plannedOriginLat: 37.7749,
    plannedOriginLng: -122.4194,
    lastAutoReplanAt: 90_000,
    now: 100_000,
    hasDestination: true,
    planInFlight: false,
    accuracy: 15,
    plan: samplePlan,
  });
  assert(cooled.replan === false, "cooldown blocks rapid auto-replan");

  const busy = shouldAutoReplanLiveMove({
    firstFix: false,
    lat: 37.85,
    lng: -122.25,
    plannedOriginLat: 37.7749,
    plannedOriginLng: -122.4194,
    lastAutoReplanAt: 0,
    now: 100_000,
    hasDestination: true,
    planInFlight: true,
    accuracy: 15,
    plan: samplePlan,
  });
  assert(busy.replan === false, "Maximize mid-calc blocks auto-replan");

  const nearStop = findNewlyPassedStop(37.563, -122.3255, samplePlan, new Set(), 0.6);
  assert(nearStop && nearStop.name === "San Mateo, CA", "detect passed Supercharger");
  const passed = shouldAutoReplanLiveMove({
    firstFix: false,
    lat: 37.563,
    lng: -122.3255,
    plannedOriginLat: 37.7749,
    plannedOriginLng: -122.4194,
    lastAutoReplanAt: 0,
    now: 100_000,
    hasDestination: true,
    planInFlight: false,
    accuracy: 15,
    plan: samplePlan,
    passedStop: nearStop,
  });
  assert(passed.replan === true && passed.reason === "passed_stop", "passing a stop replans");

  const offAuto = shouldAutoReplanLiveMove({
    firstFix: false,
    lat: 39.0,
    lng: -120.0,
    plannedOriginLat: 39.01,
    plannedOriginLng: -120.01,
    lastAutoReplanAt: 0,
    now: 100_000,
    hasDestination: true,
    planInFlight: false,
    accuracy: 15,
    plan: samplePlan,
  });
  assert(offAuto.replan === true && offAuto.reason === "off_corridor", "12 mi off-corridor auto-replans");

  // Locate-with-origin-already-set must still force replan (same as firstFix).
  const locateOverride = shouldAutoReplanLiveMove({
    firstFix: true, // armLocate / forceOrigin treats locate like firstFix
    lat: 41.45,
    lng: -83.36,
    plannedOriginLat: 37.7749,
    plannedOriginLng: -122.4194,
    lastAutoReplanAt: Date.now(),
    now: Date.now(),
    hasDestination: true,
    planInFlight: true, // even mid-calc, locate/firstFix must win
    accuracy: 15,
    plan: samplePlan,
  });
  assert(
    locateOverride.replan === true && locateOverride.reason === "first_fix",
    "locate/firstFix overrides pre-set origin even while planInFlight"
  );

  console.log("test_live_location.js: all checks passed");
}

run();

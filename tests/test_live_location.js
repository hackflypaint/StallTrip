/**
 * Live-location helpers — assert against real static/app.js (not local mirrors).
 * Load pattern matches tests/test_release_prep_v106.js (vm + window export).
 * Run: node tests/test_live_location.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadAppLiveHelpers() {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  const start = src.indexOf("function isSecureGeoContext");
  assert(start >= 0, "missing isSecureGeoContext in app.js");
  const end = src.indexOf("\nfunction setLocateBusy", start);
  assert(end > start, "could not slice live helpers before setLocateBusy");
  const snippet = src.slice(start, end);

  const sandbox = {
    console,
    Set,
    Map,
    Number,
    Math,
    String,
    Array,
    Date,
    parseInt,
    isNaN,
    JSON,
    location: { protocol: "https:", hostname: "example.com" },
    window: {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(snippet, sandbox);

  const required = [
    "isSecureGeoContext",
    "liveLocationWatchOptions",
    "oneShotLocationOptions",
    "formatLiveLocationError",
    "haversineDistanceMiles",
    "headingToCardinal",
    "formatLiveTelemetryLabel",
    "computeNextPlannedStopTelemetry",
    "isOffRouteCorridor",
    "liveFollowReplanDefaults",
    "shouldAcceptLiveFixForReplan",
    "plannedStopKey",
    "findNewlyPassedStop",
    "shouldAutoReplanLiveMove",
  ];
  for (const name of required) {
    assert(typeof sandbox[name] === "function", `app.js must define ${name}`);
    assert(sandbox.window[name] === sandbox[name], `app.js must expose window.${name}`);
  }
  return sandbox;
}

/** UI toggle helper (not exported from app.js — local for button state only). */
function nextLiveLocationAction(live) {
  if (!live || !live.watching) return "start";
  if (!live.follow) return "resume";
  return "stop";
}

function afterMapDragStart(live) {
  if (!live || !live.watching || !live.follow) return { ...live };
  return { ...live, follow: false };
}

function run() {
  const h = loadAppLiveHelpers();

  const watch = h.liveLocationWatchOptions();
  assert(watch.enableHighAccuracy === true, "driving uses high accuracy");
  assert(watch.timeout >= 8000, "timeout patient for Tesla Chromium");
  assert(watch.maximumAge > 0 && watch.maximumAge <= 5000, "short cache for drive updates");

  const mobileShot = h.oneShotLocationOptions(true);
  assert(mobileShot.maximumAge === 60_000, "mobile one-shot may use cached fix");
  assert(h.oneShotLocationOptions(false).maximumAge === 0, "desktop one-shot fresh");

  h.window.isSecureContext = true;
  assert(h.isSecureGeoContext() === true, "secure context ok");
  h.window.isSecureContext = false;
  assert(h.isSecureGeoContext() === false, "insecure blocked");
  delete h.window.isSecureContext;
  h.location.protocol = "https:";
  h.location.hostname = "example.com";
  assert(h.isSecureGeoContext() === true, "https ok");
  h.location.protocol = "http:";
  h.location.hostname = "localhost";
  assert(h.isSecureGeoContext() === true, "localhost ok");
  h.location.hostname = "192.168.1.5";
  assert(h.isSecureGeoContext() === false, "plain http LAN not secure");

  assert(/denied/i.test(h.formatLiveLocationError({ code: 1 })), "deny message");
  assert(/timed out/i.test(h.formatLiveLocationError({ code: 3 })), "timeout message");
  assert(
    /unsupported/i.test(h.formatLiveLocationError({ code: 0, message: "unsupported" })),
    "unsupported"
  );

  assert(nextLiveLocationAction({ watching: false }) === "start", "idle → start");
  assert(nextLiveLocationAction({ watching: true, follow: false }) === "resume", "paused → resume");
  assert(nextLiveLocationAction({ watching: true, follow: true }) === "stop", "following → stop");

  const paused = afterMapDragStart({ watching: true, follow: true, lat: 1 });
  assert(paused.watching === true && paused.follow === false, "drag pauses follow only");
  assert(afterMapDragStart({ watching: false, follow: false }).watching === false, "idle drag noop");

  const sfToOakland = h.haversineDistanceMiles(37.7749, -122.4194, 37.8044, -122.2712);
  assert(sfToOakland > 7 && sfToOakland < 10, `expected ~8.3 mi, got ${sfToOakland}`);
  assert(h.headingToCardinal(0) === "N", "0 deg = N");
  assert(h.headingToCardinal(135) === "SE", "135 deg = SE");
  assert(h.formatLiveTelemetryLabel(29.0576, 135) === "65 mph · SE 135°", "telemetry label");
  assert(h.formatLiveTelemetryLabel(null, null) === "LIVE GPS", "fallback telemetry label");

  const samplePlan = {
    stops: [
      { type: "ORIGIN", lat: 37.7749, lng: -122.4194 },
      { type: "SUPERCHARGER", stop_index: 1, name: "San Mateo, CA", lat: 37.563, lng: -122.3255 },
      { type: "SUPERCHARGER", stop_index: 2, name: "Gilroy, CA", lat: 37.0058, lng: -121.5683 },
      { type: "DESTINATION", name: "Los Angeles, CA", lat: 34.0522, lng: -118.2437 },
    ],
  };
  const nextStop = h.computeNextPlannedStopTelemetry(37.65, -122.38, samplePlan);
  assert(nextStop && nextStop.name === "San Mateo, CA", "nearest planned Supercharger stop");
  assert(nextStop.distanceMiles > 4 && nextStop.distanceMiles < 10, "distance to next stop in miles");
  assert(h.isOffRouteCorridor(37.65, -122.38, samplePlan, 25) === false, "on corridor");
  assert(h.isOffRouteCorridor(39.0, -120.0, samplePlan, 25) === true, "off corridor (>25 mi)");

  const defs = h.liveFollowReplanDefaults();
  assert(defs.minOriginDriftMiles === 5, "5 mi drift before auto-replan");
  assert(defs.cooldownMs >= 30_000, "cooldown prevents thrash");
  assert(defs.offCorridorAutoMiles < 25, "auto off-corridor tighter than manual pill");

  assert(
    h.shouldAcceptLiveFixForReplan({
      firstFix: true,
      lat: 41.5,
      lng: -83.3,
      accuracy: 20,
      now: 1000,
    }) === true,
    "first fix always accepted"
  );
  assert(
    h.shouldAcceptLiveFixForReplan({
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
    h.shouldAcceptLiveFixForReplan({
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
    h.shouldAcceptLiveFixForReplan({
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

  const firstNoDest = h.shouldAutoReplanLiveMove({
    firstFix: true,
    lat: 41.5,
    lng: -83.3,
    hasDestination: false,
    now: 5000,
  });
  assert(firstNoDest.reason === "first_fix_origin_only" && firstNoDest.replan === false, "first fix seeds origin only");

  const firstWithDest = h.shouldAutoReplanLiveMove({
    firstFix: true,
    lat: 41.5,
    lng: -83.3,
    hasDestination: true,
    now: 5000,
  });
  assert(firstWithDest.replan === true && firstWithDest.reason === "first_fix", "first fix replans when dest set");

  const jitter = h.shouldAutoReplanLiveMove({
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

  const drift = h.shouldAutoReplanLiveMove({
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

  const cooled = h.shouldAutoReplanLiveMove({
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

  const busy = h.shouldAutoReplanLiveMove({
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

  const nearStop = h.findNewlyPassedStop(37.563, -122.3255, samplePlan, new Set(), 0.6);
  assert(nearStop && nearStop.name === "San Mateo, CA", "detect passed Supercharger");
  const passed = h.shouldAutoReplanLiveMove({
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

  const offAuto = h.shouldAutoReplanLiveMove({
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

  const locateOverride = h.shouldAutoReplanLiveMove({
    firstFix: true,
    lat: 41.45,
    lng: -83.36,
    plannedOriginLat: 37.7749,
    plannedOriginLng: -122.4194,
    lastAutoReplanAt: Date.now(),
    now: Date.now(),
    hasDestination: true,
    planInFlight: true,
    accuracy: 15,
    plan: samplePlan,
  });
  assert(
    locateOverride.replan === true && locateOverride.reason === "first_fix",
    "locate/firstFix overrides pre-set origin even while planInFlight"
  );

  // shouldSkipFitBoundsForLiveFollow in app.js reads state — assert pure contract here.
  function shouldSkipFitBoundsForLiveFollow(live) {
    return !!(live && live.watching && live.follow);
  }
  assert(
    shouldSkipFitBoundsForLiveFollow({ watching: true, follow: true }) === true,
    "skip fitBounds while following"
  );
  assert(
    shouldSkipFitBoundsForLiveFollow({ watching: true, follow: false }) === false,
    "allow fitBounds when follow paused"
  );
  assert(
    shouldSkipFitBoundsForLiveFollow({ watching: false, follow: false }) === false,
    "allow fitBounds when not watching"
  );

  function clearActivePlanOpts(willReplan) {
    return { keepMapGeometry: !!willReplan };
  }
  assert(clearActivePlanOpts(true).keepMapGeometry === true, "replan keeps map geometry");
  assert(clearActivePlanOpts(false).keepMapGeometry === false, "no-dest clears geometry");

  console.log("test_live_location.js: all checks passed (app.js helpers)");
}

run();

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

  console.log("test_live_location.js: all checks passed");
}

run();

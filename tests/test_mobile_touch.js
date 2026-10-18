/**
 * Pure helpers for mobile Phase 2 (geolocation resolve + explore limit).
 * Mirrors static/app.js — run: node tests/test_mobile_touch.js
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

function exploreFetchLimit(mobileShell) {
  return mobileShell ? 60 : 120;
}

function freehandMinPoints(mobileShell) {
  return mobileShell ? 4 : 6;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run() {
  const ok = resolveGeolocationPlace({ coords: { latitude: 40.7, longitude: -74.0 } }, null);
  assert(ok.source === "geolocation", "success path uses geolocation");
  assert(ok.lat === 40.7 && ok.lng === -74.0, "coords copied");

  const denied = resolveGeolocationPlace(null, { code: 1, message: "denied" });
  assert(denied.source === "fallback", "error uses fallback");
  assert(denied.lat === 37.7955, "SF ferry fallback lat");

  const bad = resolveGeolocationPlace({ coords: { latitude: NaN, longitude: 0 } }, null);
  assert(bad.source === "fallback", "NaN coords fall back");

  assert(exploreFetchLimit(true) === 60, "mobile explore limit");
  assert(exploreFetchLimit(false) === 120, "desktop explore limit");
  assert(freehandMinPoints(true) === 4, "mobile freehand min pts");
  assert(freehandMinPoints(false) === 6, "desktop freehand min pts");

  console.log("test_mobile_touch.js: all checks passed");
}

run();

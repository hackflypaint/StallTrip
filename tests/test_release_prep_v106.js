/**
 * Minimal regression coverage for v1.0.6 usability fixes (pure / sliced).
 * Run: node tests/test_release_prep_v106.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadAppSnippet(startMarker, endMarker) {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  const start = src.indexOf(startMarker);
  assert(start >= 0, `missing ${startMarker}`);
  const end = endMarker ? src.indexOf(endMarker, start + startMarker.length) : src.length;
  assert(end > start, `could not slice after ${startMarker}`);
  return src.slice(start, end);
}

function testResolveGeolocationNoSilentSf() {
  const snippet = loadAppSnippet(
    "function resolveGeolocationPlace",
    "window.resolveGeolocationPlace"
  );
  const sandbox = { window: {}, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(snippet + "\nwindow.resolveGeolocationPlace = resolveGeolocationPlace;", sandbox);
  const fn = sandbox.resolveGeolocationPlace;
  assert(fn(null, { code: 1 }) === null, "deny → null");
  assert(fn({ coords: { latitude: NaN, longitude: 1 } }, null) === null, "NaN → null");
  const ok = fn({ coords: { latitude: 1, longitude: 2 } }, null);
  assert(ok && ok.source === "geolocation", "success path");
}

function testPlanRestoreHelpersPresent() {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  assert(src.includes("planRestoreSnapshot"), "state field for restore");
  assert(src.includes("function restorePlanSnapshotIfNeeded"), "restore helper");
  assert(src.includes("snapshotForRestore"), "clearActivePlan snapshot opt");
  assert(src.includes("restorePlanSnapshotIfNeeded()"), "planRoute calls restore on error");
}

function testInputMismatchInvalidatesState() {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  assert(
    src.includes("Typing away from a selected place invalidates coords"),
    "autocomplete invalidates stale state"
  );
  assert(src.includes('query !== String(selected.name).trim()'), "compares field to selected name");
}

function testAirspaceKeepsLastGoodNofly() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "static", "airspace", "airspace-overlay.js"),
    "utf8"
  );
  assert(src.includes("_lastSuaFeatures"), "caches last SUA");
  assert(src.includes("_lastTfrFeatures"), "caches last TFR");
  assert(src.includes("Keep last-good SUA/TFR"), "documents false-clear fix");
}

function testDestinationToneDangerForNegative() {
  const src = fs.readFileSync(path.join(__dirname, "..", "static", "app.js"), "utf8");
  const start = src.indexOf("function destinationBatteryTone");
  const end = src.indexOf("// Application State", start);
  const sandbox = { window: {}, console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src.slice(start, end), sandbox);
  assert(sandbox.destinationBatteryTone(-132, 15) === "danger", "negative SOC is danger");
}

function run() {
  testResolveGeolocationNoSilentSf();
  testPlanRestoreHelpersPresent();
  testInputMismatchInvalidatesState();
  testAirspaceKeepsLastGoodNofly();
  testDestinationToneDangerForNegative();
  console.log("test_release_prep_v106.js: ALL PASSED");
}

run();

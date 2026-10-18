/**
 * Cloud unit tests for Airspace / UAS style + query helpers.
 * Run: node tests/test_airspace.js
 *
 * Loads static/airspace/airspace-overlay.js in a minimal VM sandbox
 * (no Leaflet required for style/URL helpers).
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function loadModule() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "static", "airspace", "airspace-overlay.js"),
    "utf8"
  );
  const sandbox = {
    window: {},
    console,
    URLSearchParams,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  assert(sandbox.AirspaceModule, "AirspaceModule not exported");
  assert(sandbox.AirspaceModule._test, "_test helpers missing");
  return sandbox.AirspaceModule._test;
}

function run() {
  const t = loadModule();

  assert(t.FAA_ORG.includes("ssFJjBXIUyZDrSYZ"), "FAA org id");
  assert(t.MIN_ZOOM === 7, "MIN_ZOOM");
  assert(t.MIN_ZOOM_UASFM === 9, "MIN_ZOOM_UASFM");
  assert(t.LAYERS.classAirspace.path.includes("Class_Airspace"), "class path");
  assert(t.LAYERS.sua.path.includes("Special_Use_Airspace"), "sua path");
  assert(t.LAYERS.uasfm.path.includes("FAA_UAS_FacilityMap_Data"), "uasfm path");

  const b = t.classStyle("B");
  assert(b.fillColor && b.color, "class B style");
  const d = t.classStyle("D");
  assert(d.dashArray, "class D dashed");

  const r = t.suaStyle("R");
  assert(r.fillColor.includes("2a6fd6") || r.color.includes("3d8bfd"), "restricted blue");
  const p = t.suaStyle("P");
  assert(p.fillOpacity >= 0.2, "prohibited fill");

  const zero = t.uasfmStyle(0);
  const hi = t.uasfmStyle(400);
  assert(zero.fillOpacity > hi.fillOpacity, "lower ceiling darker than 400ft");

  const url = t.buildQueryUrl(t.LAYERS.classAirspace, "-77.5,38.0,-75.5,39.5");
  assert(url.startsWith(t.FAA_ORG), "query base");
  assert(url.includes("f=geojson"), "geojson");
  assert(url.includes("geometryType=esriGeometryEnvelope"), "envelope");
  assert(url.includes("outSR=4326"), "outSR");
  assert(url.includes("CLASS"), "class where clause encoded");
  assert(!url.toLowerCase().includes("autopylot"), "must not call Autopylot");

  console.log("test_airspace.js: OK");
}

run();

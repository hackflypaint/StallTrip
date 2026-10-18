/**
 * Cloud unit tests for drone flight-constraint helpers.
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
  assert(t.NPS_ORG.includes("fBc8EJBxQRMcHlei"), "NPS org id");
  assert(t.MIN_ZOOM === 7, "MIN_ZOOM");
  assert(t.MIN_ZOOM_UASFM === 9, "MIN_ZOOM_UASFM");

  assert(t.LAYERS.npsParks.path.includes("NPS_Land_Resources"), "NPS parks path");
  assert(t.LAYERS.npsParks.constraint === t.CONSTRAINT.noFly, "parks are no-fly");
  assert(t.LAYERS.suaNoFly.where.includes("'P'"), "SUA prohibited filter");
  assert(t.LAYERS.suaNoFly.where.includes("'R'"), "SUA restricted filter");
  assert(t.LAYERS.suaNoFly.constraint === t.CONSTRAINT.noFly, "SUA P/R are no-fly");
  assert(t.LAYERS.suaNoFly.restrictedIsHardNoFly === true, "R is hard no-fly");
  assert(t.suaConstraint("R") === t.CONSTRAINT.noFly, "R SUA → no-fly");
  assert(t.suaConstraint("P") === t.CONSTRAINT.noFly, "P SUA → no-fly");
  assert(t.suaConstraint("R") !== t.CONSTRAINT.auth, "R must not be auth");
  assert(!t.LAYERS.suaNoFly.where.includes("MOA"), "MOA not in SUA filter");
  assert(t.LAYERS.defenseTfr.path.includes("National_Defense"), "defense TFR");
  assert(t.LAYERS.classAuth.where.includes("CLASS"), "class auth where");
  assert(t.LAYERS.classAuth.constraint === t.CONSTRAINT.auth, "class is auth");
  assert(t.LAYERS.uasfm.path.includes("FAA_UAS_FacilityMap_Data"), "uasfm path");
  assert(t.LAYERS.stadiums.constraint === t.CONSTRAINT.noFly, "stadiums no-fly");
  assert(!t.LAYERS.airports, "airport markers removed");

  assert(t.CLASS_KEYS.noFly === "noFly", "class key noFly");
  assert(t.CLASS_KEYS.parks === "parks", "class key parks");
  assert(t.CLASS_KEYS.auth === "auth", "class key auth");
  assert(t.LAYERS.npsParks.classKey === t.CLASS_KEYS.parks, "parks classKey");
  assert(t.LAYERS.suaNoFly.classKey === t.CLASS_KEYS.noFly, "sua classKey");
  assert(t.LAYERS.classAuth.classKey === t.CLASS_KEYS.auth, "auth classKey");

  assert(t.constraintLabel(t.CONSTRAINT.noFly) === "No-fly", "no-fly label");
  assert(t.constraintLabel(t.CONSTRAINT.auth) === "Auth required", "auth label");

  assert(t.uasfmConstraint(0) === t.CONSTRAINT.noFly, "0ft UASFM = no-fly");
  assert(t.uasfmConstraint(200) === t.CONSTRAINT.auth, "200ft UASFM = auth");
  const zeroStyle = t.uasfmStyle(0);
  const hiStyle = t.uasfmStyle(400);
  assert(zeroStyle.fillOpacity > hiStyle.fillOpacity, "0ft darker than auth cell");

  assert(t.STYLES.noFly.fillColor, "no-fly style");
  assert(t.STYLES.park.fillColor, "park style");
  assert(t.STYLES.auth.fillColor, "auth style");

  const npsUrl = t.buildQueryUrl(t.LAYERS.npsParks, "-77.5,38.0,-75.5,39.5");
  assert(npsUrl.startsWith(t.NPS_ORG), "NPS query base");
  assert(npsUrl.includes("f=geojson"), "geojson");
  assert(npsUrl.includes("geometryType=esriGeometryEnvelope"), "envelope");

  const classUrl = t.buildQueryUrl(t.LAYERS.classAuth, "-77.5,38.0,-75.5,39.5");
  assert(classUrl.startsWith(t.FAA_ORG), "FAA query base");
  assert(classUrl.includes("outSR=4326"), "outSR");
  assert(classUrl.includes("CLASS"), "class where clause encoded");
  assert(!classUrl.toLowerCase().includes("autopylot"), "must not call Autopylot");
  assert(!npsUrl.toLowerCase().includes("autopylot"), "NPS must not call Autopylot");

  const suaUrl = t.buildQueryUrl(t.LAYERS.suaNoFly, "-77.5,38.0,-75.5,39.5");
  assert(suaUrl.includes("TYPE_CODE"), "SUA type filter encoded");
  assert(!decodeURIComponent(suaUrl).includes("MOA"), "MOA not requested");

  const xss = t.popupHtml('<img src=x onerror=alert(1)>', [
    ["Class", "<script>alert(1)</script>"],
  ]);
  assert(!xss.includes("<script>"), "popup escapes script tags");
  assert(!xss.includes("<img"), "popup escapes img tags");
  assert(xss.includes("&lt;script&gt;"), "popup encodes angle brackets");
  assert(xss.includes("&lt;img"), "popup encodes img opener");
  assert(t.escapeHtml('"') === "&quot;", "escapeHtml quotes");

  console.log("test_airspace.js: OK");
}

run();

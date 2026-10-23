/**
 * Unit tests for map chrome UX helpers (area-tool rest state, legend visibility, clear plan).
 * Mirrors static/app.js logic without a browser.
 * Run: node tests/test_ui_chrome.js
 */

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** Area tools: only the drawing tool is pressed — quiet at rest. */
function areaToolPressed(areaSelectMode, areaDrawMode, tool) {
  if (!areaSelectMode) return false;
  return areaDrawMode === tool;
}

/** Legend Forced row visible only when force-includes exist. */
function forcedLegendHidden(forcedCount) {
  return forcedCount === 0;
}

/** Nearby legend follows Layers toggle. */
function corridorLegendHidden(nearbyChecked) {
  return nearbyChecked === false;
}

/**
 * Clearing an endpoint drops stale plan state (M6).
 * Returns the next app-ish snapshot after clear.
 */
function clearEndpointModel({ origin, destination, activePlan, which }) {
  const next = {
    origin: which === "origin" ? null : origin,
    destination: which === "destination" ? null : destination,
    activePlan: null,
    routeCleared: true,
    resultsHidden: true,
  };
  return next;
}

function run() {
  // Rest: neither tool pressed
  assert(areaToolPressed(false, "box", "box") === false, "box quiet at rest");
  assert(areaToolPressed(false, "box", "freehand") === false, "freehand quiet at rest");
  assert(areaToolPressed(false, "freehand", "freehand") === false, "preferred freehand still quiet");

  // Drawing: only active mode pressed
  assert(areaToolPressed(true, "box", "box") === true, "box pressed while drawing box");
  assert(areaToolPressed(true, "box", "freehand") === false, "freehand off while drawing box");
  assert(areaToolPressed(true, "freehand", "freehand") === true, "freehand pressed while drawing");
  assert(areaToolPressed(true, "freehand", "box") === false, "box off while drawing freehand");

  // Legend
  assert(forcedLegendHidden(0) === true, "forced legend hidden with none");
  assert(forcedLegendHidden(2) === false, "forced legend shown with forced stops");
  assert(corridorLegendHidden(true) === false, "corridor shown when nearby on");
  assert(corridorLegendHidden(false) === true, "corridor hidden when nearby off");

  // Clear endpoint clears plan
  const after = clearEndpointModel({
    origin: { name: "A" },
    destination: { name: "B" },
    activePlan: { summary: { supercharger_stops_count: 3 } },
    which: "origin",
  });
  assert(after.origin === null, "origin cleared");
  assert(after.destination && after.destination.name === "B", "dest kept");
  assert(after.activePlan === null, "stale plan cleared");
  assert(after.routeCleared && after.resultsHidden, "map/results cleared");

  console.log("test_ui_chrome.js: ALL PASSED");
}

run();

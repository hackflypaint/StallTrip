/**
 * Cloud unit tests for Clear selection / area-forced ID tracking helpers.
 * Run: node tests/test_clear_selection.js
 *
 * Mirrors the client logic in static/app.js without a browser.
 */

function pointInPolygon(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat;
    const xi = ring[i].lng;
    const yj = ring[j].lat;
    const xj = ring[j].lng;
    if (yi === yj) continue;
    const intersect =
      (yi > lat) !== (yj > lat) &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Pure model of clearSelection side effects on forced + area ID sets. */
function clearSelectionModel(forcedChargers, areaForcedIds) {
  const nextForced = new Map(forcedChargers);
  for (const id of areaForcedIds) {
    nextForced.delete(id);
  }
  return { forcedChargers: nextForced, areaForcedIds: new Set() };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run() {
  // point-in-polygon sanity (shared with freehand)
  const square = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 2 },
    { lat: 2, lng: 2 },
    { lat: 2, lng: 0 },
    { lat: 0, lng: 0 },
  ];
  assert(pointInPolygon(1, 1, square) === true, "center inside square");
  assert(pointInPolygon(3, 3, square) === false, "outside square");

  // Clear selection removes area-batch IDs only
  const forced = new Map([
    ["area-a", { id: "area-a", name: "A" }],
    ["area-b", { id: "area-b", name: "B" }],
    ["manual-1", { id: "manual-1", name: "Manual" }],
  ]);
  const areaIds = new Set(["area-a", "area-b"]);
  const after = clearSelectionModel(forced, areaIds);
  assert(after.areaForcedIds.size === 0, "areaForcedIds cleared");
  assert(!after.forcedChargers.has("area-a"), "area-a removed");
  assert(!after.forcedChargers.has("area-b"), "area-b removed");
  assert(after.forcedChargers.has("manual-1"), "manual force-include kept");
  assert(after.forcedChargers.size === 1, "only manual remains");

  // Empty clear is a no-op on manuals
  const empty = clearSelectionModel(new Map([["m", { id: "m" }]]), new Set());
  assert(empty.forcedChargers.has("m"), "manual kept when no area ids");
  assert(empty.areaForcedIds.size === 0, "area set empty");

  console.log("test_clear_selection.js: ALL PASSED");
}

run();

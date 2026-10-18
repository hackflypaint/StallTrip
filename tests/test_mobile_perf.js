/**
 * Pure helpers for mobile Phase 3 performance.
 * Mirrors static/app.js — run: node tests/test_mobile_perf.js
 */

function exploreFetchLimitFor(zoom, mobileShell) {
  if (!mobileShell) return 120;
  const z = Number.isFinite(zoom) ? zoom : 6;
  if (z < 7) return 25;
  if (z < 9) return 40;
  return 60;
}

function corridorMarkerCapFor(zoom, mobileShell) {
  if (!mobileShell) return 500;
  const z = Number.isFinite(zoom) ? zoom : 6;
  if (z < 7) return 40;
  if (z < 9) return 80;
  return 120;
}

function subsampleMarkers(items, cap) {
  if (!Array.isArray(items) || items.length <= cap) return items || [];
  if (cap <= 0) return [];
  if (cap === 1) return [items[0]];
  const out = [];
  const last = items.length - 1;
  for (let i = 0; i < cap; i++) {
    const idx = Math.round((i * last) / (cap - 1));
    out.push(items[idx]);
  }
  return out;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function run() {
  assert(exploreFetchLimitFor(6, false) === 120, "desktop explore");
  assert(exploreFetchLimitFor(5, true) === 25, "mobile low zoom explore");
  assert(exploreFetchLimitFor(8, true) === 40, "mobile mid zoom explore");
  assert(exploreFetchLimitFor(12, true) === 60, "mobile high zoom explore");

  assert(corridorMarkerCapFor(6, false) === 500, "desktop corridor");
  assert(corridorMarkerCapFor(5, true) === 40, "mobile low zoom corridor");
  assert(corridorMarkerCapFor(8, true) === 80, "mobile mid zoom corridor");
  assert(corridorMarkerCapFor(11, true) === 120, "mobile high zoom corridor");

  const many = Array.from({ length: 100 }, (_, i) => i);
  const sub = subsampleMarkers(many, 10);
  assert(sub.length === 10, "subsample length");
  assert(sub[0] === 0 && sub[9] === 99, "subsample keeps ends");
  assert(subsampleMarkers(many, 200).length === 100, "cap above length is noop");
  assert(subsampleMarkers([], 5).length === 0, "empty ok");

  console.log("test_mobile_perf.js: all checks passed");
}

run();

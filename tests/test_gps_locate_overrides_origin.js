/**
 * Regression: typed/geocoded/preset origin MUST be overwritten when Locate Me
 * gets a GPS fix, and plan-route must be called with the GPS origin.
 *
 * Run (server on :8080):
 *   ALLOW_TEST_RATE_BYPASS=e2e-gps-replan node tests/test_gps_locate_overrides_origin.js
 */
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  ({ chromium } = require("/tmp/pw/node_modules/playwright"));
}

const BASE = process.env.PLANNER_URL || "http://localhost:8080";
const BYPASS = process.env.ALLOW_TEST_RATE_BYPASS || "e2e-gps-replan";
const GPS = { lat: 41.45, lng: -83.36 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(page, fn, { timeout = 15000, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // fn must be self-contained (no Node closures) — Playwright runs it in the page.
    const ok = await page.evaluate(fn);
    if (ok) return;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function mockWatch(page) {
  await page.evaluate((gps) => {
    navigator.geolocation.watchPosition = (success) => {
      setTimeout(() => {
        success({
          coords: {
            latitude: gps.lat,
            longitude: gps.lng,
            accuracy: 18,
            heading: 90,
            speed: 5,
          },
        });
      }, 40);
      return 501;
    };
    navigator.geolocation.clearWatch = () => {};
  }, GPS);
}

async function resetRateLimit(page) {
  try {
    await page.request.get(`${BASE}/api/health?reset_rate_limit=1`, {
      headers: { "X-Test-Rate-Bypass": BYPASS },
      timeout: 5000,
    });
  } catch (_) {
    /* optional */
  }
}

async function run() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/local/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  const planPosts = [];
  await page.route("**/api/plan-route", async (route) => {
    const body = route.request().postDataJSON();
    planPosts.push(body && body.origin);
    await route.continue();
  });

  await page.goto(`${BASE}/`, { waitUntil: "networkidle", timeout: 20000 });
  await resetRateLimit(page);
  await sleep(800);

  // --- Case 1: geocode origin first, then Locate Me (no destination) ---
  console.log("1. Geocode origin -> Locate Me (origin-only)…");
  await page.fill("#originInput", "Chicago, IL");
  await page.waitForSelector("#originSuggestions .suggestion-item", { timeout: 12000 });
  await page.locator("#originSuggestions .suggestion-item").first().click();
  await sleep(400);
  const before1 = await page.evaluate(() => ({ ...window.appState.origin }));
  if (!before1 || Math.abs(before1.lat - GPS.lat) < 0.01) {
    throw new Error(`Expected typed/geocoded origin away from GPS fixture, got ${JSON.stringify(before1)}`);
  }
  await mockWatch(page);
  await page.locator("#btnLocateMe").click();
  await waitUntil(
    page,
    () => {
      const o = window.appState.origin;
      return (
        o &&
        o.source === "geolocation" &&
        Math.abs(o.lat - 41.45) < 0.001 &&
        Math.abs(o.lng - -83.36) < 0.001
      );
    },
    { label: "geocode->locate overwrites origin" }
  );
  const after1 = await page.evaluate(() => ({
    origin: window.appState.origin,
    input: document.getElementById("originInput").value,
    reason: window.appState.liveLocation.lastReplanReason,
  }));
  if (after1.input !== "Current Location") {
    throw new Error(`originInput should read Current Location, got ${after1.input}`);
  }
  if (!["first_fix", "locate_override"].includes(after1.reason)) {
    throw new Error(`Expected first_fix/locate_override, got ${after1.reason}`);
  }
  console.log("   OK origin ->", after1.origin.lat, after1.origin.lng, after1.reason);

  // Stop follow for a clean next case
  await page.locator("#btnLocateMe").click();
  await sleep(300);

  // --- Case 2: preset (origin+dest+plan) then Locate Me -> GPS origin + replan POST ---
  console.log("2. Preset SF->LA -> Locate Me (must replan from GPS)…");
  await resetRateLimit(page);
  planPosts.length = 0;
  await page.selectOption("#maxStopsSelect", "6");
  await page.locator('button.preset-tag:has-text("SF → LA")').click();
  await page.waitForSelector("#routeResults", { state: "visible", timeout: 40000 });
  await waitUntil(page, () => !window.appState.planInFlight, {
    timeout: 45000,
    label: "preset plan idle",
  });
  const before2 = await page.evaluate(() => ({
    origin: { ...window.appState.origin },
    planOrigin: (window.appState.activePlan.stops || []).find((s) => s.type === "ORIGIN"),
  }));
  if (Math.abs(before2.origin.lat - 37.7749) > 0.01) {
    throw new Error(`Expected SF preset origin, got ${JSON.stringify(before2.origin)}`);
  }
  await mockWatch(page);
  const postsBeforeLocate = planPosts.length;
  await page.locator("#btnLocateMe").click();
  await waitUntil(
    page,
    () => {
      const o = window.appState.origin;
      return !!(o && Math.abs(o.lat - 41.45) < 0.001 && o.source === "geolocation");
    },
    { label: "preset-then-locate overwrites origin" }
  );
  // Soft-clear: coastal itinerary identity drops immediately (geometry may remain
  // until the GPS plan paints — avoids blank→fitBounds flicker).
  await waitUntil(
    page,
    () => window.appState.activePlan == null || window.appState.planInFlight,
    { timeout: 5000, label: "stale plan cleared or replan in flight" }
  );
  const deadlinePosts = Date.now() + 20000;
  let sawGpsPost = false;
  while (Date.now() < deadlinePosts) {
    for (const o of planPosts) {
      if (o && Math.abs(o[0] - 41.45) < 0.001 && Math.abs(o[1] - -83.36) < 0.001) {
        sawGpsPost = true;
        break;
      }
    }
    if (sawGpsPost) break;
    await sleep(100);
  }
  if (!sawGpsPost) {
    throw new Error(`plan-route POST never used GPS origin; posts=${JSON.stringify(planPosts)}`);
  }
  if (planPosts.length <= postsBeforeLocate) {
    throw new Error("Expected a new plan-route after locate");
  }
  await waitUntil(
    page,
    () => {
      const plan = window.appState.activePlan;
      if (!plan || window.appState.planInFlight) return false;
      const po = (plan.stops || []).find((s) => s.type === "ORIGIN");
      return !!(po && Math.abs(po.lat - 41.45) < 0.001);
    },
    { timeout: 90000, label: "replanned ORIGIN matches GPS" }
  );
  const after2 = await page.evaluate(() => {
    const po = ((window.appState.activePlan && window.appState.activePlan.stops) || []).find(
      (s) => s.type === "ORIGIN"
    );
    return {
      origin: window.appState.origin,
      planOrigin: po,
      reason: window.appState.liveLocation.lastReplanReason,
    };
  });
  console.log(
    "   OK GPS origin + replan",
    after2.origin.lat,
    after2.planOrigin && after2.planOrigin.lat,
    after2.reason
  );

  // --- Case 3: overwrite origin while following paused -> resume must commit GPS ---
  console.log("3. Pause follow, type new origin, resume locate -> GPS wins…");
  await page.evaluate(() => {
    window.appState.map.fire("dragstart");
  });
  await sleep(200);
  await page.evaluate(() => {
    window.appState.origin = {
      name: "Typed After Pause",
      lat: 37.7749,
      lng: -122.4194,
      source: "geocode",
    };
    document.getElementById("originInput").value = "Typed After Pause";
  });
  await page.locator("#btnLocateMe").click(); // resume
  await waitUntil(
    page,
    () => {
      const o = window.appState.origin;
      return o && Math.abs(o.lat - 41.45) < 0.001 && o.source === "geolocation";
    },
    { label: "resume locate overrides typed origin" }
  );
  console.log("   OK resume override");

  // --- Case 4: /tesla peek locate ---
  console.log("4. /tesla peek locate overrides origin…");
  await page.goto(`${BASE}/tesla`, { waitUntil: "networkidle", timeout: 20000 });
  await sleep(1000);
  await page.evaluate(() => {
    window.appState.origin = {
      name: "Preset Start",
      lat: 34.05,
      lng: -118.25,
      source: "geocode",
    };
    document.getElementById("originInput").value = "Preset Start";
  });
  await mockWatch(page);
  const peek = page.locator("#btnCarSheetLocate");
  await peek.click({ force: true });
  await waitUntil(
    page,
    () => {
      const o = window.appState.origin;
      return o && Math.abs(o.lat - 41.45) < 0.001 && o.source === "geolocation";
    },
    { label: "tesla peek locate overrides origin" }
  );
  console.log("   OK tesla peek locate");

  // --- Case 5: /mobile Use Current Location one-shot ---
  console.log("5. /mobile Use Current Location overrides origin…");
  await page.goto(`${BASE}/mobile`, { waitUntil: "networkidle", timeout: 20000 });
  await waitUntil(page, () => !!window.appState && !!window.isMobileShell && window.isMobileShell(), {
    timeout: 15000,
    label: "mobile shell ready",
  });
  await page.evaluate(() => {
    if (typeof window.openMobileSheet === "function") window.openMobileSheet();
    window.appState.origin = {
      name: "Mobile Typed",
      lat: 40.7,
      lng: -74.0,
      source: "geocode",
    };
    const input = document.getElementById("originInput");
    if (input) input.value = "Mobile Typed";
    navigator.geolocation.getCurrentPosition = (success) => {
      setTimeout(() => {
        success({
          coords: { latitude: 41.45, longitude: -83.36, accuracy: 20 },
        });
      }, 30);
    };
  });
  await sleep(300);
  const clicked = await page.evaluate(() => {
    const btn = document.getElementById("btnUseCurrentLocation");
    if (!btn) return { ok: false, reason: "missing-btn" };
    btn.click();
    return { ok: true, mobile: window.isMobileShell() };
  });
  if (!clicked.ok) throw new Error(`Use Current Location not clickable: ${clicked.reason}`);
  await sleep(600);
  const afterMobile = await page.evaluate(() => ({
    origin: window.appState && window.appState.origin,
    input: document.getElementById("originInput") && document.getElementById("originInput").value,
  }));
  if (
    !afterMobile.origin ||
    Math.abs(afterMobile.origin.lat - 41.45) >= 0.001 ||
    Math.abs(afterMobile.origin.lng - -83.36) >= 0.001
  ) {
    throw new Error(`mobile one-shot failed: ${JSON.stringify(afterMobile)}`);
  }
  console.log("   OK mobile one-shot");

  await browser.close();
  console.log("test_gps_locate_overrides_origin.js: ALL PASSED");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

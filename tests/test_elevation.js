/**
 * Unit + Playwright UI verification for the Elevation-Aware Battery & Grade Profile Strip.
 *
 * Run:
 *   node tests/test_elevation.js
 *   node tests/test_elevation.js --unit-only
 *
 * Verifies:
 * 1. Pure math & sampling helpers in static/elevation/elevation-profile.js (VM sandbox):
 *    - Equidistant polyline sampling (~40–60 points) & stop coordinate fallback
 *    - Open-Meteo Elevation API URL builder
 *    - Synthetic terrain fallback generator
 *    - Grade (%) computation & Supercharger stop projection onto terrain curve
 *    - Climb penalty (+kWh) vs. Regenerative Braking recovery (-kWh) & net Wh/mi delta
 * 2. End-to-end Playwright browser checks across Desktop (1440×900), Mobile (/mobile 390×844),
 *    and Tesla in-car (/tesla 773×601) viewports:
 *    - Strip renders along bottom of map when routePlanned fires
 *    - SVG area chart & Supercharger stop pins (#1, #2, ...) plotted on curve
 *    - Climb / Regen / Net kWh & Wh/mi delta badges populated
 *    - Hover/scrub highlights corresponding point on Leaflet map with elevation, % grade, and distance
 *    - Unit toggle (ft ↔ m) and collapse/expand button
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const http = require("http");
const { spawn } = require("child_process");

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

function loadElevationModule() {
  const src = fs.readFileSync(
    path.join(__dirname, "..", "static", "elevation", "elevation-profile.js"),
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
  assert(sandbox.ElevationModule, "ElevationModule not exported on window");
  assert(sandbox.ElevationModule._test, "ElevationModule._test helpers missing");
  return sandbox.ElevationModule;
}

function runUnitTests() {
  console.log("=== Running ElevationModule unit tests ===");
  const mod = loadElevationModule();
  const t = mod._test;

  assert(
    t.OPEN_METEO_ELEVATION_URL === "https://api.open-meteo.com/v1/elevation",
    "Open-Meteo endpoint URL"
  );
  assert(
    t.DEFAULT_SAMPLE_COUNT >= 40 && t.DEFAULT_SAMPLE_COUNT <= 60,
    `DEFAULT_SAMPLE_COUNT should be 40..60, got ${t.DEFAULT_SAMPLE_COUNT}`
  );

  // 1. Route coordinate extraction (plan.geometry.coordinates, plan.route.geometry.coordinates, stops fallback)
  const coordsA = t.extractRouteCoordinates({
    geometry: {
      coordinates: [
        [-122.4194, 37.7749],
        [-121.0, 36.5],
        [-118.2437, 34.0522],
      ],
    },
  });
  assert(coordsA.length === 3, "extract from plan.geometry.coordinates");

  const coordsB = t.extractRouteCoordinates({
    route: {
      geometry: {
        coordinates: [
          [-122.4194, 37.7749],
          [-118.2437, 34.0522],
        ],
      },
    },
  });
  assert(coordsB.length === 2, "extract from plan.route.geometry.coordinates");

  const coordsC = t.extractRouteCoordinates({
    stops: [
      { lat: 37.7749, lng: -122.4194 },
      { lat: 36.1699, lng: -115.1398 },
    ],
  });
  assert(coordsC.length === 2, "extract fallback from plan.stops");

  // 2. Equidistant sampling
  const samples = t.sampleRouteGeometry(coordsA, 50);
  assert(samples.length === 50, `Expected 50 equidistant samples, got ${samples.length}`);
  assert(samples[0].distKm === 0, "First sample at 0 km");
  assert(samples[49].distKm > 500, `Total SF->LA distance > 500 km, got ${samples[49].distKm}`);
  for (let i = 1; i < samples.length; i++) {
    assert(samples[i].distKm >= samples[i - 1].distKm, "Monotonic sample distance");
  }

  // 3. Open-Meteo URL builder
  const url = t.buildOpenMeteoUrl(samples.slice(0, 5));
  assert(url.startsWith("https://api.open-meteo.com/v1/elevation?latitude="), "Open-Meteo URL prefix");
  assert(url.includes("&longitude="), "Open-Meteo URL longitude param");

  // 4. Synthetic fallback & grade enrichment
  const synth = t.generateSyntheticElevations(samples);
  assert(synth.length === samples.length, "Synthetic elevations count matches samples");
  assert(synth.every((v) => Number.isFinite(v) && v >= 0), "Valid synthetic elevation values");

  // Construct a known mountain pass profile: 0m -> 1000m peak at midpoint -> 200m destination
  const customElevs = samples.map((_, i) => {
    if (i <= 25) return Math.round((i / 25) * 1000);
    return Math.round(1000 - ((i - 25) / 24) * 800);
  });
  const enriched = t.enrichSamplesWithGrade(samples, customElevs);
  assert(enriched[0].elevM === 0, "Start elevation 0m");
  assert(enriched[25].elevM === 1000, "Peak elevation 1000m");
  assert(enriched[25].elevFt === Math.round(1000 * 3.28084), "Peak elevation in feet");
  assert(enriched[10].gradePct > 0, "Ascending grade > 0%");
  assert(enriched[35].gradePct < 0, "Descending grade < 0%");

  // 5. Project stops & compute Climb Penalty (+kWh) vs Regen Braking Recovery (-kWh)
  const mockStops = [
    { type: "ORIGIN", name: "San Francisco", lat: 37.7749, lng: -122.4194 },
    {
      type: "SUPERCHARGER",
      stop_index: 1,
      name: "Kettleman City Supercharger",
      lat: 36.5,
      lng: -121.0,
      forced: false,
    },
    { type: "DESTINATION", name: "Los Angeles", lat: 34.0522, lng: -118.2437 },
  ];
  const projected = t.projectStopsToProfile(mockStops, enriched);
  assert(projected.length === 3, "Projected 3 stops");
  assert(projected[0].sampleIndex === 0, "Origin at index 0");
  assert(
    projected[1].sampleIndex > 0 && projected[1].sampleIndex < 49,
    `Mid Supercharger projected onto interior sample index (${projected[1].sampleIndex})`
  );
  assert(projected[2].sampleIndex === 49, "Destination at final sample index");

  const impact = t.computeElevationEnergyImpact(enriched, projected);
  assert(impact.overall.ascentM === 1000, `Expected 1000m ascent, got ${impact.overall.ascentM}`);
  assert(impact.overall.descentM === 800, `Expected 800m descent, got ${impact.overall.descentM}`);
  assert(
    impact.overall.climbPenaltyKwh > 5.8 && impact.overall.climbPenaltyKwh < 7.5,
    `Expected ~6.45 kWh climb penalty for 1000m ascent (Model Y LR 2,130 kg), got ${impact.overall.climbPenaltyKwh}`
  );
  assert(
    impact.overall.regenRecoveryKwh > 2.8 && impact.overall.regenRecoveryKwh < 4.5,
    `Expected ~3.8 kWh downhill recovery for 800m descent, got ${impact.overall.regenRecoveryKwh}`
  );
  assert(
    Math.abs(
      impact.overall.netElevationKwh -
        (impact.overall.climbPenaltyKwh - impact.overall.regenRecoveryKwh)
    ) < 0.05,
    "Net elevation kWh equals climb penalty minus regen recovery"
  );
  assert(
    impact.overall.netSocDeltaPct < 0,
    `Expected negative SoC delta % when net climb > regen, got ${impact.overall.netSocDeltaPct}`
  );
  assert(impact.legs.length === 2, "2 legs computed for 1 intermediate Supercharger stop");
  assert(impact.legs[0].climbPenaltyKwh > 0, "Leg 1 uphill has positive climb penalty");
  assert(impact.legs[1].regenRecoveryKwh > 0, "Leg 2 downhill has positive regen recovery");

  // 5b. Verify Tesla Longitudinal Physics: Symmetric Mountain Pass (0m -> 1000m -> 0m)
  // Climbing 1,000m and descending 1,000m back to starting elevation MUST consume net positive
  // battery energy because 1/η_drive (~1.11) > η_regen (~0.75).
  const symPassSamples = samples.map((s, i) => ({
    ...s,
    distKm: i * 1.0, // 1 km per step -> steep 4% grade (40m per km)
    distMi: i * 0.621371,
  }));
  const symElevs = symPassSamples.map((_, i) => (i <= 25 ? i * 40 : (50 - i) * 40));
  const symEnriched = t.enrichSamplesWithGrade(symPassSamples, symElevs);
  const symSeg = t.computeSegmentEnergy(symEnriched, 0, symEnriched.length - 1, {
    vehiclePresetId: "modely_lr",
  });
  assert(symSeg.ascentM === 1000 && symSeg.descentM === 960, "Symmetric pass ascent/descent");
  assert(
    symSeg.activeRegenKwh > 0,
    `Steep -4% grade must engage active battery regenerative braking, got ${symSeg.activeRegenKwh}`
  );
  assert(
    symSeg.netElevationKwh > 1.2,
    `Round-trip mountain pass must have positive net kWh penalty (1/η_drive > η_regen), got ${symSeg.netElevationKwh}`
  );

  // 5c. Verify Tesla Vehicle Mass Presets (Model 3 LR 1,980 kg vs Cybertruck 3,150 kg)
  const m3Seg = t.computeSegmentEnergy(symEnriched, 0, 25, { vehiclePresetId: "model3_lr" });
  const ctSeg = t.computeSegmentEnergy(symEnriched, 0, 25, { vehiclePresetId: "cybertruck" });
  assert(
    ctSeg.climbPenaltyKwh > m3Seg.climbPenaltyKwh * 1.45,
    `Cybertruck (3,150 kg) climb energy (${ctSeg.climbPenaltyKwh}) should scale vs Model 3 LR (1,980 kg) (${m3Seg.climbPenaltyKwh})`
  );

  // 6. Verify CSP in server.py allows https://api.open-meteo.com
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.py"), "utf8");
  assert(
    serverSrc.includes("https://api.open-meteo.com"),
    "server.py connect-src must allow https://api.open-meteo.com"
  );

  console.log("Unit tests: ALL PASSED");
}

function waitForHealth(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`Health check HTTP ${res.statusCode}`));
        }
        setTimeout(tick, 250);
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          return reject(new Error("Server health timeout"));
        }
        setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function ensureServer(baseUrl) {
  try {
    await waitForHealth(`${baseUrl}/api/health`, 1800);
    return null;
  } catch (_) {
    /* spawn local server */
  }
  const port = Number(new URL(baseUrl).port || 8080);
  const proc = spawn("python3", ["server.py", String(port)], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(`${baseUrl}/api/health`, 25000);
  return proc;
}

async function runPlaywrightVerification() {
  console.log("\n=== Running Playwright UI verification (Desktop, Mobile, Tesla) ===");
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch (_) {
    ({ chromium } = require("/tmp/pw/node_modules/playwright"));
  }
  const BASE = process.env.ELEVATION_TEST_BASE || "http://127.0.0.1:8080";
  const serverProc = await ensureServer(BASE);

  const launchOpts = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  };
  if (fs.existsSync("/usr/local/bin/google-chrome")) {
    launchOpts.executablePath = "/usr/local/bin/google-chrome";
  }

  const browser = await chromium.launch(launchOpts);
  try {
    // 1. Desktop viewport (1440×900)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("#map", { timeout: 10000 });

    // Strip is hidden before planning a route
    const initiallyHidden = await page.locator("#elevationStrip").isHidden();
    assert(initiallyHidden, "Elevation strip should be hidden before a route is planned");

    // Plan SF -> LA route
    await page.selectOption("#maxStopsSelect", "6");
    await page.locator('button.preset-tag:has-text("SF → LA")').click();
    await page.waitForSelector("#routeResults", { state: "visible", timeout: 40000 });
    await page.waitForSelector("#elevationStrip:not([hidden])", {
      state: "visible",
      timeout: 20000,
    });

    // Wait for SVG path and Supercharger pins to render
    await page.waitForSelector("#elevationSvg .elev-area-path", { timeout: 15000 });
    const pinCount = await page.locator("#elevationSvg .elev-stop-pin").count();
    assert(pinCount >= 2, `Expected >=2 Supercharger pins on elevation curve, got ${pinCount}`);

    // Check Climb / Regen / Net energy delta badges (including SoC %)
    const climbText = await page.locator("#elevClimbText").textContent();
    const regenText = await page.locator("#elevRegenText").textContent();
    const netKwhText = await page.locator("#elevNetKwhText").textContent();
    const netSocText = await page.locator("#elevNetSocText").textContent();
    const netWhMiText = await page.locator("#elevNetWhMiText").textContent();

    console.log(
      `  Desktop strip badges: Climb="${climbText}" | Regen="${regenText}" | Net="${netKwhText} · ${netSocText} · ${netWhMiText}" (${pinCount} stop pins)`
    );
    assert(/\+\d+\.\d+\s*kWh/.test(climbText || ""), `Valid climb kWh badge: ${climbText}`);
    assert(/−\d+\.\d+\s*kWh/.test(regenText || ""), `Valid regen kWh badge: ${regenText}`);
    assert(/Net\s+[+−±]\d+\.\d+\s*kWh/.test(netKwhText || ""), `Valid net kWh badge: ${netKwhText}`);
    assert(/[+−±]\d+\.\d+%\s*SoC/.test(netSocText || ""), `Valid net SoC % badge: ${netSocText}`);
    assert(/[+−±]\d+\s*Wh\/mi/.test(netWhMiText || ""), `Valid net Wh/mi badge: ${netWhMiText}`);

    // Hover along the elevation chart -> verify map marker & scrub readout update
    const chartBox = await page.locator("#elevationChartWrap").boundingBox();
    assert(chartBox && chartBox.width > 200, "Elevation chart has valid bounding box");
    await page.mouse.move(chartBox.x + chartBox.width * 0.45, chartBox.y + chartBox.height * 0.5);

    const scrubState = await page.evaluate(() => {
      const m = window.ElevationModule;
      const dist = document.getElementById("elevScrubDist")?.textContent || "";
      const alt = document.getElementById("elevScrubAlt")?.textContent || "";
      const grade = document.getElementById("elevScrubGrade")?.textContent || "";
      const leg = document.getElementById("elevScrubLeg")?.textContent || "";
      const hasHoverMarker = !!(m && m._hoverMarker && window.appState.map.hasLayer(m._hoverMarker));
      return { dist, alt, grade, leg, hasHoverMarker };
    });
    console.log(
      `  Hover scrub: ${scrubState.dist} | ${scrubState.alt} | ${scrubState.grade} | marker=${scrubState.hasHoverMarker}`
    );
    assert(scrubState.hasHoverMarker, "Hovering chart must place highlight marker on Leaflet map");
    assert(/^Dist:\s*\d+\.\d+\s*mi/.test(scrubState.dist), `Scrub distance updated: ${scrubState.dist}`);
    assert(/^Elev:\s*[\d,]+\s*ft/.test(scrubState.alt), `Scrub elevation updated: ${scrubState.alt}`);
    assert(/^Grade:\s*[+-]?\d+\.\d+%/.test(scrubState.grade), `Scrub grade updated: ${scrubState.grade}`);
    assert(/Leg #\d+/.test(scrubState.leg), `Scrub leg summary updated: ${scrubState.leg}`);

    // Unit toggle ft -> m -> ft
    await page.locator("#btnElevUnit").click();
    const climbMeters = await page.locator("#elevClimbText").textContent();
    assert(/\bm\)/.test(climbMeters || ""), `Expected meters after unit toggle, got ${climbMeters}`);
    await page.locator("#btnElevUnit").click();

    // Collapse & expand strip
    await page.locator("#btnElevCollapse").click();
    const isCollapsed = await page.evaluate(() =>
      document.getElementById("elevationStrip")?.classList.contains("is-collapsed")
    );
    assert(isCollapsed, "Elevation strip should collapse on button click");
    await page.locator("#btnElevCollapse").click();

    // 2. Tesla In-Car Viewport (/tesla 773×601)
    console.log("  Testing Tesla car-shell viewport (/tesla 773×601)...");
    await page.setViewportSize({ width: 773, height: 601 });
    await page.goto(`${BASE}/tesla`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("body.car-shell", { timeout: 8000 });
    await page.locator("#btnCarSheetPlan").click();
    await page.waitForSelector('body[data-sheet="plan"]', { timeout: 5000 });
    await page.locator('#route-tab .preset-tag:has-text("SF → LA")').click();
    await page.waitForSelector("html[data-plan-stops]", { timeout: 45000 });
    await page.waitForSelector("#elevationStrip:not([hidden])", {
      state: "visible",
      timeout: 20000,
    });
    const carStripBox = await page.locator("#elevationStrip").boundingBox();
    const carSheetBox = await page.locator("#sidebar").boundingBox();
    assert(carStripBox && carSheetBox, "Car strip and peek bar visible");
    assert(
      carStripBox.y + carStripBox.height <= carSheetBox.y + 2,
      `Elevation strip (${carStripBox.y + carStripBox.height}) must sit cleanly above car peek sheet (${carSheetBox.y})`
    );
    console.log(
      `  Tesla car-shell OK: strip bottom=${Math.round(carStripBox.y + carStripBox.height)}px <= sheet top=${Math.round(carSheetBox.y)}px`
    );

    // 3. Mobile Shell Viewport (/mobile 390×844)
    console.log("  Testing Mobile shell viewport (/mobile 390×844)...");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${BASE}/mobile?sheet=1`, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("body.ui-mobile.sheet-open", { timeout: 8000 });
    await page.selectOption("#maxStopsSelect", "6");
    await page.locator('button.preset-tag:has-text("SF → LA")').click();
    await page.waitForSelector("#elevationStrip:not([hidden])", {
      state: "visible",
      timeout: 45000,
    });
    const mobileStripVisible = await page.locator("#elevationStrip").isVisible();
    assert(mobileStripVisible, "Elevation strip visible on /mobile map after planning");
    console.log("  Mobile shell (/mobile) OK");

    assert(pageErrors.length === 0, `Unexpected page errors: ${pageErrors.join("; ")}`);
    await context.close();
    console.log("Playwright UI verification: ALL PASSED");
  } finally {
    await browser.close();
    if (serverProc) serverProc.kill("SIGTERM");
  }
}

async function main() {
  runUnitTests();
  if (process.argv.includes("--unit-only")) return;
  await runPlaywrightVerification();
}

main().catch((err) => {
  console.error("test_elevation.js FAILED:", err);
  process.exit(1);
});

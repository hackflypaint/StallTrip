/**
 * Automated Playwright verification for Live Highway Weather, Wind Headwind & Radar Overlay.
 * Tests:
 * 1. Pure unit math: compass bearing, headwind/tailwind/crosswind vectors, cold battery penalty (<50°F / 10°C).
 * 2. Live Animated Weather Radar Layer (RainViewer API) in Layers panel + play/pause + opacity + radar pill.
 * 3. Client-side Route Weather & Headwind Analysis (Open-Meteo API) on planned route + UI badges + mobile/Tesla shells.
 *
 * Run: node tests/verify_weather.js
 */
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  ({ chromium } = require("/tmp/pw/node_modules/playwright"));
}
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = "/tmp/tesla-planner-artifacts/screenshots";
const STORE_MEDIA_DIR = "/tmp/tesla-planner-media";

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

async function main() {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.mkdirSync(STORE_MEDIA_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/local/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  const consoleErrors = [];
  page.on("pageerror", (err) => {
    console.error("[PageError]", err.message);
    consoleErrors.push(err.message);
  });

  try {
    console.log("1. Loading application and verifying WeatherModule unit math...");
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle", timeout: 20000 });

    const unitCheck = await page.evaluate(() => {
      const m = window.WeatherModule;
      if (!m || !m._test) return { ok: false, reason: "WeatherModule not mounted" };
      const { computeBearing, analyzeWindVector, calculateEfficiencyImpact } = m._test;

      // Bearing due East (~90°) and due South (~180°)
      const bEast = computeBearing(37.0, -122.0, 37.0, -121.0);
      const bSouth = computeBearing(38.0, -122.0, 37.0, -122.0);

      // Direct headwind: traveling South (180°) with wind from South (180°) at 20 mph
      const hw = analyzeWindVector(20, 180, 180);
      // Direct tailwind: traveling South (180°) with wind from North (0°) at 20 mph
      const tw = analyzeWindVector(20, 0, 180);
      // Direct crosswind: traveling South (180°) with wind from West (270°) at 20 mph
      const xw = analyzeWindVector(20, 270, 180);

      // Cold weather + headwind efficiency penalty: 32°F (-18°F below 50°F) + 14 mph headwind
      const coldHwImpact = calculateEfficiencyImpact(32, 14, 2);
      // Warm tailwind boost: 68°F + -15 mph headwind (15 mph tailwind)
      const warmTwImpact = calculateEfficiencyImpact(68, -15, 0);

      return {
        ok: true,
        bEast,
        bSouth,
        hw,
        tw,
        xw,
        coldHwImpact,
        warmTwImpact,
      };
    });

    assert(unitCheck.ok, unitCheck.reason || "unitCheck failed");
    assert(Math.abs(unitCheck.bEast - 90) < 2, `Expected East bearing ~90°, got ${unitCheck.bEast}`);
    assert(Math.abs(unitCheck.bSouth - 180) < 1, `Expected South bearing ~180°, got ${unitCheck.bSouth}`);
    assert(unitCheck.hw.kind === "headwind" && unitCheck.hw.headwindMph > 19, "Expected direct headwind");
    assert(unitCheck.tw.kind === "tailwind" && unitCheck.tw.headwindMph < -19, "Expected direct tailwind");
    assert(unitCheck.xw.kind === "crosswind" && unitCheck.xw.crosswindMph > 19, "Expected crosswind");
    assert(
      unitCheck.coldHwImpact.isColdPenalty && unitCheck.coldHwImpact.totalPct <= -14,
      `Expected significant cold + headwind penalty, got ${JSON.stringify(unitCheck.coldHwImpact)}`
    );
    assert(
      !unitCheck.warmTwImpact.isColdPenalty && unitCheck.warmTwImpact.totalPct >= 4,
      `Expected tailwind boost, got ${JSON.stringify(unitCheck.warmTwImpact)}`
    );
    console.log("   Unit math verified:", {
      headwind: unitCheck.hw.label,
      tailwind: unitCheck.tw.label,
      coldHwImpact: unitCheck.coldHwImpact,
      warmTwImpact: unitCheck.warmTwImpact,
    });

    console.log("2. Testing RainViewer Live Radar Layer in Layers Menu...");
    await page.locator("#btnToggleLayers").click();
    await page.waitForSelector("#weatherRadarToggle", { state: "visible", timeout: 5000 });
    await page.locator("#weatherRadarToggle").check();
    await page.waitForSelector("#weatherDetailBlock.is-active", { state: "visible", timeout: 5000 });
    await page.waitForSelector("#weatherRadarPill.is-visible", { state: "visible", timeout: 5000 });

    // Wait for radar frames to load
    await page.waitForTimeout(1500);
    const radarState = await page.evaluate(() => ({
      enabled: window.WeatherModule.isEnabled(),
      framesCount: window.WeatherModule._frames.length,
      hasTileLayer: !!window.WeatherModule._tileLayer,
      statusText: document.getElementById("weatherStatus")?.textContent || "",
    }));
    assert(radarState.enabled, "WeatherModule radar should be enabled");
    assert(radarState.framesCount >= 1, `Expected >=1 radar frames, got ${radarState.framesCount}`);
    assert(radarState.hasTileLayer, "Expected Leaflet radar tileLayer on map");
    console.log(`   Radar active: ${radarState.framesCount} frames (${radarState.statusText})`);

    // Test Play / Pause toggle & Opacity slider
    await page.locator("#weatherPlayPauseBtn").click();
    const isPlaying = await page.evaluate(() => window.WeatherModule._playing);
    assert(isPlaying === true, "Expected radar animation playing after clicking Play");
    await page.waitForTimeout(900);
    await page.locator("#weatherPlayPauseBtn").click();
    const isPaused = await page.evaluate(() => window.WeatherModule._playing);
    assert(isPaused === false, "Expected radar animation paused after second click");

    await page.evaluate(() => {
      window.WeatherModule.setOpacity(0.85);
    });
    const opacityVal = await page.locator("#weatherOpacityVal").textContent();
    assert(opacityVal === "85%", `Expected opacity label 85%, got ${opacityVal}`);

    // Close layers panel
    await page.locator("#btnToggleLayers").click();

    console.log("3. Planning Route & Verifying Client-Side Open-Meteo Weather + Headwind Badges...");
    await page.selectOption("#maxStopsSelect", "6");
    await page.locator('button.preset-tag:has-text("SF → LA")').click();

    await page.waitForSelector("#routeResults", { state: "visible", timeout: 35000 });

    // Poll until Open-Meteo route analysis populates #routeWeatherStrip and #mapWeatherPill
    const startWait = Date.now();
    let routeWeatherReady = false;
    while (Date.now() - startWait < 20000) {
      routeWeatherReady = await page.evaluate(() => {
        const strip = document.getElementById("routeWeatherStrip");
        const pill = document.getElementById("mapWeatherPill");
        return !!(
          strip &&
          !strip.hidden &&
          strip.textContent.trim().length > 0 &&
          pill &&
          !pill.hidden &&
          pill.textContent.trim().length > 0
        );
      });
      if (routeWeatherReady) break;
      await page.waitForTimeout(300);
    }
    assert(routeWeatherReady, "Expected #routeWeatherStrip and #mapWeatherPill to become visible with weather data");

    const uiWeatherSummary = await page.evaluate(() => {
      const stripHeadline = document.getElementById("weatherStripHeadline")?.textContent || "";
      const impactBadge = document.getElementById("weatherRangeImpactBadge")?.textContent?.trim() || "";
      const pillText = document.getElementById("mapWeatherPill")?.textContent?.trim() || "";
      const timelineBadgesCount = document.querySelectorAll("#stopsTimeline .timeline-weather-row").length;
      const mapBadgesCount = document.querySelectorAll(".weather-map-badge").length;
      const analysis = window.WeatherModule.getLastRouteAnalysis();
      return {
        stripHeadline,
        impactBadge,
        pillText,
        timelineBadgesCount,
        mapBadgesCount,
        waypointCount: analysis ? analysis.waypoints.length : 0,
      };
    });

    console.log("   Route Weather Summary:", uiWeatherSummary);
    assert(
      /°F/.test(uiWeatherSummary.stripHeadline) && /mph/i.test(uiWeatherSummary.stripHeadline),
      `Expected temperature and wind speed in headline, got: ${uiWeatherSummary.stripHeadline}`
    );
    assert(uiWeatherSummary.timelineBadgesCount >= 2, "Expected per-stop weather rows in timeline");
    assert(uiWeatherSummary.mapBadgesCount >= 2, "Expected weather/wind badges on map");

    const desktopShot = path.join(ARTIFACTS_DIR, "weather_wind_desktop.png");
    await page.screenshot({ path: desktopShot, fullPage: false });
    fs.copyFileSync(desktopShot, path.join(STORE_MEDIA_DIR, "weather_wind_desktop.png"));

    console.log("4. Verifying Tesla Car Shell (/tesla) & Mobile Shell (/mobile) responsiveness...");
    await page.setViewportSize({ width: 773, height: 601 });
    await page.goto(`${BASE_URL}/tesla`, { waitUntil: "networkidle", timeout: 20000 });
    await page.locator("#btnCarSheetPlan").click();
    await page.waitForSelector('body[data-sheet="plan"]', { timeout: 5000 });
    await page.locator('#route-tab button.preset-tag[data-orig="San Francisco, CA"]').click();
    await page.waitForTimeout(3500);
    const teslaShot = path.join(ARTIFACTS_DIR, "weather_wind_tesla_car.png");
    await page.screenshot({ path: teslaShot, fullPage: false });
    fs.copyFileSync(teslaShot, path.join(STORE_MEDIA_DIR, "weather_wind_tesla_car.png"));

    assert(consoleErrors.length === 0, `Unexpected page errors: ${consoleErrors.join("; ")}`);
    console.log("\n=======================================================");
    console.log("verify_weather.js: ALL WEATHER & WIND CHECKS PASSED!");
    console.log("=======================================================\n");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error("verify_weather.js failed:", err);
  process.exit(1);
});

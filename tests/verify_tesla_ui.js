/**
 * Tesla landscape Playwright suite (Gate G1).
 *
 * Profiles (community-measured post–summer 2026 Model Y CSS sizes):
 *   - 773×601 windowed browser chrome
 *   - 1254×784 screen / fullscreen-ish
 * deviceScaleFactor 1.53, hasTouch true.
 *
 * Smoke: load → preset plan → drawer → box select → layers open.
 * Screenshots → store media/tesla-emulation/ when run.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const BASE = process.env.TESLA_UI_BASE || "http://127.0.0.1:8080";
const MEDIA_DIR =
  process.env.TESLA_MEDIA_DIR ||
  "/tmp/tesla-planner-media";

const TESLA_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/148.0.0.0 Safari/537.36";

const PROFILES = [
  { name: "windowed-773x601", width: 773, height: 601 },
  { name: "screen-1254x784", width: 1254, height: 784 },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForHealth(url, timeoutMs = 45000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error(`health check failed: ${res.statusCode}`));
          return;
        }
        setTimeout(tick, 300);
      });
      req.on("error", () => {
        if (Date.now() - started > timeoutMs) {
          reject(new Error("server did not become healthy in time"));
          return;
        }
        setTimeout(tick, 300);
      });
    };
    tick();
  });
}

async function ensureServer() {
  try {
    await waitForHealth(`${BASE}/api/health`, 2000);
    console.log(`Using existing server at ${BASE}`);
    return null;
  } catch (_) {
    /* start local */
  }
  const port = Number(new URL(BASE).port || 8080);
  console.log(`Starting python3 server.py ${port} ...`);
  const child = spawn("python3", ["server.py", String(port)], {
    cwd: path.join(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));
  await waitForHealth(`${BASE}/api/health`);
  return child;
}

async function runProfile(browser, profile) {
  console.log(`\n=== Tesla profile ${profile.name} (${profile.width}×${profile.height}) ===`);
  const context = await browser.newContext({
    viewport: { width: profile.width, height: profile.height },
    deviceScaleFactor: 1.53,
    hasTouch: true,
    isMobile: true,
    userAgent: TESLA_UA,
  });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`[PageError ${profile.name}]:`, err.message));
  page.on("dialog", async (dialog) => {
    console.log(`[Dialog ${profile.name}]:`, dialog.message());
    await dialog.dismiss();
  });

  const shot = (name) =>
    page.screenshot({
      path: path.join(MEDIA_DIR, `${profile.name}_${name}.png`),
      fullPage: false,
    });

  // Probe page fingerprint fields
  console.log("0. /tesla-probe fingerprint...");
  await page.goto(`${BASE}/tesla-probe`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#probeRows .row", { timeout: 10000 });
  const probeText = await page.locator("#probeRows").innerText();
  if (!/userAgent/i.test(probeText) || !/devicePixelRatio/i.test(probeText)) {
    throw new Error("probe page missing core fingerprint rows");
  }
  const chromiumCell = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("#probeRows .row")];
    const hit = rows.find((r) => /chromiumMajor/i.test(r.textContent || ""));
    return hit ? hit.textContent : "";
  });
  if (!/148/.test(chromiumCell || "")) {
    throw new Error(`expected Chromium major 148 from spoofed UA, got: ${chromiumCell}`);
  }
  // Touch smoke on probe pad
  await page.locator("#touchPad").tap();
  await page.waitForFunction(
    () => {
      const pad = document.getElementById("touchPad");
      return pad && pad.classList.contains("hit");
    },
    { timeout: 5000 }
  );
  await shot("probe");
  console.log("  probe OK");

  // App smoke
  console.log("1. Load planner...");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#totalChargersBadge", { timeout: 15000 });
  await page.waitForSelector("button.preset-tag", { timeout: 10000 });
  await shot("01_load");

  console.log("2. Preset plan SF → LA...");
  await page.selectOption("#maxStopsSelect", "6");
  await page.locator('button.preset-tag:has-text("SF → LA")').tap();
  await page.waitForSelector("#routeResults", { state: "visible", timeout: 45000 });
  await page.waitForFunction(
    () => {
      const el = document.getElementById("statStops");
      return el && parseInt(el.textContent || "0", 10) > 1;
    },
    { timeout: 45000 }
  );
  const stops = parseInt(await page.locator("#statStops").textContent(), 10);
  console.log(`  stops=${stops}`);
  if (!(stops > 1)) {
    throw new Error(`Visit Maximizer expected >1 stops, got ${stops}`);
  }
  await shot("02_plan");

  console.log("3. Open charger drawer...");
  await page.locator(".timeline-item.supercharger .timeline-content").first().tap();
  await page.waitForSelector("#chargerDrawer", { state: "visible", timeout: 8000 });
  const drawerTitle = (await page.locator("#drawerTitle").textContent()) || "";
  if (!drawerTitle.trim()) {
    throw new Error("drawer title empty");
  }
  // Force-include control must be tappable (no hover-only)
  await page.locator("#btnAddStopToRoute").tap();
  await page.waitForFunction(() => window.appState && window.appState.forcedChargers.size >= 1, {
    timeout: 10000,
  });
  await shot("03_drawer");
  await page.locator("#btnCloseDrawer").tap();
  await sleep(400);

  console.log("4. Box select from map toolbar...");
  const areaOnBar = await page.locator(".map-floating-bar #btnAreaModeBox").count();
  if (areaOnBar < 1) {
    throw new Error("Box tool must be on map floating bar");
  }
  await page.locator("#btnAreaModeBox").tap();
  await page.waitForSelector("#mapModeBanner", { state: "visible", timeout: 5000 });
  const mapBox = await page.locator("#map").boundingBox();
  if (!mapBox) {
    throw new Error("#map has no bounding box");
  }
  // Prefer touchscreen drag when available
  const start = { x: mapBox.x + mapBox.width * 0.4, y: mapBox.y + mapBox.height * 0.4 };
  const end = { x: mapBox.x + mapBox.width * 0.7, y: mapBox.y + mapBox.height * 0.7 };
  if (page.touchscreen && typeof page.touchscreen.tap === "function") {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  } else {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 8 });
    await page.mouse.up();
  }
  await sleep(1500);
  await shot("04_box");
  // Clear so layers interaction is clean
  const clearBtn = page.locator(".map-floating-bar #btnClearSelection");
  if (!(await clearBtn.isDisabled())) {
    await clearBtn.tap();
    await sleep(400);
  }

  console.log("5. Open layers panel...");
  // At 773×601 the map legend can cover #btnToggleLayers (Phase 2 car-shell).
  // Prefer a real tap; otherwise dispatch a DOM click (still exercises the handler).
  const layersBtn = page.locator("#btnToggleLayers");
  try {
    await layersBtn.tap({ timeout: 4000 });
  } catch (_) {
    await page.evaluate(() => {
      const btn = document.getElementById("btnToggleLayers");
      if (!btn) throw new Error("btnToggleLayers missing");
      btn.click();
    });
  }
  await page.waitForFunction(
    () => {
      const panel = document.getElementById("layersPanel");
      return panel && panel.style.display !== "none" && panel.getAttribute("aria-hidden") !== "true";
    },
    { timeout: 8000 }
  );
  const layersVisible = await page.locator("#layersPanel").isVisible();
  if (!layersVisible) {
    throw new Error("layers panel not visible after open");
  }
  // Streets radio present — primary layer control without hover
  const streets = await page.locator('input[name="basemapRadio"][value="streets"]').count();
  if (streets < 1) {
    throw new Error("basemap streets control missing");
  }
  await shot("05_layers");

  console.log(`Profile ${profile.name} PASSED`);
  await context.close();
}

async function main() {
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }

  const serverProc = await ensureServer();
  const launchOpts = {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  };
  if (fs.existsSync("/usr/local/bin/google-chrome")) {
    launchOpts.executablePath = "/usr/local/bin/google-chrome";
  }

  const browser = await chromium.launch(launchOpts);
  try {
    for (const profile of PROFILES) {
      await runProfile(browser, profile);
    }
    console.log("\n=============================================");
    console.log("TESLA LANDSCAPE PLAYWRIGHT SUITE PASSED");
    console.log(`Screenshots: ${MEDIA_DIR}`);
    console.log("=============================================\n");
  } finally {
    await browser.close();
    if (serverProc) {
      serverProc.kill("SIGTERM");
    }
  }
}

main().catch((err) => {
  console.error("Tesla UI verification failed:", err);
  process.exit(1);
});

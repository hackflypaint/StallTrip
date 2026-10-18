/**
 * Tesla landscape Playwright suite (Gate G1).
 *
 * Profiles include half-MCU (~627×650) — the real ngrok pane that broke
 * the v1 detector (w>=700). Also 773×601 and 1254×784.
 * Avoid waitForFunction predicates (CSP blocks unsafe-eval).
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
  // Real half-MCU CSS size (DPR 1.53 → ~half of 1254)
  { name: "half-mcu-627x650", width: 627, height: 650 },
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

  console.log("0. /tesla-probe...");
  await page.goto(`${BASE}/tesla-probe`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("#probeRows .row", { timeout: 10000 });
  await page.locator("#touchPad").tap();
  await page.locator("#touchPad.hit").waitFor({ timeout: 5000 });
  await shot("probe");

  console.log("1. Load planner — require CAR MODE...");
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForSelector("body.car-shell", { timeout: 8000 });
  await page.waitForSelector('body[data-sheet="peek"]', { timeout: 5000 });
  await page.waitForSelector("#carModeBadge", { state: "visible", timeout: 5000 });
  await page.waitForSelector("#carPresetRow .preset-tag", { timeout: 5000 });

  const badgeText = (await page.locator("#carModeBadge").textContent()) || "";
  if (!/CAR MODE/i.test(badgeText)) {
    throw new Error(`car mode badge missing text: ${badgeText}`);
  }

  // Use getBoundingClientRect (CSS height) — more reliable than locator union box
  const metrics = await page.locator("body").evaluate((body) => {
    const sb = document.getElementById("sidebar");
    const btn = document.getElementById("btnToggleLayers");
    const sheetH = sb ? sb.getBoundingClientRect().height : 0;
    const layersH = btn ? btn.getBoundingClientRect().height : 0;
    const varH = getComputedStyle(body).getPropertyValue("--car-sheet-h").trim();
    return { sheetH, layersH, varH, sheet: body.getAttribute("data-sheet") };
  });
  if (metrics.layersH < 44) {
    throw new Error(`map control too small: ${metrics.layersH}px`);
  }
  const sheetH = metrics.sheetH;
  const mapShare = 1 - sheetH / profile.height;
  console.log(
    `  ${badgeText.trim()}; sheet≈${Math.round(sheetH)}px (css ${metrics.varH}); map≈${(mapShare * 100).toFixed(0)}%`
  );
  if (mapShare < 0.6) {
    throw new Error(
      `MAP MUST DOMINATE: share ${(mapShare * 100).toFixed(0)}% < 60% (sheet ${Math.round(sheetH)}px / ${profile.height}px)`
    );
  }

  // Must NOT look like baseline: tall brand header should be gone
  const headerVisible = await page.locator(".sidebar-header").isVisible().catch(() => false);
  if (headerVisible) {
    throw new Error("sidebar-header still visible in car peek — not compressed");
  }

  await shot("01_load_peek");

  console.log("2. Preset SF → LA...");
  await page.locator('#carPresetRow .preset-tag:has-text("SF → LA")').tap();
  await page.waitForSelector("html[data-plan-stops]", { timeout: 45000 });
  await page.waitForSelector('body[data-sheet="peek"]', { timeout: 8000 });
  const stops = parseInt((await page.getAttribute("html", "data-plan-stops")) || "0", 10);
  if (!(stops > 1)) throw new Error(`expected >1 stops, got ${stops}`);
  await page.locator("#carPeekSummary").filter({ hasText: /\d+\s+stops/i }).waitFor({ timeout: 5000 });
  await shot("02_plan_peek");

  console.log("3. Itinerary + drawer...");
  await page.locator("#btnCarSheetItinerary").tap();
  await page.waitForSelector('body[data-sheet="itinerary"]', { timeout: 5000 });
  await page.waitForSelector("#routeResults", { state: "visible", timeout: 8000 });
  await page.locator(".timeline-item.supercharger .timeline-content").first().tap();
  await page.waitForSelector("#chargerDrawer", { state: "visible", timeout: 8000 });
  await page.locator("#btnAddStopToRoute").tap();
  await page.waitForSelector('html[data-forced-count]:not([data-forced-count="0"])', {
    timeout: 10000,
  });
  await shot("03_drawer");
  await page.locator("#btnCloseDrawer").tap();
  await sleep(200);
  await page.locator("#btnCarSheetHandle").tap();
  await page.waitForSelector('body[data-sheet="peek"]', { timeout: 5000 });

  console.log("4. Box select...");
  await page.locator("#btnAreaModeBox").tap();
  await page.waitForSelector("#mapModeBanner", { state: "visible", timeout: 5000 });
  const mapBox = await page.locator("#map").boundingBox();
  if (!mapBox) throw new Error("#map missing");
  await page.mouse.move(mapBox.x + mapBox.width * 0.4, mapBox.y + mapBox.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(mapBox.x + mapBox.width * 0.7, mapBox.y + mapBox.height * 0.55, {
    steps: 8,
  });
  await page.mouse.up();
  await sleep(1200);
  await shot("04_box");
  const clearBtn = page.locator(".map-floating-bar #btnClearSelection");
  if (!(await clearBtn.isDisabled())) await clearBtn.tap();

  console.log("5. Layers...");
  await page.locator("#btnToggleLayers").tap({ timeout: 8000 });
  await page.waitForSelector('#layersPanel:not([aria-hidden="true"])', { timeout: 8000 });
  await shot("05_layers");

  console.log(`Profile ${profile.name} PASSED (map ${(mapShare * 100).toFixed(0)}%)`);
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
    if (serverProc) serverProc.kill("SIGTERM");
  }
}

main().catch((err) => {
  console.error("Tesla UI verification failed:", err);
  process.exit(1);
});

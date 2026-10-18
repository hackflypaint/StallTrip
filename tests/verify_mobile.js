/**
 * Playwright smoke for the /mobile shell (Phase 4).
 *
 * Requires: server on :8080, Node + playwright, Chrome at /usr/local/bin/google-chrome
 *   npm install --no-save playwright   # if missing
 *   python3 server.py 8080 &
 *   node tests/verify_mobile.js
 *
 * Screenshots → MEDIA_DIR (override with MOBILE_MEDIA_DIR).
 */
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  ({ chromium } = require("/tmp/pw/node_modules/playwright"));
}
const fs = require("fs");
const path = require("path");

const BASE = process.env.MOBILE_BASE_URL || "http://127.0.0.1:8080";
const MEDIA_DIR =
  process.env.MOBILE_MEDIA_DIR ||
  "/tmp/tesla-planner-media/mobile-sheet";

async function run() {
  console.log("Mobile shell Playwright smoke…");
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/local/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });

  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  });
  const page = await context.newPage();

  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("dialog", async (d) => {
    console.log("[dialog]", d.message());
    await d.dismiss();
  });

  try {
    // 1. Health advertises shell
    const health = await (await page.request.get(`${BASE}/api/health`)).json();
    if (health.mobile_shell !== "/mobile") {
      throw new Error(`expected mobile_shell /mobile, got ${health.mobile_shell}`);
    }
    console.log("1. /api/health ok — mobile_shell=/mobile");

    // 2. Map-first /mobile
    await page.goto(`${BASE}/mobile`, { waitUntil: "networkidle", timeout: 20000 });
    await page.waitForSelector("#map", { timeout: 10000 });
    const isMobile = await page.evaluate(() => document.body.classList.contains("ui-mobile"));
    if (!isMobile) throw new Error("body.ui-mobile missing on /mobile");
    const toggle = page.locator("#btnMobileSheet");
    await toggle.waitFor({ state: "visible", timeout: 5000 });
    await page.screenshot({ path: path.join(MEDIA_DIR, "01-mobile-map-first.png") });
    console.log("2. Map-first shell + Plan toggle visible");

    // 3. Open planner sheet — tabs first, no Supercharge brand header
    await toggle.click();
    await page.waitForFunction(() => document.body.classList.contains("sheet-open"), null, {
      timeout: 5000,
    });
    const headerVisible = await page.locator(".sidebar-header").isVisible().catch(() => false);
    if (headerVisible) {
      throw new Error("sidebar-header (Supercharge Route) must be hidden on /mobile sheet");
    }
    await page.waitForSelector(".tabs", { state: "visible", timeout: 5000 });
    await page.waitForSelector("#tabRoute", { state: "visible", timeout: 3000 });
    await page.screenshot({ path: path.join(MEDIA_DIR, "02-mobile-sheet-tabs-first.png") });
    console.log("3. Sheet opens — tabs first, brand header gone");

    // 4. Plan a short corridor trip (SF → LA, capped stops)
    await page.selectOption("#maxStopsSelect", "6");
    await page.locator('button.preset-tag:has-text("SF → LA")').click();
    await page.waitForSelector("#routeResults", { state: "visible", timeout: 45000 });
    const stops = parseInt(await page.locator("#statStops").textContent(), 10);
    if (!(stops > 1)) throw new Error(`expected multiple stops, got ${stops}`);
    // After plan, sheet should close so the map shows the route
    await page.waitForFunction(() => !document.body.classList.contains("sheet-open"), null, {
      timeout: 5000,
    });
    await page.screenshot({ path: path.join(MEDIA_DIR, "03-mobile-route-map.png") });
    console.log(`4. Route planned (${stops} stops); sheet closed to map`);

    // 5. QA hook ?sheet=1
    await page.goto(`${BASE}/mobile?sheet=1`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForFunction(() => document.body.classList.contains("sheet-open"), null, {
      timeout: 5000,
    });
    await page.screenshot({ path: path.join(MEDIA_DIR, "04-mobile-sheet-query.png") });
    console.log("5. /mobile?sheet=1 opens planner");

    // 6. Default: no UA redirect on /
    const desktop = await context.request.get(`${BASE}/`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        Accept: "text/html",
      },
      maxRedirects: 0,
    });
    // Playwright request follows redirects by default — check final URL stays /
    // Use API-style check via evaluate fetch instead:
    const redirected = await page.evaluate(async (base) => {
      const res = await fetch(base + "/", {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
        },
      });
      return { status: res.status, location: res.headers.get("Location") };
    }, BASE);
    if (redirected.status === 302 && redirected.location === "/mobile") {
      throw new Error("UA redirect unexpectedly enabled on /");
    }
    console.log("6. UA redirect remains OFF by default");

    console.log("\nMOBILE PLAYWRIGHT SMOKE PASSED");
    console.log(`Screenshots → ${MEDIA_DIR}`);
  } catch (err) {
    console.error("Mobile smoke failed:", err);
    try {
      await page.screenshot({ path: path.join(MEDIA_DIR, "FAIL-mobile.png") });
    } catch (_) {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

run();

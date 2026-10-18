/**
 * Focused Playwright smoke for drone flight Layers overlay.
 * Run (server on :8080): node tests/test_drone_airspace_ui.js
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const MEDIA_DIR =
  "/tmp/tesla-planner-media/drone-airspace";
const ARTIFACTS = "/tmp/tesla-planner-artifacts";

async function main() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(ARTIFACTS, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    executablePath: "/usr/local/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  page.on("pageerror", (err) => console.log("[PageError]", err.message));

  await page.goto("http://localhost:8080/", { waitUntil: "networkidle", timeout: 20000 });
  await page.locator("#btnToggleLayers").click();
  await page.waitForSelector("#airspaceToggle", { state: "visible", timeout: 5000 });
  await page.locator("#airspaceToggle").check();
  await page.waitForSelector("#airspaceDetailBlock.is-active", { state: "visible" });

  const title = await page.locator(".airspace-slot-title").textContent();
  if (!/Drone flight/i.test(title || "")) {
    throw new Error(`Unexpected title: ${title}`);
  }
  const legend = await page.locator(".airspace-legend-mini").textContent();
  if (!/No-fly/i.test(legend || "") || !/Auth required/i.test(legend || "")) {
    throw new Error(`Legend missing constraint classes: ${legend}`);
  }
  if (!/National park/i.test(legend || "")) {
    throw new Error(`Legend missing park swatch: ${legend}`);
  }

  // Shenandoah / Mid-Atlantic — parks + Class airspace + SUA
  await page.evaluate(() => {
    window.appState.map.setView([38.55, -78.35], 9);
  });

  await page.waitForFunction(() => {
    const t = document.getElementById("airspaceStatus")?.textContent || "";
    return /No-fly\s+\d+/.test(t) && /Parks\s+[1-9]\d*/.test(t);
  }, { timeout: 30000 });

  const status = await page.locator("#airspaceStatus").textContent();
  console.log("status:", status);

  const shot1 = path.join(MEDIA_DIR, "drone_constraints_shenandoah.png");
  const shot1a = path.join(ARTIFACTS, "drone_constraints_shenandoah.png");
  await page.screenshot({ path: shot1, fullPage: false });
  fs.copyFileSync(shot1, shot1a);

  // DC area — prohibited P-56, Class B/D, NPS units
  await page.evaluate(() => {
    window.appState.map.setView([38.89, -77.03], 11);
  });
  await page.waitForFunction(() => {
    const t = document.getElementById("airspaceStatus")?.textContent || "";
    return /No-fly\s+[1-9]\d*/.test(t) && /Auth\s+[1-9]\d*/.test(t);
  }, { timeout: 30000 });

  const statusDc = await page.locator("#airspaceStatus").textContent();
  console.log("status DC:", statusDc);

  const shot2 = path.join(MEDIA_DIR, "drone_constraints_dc.png");
  const shot2a = path.join(ARTIFACTS, "drone_constraints_dc.png");
  await page.screenshot({ path: shot2, fullPage: false });
  fs.copyFileSync(shot2, shot2a);

  // Layers panel close-up
  const panel = page.locator("#layersPanel");
  const shot3 = path.join(MEDIA_DIR, "drone_layers_panel.png");
  const shot3a = path.join(ARTIFACTS, "drone_layers_panel.png");
  await panel.screenshot({ path: shot3 });
  fs.copyFileSync(shot3, shot3a);

  await browser.close();
  console.log("test_drone_airspace_ui.js: OK");
  console.log("media:", MEDIA_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Focused Playwright smoke for drone flight Layers overlay (Autopylot-parity).
 * Run (server on :8080): node tests/test_drone_airspace_ui.js
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const MEDIA_DIR =
  "/tmp/tesla-planner-media/drone-airspace";
const PARITY_DIR =
  "/tmp/tesla-planner-media/autopylot-parity";
const ARTIFACTS = "/tmp/tesla-planner-artifacts";

async function main() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  fs.mkdirSync(PARITY_DIR, { recursive: true });
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

  for (const id of ["airspaceClassNoFly", "airspaceClassParks", "airspaceClassAuth"]) {
    const el = page.locator(`#${id}`);
    if ((await el.count()) < 1) throw new Error(`Missing class toggle ${id}`);
    if (!(await el.isChecked())) throw new Error(`${id} should default checked`);
  }

  const toggles = await page.locator("#airspaceClassToggles").textContent();
  if (!/Do Not Fly/i.test(toggles || "") || !/Fly with Approval/i.test(toggles || "")) {
    throw new Error(`Class toggles missing Autopylot labels: ${toggles}`);
  }
  if (!/National park/i.test(toggles || "")) {
    throw new Error(`Class toggles missing park: ${toggles}`);
  }

  // Poll DOM via Playwright locators (avoid waitForFunction — CSP blocks unsafe-eval)
  async function waitStatus(pred, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const t = (await page.locator("#airspaceStatus").textContent()) || "";
      if (pred(t)) return t;
      await page.waitForTimeout(250);
    }
    throw new Error(`Timeout waiting for airspace status (${timeoutMs}ms)`);
  }

  // Shenandoah / Mid-Atlantic — parks + Class airspace + SUA
  await page.evaluate(() => {
    window.appState.map.setView([38.55, -78.35], 9);
  });

  const status = await waitStatus(
    (t) => /Do Not Fly\s+\d+/.test(t) && /Parks\s+[1-9]\d*/.test(t),
    30000
  );
  console.log("status:", status);

  const lightOn = await page.evaluate(() =>
    document.getElementById("map")?.classList.contains("basemap-airspace-light")
  );
  if (!lightOn) throw new Error("Expected basemap-airspace-light while drone overlay on");

  // Independent toggle: hide approval class
  await page.locator("#airspaceClassAuth").uncheck();
  await waitStatus((t) => /Approval off/.test(t), 5000);
  console.log("after auth off:", await page.locator("#airspaceStatus").textContent());

  const shotToggles = path.join(PARITY_DIR, "parity_approval_off.png");
  const shotTogglesA = path.join(ARTIFACTS, "parity_approval_off.png");
  await page.screenshot({ path: shotToggles, fullPage: false });
  fs.copyFileSync(shotToggles, shotTogglesA);

  await page.locator("#airspaceClassAuth").check();
  await waitStatus((t) => !/Approval off/.test(t), 5000);

  // DC area — denser UASFM; then zoom for ceiling labels
  await page.evaluate(() => {
    window.appState.map.setView([38.89, -77.03], 11);
  });
  const statusDc = await waitStatus(
    (t) => /Do Not Fly\s+[1-9]\d*/.test(t) && /Approval\s+[1-9]\d*/.test(t),
    30000
  );
  console.log("status DC:", statusDc);

  await page.evaluate(() => {
    window.appState.map.setView([38.851, -77.04], 13);
  });
  await waitStatus((t) => /UASFM\s+[1-9]\d*/.test(t), 30000);
  // Allow labels to paint after debounced refresh
  await page.waitForTimeout(2000);
  const labelCount = await page.locator(".airspace-uasfm-label").count();
  console.log("uasfm labels:", labelCount);
  if (labelCount < 1) {
    throw new Error("Expected UASFM ceiling labels at zoom ≥11");
  }

  const shotGrid = path.join(PARITY_DIR, "parity_dc_uasfm_grid.png");
  const shotGridA = path.join(ARTIFACTS, "parity_dc_uasfm_grid.png");
  await page.screenshot({ path: shotGrid, fullPage: false });
  fs.copyFileSync(shotGrid, shotGridA);

  const panel = page.locator("#layersPanel");
  const shotPanel = path.join(PARITY_DIR, "parity_layers_panel.png");
  const shotPanelA = path.join(ARTIFACTS, "parity_layers_panel.png");
  await panel.screenshot({ path: shotPanel });
  fs.copyFileSync(shotPanel, shotPanelA);

  // Keep legacy drone-airspace paths updated for prior status docs
  fs.copyFileSync(shotToggles, path.join(MEDIA_DIR, "drone_class_toggles_auth_off.png"));
  fs.copyFileSync(shotGrid, path.join(MEDIA_DIR, "drone_constraints_dc_toggles.png"));
  fs.copyFileSync(shotPanel, path.join(MEDIA_DIR, "drone_layers_panel_class_toggles.png"));

  await browser.close();
  console.log("test_drone_airspace_ui.js: OK");
  console.log("parity media:", PARITY_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

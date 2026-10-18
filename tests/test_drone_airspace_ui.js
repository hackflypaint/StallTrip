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

  for (const id of ["airspaceClassNoFly", "airspaceClassParks", "airspaceClassAuth"]) {
    const el = page.locator(`#${id}`);
    if ((await el.count()) < 1) throw new Error(`Missing class toggle ${id}`);
    if (!(await el.isChecked())) throw new Error(`${id} should default checked`);
  }

  const toggles = await page.locator("#airspaceClassToggles").textContent();
  if (!/No-fly/i.test(toggles || "") || !/Auth required/i.test(toggles || "")) {
    throw new Error(`Class toggles missing labels: ${toggles}`);
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
    (t) => /No-fly\s+\d+/.test(t) && /Parks\s+[1-9]\d*/.test(t),
    30000
  );
  console.log("status:", status);

  // Independent toggle: hide auth, keep no-fly + parks
  await page.locator("#airspaceClassAuth").uncheck();
  await waitStatus((t) => /Auth off/.test(t), 5000);
  console.log("after auth off:", await page.locator("#airspaceStatus").textContent());

  const shotToggles = path.join(MEDIA_DIR, "drone_class_toggles_auth_off.png");
  const shotTogglesA = path.join(ARTIFACTS, "drone_class_toggles_auth_off.png");
  await page.screenshot({ path: shotToggles, fullPage: false });
  fs.copyFileSync(shotToggles, shotTogglesA);

  await page.locator("#airspaceClassAuth").check();
  await waitStatus((t) => !/Auth off/.test(t), 5000);

  // DC area — prohibited P-56, Class B/D, NPS units
  await page.evaluate(() => {
    window.appState.map.setView([38.89, -77.03], 11);
  });
  const statusDc = await waitStatus(
    (t) => /No-fly\s+[1-9]\d*/.test(t) && /Auth\s+[1-9]\d*/.test(t),
    30000
  );
  console.log("status DC:", statusDc);

  const FINAL =
    "/tmp/tesla-planner-media/media/final-audit";
  fs.mkdirSync(FINAL, { recursive: true });

  const shot2 = path.join(MEDIA_DIR, "drone_constraints_dc_toggles.png");
  const shot2a = path.join(ARTIFACTS, "drone_constraints_dc_toggles.png");
  await page.screenshot({ path: shot2, fullPage: false });
  fs.copyFileSync(shot2, shot2a);
  fs.copyFileSync(shot2, path.join(FINAL, "drone_constraints_dc_toggles.png"));
  fs.copyFileSync(shotToggles, path.join(FINAL, "drone_class_toggles_auth_off.png"));

  // Layers panel close-up with class toggles
  const panel = page.locator("#layersPanel");
  const shot3 = path.join(MEDIA_DIR, "drone_layers_panel_class_toggles.png");
  const shot3a = path.join(ARTIFACTS, "drone_layers_panel_class_toggles.png");
  await panel.screenshot({ path: shot3 });
  fs.copyFileSync(shot3, shot3a);
  fs.copyFileSync(shot3, path.join(FINAL, "drone_layers_panel_class_toggles.png"));

  await browser.close();
  console.log("test_drone_airspace_ui.js: OK");
  console.log("media:", MEDIA_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (_) {
  ({ chromium } = require('/tmp/pw/node_modules/playwright'));
}
const fs = require('fs');
const path = require('path');

const MEDIA_DIR = '/tmp/tesla-planner-media';
const TMP_SHOT_DIR = '/tmp/tesla-planner-artifacts/screenshots';

async function saveShot(page, filename) {
  fs.mkdirSync(TMP_SHOT_DIR, { recursive: true });
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const tmpPath = path.join(TMP_SHOT_DIR, filename);
  await page.screenshot({ path: tmpPath });
  try {
    fs.copyFileSync(tmpPath, path.join(MEDIA_DIR, filename));
  } catch (_) {
    /* ignore transient FUSE EIO on copy */
  }
}

async function runVerification() {
  console.log('Launching browser for comprehensive UI verification...');
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
  }

  // Catch console errors and logs
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('Browser console error:', msg.text());
    }
  });
  page.on('pageerror', err => {
    console.log('[Browser PageError]:', err.message);
  });
  page.on('dialog', async dialog => {
    console.log('[Browser Dialog]:', dialog.message());
    await dialog.dismiss();
  });

  try {
    console.log('1. Navigating to http://localhost:8080 ...');
    await page.goto('http://localhost:8080/', { waitUntil: 'networkidle', timeout: 15000 });

    const badgeText = await page.locator('#totalChargersBadge').textContent();
    console.log(`Chargers in database: ${badgeText}`);

    await page.waitForTimeout(2000);

    // 2. Click preset route: "SF -> LA" in Visit Maximizer mode
    console.log('2. Clicking "SF -> LA" preset in Visit Maximizer mode...');
    // Set max stops to 6 for faster test run
    await page.selectOption('#maxStopsSelect', '6');
    await page.locator('button.preset-tag:has-text("SF → LA")').click();

    await page.waitForSelector('#routeResults', { state: 'visible', timeout: 35000 });
    await page.waitForTimeout(3000);

    const distance = await page.locator('#statDistance').textContent();
    const tripTime = await page.locator('#statTotalTime').textContent();
    const stopsCount = await page.locator('#statStops').textContent();
    const corridorText = await page.locator('#corridorCountText').textContent();

    console.log(`Route Computed (Visit Maximizer):`);
    console.log(`  Distance: ${distance}`);
    console.log(`  Trip Time: ${tripTime}`);
    console.log(`  Supercharger Stops Visited: ${stopsCount}`);
    console.log(`  Corridor details: ${corridorText}`);

    // Verify stopsCount > 1 (Visit Maximizer)
    if (parseInt(stopsCount) <= 1) {
      throw new Error(`Expected multiple stops in Visit Maximizer mode, but got ${stopsCount}`);
    }

    await saveShot(page, '01_visit_maximizer_route.png');
    console.log('Saved 01_visit_maximizer_route.png');

    // 2a. Strategy toggle multiple times must replan (Max → Min → Max)
    console.log('2a. Toggling route strategy Max → Min → Max and verifying replan...');
    const stopsAfterMax = parseInt(await page.locator('#statStops').textContent(), 10);
    await page.locator('#btnModeMinStops').click();
    await page.waitForFunction(() => {
      const btn = document.getElementById('btnPlanRoute');
      return btn && !btn.disabled;
    }, { timeout: 40000 });
    await page.waitForTimeout(1500);
    const modeMin = await page.evaluate(() => window.appState.routingMode);
    if (modeMin !== 'MIN_STOPS') {
      throw new Error(`Expected MIN_STOPS after toggle, got ${modeMin}`);
    }
    const stopsAfterMin = parseInt(await page.locator('#statStops').textContent(), 10);
    console.log(`  Stops after Max: ${stopsAfterMax}, after Min: ${stopsAfterMin}`);
    if (!(stopsAfterMin < stopsAfterMax)) {
      throw new Error(`Min Stops should reduce stop count (${stopsAfterMin} vs Max ${stopsAfterMax})`);
    }
    await page.locator('#btnModeMaximize').click();
    await page.waitForFunction(() => {
      const btn = document.getElementById('btnPlanRoute');
      return btn && !btn.disabled;
    }, { timeout: 40000 });
    await page.waitForTimeout(1500);
    const modeMaxAgain = await page.evaluate(() => window.appState.routingMode);
    if (modeMaxAgain !== 'MAXIMIZE') {
      throw new Error(`Expected MAXIMIZE after toggle back, got ${modeMaxAgain}`);
    }
    const stopsBack = parseInt(await page.locator('#statStops').textContent(), 10);
    if (stopsBack <= 1) {
      throw new Error(`Expected multiple stops after returning to Maximize, got ${stopsBack}`);
    }
    // Max corridor stops ceiling includes 50
    const maxOpt = await page.locator('#maxStopsSelect option[value="50"]').count();
    if (maxOpt < 1) {
      throw new Error('maxStopsSelect must include option value 50');
    }
    console.log('  Strategy toggle replan OK; maxStops=50 option present');

    // 2b. Open Layers panel → Topographic basemap
    console.log('2b. Opening Layers panel and selecting Topographic...');
    await page.locator('#btnToggleLayers').click();
    await page.waitForSelector('#layersPanel', { state: 'visible', timeout: 5000 });
    await page.locator('input[name="basemapRadio"][value="topo"]').check();
    await page.waitForTimeout(2500);

    const mapHasTopoClass = await page.locator('#map.basemap-topo').count();
    if (mapHasTopoClass < 1) {
      throw new Error('Expected #map.basemap-topo after selecting Topographic layer');
    }
    const topoRadioChecked = await page.locator('input[name="basemapRadio"][value="topo"]').isChecked();
    if (!topoRadioChecked) {
      throw new Error('Topographic radio was not checked after click');
    }

    await saveShot(page, 'topo_layer.png');
    console.log('Saved topo_layer.png');

    // Switch back to Streets
    await page.locator('input[name="basemapRadio"][value="streets"]').check();
    await page.waitForTimeout(800);

    // 2c. Enable Fall Foliage overlay + scrub day slider
    console.log('2c. Enabling Fall Foliage overlay and day slider...');
    await page.locator('#foliageToggle').check();
    await page.waitForSelector('#foliageSliderBlock.is-active', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(2000);

    const foliageImgCount = await page.locator('.leaflet-image-layer, img.foliage-image-overlay, .leaflet-overlay-pane img').count();
    if (foliageImgCount < 1) {
      throw new Error('Expected Explore Fall image overlay on the map');
    }

    // Scrub slider toward mid-October (season index ~47 ≈ Oct 18)
    await page.evaluate(() => {
      const slider = document.getElementById('foliageDaySlider');
      if (!slider) throw new Error('foliageDaySlider missing');
      slider.value = '47';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(1200);
    const dateLabel = await page.locator('#foliageDateLabel').textContent();
    console.log(`Foliage slider date label: ${dateLabel}`);

    // Zoom out to show CONUS foliage wash
    await page.evaluate(() => {
      if (window.appState && window.appState.map) {
        window.appState.map.setView([39.5, -98.0], 4);
      }
    });
    await page.waitForTimeout(1500);

    await saveShot(page, 'foliage_layer.png');
    console.log('Saved foliage_layer.png');

    // Disable foliage so it does not obscure airspace check
    await page.locator('#foliageToggle').uncheck();
    await page.waitForTimeout(500);

    // 2d. Enable drone flight constraints (FAA + NPS) over Mid-Atlantic
    console.log('2d. Enabling drone flight overlay over Mid-Atlantic...');
    await page.locator('#airspaceToggle').check();
    await page.waitForSelector('#airspaceDetailBlock.is-active', { state: 'visible', timeout: 5000 });
    const droneTitle = await page.locator('.airspace-slot-title').textContent();
    if (!/Drone flight/i.test(droneTitle || '')) {
      throw new Error(`Expected Drone flight title, got: ${droneTitle}`);
    }

    await page.evaluate(() => {
      if (window.appState && window.appState.map) {
        window.appState.map.setView([38.9, -76.5], 9);
      }
    });

    await page.waitForFunction(() => {
      const el = document.getElementById('airspaceStatus');
      if (!el) return false;
      const t = el.textContent || '';
      return /Do Not Fly\s+\d+/.test(t) || /Approval\s+\d+/.test(t) || /No-fly\s+\d+/.test(t) || /Auth\s+\d+/.test(t) || /Parks\s+\d+/.test(t) || /UASFM\s+\d+/.test(t);
    }, { timeout: 25000 });

    const airspaceStatus = await page.locator('#airspaceStatus').textContent();
    console.log(`Drone airspace status: ${airspaceStatus}`);
    const airspaceOn = await page.evaluate(() => !!(window.AirspaceModule && window.AirspaceModule.isEnabled()));
    if (!airspaceOn) {
      throw new Error('AirspaceModule should be enabled after toggle');
    }

    // Ensure route/foliage modules still present and layers panel intact
    const foliageStillThere = await page.locator('#foliageToggle').count();
    if (foliageStillThere < 1) {
      throw new Error('Foliage toggle missing after airspace enable');
    }

    await saveShot(page, 'airspace_layer.png');
    console.log('Saved airspace_layer.png');

    await page.locator('#airspaceToggle').uncheck();
    await page.waitForTimeout(400);

    // Close layers panel and fit back to route
    await page.locator('#btnToggleLayers').click();
    await page.locator('#btnMapReset').click();
    await page.waitForTimeout(1000);

    // 3. Test Drawer and Force-Include toggle
    console.log('3. Clicking first Supercharger stop in timeline to view details...');
    const firstStop = page.locator('.timeline-item.supercharger .timeline-content').first();
    await firstStop.click();
    await page.waitForSelector('#chargerDrawer', { state: 'visible', timeout: 5000 });
    await page.waitForTimeout(1000);

    const drawerTitle = await page.locator('#drawerTitle').textContent();
    console.log(`Opened drawer for: ${drawerTitle}`);

    // Toggle Force Include (drawer pin — no sidebar Force-Included panel)
    console.log('Toggling "Force-Include in Route" button in drawer...');
    await page.locator('#btnAddStopToRoute').click();
    await page.waitForTimeout(2000);

    const forcedAfterDrawer = await page.evaluate(() => window.appState.forcedChargers.size);
    console.log(`Forced chargers count after drawer pin: ${forcedAfterDrawer}`);
    if (forcedAfterDrawer < 1) {
      throw new Error('Expected at least one force-included charger after drawer pin');
    }
    const sidebarForcedPanel = await page.locator('.sidebar .forced-section, .sidebar #forcedChipsList, .sidebar #forcedCountBadge').count();
    if (sidebarForcedPanel > 0) {
      throw new Error('Force-Included Stops sidebar panel must be removed');
    }

    await saveShot(page, '02_drawer_force_include.png');
    console.log('Saved 02_drawer_force_include.png');

    await page.locator('#btnCloseDrawer').click();
    await page.waitForTimeout(500);

    // 4a. Box area select from top-right map toolbar
    console.log('4a. Activating Box area selection from top-right toolbar...');
    // Ensure area tools live on the floating bar (not left sidebar)
    const areaToolsInBar = await page.locator('.map-floating-bar #btnAreaModeBox').count();
    const areaToolsInSidebar = await page.locator('.sidebar #btnAreaModeBox').count();
    if (areaToolsInBar < 1 || areaToolsInSidebar > 0) {
      throw new Error('Box/Freehand area tools must be on map floating bar, not sidebar');
    }
    await page.locator('#btnAreaModeBox').click();
    await page.waitForSelector('#mapModeBanner', { state: 'visible' });
    if (!(await page.locator('#btnAreaModeBox').evaluate((el) => el.classList.contains('active')))) {
      throw new Error('Box mode button should be active');
    }
    if (!(await page.locator('#btnAreaModeBox').evaluate((el) => el.classList.contains('drawing')))) {
      throw new Error('Box mode button should show drawing state');
    }
    const boxBanner = await page.locator('#mapModeBannerText').textContent();
    if (!/selection box|rectangle|box/i.test(boxBanner || '')) {
      throw new Error(`Expected box banner text, got: ${boxBanner}`);
    }

    const mapBox = await page.locator('#map').boundingBox();
    if (mapBox) {
      const startX = mapBox.x + mapBox.width * 0.45;
      const startY = mapBox.y + mapBox.height * 0.45;
      const endX = mapBox.x + mapBox.width * 0.65;
      const endY = mapBox.y + mapBox.height * 0.65;
      console.log(`Dragging box from (${startX}, ${startY}) to (${endX}, ${endY})...`);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(2500);
    }
    const boxForced = await page.evaluate(() => window.appState.forcedChargers.size);
    console.log(`Forced count after box select: ${boxForced}`);
    await saveShot(page, '03_area_selected_route.png');
    console.log('Saved 03_area_selected_route.png');

    // 4a2. Clear selection (top-right) restores pan/zoom and drops area-forced chargers
    console.log('4a2. Clicking Clear selection on map toolbar...');
    const clearSel = page.locator('.map-floating-bar #btnClearSelection');
    if (await clearSel.isDisabled()) {
      // Still valid if box found no chargers — enable by entering draw mode
      await page.locator('#btnAreaModeBox').click();
      await page.waitForSelector('#mapModeBanner', { state: 'visible' });
    }
    await clearSel.click();
    await page.waitForTimeout(800);
    const afterClear = await page.evaluate(() => ({
      forced: window.appState.forcedChargers.size,
      areaIds: window.appState.areaForcedIds.size,
    }));
    console.log(`Forced count after Clear selection: ${afterClear.forced} (areaIds=${afterClear.areaIds})`);
    const stillDrawing = await page.locator('#mapModeBanner').isVisible();
    if (stillDrawing) {
      throw new Error('mapModeBanner should be hidden after Clear selection');
    }
    const mapDragging = await page.evaluate(() => {
      return !!(window.appState && window.appState.map && window.appState.map.dragging.enabled());
    });
    if (!mapDragging) {
      throw new Error('Map dragging should be re-enabled after Clear selection');
    }
    if (afterClear.areaIds !== 0) {
      throw new Error(`Expected areaForcedIds empty after Clear selection, got ${afterClear.areaIds}`);
    }
    await saveShot(page, '03a_clear_selection.png');
    console.log('Saved 03a_clear_selection.png');

    // Test freehand as additional option (Clear selection already dropped area batch)
    console.log('4b. Switching to Freehand outline mode...');
    await page.locator('#btnAreaModeFreehand').click();
    await page.waitForSelector('#mapModeBanner', { state: 'visible' });
    if (!(await page.locator('#btnAreaModeFreehand').evaluate((el) => el.classList.contains('active')))) {
      throw new Error('Freehand mode button should be active');
    }
    const freeBanner = await page.locator('#mapModeBannerText').textContent();
    if (!/freehand|outline/i.test(freeBanner || '')) {
      throw new Error(`Expected freehand/outline banner text, got: ${freeBanner}`);
    }

    const mapBox2 = await page.locator('#map').boundingBox();
    if (mapBox2) {
      const cx = mapBox2.x + mapBox2.width * 0.55;
      const cy = mapBox2.y + mapBox2.height * 0.55;
      const rx = mapBox2.width * 0.12;
      const ry = mapBox2.height * 0.14;
      const steps = 24;
      console.log(`Drawing freehand outline centered near (${cx}, ${cy})...`);
      await page.mouse.move(cx + rx, cy);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        const ang = (Math.PI * 2 * i) / steps;
        await page.mouse.move(cx + rx * Math.cos(ang), cy + ry * Math.sin(ang), { steps: 2 });
      }
      await page.mouse.up();
      await page.waitForTimeout(3000);
    }

    const updatedForced = await page.evaluate(() => window.appState.forcedChargers.size);
    console.log(`Updated Forced Count after freehand select: ${updatedForced}`);
    await saveShot(page, '03b_freehand_area_selected.png');
    console.log('Saved 03b_freehand_area_selected.png');

    // Mid-draw Clear selection cancels freehand without leaving draw mode stuck
    console.log('4c. Starting freehand draw then Clear selection mid-stroke...');
    await page.locator('#btnAreaModeFreehand').click();
    await page.waitForSelector('#mapModeBanner', { state: 'visible' });
    const mapBox3 = await page.locator('#map').boundingBox();
    if (mapBox3) {
      await page.mouse.move(mapBox3.x + mapBox3.width * 0.4, mapBox3.y + mapBox3.height * 0.4);
      await page.mouse.down();
      await page.mouse.move(mapBox3.x + mapBox3.width * 0.5, mapBox3.y + mapBox3.height * 0.45, { steps: 5 });
      // Do not mouse.up — abandon with Clear selection on toolbar
      await page.locator('.map-floating-bar #btnClearSelection').click();
      await page.waitForTimeout(400);
      await page.mouse.up().catch(() => {});
    }
    if (await page.locator('#mapModeBanner').isVisible()) {
      throw new Error('Draw mode should end when Clear selection is clicked mid-stroke');
    }
    const shapeLeft = await page.evaluate(() => !!window.appState.selectionShape);
    if (shapeLeft) {
      throw new Error('selectionShape should be null after Clear selection mid-draw');
    }

    // 5. Switch to Explore Tab and check filters
    console.log('5. Testing Explore Chargers tab...');
    await page.locator('#tabExplore').click();
    await page.waitForSelector('#explore-tab', { state: 'visible' });
    await page.waitForTimeout(1500);

    const countText = await page.locator('#chargerListCount').textContent();
    console.log(`Explore Chargers count: ${countText}`);

    await saveShot(page, '04_explore_tab.png');
    console.log('Saved 04_explore_tab.png');

    // 6. Test Mobile Viewport
    console.log('6. Testing Mobile responsive viewport (390x844)...');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#tabRoute').click();
    await page.waitForTimeout(1500);

    await saveShot(page, '05_mobile_responsive.png');
    console.log('Saved 05_mobile_responsive.png');

    // 7. Test Client-Side Live Driving / Follow-Me Mode (mock watchPosition + Wake Lock + HUD + Re-center)
    console.log('7. Testing Client-Side Live Driving / Follow-Me Mode (watchPosition + HUD + Re-center)...');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => {
      window.__mockWatchCallbacks = {};
      window.__wakeLockRequested = 0;
      const mockWakeLock = {
        request: async (type) => {
          window.__wakeLockRequested++;
          return {
            type,
            addEventListener: () => {},
            release: async () => {},
          };
        },
      };
      try {
        Object.defineProperty(navigator, 'wakeLock', {
          value: mockWakeLock,
          configurable: true,
        });
      } catch (_) {
        navigator.wakeLock = mockWakeLock;
      }
      navigator.geolocation.watchPosition = (success, error, opts) => {
        window.__mockWatchCallbacks = { success, error, opts };
        setTimeout(() => {
          success({
            coords: {
              latitude: 37.65,
              longitude: -122.38,
              accuracy: 18,
              heading: 135,
              speed: 29.0576, // 65 mph
            },
          });
        }, 30);
        return 42;
      };
      navigator.geolocation.clearWatch = () => {
        window.__mockWatchCleared = true;
      };
    });

    await page.locator('#btnLocateMe').click();
    await page.waitForSelector('#liveDriveHud:not([hidden])', { timeout: 5000 });
    await page.waitForSelector('.user-location-dot', { timeout: 5000 });
    const hudCheck = await page.evaluate(() => ({
      speedText: document.getElementById('liveHudSpeed')?.textContent || '',
      nextText: document.getElementById('liveHudNextStop')?.textContent || '',
      wakeLocks: window.__wakeLockRequested,
      following: window.appState.liveLocation.follow,
    }));
    console.log(`  Live HUD: speed="${hudCheck.speedText}" next="${hudCheck.nextText}" wakeLocks=${hudCheck.wakeLocks}`);
    if (!/65 mph/i.test(hudCheck.speedText) || !/SE 135/i.test(hudCheck.speedText)) {
      throw new Error(`Expected speed/heading in HUD, got: ${hudCheck.speedText}`);
    }
    if (!/mi/i.test(hudCheck.nextText)) {
      throw new Error(`Expected distance to next planned stop in HUD, got: ${hudCheck.nextText}`);
    }
    if (hudCheck.wakeLocks < 1) {
      throw new Error('Expected navigator.wakeLock.request("screen") to be called');
    }

    // Simulate manual map drag -> pauses follow and reveals Re-center pill
    await page.evaluate(() => {
      window.appState.map.fire('dragstart');
    });
    await page.waitForSelector('#btnLiveRecenter:not([hidden])', { timeout: 3000 });
    await page.locator('#btnLiveRecenter').click();
    const resumed = await page.evaluate(() => window.appState.liveLocation.follow);
    if (!resumed) {
      throw new Error('Expected Re-center pill to resume live follow');
    }
    // Stop live follow
    await page.locator('#btnLocateMe').click();
    const stopped = await page.evaluate(() => !window.appState.liveLocation.watching);
    if (!stopped) {
      throw new Error('Expected second tap while following to stop live watch');
    }
    console.log('  Live Drive mode + HUD + Wake Lock + Re-center verified!');

    // 8. Combined Unified Check: Route Planned + Live Drive HUD + Weather Radar + Elevation Strip simultaneously
    console.log('8. Verifying ALL 3 features simultaneously across Desktop (1440x900), Mobile (390x844), and Tesla (773x601)...');
    await page.setViewportSize({ width: 1440, height: 900 });
    // Enable Live Drive HUD
    await page.locator('#btnLocateMe').click();
    await page.waitForSelector('#liveDriveHud:not([hidden])', { timeout: 5000 });
    // Enable Weather Radar
    await page.locator('#btnToggleLayers').click();
    await page.waitForSelector('#weatherRadarToggle', { state: 'visible', timeout: 5000 });
    await page.locator('#weatherRadarToggle').check();
    await page.waitForSelector('#weatherRadarPill.is-visible', { state: 'visible', timeout: 5000 });
    await page.locator('#btnToggleLayers').click();
    // Ensure Elevation Strip & Map Weather Pill are visible
    await page.waitForSelector('#elevationStrip:not([hidden])', { state: 'visible', timeout: 10000 });
    await page.waitForSelector('#mapWeatherPill:not([hidden])', { state: 'visible', timeout: 15000 });

    const rectsIntersect = (a, b) =>
      a && b && !(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y);

    const deskHudBox = await page.locator('#liveDriveHud').boundingBox();
    const deskWeatherPillBox = await page.locator('#mapWeatherPill').boundingBox();
    const deskRadarPillBox = await page.locator('#weatherRadarPill').boundingBox();
    const deskElevBox = await page.locator('#elevationStrip').boundingBox();

    if (rectsIntersect(deskHudBox, deskWeatherPillBox)) {
      throw new Error(`Desktop overlap between #liveDriveHud (${JSON.stringify(deskHudBox)}) and #mapWeatherPill (${JSON.stringify(deskWeatherPillBox)})`);
    }
    if (rectsIntersect(deskRadarPillBox, deskElevBox)) {
      throw new Error(`Desktop overlap between #weatherRadarPill (${JSON.stringify(deskRadarPillBox)}) and #elevationStrip (${JSON.stringify(deskElevBox)})`);
    }
    console.log('  Desktop (1440x900) unified zero-overlap check PASSED!');
    await saveShot(page, 'unified_release_desktop.png');
    console.log('Saved unified_release_desktop.png');

    // Check Tesla Car-Shell (773x601) with all 3 features active
    await page.setViewportSize({ width: 773, height: 601 });
    await page.goto('http://localhost:8080/tesla', { waitUntil: 'networkidle', timeout: 20000 });
    await page.evaluate(() => {
      navigator.geolocation.watchPosition = (success) => {
        setTimeout(() => {
          success({
            coords: { latitude: 37.65, longitude: -122.38, accuracy: 18, heading: 135, speed: 29.0576 },
          });
        }, 20);
        return 77;
      };
    });
    await page.locator('#carPresetRow .preset-tag:has-text("SF→LA")').click();
    await page.waitForSelector('#elevationStrip:not([hidden])', { state: 'visible', timeout: 25000 });
    await page.waitForSelector('#mapWeatherPill:not([hidden])', { state: 'visible', timeout: 20000 });
    await page.locator('#btnLocateMe').click();
    await page.waitForSelector('#liveDriveHud:not([hidden])', { state: 'visible', timeout: 5000 });
    await page.locator('#btnToggleLayers').click();
    await page.locator('#weatherRadarToggle').check();
    await page.waitForSelector('#weatherRadarPill.is-visible', { state: 'visible', timeout: 5000 });
    await page.locator('#btnToggleLayers').click();

    const carHudBox = await page.locator('#liveDriveHud').boundingBox();
    const carWeatherPillBox = await page.locator('#mapWeatherPill').boundingBox();
    const carRadarPillBox = await page.locator('#weatherRadarPill').boundingBox();
    const carElevBox = await page.locator('#elevationStrip').boundingBox();
    if (rectsIntersect(carHudBox, carWeatherPillBox)) {
      throw new Error(`Tesla car-shell overlap between #liveDriveHud and #mapWeatherPill`);
    }
    if (rectsIntersect(carRadarPillBox, carElevBox)) {
      throw new Error(`Tesla car-shell overlap between #weatherRadarPill and #elevationStrip`);
    }
    console.log('  Tesla car-shell (773x601) unified zero-overlap check PASSED!');
    await saveShot(page, 'unified_release_tesla.png');
    console.log('Saved unified_release_tesla.png');

    // Check Mobile Shell (/mobile 390x844) with all 3 features active
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('http://localhost:8080/mobile?sheet=1', { waitUntil: 'networkidle', timeout: 20000 });
    await page.evaluate(() => {
      navigator.geolocation.watchPosition = (success) => {
        setTimeout(() => {
          success({
            coords: { latitude: 37.65, longitude: -122.38, accuracy: 18, heading: 135, speed: 29.0576 },
          });
        }, 20);
        return 88;
      };
    });
    await page.selectOption('#maxStopsSelect', '6');
    await page.locator('button.preset-tag:has-text("SF → LA")').click();
    await page.waitForSelector('#elevationStrip:not([hidden])', { state: 'visible', timeout: 25000 });
    await page.waitForSelector('#mapWeatherPill:not([hidden])', { state: 'visible', timeout: 20000 });
    await page.locator('#btnLocateMe').click();
    await page.waitForSelector('#liveDriveHud:not([hidden])', { state: 'visible', timeout: 5000 });
    await page.locator('#btnToggleLayers').click();
    await page.locator('#weatherRadarToggle').check();
    await page.waitForSelector('#weatherRadarPill.is-visible', { state: 'visible', timeout: 5000 });
    await page.locator('#btnToggleLayers').click();

    const mobHudBox = await page.locator('#liveDriveHud').boundingBox();
    const mobWeatherPillBox = await page.locator('#mapWeatherPill').boundingBox();
    const mobRadarPillBox = await page.locator('#weatherRadarPill').boundingBox();
    const mobElevBox = await page.locator('#elevationStrip').boundingBox();
    if (rectsIntersect(mobHudBox, mobWeatherPillBox)) {
      throw new Error(`Mobile overlap between #liveDriveHud (${JSON.stringify(mobHudBox)}) and #mapWeatherPill (${JSON.stringify(mobWeatherPillBox)})`);
    }
    if (rectsIntersect(mobRadarPillBox, mobElevBox)) {
      throw new Error(`Mobile overlap between #weatherRadarPill (${JSON.stringify(mobRadarPillBox)}) and #elevationStrip (${JSON.stringify(mobElevBox)})`);
    }
    console.log('  Mobile shell (390x844) unified zero-overlap check PASSED!');

    console.log('\n=============================================');
    console.log('ALL PLAYWRIGHT VERIFICATION CHECKS PASSED!');
    console.log('=============================================\n');
  } catch (err) {
    console.error('Verification failed:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
  process.exit(0);
}

runVerification();

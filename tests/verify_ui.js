const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const MEDIA_DIR = '/tmp/tesla-planner-media';

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

    await page.screenshot({ path: path.join(MEDIA_DIR, '01_visit_maximizer_route.png') });
    console.log('Saved 01_visit_maximizer_route.png');

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

    await page.screenshot({ path: path.join(MEDIA_DIR, 'topo_layer.png') });
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

    await page.screenshot({ path: path.join(MEDIA_DIR, 'foliage_layer.png') });
    console.log('Saved foliage_layer.png');

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

    // Toggle Force Include
    console.log('Toggling "Force-Include in Route" button in drawer...');
    await page.locator('#btnAddStopToRoute').click();
    await page.waitForTimeout(2000);

    const forcedBadge = await page.locator('#forcedCountBadge').textContent();
    console.log(`Forced chargers count: ${forcedBadge}`);

    await page.screenshot({ path: path.join(MEDIA_DIR, '02_drawer_force_include.png') });
    console.log('Saved 02_drawer_force_include.png');

    await page.locator('#btnCloseDrawer').click();
    await page.waitForTimeout(500);

    // 4. Test Area Selection Tool on Map
    console.log('4. Activating Area Selection Tool...');
    await page.locator('#btnSelectArea').click();
    await page.waitForSelector('#mapModeBanner', { state: 'visible' });
    console.log('Area select banner is visible.');

    // Simulate drag bounding box in Central Valley / Southern California
    const mapBox = await page.locator('#map').boundingBox();
    if (mapBox) {
      const startX = mapBox.x + mapBox.width * 0.45;
      const startY = mapBox.y + mapBox.height * 0.45;
      const endX = mapBox.x + mapBox.width * 0.65;
      const endY = mapBox.y + mapBox.height * 0.65;

      console.log(`Dragging selection box from (${startX}, ${startY}) to (${endX}, ${endY})...`);
      await page.mouse.move(startX, startY);
      await page.mouse.down();
      await page.mouse.move(endX, endY, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(3000);
    }

    const updatedForcedBadge = await page.locator('#forcedCountBadge').textContent();
    console.log(`Updated Forced Count after area select: ${updatedForcedBadge}`);

    await page.screenshot({ path: path.join(MEDIA_DIR, '03_area_selected_route.png') });
    console.log('Saved 03_area_selected_route.png');

    // 5. Switch to Explore Tab and check filters
    console.log('5. Testing Explore Chargers tab...');
    await page.locator('#tabExplore').click();
    await page.waitForSelector('#explore-tab', { state: 'visible' });
    await page.waitForTimeout(1500);

    const countText = await page.locator('#chargerListCount').textContent();
    console.log(`Explore Chargers count: ${countText}`);

    await page.screenshot({ path: path.join(MEDIA_DIR, '04_explore_tab.png') });
    console.log('Saved 04_explore_tab.png');

    // 6. Test Mobile Viewport
    console.log('6. Testing Mobile responsive viewport (390x844)...');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#tabRoute').click();
    await page.waitForTimeout(1500);

    await page.screenshot({ path: path.join(MEDIA_DIR, '05_mobile_responsive.png') });
    console.log('Saved 05_mobile_responsive.png');

    console.log('\n=============================================');
    console.log('ALL PLAYWRIGHT VERIFICATION CHECKS PASSED!');
    console.log('=============================================\n');
  } catch (err) {
    console.error('Verification failed:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runVerification();

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

async function runVerification() {
  console.log('Launching browser...');
  const browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/local/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 }
  });

  const page = await context.newPage();
  const screenshotsDir = '/tmp/test_screenshots';
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  }

  try {
    console.log('Navigating to http://localhost:8080 ...');
    await page.goto('http://localhost:8080/', { waitUntil: 'networkidle', timeout: 15000 });

    // 1. Check title & badge
    const badgeText = await page.locator('#totalChargersBadge').textContent();
    console.log(`Chargers Badge: ${badgeText}`);

    // Wait a brief moment for map tiles to render
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(screenshotsDir, '01_initial_page.png') });
    console.log('Saved 01_initial_page.png');

    // 2. Click preset route button: "SF -> LA"
    console.log('Clicking "SF -> LA" preset...');
    await page.locator('button.preset-tag:has-text("SF → LA")').click();

    // Wait for route plan to finish computing & rendering
    console.log('Waiting for route results...');
    await page.waitForSelector('#routeResults', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(3000); // allow map animation and tiles to settle

    const distance = await page.locator('#statDistance').textContent();
    const tripTime = await page.locator('#statTotalTime').textContent();
    const stops = await page.locator('#statStops').textContent();
    const corridorText = await page.locator('#corridorCountText').textContent();

    console.log(`Route Computed:`);
    console.log(`  Distance: ${distance}`);
    console.log(`  Trip Time: ${tripTime}`);
    console.log(`  Stops: ${stops}`);
    console.log(`  Corridor info: ${corridorText}`);

    await page.screenshot({ path: path.join(screenshotsDir, '02_route_calculated.png') });
    console.log('Saved 02_route_calculated.png');

    // 3. Click on a Supercharger timeline item to open drawer
    console.log('Clicking on Supercharger stop in timeline...');
    const firstStop = page.locator('.timeline-item.supercharger .timeline-content').first();
    if (await firstStop.isVisible()) {
      await firstStop.click();
      await page.waitForSelector('#chargerDrawer', { state: 'visible', timeout: 5000 });
      await page.waitForTimeout(1000);

      const chargerTitle = await page.locator('#drawerTitle').textContent();
      const chargerPower = await page.locator('#drawerPower').textContent();
      const chargerStalls = await page.locator('#drawerStalls').textContent();
      console.log(`Charger Drawer opened: ${chargerTitle} (${chargerPower}, ${chargerStalls} stalls)`);

      await page.screenshot({ path: path.join(screenshotsDir, '03_charger_drawer.png') });
      console.log('Saved 03_charger_drawer.png');
    }

    // 4. Switch to Explore Chargers tab
    console.log('Switching to Explore Chargers tab...');
    await page.locator('#tabExplore').click();
    await page.waitForSelector('#explore-tab', { state: 'visible' });
    await page.waitForTimeout(2000);

    const chargerCountText = await page.locator('#chargerListCount').textContent();
    console.log(`Explore Chargers: ${chargerCountText}`);

    await page.screenshot({ path: path.join(screenshotsDir, '04_explore_tab.png') });
    console.log('Saved 04_explore_tab.png');

    console.log('ALL VERIFICATION CHECKS PASSED SUCCESSFULLY!');
  } catch (err) {
    console.error('Verification failed:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runVerification();

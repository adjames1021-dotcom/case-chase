// Plays the game in a headless browser before every deploy: splash, username,
// open a case, keep the item, visit every tab. Fails on any script error.
// Calls to the online server are blocked, so testing never touches real
// players or the live leaderboard.
//
// Run with: npm install --no-save playwright && npx playwright install chromium && node scripts/smoke.mjs

import { chromium } from 'playwright';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = 'file://' + join(root, 'site/index.html');
const errors = [];
const step = (msg) => console.log('ok   ' + msg);

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/^https?:\/\/(?!localhost)/, (route) => route.abort());   // stay offline

  await page.goto(url);
  await page.waitForSelector('#splash-enter:not([disabled])', { timeout: 15000 });
  await page.click('#splash-enter');
  await page.waitForSelector('#name-gate.open');
  await page.fill('#name-in', 'smoketest');
  await page.click('#name-go');
  await page.waitForSelector('#name-gate:not(.open)', { state: 'attached' });
  step('splash and username');

  const cases = await page.locator('.case-card').count();
  if (cases < 5) throw new Error('only ' + cases + ' cases on the shop page');
  step(cases + ' cases in the shop');

  await page.locator('[data-open="0"]').click();            // the free case
  await page.waitForSelector('#skip-btn');
  await page.waitForTimeout(300);
  await page.click('#skip-btn');
  await page.waitForTimeout(400);
  await page.click('#keep-pulls');
  await page.waitForTimeout(300);
  const items = await page.evaluate(() => JSON.parse(localStorage.getItem('case-opening-sim-v2')).inventory.length);
  if (items < 1) throw new Error('opening a case did not add an item');
  step('opened a case and kept the item');

  for (const tab of ['inventory', 'upgrader', 'trade', 'battles', 'leaderboard', 'cases']) {
    await page.locator('.rail .tab[data-tab="' + tab + '"]').click();
    await page.waitForTimeout(250);
    if (!(await page.locator('#panel-' + tab).isVisible())) throw new Error(tab + ' tab did not open');
  }
  step('every tab opens');

  await page.reload();
  await page.waitForSelector('#splash-enter:not([disabled])');
  await page.click('#splash-enter');
  await page.waitForTimeout(500);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('case-opening-sim-v2')).inventory.length);
  if (kept !== items) throw new Error('save did not survive a reload');
  step('save survives a reload');

  if (errors.length) throw new Error('script errors:\n' + errors.join('\n'));
  console.log('\nSmoke test passed.');
} catch (e) {
  console.error('\nSMOKE TEST FAILED: ' + e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}

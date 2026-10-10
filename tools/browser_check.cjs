/* Run against the local server: npm test. Optional BROWSER_PATH for installed Chrome. */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const url = process.env.JOURNEY_URL || 'http://127.0.0.1:8000';
const out = path.resolve(__dirname, '../test-results');
fs.mkdirSync(out, { recursive: true });

async function ready(page) {
  await page.waitForFunction(() => document.querySelector('#loader').hidden);
}
async function chapterReady(page) {
  await page.waitForFunction(() => !document.querySelector('#chapter').hidden &&
    document.querySelector('#mapScreen').inert &&
    !document.querySelector('#portal').classList.contains('portal--active'));
}
async function photoReady(page) {
  await page.waitForFunction(() => {
    const image = document.querySelector('#heroMedia img');
    return image && image.complete && image.naturalWidth > 0;
  });
}
async function mapReady(page) {
  await page.waitForFunction(() => document.querySelector('#chapter').hidden &&
    !document.querySelector('#portal').classList.contains('portal--active'));
}
async function screenshot(page, name) {
  await page.screenshot({ path: path.join(out, name + '.png') });
}

(async () => {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.BROWSER_PATH ? { executablePath: process.env.BROWSER_PATH } : {}) });
  try {
    const errors = [];
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await ready(page);
    assert.equal(await page.locator('.stop').count(), 1);
    assert.equal(await page.locator('.tl--locked:disabled').count(), 9);
    await screenshot(page, 'desktop-map');
    for (let i = 0; i < 10; i++) {
      await page.locator('.tl--available').click();
      await chapterReady(page);
      await photoReady(page);
      assert.equal(await page.locator('.hero__kicker').textContent(), i === 0 ? 'Пролог' : 'Глава ' + (i + 1));
      assert.equal(await page.locator('.sources').count(), 1);
      assert.equal(await page.locator('.today a').count(), 2);
      assert.equal(await page.evaluate(() => document.querySelector('#chapter').scrollWidth > innerWidth), false);
      if (i === 0) {
        await screenshot(page, 'desktop-chapter');
        await page.locator('.hero__credit-toggle').click();
        assert.equal(await page.locator('#heroCredit').isVisible(), true);
        await page.locator('[data-action="to-map"]').first().click();
        await mapReady(page);
        assert.equal(await page.locator('.tl--visited').count(), 0);
        await page.waitForTimeout(80);
        await page.locator('.tl--available').click();
        await chapterReady(page);
      }
      await page.locator('[data-action="continue"]').click();
      await mapReady(page);
      await page.waitForFunction(n => document.querySelectorAll('.tl--visited').length === n, i + 1);
      await page.waitForTimeout(80);
      if (i === 4) {
        await page.reload(); await ready(page);
        assert.equal(await page.locator('.tl--visited').count(), 5);
        assert.equal(await page.locator('.tl--locked').count(), 4);
      }
      console.log('PASS chapter ' + (i + 1));
    }
    await page.locator('#finalTitle').waitFor({ state: 'visible' });
    await screenshot(page, 'final');
    await page.locator('[data-action="collapse-final"]').click();
    await page.locator('#final').waitFor({ state: 'hidden' });
    await screenshot(page, 'full-map');
    // All close clusters must still have distinct, clickable light positions.
    const centers = await page.locator('.stop__body').evaluateAll(elements => elements.map(el => {
      const r = el.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2];
    }));
    assert.equal(new Set(centers.map(p => p.map(Math.round).join(','))).size, 10);
    await page.locator('.tl--visited').nth(2).click();
    await chapterReady(page);
    assert.equal(await page.locator('[data-action="continue"]').count(), 0);
    await page.keyboard.press('Escape'); await mapReady(page);
    await page.waitForTimeout(80);
    await page.locator('#btnReset').click(); await page.locator('#resetCancel').click();
    assert.equal(await page.locator('.tl--visited').count(), 10);
    await page.locator('#btnReset').click(); await page.locator('#resetConfirm').click();
    assert.equal(await page.locator('.tl--visited').count(), 0);
    assert.equal(await page.locator('.stop').count(), 1);
    await page.reload(); await ready(page);
    assert.equal(await page.locator('.tl--visited').count(), 0);
    // A keyboard user can open and leave the available chapter.
    await page.locator('.stop').focus(); await page.keyboard.press('Enter'); await chapterReady(page);
    await page.goBack(); await mapReady(page);

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 },
      isMobile: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    mobile.on('pageerror', error => errors.push(error.message));
    await mobile.goto(url); await ready(mobile); await screenshot(mobile, 'mobile-map');
    await mobile.locator('.stop').click(); await chapterReady(mobile); await photoReady(mobile);
    await screenshot(mobile, 'mobile-chapter');
    await mobile.locator('#chapter').evaluate(el => { el.scrollTop = 850; });
    await screenshot(mobile, 'mobile-story');
    assert.equal(await mobile.evaluate(() => document.querySelector('#chapter').scrollWidth > innerWidth), false);
    await mobile.setViewportSize({ width: 320, height: 568 });
    assert.equal(await mobile.evaluate(() => document.querySelector('#chapter').scrollWidth > innerWidth), false);

    const animated = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    animated.on('pageerror', error => errors.push(error.message));
    await animated.goto(url); await ready(animated);
    await animated.locator('.stop').click();
    await animated.waitForFunction(() => document.querySelector('#portal').classList.contains('portal--active'));
    await screenshot(animated, 'opening-transition');
    await chapterReady(animated); await photoReady(animated);
    await animated.locator('[data-action="continue"]').click();
    await animated.locator('.stop--available[data-idx="1"]').waitFor({ state: 'visible' });
    assert.equal(await animated.locator('.tl--visited').count(), 1);
    await screenshot(animated, 'next-map');
    // Simulate an unavailable image; the chapter remains readable and shows its source.
    const missing = await browser.newPage({ reducedMotion: 'reduce' });
    await missing.route('**/assets/photos/*', route => route.abort());
    await missing.route('https://commons.wikimedia.org/**', route => route.abort());
    await missing.goto(url); await ready(missing);
    await missing.locator('.tl--available').click(); await chapterReady(missing);
    await missing.locator('#heroMedia .photo__missing').waitFor({ state: 'visible' });
    assert.equal(await missing.locator('#chapterTitle').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS reload, revisit, keyboard, browser back, reset, mobile, animation, image fallback; no page errors');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });

import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const url = process.env.QA_URL || 'http://127.0.0.1:5278';
const output = new URL('../test-results/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const result = { url, viewports: [], errors: [] };
const readiness = await (await fetch(`${url}/api/status`)).json();
try {
  const intro = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  intro.on('pageerror', e => result.errors.push(e.message));
  await intro.goto(url); await intro.evaluate(() => document.fonts.ready);
  const frames = [];
  for (const delay of [350, 800, 1000]) {
    await intro.waitForTimeout(delay);
    const bytes = await intro.screenshot(); frames.push(createHash('sha256').update(bytes).digest('hex'));
    await writeFile(new URL(`intro-${frames.length}.png`, output), bytes);
  }
  assert.equal(new Set(frames).size, 3, 'The intro must visibly move.');
  await intro.waitForTimeout(1800);
  await assert.doesNotReject(() => intro.locator('.app-shell:not([inert])').waitFor());
  assert.equal(await intro.locator('.intro').count(), 0);
  await intro.close();
  for (const [width, height] of [[1440, 900], [1366, 768], [390, 844], [320, 640]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', e => result.errors.push(e.message));
    await page.addInitScript(() => sessionStorage.setItem('zecpaid-intro-v2', '1'));
    await page.goto(url); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(700);
    assert.equal(await page.locator('.header-contract strong').innerText(), 'SOON');
    assert.equal(await page.locator('.header-contract .token-square').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Replay intro' }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'ZecPaid on X', exact: true }).first().getAttribute('href'), 'https://x.com/zecpaid');
    assert.ok(await page.evaluate(() => document.fonts.check('20px Jacquard') && document.fonts.check('17px Pixelify')));
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight }));
    assert.equal(dimensions.scrollHeight, height, `Root vertical scroll at ${width}`); assert.equal(dimensions.scrollWidth, width);
    const actions = await page.locator('.form-actions').boundingBox();
    assert.ok(actions.y + actions.height < height - 22, `Actions clipped at ${width}x${height}`);
    await page.locator('.handle-input > span').click();
    await page.keyboard.type('@Zcash');
    assert.equal(await page.locator('#recipient').inputValue(), '@Zcash', `Prefix focus or @ input failed at ${width}`);
    assert.ok(await page.locator('#recipient').evaluate(n => n.checkValidity()));
    await page.locator('#recipient').fill('Zcash');
    assert.ok(await page.locator('#recipient').evaluate(n => n.checkValidity()));
    for (const label of ['Create a coin', 'Live launches', 'My ZEC', "Builders' fund", 'Docs']) {
      await page.getByTitle(label, { exact: true }).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: fileURLToPath(new URL(`${width}-${label.replace(/[^a-z]/gi, '').toLowerCase()}.png`, output)) });
      const overflows = await page.locator('button').evaluateAll(nodes => nodes.filter(n => n.getBoundingClientRect().width > 0 && (n.scrollWidth > n.clientWidth + 3 || n.scrollHeight > n.clientHeight + 3)).map(n => n.innerText));
      assert.deepEqual(overflows, [], `Button overflow at ${width} on ${label}`);
    }
    await page.getByRole('button', { name: 'Operator setup', exact: true }).click();
    assert.ok(await page.getByRole('heading', { name: 'Connect the actual services.' }).isVisible());
    if (!readiness.oauthReady) {
      await page.getByRole('button', { name: 'Connect X', exact: true }).first().click();
      await page.getByRole('dialog').waitFor();
      await page.keyboard.press('Escape'); assert.equal(await page.getByRole('dialog').count(), 0);
    }
    await page.getByTitle('Create a coin', { exact: true }).click();
    await page.locator('#token-name').fill('My builder coin');
    await page.getByTitle('Docs', { exact: true }).click();
    await page.getByTitle('Create a coin', { exact: true }).click();
    assert.equal(await page.locator('#token-name').inputValue(), 'My builder coin');
    assert.ok((await page.locator('.brand img').evaluate(n => n.naturalWidth)) > 0);
    result.viewports.push({ width, height, rootScroll: false, actionsVisible: true, navigation: true, images: true, fonts: true });
    await page.close();
  }
  const reduced = await browser.newPage({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  await reduced.goto(url); await reduced.waitForTimeout(400); assert.equal(await reduced.locator('.intro').count(), 0); await reduced.close();
  assert.deepEqual(result.errors, []);
  await writeFile(new URL('browser-report.json', output), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); }

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { deployed, override } from './live.mjs';

const artifacts = new URL('../../../artifacts/live/', import.meta.url);
const prompt = /slicc:[^\s]*[$#] /;
const browser = await chromium.launch();
after(() => browser.close());

test('boots seven.sliccy.ai into bash in the terminal', async () => {
  await deployed('https://seven.sliccy.ai/');
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://*.sliccy.ai/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), ...override } })
  );
  const page = await context.newPage();
  await page.goto('https://seven.sliccy.ai/');
  const grid = page.locator('slicc-terminal .term-grid');
  await grid.filter({ hasText: prompt }).waitFor({ timeout: 120000 });
  assert.equal(await page.evaluate(() => location.pathname), '/os/');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await page.locator('slicc-terminal').focus();
  await page.keyboard.insertText('echo "sum $((6 * 7))"');
  await page.keyboard.press('Enter');
  await grid.filter({ hasText: 'sum 42' }).waitFor({ timeout: 30000 });
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: new URL('seven.png', artifacts).pathname });
  await context.close();
});

const routed = !env.GITHUB_REF_NAME || env.GITHUB_REF_NAME === 'main';

test('boots www.sliccy.ai/7/ into bash, with the UI at /os/', {
  skip: routed ? false : 'the www.sliccy.ai routes reach a version only once main deploys them',
}, async () => {
  await deployed('https://www.sliccy.ai/7/');
  const context = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  await context.route('https://*.sliccy.ai/**', (route) =>
    route.continue({ headers: { ...route.request().headers(), ...override } })
  );
  const page = await context.newPage();
  await page.goto('https://www.sliccy.ai/7/');
  const grid = page.locator('slicc-terminal .term-grid');
  await grid.filter({ hasText: prompt }).waitFor({ timeout: 120000 });
  assert.equal(await page.evaluate(() => location.pathname), '/os/');
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  assert.equal(
    await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL),
    'https://www.sliccy.ai/7/sw.js'
  );
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: new URL('www-7.png', artifacts).pathname });
  await context.close();
});

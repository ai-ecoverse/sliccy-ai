import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { deployed, override } from './live.mjs';

const artifacts = new URL('../../../artifacts/live/', import.meta.url);
const prompt = 'slicc:~$ ';
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
  await page.waitForFunction(
    (prompt) =>
      location.pathname === '/os/' &&
      document.querySelector('slicc-terminal .term-grid')?.textContent.includes(prompt),
    prompt,
    { timeout: 120000 }
  );
  assert.equal(await page.evaluate(() => crossOriginIsolated), true);
  await page.locator('slicc-terminal').focus();
  await page.keyboard.insertText('echo "sum $((6 * 7))"');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('slicc-terminal .term-grid').textContent.includes('sum 42'),
    null,
    { timeout: 30000 }
  );
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: new URL('seven.png', artifacts).pathname });
  await context.close();
});

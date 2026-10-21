import assert from 'node:assert/strict';
import { env } from 'node:process';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const seven = 'https://seven.sliccy.ai/';

before(() => deployed(seven));

test('serves seven from the version under test', async () => {
  const response = await deployed(seven);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.match(await response.text(), /<title>SLICC BIOS<\/title>/);
  if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
});

test('answers 404 for a host nobody published', async () => {
  const response = await deployed(`https://nobody-${Date.now().toString(36)}.sliccy.ai/`);
  assert.equal(response.status, 404);
  if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
});

test('answers conditional requests', async () => {
  const url = `${seven}bios.js`;
  const response = await get(url);
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const etag = response.headers.get('etag');
  assert.equal((await get(url, { headers: { 'if-none-match': etag } })).status, 304);
  assert.equal((await get(url, { headers: { 'if-match': '"none"' } })).status, 412);
});

test('passes Adobe Clean through from www.sliccy.ai', async () => {
  const response = await get(`${seven}fonts/AdobeClean-Regular.otf`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'font/otf');
  if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
});

test('rejects writes', async () => {
  const response = await get(seven, { method: 'POST', body: 'x' });
  assert.equal(response.status, 405);
});

test('leaves www.sliccy.ai and sliccy.ai to slicc-tray-hub', async () => {
  const status = await get('https://www.sliccy.ai/status');
  assert.equal((await status.json()).service, 'slicc-tray-hub');
  assert.equal(status.headers.get('x-sliccy-ai-version'), null);
  const apex = await get('https://sliccy.ai/', { redirect: 'manual' });
  assert.equal(apex.status, 301);
  assert.equal(apex.headers.get('x-sliccy-ai-version'), null);
});

const routed = !env.GITHUB_REF_NAME || env.GITHUB_REF_NAME === 'main';
const onlyMain = routed
  ? false
  : 'the www.sliccy.ai routes reach a version only once main deploys them';

test('serves seven at www.sliccy.ai/7/ next to six', { skip: onlyMain }, async () => {
  const bios = await deployed('https://www.sliccy.ai/7/');
  assert.equal(bios.status, 200);
  assert.match(await bios.text(), /<title>SLICC BIOS<\/title>/);
  assert.equal(bios.headers.get('x-frame-options'), 'SAMEORIGIN');
  if (version) assert.equal(bios.headers.get('x-sliccy-ai-version'), version);
  const sw = await get('https://www.sliccy.ai/7/sw.js');
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  const bare = await get('https://www.sliccy.ai/7', { redirect: 'manual' });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '/7/');
  const query = await get('https://www.sliccy.ai/7?from=six', { redirect: 'manual' });
  assert.equal(query.status, 301);
  assert.equal(query.headers.get('location'), '/7/?from=six');
  const ui = await get('https://www.sliccy.ai/os/', {
    redirect: 'manual',
    headers: { 'sec-fetch-dest': 'document' },
  });
  assert.equal(ui.status, 302);
  assert.equal(ui.headers.get('location'), '/7/');
  const six = await get('https://www.sliccy.ai/status');
  assert.equal((await six.json()).service, 'slicc-tray-hub');
});

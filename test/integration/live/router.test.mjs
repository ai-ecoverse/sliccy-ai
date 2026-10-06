import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const seven = 'https://seven.sliccy.ai/';

before(() => deployed(seven));

test('serves seven from the version under test', async () => {
  const response = await get(seven);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
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

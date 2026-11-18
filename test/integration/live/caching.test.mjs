import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const seven = 'https://seven.sliccy.ai/';
const vault = 'https://vault.sliccy.ai/';

before(() => deployed(seven));

test('HTML documents are no-store', async () => {
  for (const url of [seven, vault]) {
    const response = await deployed(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', url);
    assert.equal(response.headers.get('cache-control'), 'no-store', url);
    if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
  }
});

test('embedders.json is no-store', async () => {
  for (const url of [`${vault}embedders.json`, 'https://vault-preview.sliccy.ai/embedders.json']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await get(url, { method });
      assert.equal(response.status, 200, `${method} ${url}`);
      assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${url}`);
    }
  }
});

test('scripts stay no-cache', async () => {
  const response = await get(`${seven}bios.js`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.ok(response.headers.get('etag'));
});

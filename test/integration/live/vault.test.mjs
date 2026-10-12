import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const vault = 'https://vault.sliccy.ai';

before(() => deployed(`${vault}/`));

test('vault.sliccy.ai answers from this worker with the vault headers, and no seven routes', async () => {
  const response = await get(`${vault}/`);
  assert.ok([200, 404].includes(response.status), String(response.status));
  if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
  const csp = response.headers.get('content-security-policy') ?? '';
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /frame-ancestors https:\/\/seven\.sliccy\.ai/);
  assert.doesNotMatch(csp, /localhost/);
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-site');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal((await get(`${vault}/bios.js`)).status, 404);
  assert.equal((await get(`${vault}/tray`, { method: 'POST', body: '{}' })).status, 405);
});

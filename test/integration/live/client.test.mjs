import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const url = 'https://seven.sliccy.ai/oauth/client.json';

before(() => deployed(url));

test('seven.sliccy.ai serves SLICC’s client ID metadata document, whose client_id is its own URL', async () => {
  const response = await get(url);
  assert.equal(response.status, 200);
  if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
  const document = await response.json();
  assert.equal(document.client_id, url);
  assert.deepEqual(document.redirect_uris, ['https://seven.sliccy.ai/oauth/mcp-callback']);
});

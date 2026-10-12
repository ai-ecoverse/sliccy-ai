import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const url = 'https://mcpcat.sliccy.ai/oauth/client.json';

before(() => deployed(url));

test('mcpcat.sliccy.ai serves mcpcat’s client ID metadata document, whose client_id is its own URL', async () => {
  const response = await get(url);
  assert.equal(response.status, 200);
  if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal((await response.json()).client_id, url);
  assert.equal((await get('https://mcpcat.sliccy.ai/')).status, 404);
});

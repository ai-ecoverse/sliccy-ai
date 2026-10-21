import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deployed, version } from './live.mjs';

test('seven.sliccy.ai frames its 404s only from itself, and get.sliccy.ai refuses every frame', async () => {
  const missing = await deployed(
    `https://seven.sliccy.ai/does-not-exist-${Math.random().toString(36).slice(2)}`
  );
  assert.equal(missing.status, 404);
  if (version) assert.equal(missing.headers.get('x-sliccy-ai-version'), version);
  assert.equal(missing.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(missing.headers.get('x-frame-options'), 'SAMEORIGIN');
  const index = await deployed('https://get.sliccy.ai/');
  assert.equal(index.status, 200);
  if (version) assert.equal(index.headers.get('x-sliccy-ai-version'), version);
  assert.equal(index.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(index.headers.get('x-frame-options'), 'DENY');
});

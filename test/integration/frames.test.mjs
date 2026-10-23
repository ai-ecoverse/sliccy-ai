import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const [{ binding }] = config.r2_buckets;

const worker = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: fileURLToPath(new URL(config.main, root)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [binding],
  bindings: { [config.version_metadata.binding]: { id: 'local' } },
  serviceBindings: {
    [config.services[0].binding]: (request) =>
      request.url.endsWith('.otf')
        ? new Response('OTTO', { headers: { 'content-type': 'font/otf' } })
        : new Response('six', { headers: { 'content-type': 'text/html' } }),
  },
});
after(() => worker.dispose());

const bucket = await worker.getR2Bucket(binding);
await bucket.put('seven/index.html', '<!doctype html><title>seven</title>');
await bucket.put('seven/bios.js', 'export {};');
await bucket.put('branches/feat-shell/index.html', '<!doctype html><title>branch</title>');

async function frames(url, init) {
  const response = await worker.dispatchFetch(url, { redirect: 'manual', ...init });
  await response.arrayBuffer();
  return {
    status: response.status,
    csp: response.headers.get('content-security-policy'),
    xfo: response.headers.get('x-frame-options'),
  };
}

const self = (status) => ({ status, csp: "frame-ancestors 'self'", xfo: 'SAMEORIGIN' });
const none = (status) => ({ status, csp: "frame-ancestors 'none'", xfo: 'DENY' });

test('seven and its previews send frame headers on every answer they make', async () => {
  assert.deepEqual(await frames('https://seven.sliccy.ai/'), self(200));
  assert.deepEqual(await frames('https://seven.sliccy.ai/does-not-exist'), self(404));
  assert.deepEqual(await frames('https://feat-shell.sliccy.ai/does-not-exist'), self(404));
  assert.deepEqual(await frames('https://nobody.sliccy.ai/'), self(404));
  assert.deepEqual(
    await frames('https://seven.sliccy.ai/', { method: 'POST', body: 'x' }),
    self(405)
  );
  assert.deepEqual(await frames('https://seven.sliccy.ai/bios.js'), self(200));
  const { headers } = await worker.dispatchFetch('https://seven.sliccy.ai/bios.js');
  const etag = headers.get('etag');
  assert.deepEqual(
    await frames('https://seven.sliccy.ai/bios.js', { headers: { 'if-none-match': etag } }),
    self(304)
  );
  assert.deepEqual(
    await frames('https://seven.sliccy.ai/bios.js', { headers: { 'if-match': '"none"' } }),
    self(412)
  );
  assert.deepEqual(await frames('https://seven.sliccy.ai/api/publish/manifest'), self(401));
  assert.deepEqual(await frames('https://seven.sliccy.ai/fonts/not-a-font.css'), self(404));
  assert.deepEqual(await frames('https://feat-shell.sliccy.ai/fonts/not-a-font.css'), self(404));
});

test('seven on www.sliccy.ai sends frame headers on every answer it makes, and six’s answers pass through untouched', async () => {
  assert.deepEqual(await frames('https://www.sliccy.ai/7/does-not-exist'), self(404));
  assert.deepEqual(await frames('https://www.sliccy.ai/7/bios.js'), self(200));
  assert.deepEqual(await frames('https://www.sliccy.ai/7'), self(301));
  assert.deepEqual(await frames('https://www.sliccy.ai/os/'), self(404));
  assert.deepEqual(
    await frames('https://www.sliccy.ai/os/', { headers: { 'sec-fetch-dest': 'document' } }),
    self(302)
  );
  assert.deepEqual(
    await frames('https://www.sliccy.ai/7/', { method: 'POST', body: 'x' }),
    self(405)
  );
  const unframed = { status: 200, csp: null, xfo: null };
  assert.deepEqual(await frames('https://www.sliccy.ai/status'), unframed);
  assert.deepEqual(await frames('https://seven.sliccy.ai/fonts/AdobeClean-Regular.otf'), unframed);
});

test('get.sliccy.ai and mcpcat.sliccy.ai refuse to be framed on every answer', async () => {
  assert.deepEqual(await frames('https://get.sliccy.ai/'), none(200));
  assert.deepEqual(await frames('https://get.sliccy.ai/slicc'), none(302));
  assert.deepEqual(await frames('https://get.sliccy.ai/slicc.ps1'), none(200));
  assert.deepEqual(await frames('https://get.sliccy.ai/nothing.ps1'), none(404));
  assert.deepEqual(await frames('https://get.sliccy.ai/nothing'), none(404));
  assert.deepEqual(
    await frames('https://get.sliccy.ai/', { method: 'POST', body: 'x' }),
    none(405)
  );
  assert.deepEqual(await frames('https://mcpcat.sliccy.ai/oauth/client.json'), none(200));
  assert.deepEqual(await frames('https://mcpcat.sliccy.ai/'), none(404));
});

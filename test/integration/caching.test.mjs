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
  serviceBindings: { [config.services[0].binding]: () => new Response(null, { status: 404 }) },
});
after(() => worker.dispose());

const bucket = await worker.getR2Bucket(binding);
const files = {
  'seven/index.html': '<!doctype html><title>seven</title>',
  'seven/os/index.html': '<!doctype html><title>os</title>',
  'seven/bios.js': 'export {};',
  'seven/sw.js': 'self.addEventListener("fetch", () => {});',
  'seven/app.css': 'body{}',
  'seven/kernel.wasm': '\0asm',
  'branches/feat-shell/index.html': '<!doctype html><title>branch</title>',
  'branches/feat-shell/bios.js': 'export {};',
  'branches/feat-shell.json': '{"branch":"feat/shell","files":["index.html"]}',
  'vault/main/index.html': '<!doctype html><title>vault</title>',
  'vault/main/popup.html': '<!doctype html><title>popup</title>',
  'vault/main/button.html': '<!doctype html><title>button</title>',
  'vault/main/auth/callback.html': '<!doctype html><title>callback</title>',
  'vault/main/vault.js': 'export {};',
  'vault/branches/feat-x/index.html': '<!doctype html><title>vault branch</title>',
  'vault/branches/feat-x/vault.js': 'export {};',
};
for (const [key, body] of Object.entries(files)) await bucket.put(key, body);

async function get(url, init) {
  const response = await worker.dispatchFetch(url, init);
  await response.arrayBuffer();
  return response;
}

const documents = [
  'https://seven.sliccy.ai/',
  'https://seven.sliccy.ai/index.html',
  'https://seven.sliccy.ai/os/',
  'https://feat-shell.sliccy.ai/',
  'https://www.sliccy.ai/7/',
  'https://www.sliccy.ai/7/index.html',
  'https://vault.sliccy.ai/',
  'https://vault.sliccy.ai/popup.html',
  'https://vault.sliccy.ai/button.html',
  'https://vault.sliccy.ai/auth/callback.html',
  'https://vault-preview.sliccy.ai/',
  'https://vault-feat-x.sliccy.ai/',
];

const assets = [
  ['https://seven.sliccy.ai/bios.js', 'text/javascript; charset=utf-8'],
  ['https://seven.sliccy.ai/sw.js', 'text/javascript; charset=utf-8'],
  ['https://seven.sliccy.ai/app.css', 'text/css; charset=utf-8'],
  ['https://seven.sliccy.ai/kernel.wasm', 'application/wasm'],
  ['https://feat-shell.sliccy.ai/bios.js', 'text/javascript; charset=utf-8'],
  ['https://www.sliccy.ai/7/bios.js', 'text/javascript; charset=utf-8'],
  ['https://www.sliccy.ai/7/sw.js', 'text/javascript; charset=utf-8'],
  ['https://vault.sliccy.ai/vault.js', 'text/javascript; charset=utf-8'],
  ['https://vault-preview.sliccy.ai/vault.js', 'text/javascript; charset=utf-8'],
  ['https://vault-feat-x.sliccy.ai/vault.js', 'text/javascript; charset=utf-8'],
];

test('HTML documents are no-store, with their ETag', async () => {
  for (const url of documents) {
    for (const method of ['GET', 'HEAD']) {
      const response = await get(url, { method });
      assert.equal(response.status, 200, `${method} ${url}`);
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8', url);
      assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${url}`);
      assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]+"$/, url);
    }
  }
});

test('a 304 for an HTML document is no-store and keeps the ETag', async () => {
  for (const url of documents) {
    const etag = (await get(url)).headers.get('etag');
    const cached = await get(url, { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304, url);
    assert.equal(cached.headers.get('etag'), etag, url);
    assert.equal(cached.headers.get('cache-control'), 'no-store', url);
  }
});

test('a 412 for an HTML document stays a 412', async () => {
  const response = await get('https://seven.sliccy.ai/', { headers: { 'if-match': '"other"' } });
  assert.equal(response.status, 412);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('every other asset stays no-cache, with its ETag and 304', async () => {
  for (const [url, type] of assets) {
    const response = await get(url);
    assert.equal(response.status, 200, url);
    assert.equal(response.headers.get('content-type'), type, url);
    assert.equal(response.headers.get('cache-control'), 'no-cache', url);
    const etag = response.headers.get('etag');
    const cached = await get(url, { headers: { 'if-none-match': etag } });
    assert.equal(cached.status, 304, url);
    assert.equal(cached.headers.get('etag'), etag, url);
    assert.equal(cached.headers.get('cache-control'), 'no-cache', url);
  }
  const embedders = await get('https://vault.sliccy.ai/embedders.json');
  assert.equal(embedders.headers.get('content-type'), 'application/json');
  assert.equal(embedders.headers.get('cache-control'), 'no-cache');
});

test('the other headers on an HTML document are unchanged', async () => {
  const seven = await get('https://seven.sliccy.ai/');
  assert.equal(seven.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(seven.headers.get('x-frame-options'), 'SAMEORIGIN');
  const bios = await get('https://www.sliccy.ai/7/');
  assert.equal(bios.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(bios.headers.get('service-worker-allowed'), null);
  const vault = await get('https://vault.sliccy.ai/popup.html');
  assert.match(vault.headers.get('content-security-policy'), /frame-ancestors https:\/\/seven/);
  assert.equal(vault.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(vault.headers.get('referrer-policy'), 'no-referrer');
});

test('a vault host has no extensionless /auth/callback page', async () => {
  for (const host of ['vault', 'vault-preview']) {
    const callback = await get(`https://${host}.sliccy.ai/auth/callback`);
    assert.equal(callback.status, 404, host);
  }
});

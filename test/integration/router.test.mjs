import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const [{ binding }] = config.r2_buckets;

const upstream = [];
const worker = new Miniflare({
  modules: true,
  scriptPath: fileURLToPath(new URL(config.main, root)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [binding],
  bindings: { [config.version_metadata.binding]: { id: 'local' } },
  serviceBindings: {
    [config.services[0].binding]: (request) => {
      upstream.push(`${request.method} ${request.url}`);
      return request.url.endsWith('.otf')
        ? new Response('OTTO', { headers: { 'content-type': 'font/otf' } })
        : new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
    },
  },
});
after(() => worker.dispose());

const bucket = await worker.getR2Bucket(binding);
await bucket.put('seven/index.html', '<!doctype html><title>seven</title>');
await bucket.put('seven/bios.js', 'export {};');
await bucket.put('seven/packages/package-lock.json', '{}');
await bucket.put('seven.json', '{"branch":"main","files":["index.html"]}');
await bucket.put('branches/feat-shell/index.html', '<!doctype html><title>branch</title>');
await bucket.put('branches/feat-shell.json', '{"branch":"feat/shell","files":["index.html"]}');
await bucket.put('feat-shell/index.html', '<!doctype html><title>old layout</title>');

const get = (url, init) => worker.dispatchFetch(url, init);

test('serves each host from its own prefix', async () => {
  const seven = await get('https://seven.sliccy.ai/');
  assert.equal(seven.status, 200);
  assert.equal(seven.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(seven.headers.get('cache-control'), 'no-cache');
  assert.match(await seven.text(), /seven/);

  const branch = await get('https://feat-shell.sliccy.ai/index.html');
  assert.match(await branch.text(), /branch/);
});

test('serves branches from branches/ and only seven from the top level', async () => {
  const branch = await get('https://feat-shell.sliccy.ai/');
  assert.match(await branch.text(), /<title>branch</);
  const top = await get('https://branches.sliccy.ai/feat-shell/index.html');
  await top.arrayBuffer();
  assert.equal(top.status, 404);
});

test('names the worker version on every response', async () => {
  for (const [url, init] of [
    ['https://seven.sliccy.ai/', {}],
    ['https://nobody.sliccy.ai/', {}],
    ['https://seven.sliccy.ai/', { method: 'POST', body: 'x' }],
  ]) {
    const response = await get(url, init);
    await response.arrayBuffer();
    assert.equal(response.headers.get('x-sliccy-ai-version'), 'local', url);
  }
});

test('picks the content type from the extension', async () => {
  const types = await Promise.all(
    ['bios.js', 'packages/package-lock.json'].map(async (path) => {
      const response = await get(`https://seven.sliccy.ai/${path}`);
      await response.arrayBuffer();
      return response.headers.get('content-type');
    })
  );
  assert.deepEqual(types, ['text/javascript; charset=utf-8', 'application/json']);
});

test('answers 404 for unknown hosts, files and manifests', async () => {
  for (const url of [
    'https://nobody.sliccy.ai/',
    'https://seven.sliccy.ai/missing.js',
    'https://feat-shell.sliccy.ai/bios.js',
    'https://seven.sliccy.ai/../seven.json',
    'https://feat-shell.sliccy.ai/../feat-shell.json',
  ]) {
    const response = await get(url);
    await response.arrayBuffer();
    assert.equal(response.status, 404, url);
  }
});

test('supports HEAD and conditional requests', async () => {
  const head = await get('https://seven.sliccy.ai/bios.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');

  const etag = head.headers.get('etag');
  const cached = await get('https://seven.sliccy.ai/bios.js', {
    headers: { 'if-none-match': etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get('etag'), etag);
});

test('answers failed match preconditions with 412', async () => {
  const url = 'https://seven.sliccy.ai/bios.js';
  const head = await get(url, { method: 'HEAD' });
  const etag = head.headers.get('etag');
  const cases = [
    [{ 'if-match': '"other"' }, 412],
    [{ 'if-match': `"other", ${etag}`, 'if-none-match': etag }, 304],
    [{ 'if-unmodified-since': 'Mon, 01 Jan 2024 00:00:00 GMT' }, 412],
    [{ 'if-modified-since': new Date(Date.now() + 60000).toUTCString() }, 304],
  ];
  for (const [headers, status] of cases) {
    const response = await get(url, { headers });
    await response.arrayBuffer();
    assert.equal(response.status, status, JSON.stringify(headers));
  }
});

test('passes fonts through from www.sliccy.ai on every host', async () => {
  upstream.length = 0;
  const font = await get('https://seven.sliccy.ai/fonts/AdobeClean-Regular.otf');
  assert.equal(font.status, 200);
  assert.equal(font.headers.get('content-type'), 'font/otf');
  assert.equal(font.headers.get('cache-control'), 'public, max-age=86400');
  assert.equal(font.headers.get('x-sliccy-ai-version'), 'local');
  assert.equal(await font.text(), 'OTTO');
  const branch = await get('https://feat-shell.sliccy.ai/fonts/AdobeClean-Bold.otf', {
    method: 'HEAD',
  });
  await branch.arrayBuffer();
  assert.equal(branch.status, 200);
  assert.deepEqual(upstream, [
    'GET https://www.sliccy.ai/fonts/AdobeClean-Regular.otf',
    'HEAD https://www.sliccy.ai/fonts/AdobeClean-Bold.otf',
  ]);
});

test('answers 404 for anything under /fonts/ that is not a font', async () => {
  const response = await get('https://seven.sliccy.ai/fonts/site.woff2');
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'not found');
});

test('rejects writes', async () => {
  const response = await get('https://seven.sliccy.ai/', { method: 'POST', body: 'x' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
});

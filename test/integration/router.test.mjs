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
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
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
await bucket.put('seven/sw.js', 'self.addEventListener("fetch", () => {});');
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

test('the vault is served from R2 on vault.sliccy.ai, framed only by seven, while its previews are framed by the published seven previews', async () => {
  await bucket.put('vault/main/index.html', '<!doctype html><title>vault</title>');
  const response = await get('https://vault.sliccy.ai/');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>vault<\/title>/);
  const csp = response.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors https:\/\/seven\.sliccy\.ai https:\/\/www\.sliccy\.ai$/);
  assert.deepEqual((await (await get('https://vault.sliccy.ai/embedders.json')).json()).embedders, [
    'https://seven.sliccy.ai',
    'https://www.sliccy.ai',
  ]);
  const preview = await get('https://vault-preview.sliccy.ai/embedders.json');
  assert.deepEqual((await preview.json()).embedders, [
    'https://feat-shell.sliccy.ai',
    'http://localhost:*',
    'http://127.0.0.1:*',
  ]);
  assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
  assert.equal((await get('https://vault.sliccy.ai/tray', { method: 'POST' })).status, 405);
  assert.equal((await get('https://vault-x.sliccy.ai/')).status, 404);
});

test('www.sliccy.ai/7/ serves seven from seven/, next to six', async () => {
  const bios = await get('https://www.sliccy.ai/7/');
  assert.equal(bios.status, 200);
  assert.match(await bios.text(), /<title>seven<\/title>/);
  assert.equal(bios.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(bios.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(bios.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(bios.headers.get('x-sliccy-ai-version'), 'local');
  assert.equal(bios.headers.get('service-worker-allowed'), null);

  const sw = await get('https://www.sliccy.ai/7/sw.js');
  assert.equal(sw.status, 200);
  assert.equal(sw.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(sw.headers.get('service-worker-allowed'), '/');
  const again = await get('https://www.sliccy.ai/7/sw.js', {
    headers: { 'if-none-match': sw.headers.get('etag') },
  });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('service-worker-allowed'), '/');
  await sw.arrayBuffer();

  const lock = await get('https://www.sliccy.ai/7/packages/package-lock.json', { method: 'HEAD' });
  assert.equal(lock.status, 200);
  assert.equal(lock.headers.get('content-type'), 'application/json');
});

test('www.sliccy.ai/7 goes to /7/, and /os/ goes through the BIOS while no service worker answers it', async () => {
  const bare = await get('https://www.sliccy.ai/7?x=1', { redirect: 'manual' });
  assert.equal(bare.status, 301);
  assert.equal(bare.headers.get('location'), '/7/?x=1');
  const ui = await get('https://www.sliccy.ai/os/', {
    redirect: 'manual',
    headers: { 'sec-fetch-dest': 'document' },
  });
  assert.equal(ui.status, 302);
  assert.equal(ui.headers.get('location'), '/7/');
  assert.equal(ui.headers.get('x-sliccy-ai-version'), 'local');
  const seat = await get('https://www.sliccy.ai/os/join.html', {
    redirect: 'manual',
    headers: { 'sec-fetch-dest': 'document' },
  });
  assert.equal(seat.headers.get('location'), '/7/');
  const script = await get('https://www.sliccy.ai/os/os.js', {
    headers: { 'sec-fetch-mode': 'cors' },
  });
  assert.equal(script.status, 404);
  await script.arrayBuffer();
});

test('everything else on www.sliccy.ai stays six’s, and /7/ never publishes or takes writes', async () => {
  upstream.length = 0;
  for (const path of [
    '/',
    '/join/abc',
    '/auth/callback?nonce=n',
    '/fonts/AdobeClean-Regular.otf',
    '/70',
    '/7.html?x=1',
  ]) {
    const response = await get(`https://www.sliccy.ai${path}`);
    await response.arrayBuffer();
    assert.equal(response.status, 200, path);
  }
  assert.deepEqual(upstream, [
    'GET https://www.sliccy.ai/',
    'GET https://www.sliccy.ai/join/abc',
    'GET https://www.sliccy.ai/auth/callback?nonce=n',
    'GET https://www.sliccy.ai/fonts/AdobeClean-Regular.otf',
    'GET https://www.sliccy.ai/70',
    'GET https://www.sliccy.ai/7.html?x=1',
  ]);
  upstream.length = 0;
  const publish = await get('https://www.sliccy.ai/7/api/publish/manifest');
  assert.equal(publish.status, 404);
  await publish.arrayBuffer();
  for (const method of ['PUT', 'POST', 'DELETE']) {
    const response = await get('https://www.sliccy.ai/7/api/publish/files/index.html', {
      method,
      body: 'x',
    });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    await response.arrayBuffer();
  }
  for (const missing of [
    'https://www.sliccy.ai/7/missing.js',
    'https://www.sliccy.ai/7/../seven.json',
  ]) {
    const response = await get(missing);
    await response.arrayBuffer();
    assert.notEqual(response.headers.get('content-type'), 'application/json', missing);
  }
  assert.deepEqual(upstream, ['GET https://www.sliccy.ai/seven.json']);
});

test('echo.sliccy.ai echoes a real WebSocket in workerd', async () => {
  const response = await get('https://echo.sliccy.ai/', {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': 'echo' },
  });
  assert.equal(response.status, 101);
  assert.equal(response.headers.get('sec-websocket-protocol'), 'echo');
  const socket = response.webSocket;
  socket.accept();
  const got = new Promise((resolve) =>
    socket.addEventListener('message', ({ data }) => resolve(data), { once: true })
  );
  socket.send('hello');
  assert.equal(await got, 'hello');
  const bin = new Promise((resolve) =>
    socket.addEventListener('message', ({ data }) => resolve(data), { once: true })
  );
  socket.send(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...new Uint8Array(await bin)], [1, 2, 3]);
  socket.close(1000, 'done');
  assert.equal((await get('https://echo.sliccy.ai/')).status, 426);
});

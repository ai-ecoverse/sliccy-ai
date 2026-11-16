import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { createDownload } from '../../src/download.js';

const REPO = 'https://github.com/ai-ecoverse/sliccy-app';
const API = 'https://api.github.com/repos/ai-ecoverse/sliccy-app/releases/latest';
const DOWNLOAD_URL = 'https://www.sliccy.ai/download/sliccy.dmg';
const dmg = (version = '7.0.0') => `${REPO}/releases/download/v${version}/Sliccy-${version}.dmg`;
const release = (version = '7.0.0') => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  html_url: `${REPO}/releases/tag/v${version}`,
  assets: [
    { name: 'appcast.xml', browser_download_url: `${REPO}/releases/latest/download/appcast.xml` },
    {
      name: `Sliccy-${version}.dmg`,
      browser_download_url: dmg(version),
      state: 'uploaded',
      size: 16406004,
    },
    { name: `Sliccy-${version}.zip`, browser_download_url: 'https://example.com/ignored.zip' },
  ],
});
const json = (value = release()) => Response.json(value);
const request = (method = 'GET') => new Request(DOWNLOAD_URL, { method });

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const upstream = [];
const discoveries = [];
const options = {
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: fileURLToPath(new URL(config.main, root)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [config.r2_buckets[0].binding],
  bindings: { [config.version_metadata.binding]: { id: 'local' } },
  outboundService: (req) => {
    discoveries.push(req);
    assert.equal(req.url, API);
    return json();
  },
  serviceBindings: {
    [config.services[0].binding]: (req) => {
      upstream.push(`${req.method} ${req.url}`);
      return new Response(null, {
        status: 302,
        headers: {
          location:
            'https://github.com/ai-ecoverse/slicc/releases/download/v6.259.12/sliccstart-v6.259.12.dmg',
        },
      });
    },
  },
};
const worker = new Miniflare(options);
after(() => worker.dispose());

test('www GET/HEAD resolve the versioned DMG without forwarding redirect input or credentials', async () => {
  assert.ok(config.routes.some(({ pattern }) => pattern === 'www.sliccy.ai/download/sliccy.dmg*'));
  for (const method of ['GET', 'HEAD']) {
    const response = await worker.dispatchFetch(
      `${DOWNLOAD_URL}?url=https://evil.example/payload.dmg`,
      {
        method,
        redirect: 'manual',
        headers: { cookie: 'private=value', authorization: 'Bearer private' },
      }
    );
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), dmg());
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-sliccy-ai-version'), 'local');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(await response.text(), '');
  }
  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0].method, 'GET');
  assert.equal(discoveries[0].headers.get('cookie'), null);
  assert.equal(discoveries[0].headers.get('authorization'), null);
  assert.equal(discoveries[0].headers.get('user-agent'), 'sliccy-ai-download');
  assert.deepEqual(upstream, []);
});

test('legacy, other platforms, and new-route lookalikes remain V6 requests', async () => {
  upstream.length = 0;
  for (const path of [
    '/download/slicc.dmg',
    '/download/slicc.exe',
    '/download/slicc.AppImage',
    '/download/sliccy.dmg.extra',
    '/download/sliccy.dmg/other',
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const response = await worker.dispatchFetch(`https://www.sliccy.ai${path}?keep=1`, {
        method,
        redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.match(response.headers.get('location'), /sliccstart-v6\.259\.12\.dmg$/);
      assert.equal(upstream.at(-1), `${method} https://www.sliccy.ai${path}?keep=1`);
      await response.arrayBuffer();
    }
  }
  const otherHost = await worker.dispatchFetch('https://seven.sliccy.ai/download/sliccy.dmg');
  assert.equal(otherHost.status, 404);
  await otherHost.arrayBuffer();
});

test('www GET/HEAD discovery failures return retryable unframed errors', async (t) => {
  const broken = new Miniflare({
    ...options,
    outboundService: () => new Response('rate limited', { status: 403 }),
  });
  t.after(() => broken.dispose());
  for (const method of ['GET', 'HEAD']) {
    const response = await broken.dispatchFetch(DOWNLOAD_URL, { method, redirect: 'manual' });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal((await response.text()).length > 0, method === 'GET');
  }
});

test('unsupported methods return 405 without discovering a release', async () => {
  const download = createDownload({ fetcher: () => assert.fail('unexpected discovery') });
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await download(request(method));
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal(response.headers.get('location'), null);
  }
  const response = await worker.dispatchFetch(DOWNLOAD_URL, { method: 'POST', redirect: 'manual' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  await response.arrayBuffer();
});

test('concurrent discovery is shared, cached briefly, then follows the next release', async () => {
  let at = 0;
  let calls = 0;
  let ready;
  const gate = new Promise((resolve) => {
    ready = resolve;
  });
  const download = createDownload({
    now: () => at,
    fetcher: async (url, init) => {
      assert.equal(url, API);
      assert.equal(init.redirect, 'manual');
      assert.deepEqual(init.cf.cacheTtlByStatus, { 200: 300, '201-599': -1 });
      calls += 1;
      await gate;
      return json(release(calls === 1 ? '7.0.0' : '7.1.2'));
    },
  });
  const first = download(request());
  const head = download(request('HEAD'));
  ready();
  for (const response of await Promise.all([first, head]))
    assert.equal(response.headers.get('location'), dmg());
  at = 59_999;
  assert.equal((await download(request())).headers.get('location'), dmg());
  assert.equal(calls, 1);
  at = 60_000;
  assert.equal((await download(request())).headers.get('location'), dmg('7.1.2'));
  assert.equal(calls, 2);
});

test('failed refresh discards an expired success, backs off for a minute, and recovers', async () => {
  let at = 0;
  let calls = 0;
  const download = createDownload({
    now: () => at,
    fetcher: () => {
      calls += 1;
      if (calls === 2) throw new Error('offline');
      return json();
    },
  });
  assert.equal((await download(request())).status, 302);
  at = 60_000;
  for (const method of ['GET', 'HEAD']) {
    const response = await download(request(method));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('retry-after'), '60');
    assert.equal(response.headers.get('link'), `<${REPO}/releases/latest>; rel="alternate"`);
    assert.equal((await response.text()).length > 0, method === 'GET');
  }
  assert.equal(calls, 2);
  at = 120_000;
  assert.equal((await download(request())).status, 302);
  assert.equal(calls, 3);
});

test('only a complete stable release with its own exact uploaded DMG is accepted', async () => {
  const invalid = [
    null,
    { ...release(), draft: true },
    { ...release(), prerelease: true },
    { ...release(), tag_name: 'v7.0.1-beta.1' },
    { ...release(), tag_name: '../../other' },
    { ...release(), html_url: 'https://github.com/other/repo/releases/tag/v7.0.0' },
    { ...release(), assets: null },
    { ...release(), assets: [] },
    { ...release(), assets: [release().assets[1], release().assets[1]] },
    ...[
      { name: 'Sliccy.dmg' },
      { name: 'Sliccy-7.0.0-arm64.dmg' },
      { browser_download_url: 'https://evil.example/Sliccy-7.0.0.dmg' },
      { browser_download_url: dmg().replace('https:', 'http:') },
      { browser_download_url: dmg().replace('/sliccy-app/', '/other/') },
      { browser_download_url: `${dmg()}?redirect=https://evil.example` },
      { browser_download_url: dmg('6.0.0') },
      { state: 'starter' },
      { size: 0 },
      { size: '16406004' },
    ].map((patch) => ({ ...release(), assets: [{ ...release().assets[1], ...patch }] })),
  ];
  for (const value of invalid) {
    const download = createDownload({ fetcher: () => json(value) });
    const response = await download(request());
    assert.equal(response.status, 503, JSON.stringify(value));
    assert.equal(response.headers.get('location'), null);
  }
});

test('upstream failures, malformed/oversized JSON, and slow headers/body fail closed', async () => {
  for (const fetcher of [
    () => new Response('rate limited', { status: 403 }),
    () => new Response('not found', { status: 404 }),
    () => new Response('unavailable', { status: 503 }),
    () => new Response(null, { status: 302, headers: { location: 'https://evil.example' } }),
    () => new Response('<html>fallback</html>'),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () =>
      new Response(' '.repeat(256 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => Promise.reject(new Error('network failed')),
  ]) {
    const response = await createDownload({ fetcher })(request());
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('location'), null);
  }
  for (const body of [false, true]) {
    let signal;
    const download = createDownload({
      timeoutMs: 20,
      fetcher: (_, init) => {
        signal = init.signal;
        if (!body) return new Promise(() => {});
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener('abort', () => controller.error(new Error('aborted')));
            },
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      },
    });
    assert.equal((await download(request('HEAD'))).status, 503);
    assert.equal(signal.aborted, true);
  }
});

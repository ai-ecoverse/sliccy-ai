import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { connect, publisher } from './publisher.mjs';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const bridgeJs = readFileSync(
  new URL('node_modules/@ai-ecoverse/cherry/dist/preview-bridge.js', root),
  'utf8'
);

const six = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get('upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener('message', (event) => server.send('six ' + url.host + ' ' + event.data));
      return new Response(null, { status: 101, webSocket: client });
    }
    return new Response(JSON.stringify({
      url: request.url,
      method: request.method,
      headers: [...request.headers],
      body: await request.text(),
    }), { status: 418, headers: { 'x-six': '1', 'set-cookie': 'six=1; Domain=sliccy.now', 'content-type': 'application/json' } });
  },
};`;

const MIB = 1024 * 1024;
const worker = new Miniflare({
  workers: [
    {
      name: 'sliccy-ai',
      modules: true,
      modulesRules: [
        { type: 'Text', include: ['**/cherry/dist/preview-bridge.js'] },
        { type: 'ESModule', include: ['**/*.js'] },
      ],
      scriptPath: fileURLToPath(new URL(config.main, root)),
      compatibilityDate: config.compatibility_date,
      r2Buckets: config.r2_buckets.map(({ binding }) => binding),
      bindings: {
        [config.version_metadata.binding]: { id: 'local' },
        SERVE_LIMITS: JSON.stringify({
          head: 1500,
          idle: 1500,
          ack: 1500,
          requestBody: 3 * MIB,
          file: 2 * MIB,
          total: 5 * MIB,
          files: 4,
          pending: 2500,
        }),
      },
      serviceBindings: { V6: 'hub', V6_PREVIEW: 'six' },
      durableObjects: { SERVE: { className: 'ServeHost', useSQLite: true } },
    },
    { name: 'hub', modules: true, script: 'export default { fetch: () => new Response("v6") }' },
    { name: 'six', modules: true, script: six, compatibilityDate: config.compatibility_date },
  ],
});
after(() => worker.dispose());

const API = 'https://seven.sliccy.ai/api/serve/host';

async function host() {
  const response = await worker.dispatchFetch(API, { method: 'POST' });
  assert.equal(response.status, 201);
  const { hostId, secret } = await response.json();
  const call = (path, init = {}) =>
    worker.dispatchFetch(`${API}/${hostId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${secret}`, ...init.headers },
    });
  const mint = async (body = {}) => {
    const minted = await call('/previews', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(minted.status, 201);
    return minted.json();
  };
  const publish = async (handler) => {
    const { ws } = await connect(worker, `${API}/${hostId}/ws`, { secret });
    const pub = publisher(ws, handler);
    await pub.next('hello');
    return pub;
  };
  return { hostId, secret, call, mint, publish };
}

const visit = (preview, path = '/', init) =>
  worker.dispatchFetch(`https://${preview.previewToken}.sliccy.now${path}`, init);

test('creates a host on every seven origin, and refuses wrong or missing secrets', async () => {
  const { hostId, secret, call } = await host();
  assert.match(hostId, /^[0-9a-f]{20}$/);
  assert.match(secret, /^[0-9a-f]{64}$/);
  const listed = await call('/previews');
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { previews: [] });
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  assert.equal(listed.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(listed.headers.get('x-sliccy-ai-version'), 'local');
  for (const origin of ['https://feat-x.sliccy.ai', 'https://www.sliccy.ai/7']) {
    const elsewhere = await worker.dispatchFetch(`${origin}/api/serve/host/${hostId}/previews`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    assert.equal(elsewhere.status, 200, origin);
  }
  const missing = await worker.dispatchFetch(`${API}/${hostId}/previews`);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await missing.json()).code, 'UNAUTHORIZED');
  const wrong = await call('/previews', { headers: { authorization: 'Bearer nope' } });
  assert.equal(wrong.status, 401);
  const unknown = await worker.dispatchFetch(`${API}/${'0'.repeat(20)}/previews`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).code, 'HOST_NOT_FOUND');
  const malformed = await worker.dispatchFetch(`${API}/xyz/previews`);
  assert.equal((await malformed.json()).code, 'HOST_NOT_FOUND');
  const listing = await worker.dispatchFetch(API);
  assert.equal(listing.status, 405);
  assert.equal(listing.headers.get('allow'), 'POST');
  assert.equal((await worker.dispatchFetch(`${API.slice(0, -5)}/other`)).status, 404);
  assert.equal((await call('/previews', { method: 'PUT' })).status, 405);
  assert.equal((await call('', { method: 'GET' })).status, 405);
});

test('mints, lists and validates previews', async () => {
  const { hostId, call, mint } = await host();
  const live = await mint({ entry: '/app/?x=1', tag: '/srv/serve/0123' });
  assert.match(live.previewToken, new RegExp(`^${hostId}-[0-9a-f]{32}$`));
  assert.equal(live.url, `https://${live.previewToken}.sliccy.now/app/?x=1`);
  assert.deepEqual(
    { ...live, createdAt: null },
    {
      previewToken: live.previewToken,
      url: live.url,
      entry: '/app/?x=1',
      tag: '/srv/serve/0123',
      mode: 'live',
      state: 'ready',
      bridge: false,
      maxTabs: 20,
      quiet: false,
      createdAt: null,
      expiresAt: null,
      files: 0,
      bytes: 0,
    }
  );
  const { previews } = await (await call('/previews')).json();
  assert.deepEqual(previews, [live]);
  for (const [body, code] of [
    [{ entry: 'app' }, 'INVALID_ENTRY'],
    [{ entry: '/a\\b' }, 'INVALID_ENTRY'],
    [{ tag: 7 }, 'INVALID_TAG'],
    [{ bridge: 'yes' }, 'INVALID_BODY'],
    [{ maxTabs: 0 }, 'INVALID_MAX_TABS'],
    [{ ttlMs: -1 }, 'INVALID_TTL'],
    [{ ttlMs: 31 * 86_400_000 }, 'INVALID_TTL'],
    [{ ttlMs: 1000, bridge: true }, 'INVALID_BODY'],
    [{ ttlMs: 1000, entry: '/../x' }, 'INVALID_ENTRY'],
    [[], 'INVALID_BODY'],
  ]) {
    const refused = await call('/previews', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal((await refused.json()).code, code);
  }
  const broken = await call('/previews', { method: 'POST', body: '{' });
  assert.equal((await broken.json()).code, 'INVALID_BODY');
  const gone = await call(`/previews/${hostId}-${'0'.repeat(32)}`, { method: 'DELETE' });
  assert.equal((await gone.json()).code, 'PREVIEW_NOT_FOUND');
  assert.equal((await call(`/previews/${live.previewToken}`)).status, 405);
});

test("a live preview is 502 without its publisher and 404 once it's stopped", async () => {
  const { call, mint, publish } = await host();
  const preview = await mint();
  const offline = await visit(preview);
  assert.equal(offline.status, 502);
  assert.equal(await offline.text(), 'the publisher of this preview is offline');
  assert.equal(offline.headers.get('x-frame-options'), 'DENY');
  assert.equal(offline.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(offline.headers.get('x-sliccy-ai-version'), 'local');
  const pub = await publish(() => ({ status: 200, body: 'up' }));
  assert.equal(await (await visit(preview)).text(), 'up');
  const stopped = await call(`/previews/${preview.previewToken}`, { method: 'DELETE' });
  assert.deepEqual(await stopped.json(), { stopped: true });
  const revoked = await pub.next('preview.revoked');
  assert.equal(revoked.previewToken, preview.previewToken);
  assert.equal((await visit(preview)).status, 404);
  assert.deepEqual(await (await call('/previews')).json(), { previews: [] });
  pub.close();
});

test('relays a full HTTP request and response, with the header rules', async () => {
  const { mint, publish } = await host();
  const preview = await mint();
  const seen = [];
  const pub = await publish(async (request) => {
    seen.push({ ...request, text: await request.text() });
    return {
      status: 201,
      headers: [
        ['content-type', 'text/plain'],
        ['set-cookie', 'a=1; Domain=sliccy.now; Path=/; Secure'],
        ['set-cookie', 'b=2;domain=.sliccy.now;HttpOnly'],
        ['x-sliccy-ai-version', 'forged'],
        ['alt-svc', 'h3=":443"'],
        ['connection', 'x-drop'],
        ['x-drop', '1'],
        ['x-kept', 'yes'],
      ],
      body: 'made',
    };
  });
  const response = await visit(preview, '/a/b%20c?x=1&y=%2F', {
    method: 'POST',
    headers: {
      cookie: 'session=1',
      range: 'bytes=0-1',
      'cf-connecting-ip': '203.0.113.7',
      'x-forwarded-for': '203.0.113.7',
      'x-real-ip': '203.0.113.7',
      forwarded: 'for=203.0.113.7',
      'x-sliccy-secret': 'no',
      'content-type': 'text/plain',
    },
    body: 'hello',
  });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), 'made');
  assert.deepEqual(response.headers.getSetCookie(), ['a=1; Path=/; Secure', 'b=2;HttpOnly']);
  assert.equal(response.headers.get('x-sliccy-ai-version'), 'local');
  assert.equal(response.headers.get('alt-svc'), null);
  assert.equal(response.headers.get('x-drop'), null);
  assert.equal(response.headers.get('x-kept'), 'yes');
  assert.equal(response.headers.get('x-frame-options'), null);
  assert.equal(response.headers.get('content-security-policy'), null);
  const [request] = seen;
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/a/b%20c?x=1&y=%2F');
  assert.equal(request.url, `https://${preview.previewToken}.sliccy.now/a/b%20c?x=1&y=%2F`);
  assert.equal(request.previewToken, preview.previewToken);
  assert.equal(request.body, true);
  assert.equal(request.text, 'hello');
  const names = request.headers.map(([name]) => name);
  assert.deepEqual(
    names.filter((name) => /^(host|cf-|x-forwarded|x-real-ip|forwarded|x-sliccy)/.test(name)),
    []
  );
  const header = (name) => request.headers.find(([key]) => key === name)?.[1];
  assert.equal(header('cookie'), 'session=1');
  assert.equal(header('range'), 'bytes=0-1');
  pub.close();
});

test('streams large bodies both ways within the flow-control window', async () => {
  const { mint, publish } = await host();
  const preview = await mint();
  const big = new Uint8Array(3 * MIB + 17).map((_, index) => index % 251);
  let uploaded = null;
  const pub = await publish(async (request) => {
    if (request.method === 'PUT') {
      uploaded = await request.bytes();
      return { status: 204 };
    }
    if (request.path === '/head') return { status: 200, headers: [['content-length', '9']] };
    return {
      status: 200,
      headers: [
        ['content-type', 'application/octet-stream'],
        ['content-length', String(big.byteLength)],
      ],
      body: big,
    };
  });
  const response = await visit(preview, '/big');
  assert.equal(response.headers.get('content-length'), String(big.byteLength));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), big);
  assert.ok(pub.maxUnacked <= MIB, `${pub.maxUnacked} bytes unacknowledged`);
  const upload = new Uint8Array(2 * MIB + 5).map((_, index) => index % 13);
  const put = await visit(preview, '/up', { method: 'PUT', body: upload });
  assert.equal(put.status, 204);
  assert.deepEqual(new Uint8Array(uploaded), upload);
  const head = await visit(preview, '/head', { method: 'HEAD' });
  assert.equal(head.status, 200);
  const tooBig = await visit(preview, '/up', {
    method: 'PUT',
    headers: { 'content-length': String(3 * MIB + 1) },
    body: new Uint8Array(3 * MIB + 1),
  });
  assert.equal(tooBig.status, 413);
  pub.close();
});

test('passes encoded bodies through untouched', async () => {
  const { mint, publish } = await host();
  const preview = await mint();
  const pub = await publish(() => ({
    status: 200,
    headers: [
      ['content-type', 'text/plain'],
      ['content-encoding', 'gzip'],
    ],
    body: new Uint8Array(gzipSync('squeezed')),
  }));
  const response = await visit(preview, '/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(await response.text(), 'squeezed');
  pub.close();
});

test('times out, cancels both ways, and bounds the streams', async () => {
  const { mint, publish } = await host();
  const preview = await mint();
  const pub = await publish((request) => {
    if (request.path === '/never') return new Promise(() => {});
    if (request.path === '/cancel') {
      pub.send({ type: 'http.cancel', id: request.id, reason: 'origin failed' });
      return null;
    }
    if (request.path === '/bad') return { status: 99 };
    if (request.path === '/badheaders') return { status: 200, headers: [['a']] };
    if (request.path === '/stall') return { status: 200, body: 'partial', end: false };
    return null;
  });
  const slow = await visit(preview, '/never');
  assert.equal(slow.status, 504);
  assert.equal(await slow.text(), "the publisher didn't answer within 30 s");
  await pub.next('http.cancel');
  const cancelled = await visit(preview, '/cancel');
  assert.equal(cancelled.status, 502);
  assert.equal(await cancelled.text(), 'origin failed');
  assert.equal((await visit(preview, '/bad')).status, 502);
  assert.equal((await visit(preview, '/badheaders')).status, 502);
  const stalled = await visit(preview, '/stall');
  assert.equal(stalled.status, 200);
  await stalled.text().catch(() => {});
  await pub.next('http.cancel', (m) => m.reason === 'the publisher stopped sending for 120 s');
  const upgrade = await visit(preview, '/socket', { headers: { upgrade: 'websocket' } });
  assert.equal(upgrade.status, 501);
  pub.close();
});

test('cancels a request body the publisher does not read', async () => {
  const { mint, publish } = await host();
  const preview = await mint();
  const pub = await publish(() => new Promise(() => {}));
  pub.holdAcks = true;
  const response = await visit(preview, '/up', {
    method: 'POST',
    body: new Uint8Array(2 * MIB),
  });
  assert.equal(response.status, 504);
  pub.close();
});

test('takes the secret as a subprotocol, and a new socket replaces the old one', async () => {
  const { hostId, secret, mint, publish } = await host();
  const preview = await mint();
  const first = await publish(() => ({ status: 200, body: 'first' }));
  const { ws, protocol } = await connect(worker, `${API}/${hostId}/ws`, {
    protocols: ['slicc-serve.v1', `bearer.${secret}`],
  });
  assert.equal(protocol, 'slicc-serve.v1');
  const second = publisher(ws, () => ({ status: 200, body: 'second' }));
  await second.next('hello');
  assert.equal((await first.next('close', undefined, 15_000)).code, 4000);
  assert.equal(await (await visit(preview)).text(), 'second');
  const { refused } = await connect(worker, `${API}/${hostId}/ws`, {
    protocols: [`bearer.${secret}`],
  });
  assert.equal(refused.status, 400);
  const plain = await worker.dispatchFetch(`${API}/${hostId}/ws`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(plain.status, 426);
  second.raw('ping');
  await second.next('pong');
  second.raw(new Uint8Array(3));
  assert.equal((await second.next('close')).code, 1008);
});

test('closes a socket that sends malformed frames', async () => {
  const { publish } = await host();
  for (const [data, code] of [
    ['{', 1008],
    ['{}', 1008],
    [new Uint8Array(64 * 1024 + 6), 1009],
  ]) {
    const pub = await publish(() => null);
    pub.raw(data);
    assert.equal((await pub.next('close')).code, code);
  }
  const pub = await publish(() => null);
  pub.send({ type: 'something.new' });
  pub.raw(new Uint8Array([0, 0, 0, 9, 1]));
  pub.send({ type: 'http.ack', id: 12345, bytes: 3 });
  pub.raw('ping');
  await pub.next('pong');
  assert.equal(pub.closed, null);
  pub.close();
});

test('stores, serves and stops a --ttl snapshot', async () => {
  const { call, mint } = await host();
  const snapshot = await mint({ ttlMs: 60_000 });
  assert.equal(snapshot.mode, 'snapshot');
  assert.equal(snapshot.state, 'uploading');
  assert.equal(snapshot.expiresAt, null);
  const token = snapshot.previewToken;
  const put = (path, body, headers = {}) =>
    call(`/previews/${token}/files/${path}`, {
      method: 'PUT',
      body,
      headers: { 'content-length': String(Buffer.byteLength(body)), ...headers },
    });
  assert.equal((await visit(snapshot)).status, 404);
  const early = await call(`/previews/${token}/finalize`, { method: 'POST' });
  assert.equal((await early.json()).code, 'ENTRY_MISSING');
  const index = await put('index.html', '<h1>v1</h1>', { 'content-type': 'text/html' });
  assert.deepEqual(await index.json(), { path: 'index.html', size: 11 });
  await put('index.html', '<h1>home</h1>', { 'content-type': 'text/html' });
  await put('sub/index.html', 'sub', { 'content-type': 'text/html' });
  await put('my%20file.txt', '0123456789', { 'content-type': 'text/plain' });
  for (const [path, code] of [
    ['a%2F..%2Fb', 'INVALID_PATH'],
    ['a%5Cb', 'INVALID_PATH'],
    ['a//b', 'INVALID_PATH'],
    ['%E0%A4%A', 'INVALID_PATH'],
  ])
    assert.equal((await (await put(path, 'x')).json()).code, code);
  const unsized = await call(`/previews/${token}/files/u.txt`, { method: 'PUT', body: 'x' });
  assert.equal(unsized.status, 411);
  const listed = (await (await call('/previews')).json()).previews[0];
  assert.equal(listed.files, 3);
  assert.equal(listed.bytes, 13 + 3 + 10);
  const done = await call(`/previews/${token}/finalize`, { method: 'POST' });
  const ready = await done.json();
  assert.equal(ready.state, 'ready');
  assert.ok(Date.parse(ready.expiresAt) > Date.now() + 50_000);
  assert.equal((await put('late.txt', 'x')).status, 409);
  assert.equal(
    (await (await call(`/previews/${token}/finalize`, { method: 'POST' })).json()).code,
    'SNAPSHOT_FINALIZED'
  );
  const home = await visit(snapshot);
  assert.equal(await home.text(), '<h1>home</h1>');
  assert.equal(home.headers.get('content-type'), 'text/html');
  assert.equal(home.headers.get('cache-control'), 'no-cache');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
  const etag = home.headers.get('etag');
  assert.equal((await visit(snapshot, '/', { headers: { 'if-none-match': etag } })).status, 304);
  const moved = await visit(snapshot, '/sub?q=1', { redirect: 'manual' });
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get('location'), '/sub/?q=1');
  assert.equal(await (await visit(snapshot, '/sub/')).text(), 'sub');
  const ranged = await visit(snapshot, '/my%20file.txt', { headers: { range: 'bytes=2-4' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await ranged.text(), '234');
  const tail = await visit(snapshot, '/my%20file.txt', { headers: { range: 'bytes=-3' } });
  assert.equal(await tail.text(), '789');
  const outside = await visit(snapshot, '/my%20file.txt', { headers: { range: 'bytes=20-' } });
  assert.equal(outside.status, 416);
  assert.equal(outside.headers.get('content-range'), 'bytes */10');
  const head = await visit(snapshot, '/my%20file.txt', { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '10');
  assert.equal((await visit(snapshot, '/missing')).status, 404);
  assert.equal((await visit(snapshot, '/%E0%A4%A')).status, 404);
  assert.equal((await visit(snapshot, '/', { method: 'POST' })).status, 405);
  const storage = await worker.getR2Bucket('SERVE_STORAGE');
  const stored = await storage.list({ prefix: 'serve/' });
  assert.ok(stored.objects.length >= 3);
  await call(`/previews/${token}`, { method: 'DELETE' });
  assert.equal((await visit(snapshot)).status, 404);
  const [, secretPart] = token.split('-');
  const left = await storage.list({ prefix: `serve/${token.split('-')[0]}/${secretPart}/` });
  assert.equal(left.objects.length, 0);
});

test('bounds the files of a snapshot', async () => {
  const { call, mint } = await host();
  const live = await mint();
  const notSnapshot = await call(`/previews/${live.previewToken}/files/a`, {
    method: 'PUT',
    headers: { 'content-length': '1' },
    body: 'x',
  });
  assert.equal(notSnapshot.status, 404);
  const finalized = await call(`/previews/${live.previewToken}/finalize`, { method: 'POST' });
  assert.equal(finalized.status, 404);
  const snapshot = await mint({ ttlMs: 1000, entry: '/docs/' });
  const put = (path, size) =>
    call(`/previews/${snapshot.previewToken}/files/${path}`, {
      method: 'PUT',
      headers: { 'content-length': String(size) },
      body: new Uint8Array(size),
    });
  const code = async (path, size) => (await (await put(path, size)).json()).code;
  assert.equal(await code('big', 2 * MIB + 1), 'FILE_TOO_LARGE');
  assert.equal((await put('a', 2 * MIB)).status, 200);
  assert.equal((await put('b', 2 * MIB)).status, 200);
  assert.equal(await code('c', 1.5 * MIB), 'SNAPSHOT_TOO_LARGE');
  assert.equal((await put('a', 1)).status, 200);
  assert.equal((await put('c', 2 * MIB)).status, 200);
  assert.equal((await put('d', 1)).status, 200);
  assert.equal(await code('e', 1), 'TOO_MANY_FILES');
  const early = await call(`/previews/${snapshot.previewToken}/finalize`, { method: 'POST' });
  assert.match((await early.json()).error, /docs\/index\.html/);
});

test('finalizes and serves entries whose names need percent-encoding, or carry a query', async () => {
  const { call, mint } = await host();
  for (const [name, encoded, entry, query] of [
    ['a b.html', 'a%20b.html', '/a%20b.html', ''],
    ['ü.css', '%C3%BC.css', '/%C3%BC.css', ''],
    ['x%y.js', 'x%25y.js', '/x%25y.js', ''],
    ['index.html', 'index.html', '/index.html?theme=dark', '?theme=dark'],
    ['index.html', 'index.html', '/?theme=dark#top', '?theme=dark#top'],
    ['d i/index.html', 'd%20i/index.html', '/d%20i/?q=1', '?q=1'],
  ]) {
    const snapshot = await mint({ ttlMs: 60_000, entry });
    const body = `file ${name}`;
    const put = await call(`/previews/${snapshot.previewToken}/files/${encoded}`, {
      method: 'PUT',
      headers: { 'content-length': String(Buffer.byteLength(body)), 'content-type': 'text/plain' },
      body,
    });
    assert.deepEqual(await put.json(), { path: name, size: Buffer.byteLength(body) }, entry);
    const done = await call(`/previews/${snapshot.previewToken}/finalize`, { method: 'POST' });
    assert.equal(done.status, 200, `${entry}: ${JSON.stringify(await done.clone().json())}`);
    const ready = await done.json();
    assert.equal(ready.url, `https://${snapshot.previewToken}.sliccy.now${entry}`);
    const served = await worker.dispatchFetch(ready.url);
    assert.equal(served.status, 200, ready.url);
    assert.equal(await served.text(), body, ready.url);
    const path = entry.slice(0, entry.length - query.length);
    assert.equal(await (await visit(snapshot, path)).text(), body, path);
  }
});

test('deletes snapshots when they expire, and unfinished ones after the upload window', async () => {
  const { call, mint } = await host();
  const expiring = await mint({ ttlMs: 1200 });
  const unfinished = await mint({ ttlMs: 60_000 });
  await call(`/previews/${expiring.previewToken}/files/index.html`, {
    method: 'PUT',
    headers: { 'content-length': '2', 'content-type': 'text/html' },
    body: 'hi',
  });
  await call(`/previews/${expiring.previewToken}/finalize`, { method: 'POST' });
  assert.equal(await (await visit(expiring)).text(), 'hi');
  await sleep(1800);
  assert.equal((await visit(expiring)).status, 404);
  const listed = (await (await call('/previews')).json()).previews;
  assert.deepEqual(
    listed.map(({ previewToken }) => previewToken),
    [unfinished.previewToken]
  );
  await sleep(1200);
  assert.deepEqual(await (await call('/previews')).json(), { previews: [] });
  const storage = await worker.getR2Bucket('SERVE_STORAGE');
  const left = await storage.list({ prefix: `serve/${expiring.previewToken.split('-')[0]}/` });
  assert.equal(left.objects.length, 0);
});

test("forwards six's labels to six's preview worker byte for byte", async () => {
  for (const label of [`${'a'.repeat(32)}--${'b'.repeat(20)}`, 'whatever', 'ABC-def']) {
    const response = await worker.dispatchFetch(`https://${label}.sliccy.now/x?y=1`, {
      method: 'POST',
      headers: { cookie: 'c=1', 'x-any': 'thing' },
      body: 'payload',
    });
    assert.equal(response.status, 418);
    assert.equal(response.headers.get('x-six'), '1');
    assert.equal(response.headers.get('set-cookie'), 'six=1; Domain=sliccy.now');
    assert.equal(response.headers.get('x-sliccy-ai-version'), null);
    const echoed = await response.json();
    assert.equal(echoed.url, `https://${label.toLowerCase()}.sliccy.now/x?y=1`);
    assert.equal(echoed.body, 'payload');
    const headers = Object.fromEntries(echoed.headers);
    assert.equal(headers.cookie, 'c=1');
    assert.equal(headers['x-any'], 'thing');
  }
  const upgraded = await worker.dispatchFetch(
    `https://${'c'.repeat(32)}--d.sliccy.now/__slicc/bridge`,
    {
      headers: { upgrade: 'websocket' },
    }
  );
  assert.equal(upgraded.status, 101);
  const socket = upgraded.webSocket;
  socket.accept();
  const echoed = new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(event.data))
  );
  socket.send('hi');
  assert.equal(await echoed, `six ${'c'.repeat(32)}--d.sliccy.now hi`);
  socket.close();
});

test('bridges visitor tabs to the publisher', async () => {
  const { hostId, secret, mint, publish } = await host();
  const preview = await mint({ bridge: true, maxTabs: 1 });
  const plain = await mint();
  const requests = [];
  let pub = await publish((request) => {
    requests.push(request);
    if (request.path === '/plain')
      return { status: 200, headers: [['content-type', 'text/html']], body: '<p>x</p>' };
    return {
      status: 200,
      headers: [
        ['content-type', 'text/html; charset=utf-8'],
        ['content-length', '57'],
        ['content-security-policy', "default-src 'self'; connect-src 'self'"],
      ],
      body: '<!doctype html><html><head><title>t</title></head></html>',
    };
  });
  const page = await visit(preview, '/', { headers: { 'accept-encoding': 'gzip, br' } });
  const html = await page.text();
  const socketUrl = `wss://${preview.previewToken}.sliccy.now`;
  assert.equal(
    html,
    `<!doctype html><html><head><script src="/__slicc/preview-bridge.js" data-slicc-token="${preview.previewToken}" data-slicc-ws="${socketUrl}/__slicc/bridge"></script><title>t</title></head></html>`
  );
  assert.equal(page.headers.get('content-length'), null);
  assert.equal(
    page.headers.get('content-security-policy'),
    `default-src 'self'; connect-src 'self' ${socketUrl}`
  );
  assert.deepEqual(
    requests[0].headers.filter(([name]) => name === 'accept-encoding'),
    [['accept-encoding', 'identity']]
  );
  const fragment = await visit(preview, '/plain');
  assert.match(await fragment.text(), /^<p>x<\/p><script src="\/__slicc\/preview-bridge\.js"/);
  const script = await visit(preview, '/__slicc/preview-bridge.js');
  assert.equal(await script.text(), bridgeJs);
  assert.equal(script.headers.get('cache-control'), 'public, max-age=86400');
  const unbridged = await visit(plain, '/__slicc/preview-bridge.js');
  assert.notEqual(await unbridged.text(), bridgeJs);
  assert.equal(requests.at(-1).path, '/__slicc/preview-bridge.js');

  const tabResponse = await visit(preview, '/__slicc/bridge', {
    headers: { upgrade: 'websocket', origin: 'https://visitor.example', 'user-agent': 'UA' },
  });
  assert.equal(tabResponse.status, 101);
  const tab = tabResponse.webSocket;
  const fromHub = [];
  tab.addEventListener('message', (event) => fromHub.push(event.data));
  tab.accept();
  const connected = await pub.next('bridge.connected');
  assert.equal(connected.previewToken, preview.previewToken);
  assert.equal(connected.origin, 'https://visitor.example');
  assert.equal(connected.userAgent, 'UA');
  const { connId } = connected;
  const full = await visit(preview, '/__slicc/bridge', { headers: { upgrade: 'websocket' } });
  assert.equal(full.status, 429);
  assert.equal((await full.json()).code, 'BRIDGE_CAP');

  pub.send({
    type: 'bridge.cdp.request',
    connId,
    id: 7,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
  });
  while (fromHub.length < 2) await sleep(10);
  assert.deepEqual(JSON.parse(fromHub[0]), { t: 'welcome', connId });
  assert.deepEqual(JSON.parse(fromHub[1]), {
    t: 'cdp.req',
    id: 7,
    method: 'Runtime.evaluate',
    params: { expression: '1' },
  });
  tab.send(JSON.stringify({ t: 'cdp.res', id: 7, result: { value: 1 } }));
  const answered = await pub.next('bridge.cdp.response', (m) => m.id === 7);
  assert.deepEqual(answered, { type: 'bridge.cdp.response', connId, id: 7, result: { value: 1 } });
  tab.send(JSON.stringify({ t: 'emit', name: 'clicked', detail: { n: 1 } }));
  const emitted = await pub.next('bridge.emit');
  assert.equal(emitted.connId, connId);
  assert.equal(emitted.name, 'clicked');
  assert.deepEqual(emitted.detail, { n: 1 });
  tab.send('not json');
  tab.send(JSON.stringify({ t: 'emit', name: 'big', detail: 'x'.repeat(17 * 1024) }));
  const beacon = await visit(preview, '/__slicc/emit', {
    method: 'POST',
    body: JSON.stringify({ t: 'emit', name: 'beacon', detail: 2 }),
  });
  assert.equal(beacon.status, 204);
  const beaconed = await pub.next('bridge.emit', (m) => m.name === 'beacon');
  assert.equal(beaconed.connId, null);
  assert.equal(
    pub.messages.some((m) => m.name === 'big'),
    false
  );
  const badBeacon = await visit(preview, '/__slicc/emit', { method: 'POST', body: 'x' });
  assert.equal(badBeacon.status, 400);
  const hugeBeacon = await visit(preview, '/__slicc/emit', {
    method: 'POST',
    body: 'x'.repeat(17 * 1024),
  });
  assert.equal(hugeBeacon.status, 413);
  for (let n = 0; n < 25; n += 1) tab.send(JSON.stringify({ t: 'emit', name: `burst${n}` }));
  await pub.next('bridge.emit', (m) => m.name === 'burst18');
  await sleep(100);
  assert.equal(pub.messages.filter((m) => m.name?.startsWith('burst')).length, 19);

  pub.send({ type: 'preview.state.update', previewToken: preview.previewToken, announced: true });
  pub.close();
  await sleep(50);
  const { ws } = await connect(worker, `${API}/${hostId}/ws`, { secret });
  pub = publisher(ws, () => null);
  await pub.next('hello');
  const state = await pub.next('preview.state');
  assert.deepEqual(state, {
    type: 'preview.state',
    previewToken: preview.previewToken,
    quiet: false,
    announced: true,
  });
  const replay = await pub.next('bridge.connected');
  assert.equal(replay.connId, connId);
  assert.equal(replay.replay, true);

  pub.send({ type: 'bridge.close', connId });
  const disconnected = await pub.next('bridge.disconnected');
  assert.equal(disconnected.connId, connId);
  pub.send({ type: 'bridge.cdp.request', connId, id: 8, method: 'Page.navigate' });
  const goneAnswer = await pub.next('bridge.cdp.response', (m) => m.id === 8);
  assert.deepEqual(goneAnswer.error, {
    code: -32000,
    message: 'Preview bridge connection is gone',
  });
  pub.close();
});

test('stopping a bridged preview closes its tabs', async () => {
  const { call, mint, publish } = await host();
  const preview = await mint({ bridge: true });
  const pub = await publish(() => null);
  const tab = (await visit(preview, '/__slicc/bridge', { headers: { upgrade: 'websocket' } }))
    .webSocket;
  tab.accept();
  const closed = new Promise((resolve) => tab.addEventListener('close', resolve));
  await pub.next('bridge.connected');
  await call(`/previews/${preview.previewToken}`, { method: 'DELETE' });
  await closed;
  pub.close();
});

test('deleting a host closes its socket, and the host answers 410 from then on', async () => {
  const { call, mint, publish } = await host();
  const live = await mint();
  const snapshot = await mint({ ttlMs: 1000 });
  await call(`/previews/${snapshot.previewToken}/files/index.html`, {
    method: 'PUT',
    headers: { 'content-length': '1' },
    body: 'x',
  });
  const pub = await publish(() => null);
  const deleted = await call('', { method: 'DELETE' });
  assert.deepEqual(await deleted.json(), { deleted: true });
  assert.equal((await pub.next('close', undefined, 15_000)).code, 4001);
  const after = await call('/previews');
  assert.equal(after.status, 410);
  assert.equal((await after.json()).code, 'HOST_GONE');
  assert.equal((await visit(live)).status, 404);
});

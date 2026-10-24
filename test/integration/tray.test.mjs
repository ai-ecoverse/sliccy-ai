import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));

const hub = `const frames = {
  wide: { 'content-security-policy': "default-src *; frame-ancestors *", 'x-frame-options': 'ALLOWALL' },
  none: { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'", 'x-frame-options': 'DENY' },
};
export default {
  async fetch(request) {
    const response = await answer(request);
    if (response.webSocket) return response;
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(frames[request.headers.get('x-six-frames')] ?? {})) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  },
};
async function answer(request) {
    const url = new URL(request.url);
    if (url.pathname === '/join/old') {
      return new Response('{"result":{"action":"redirect"}}', { status: 308, headers: { location: 'https://www.sliccy.ai/join/new' } });
    }
    if (url.pathname === '/join/gone') return new Response('gone', { status: 404 });
    if (request.headers.get('upgrade') === 'websocket') {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      server.addEventListener('message', (event) => server.send(url.pathname + ' ' + request.headers.get('cookie') + ' ' + event.data));
      return new Response(null, { status: 101, webSocket: client });
    }
    return Response.json(
      { url: request.url, method: request.method, cookie: request.headers.get('cookie'), body: await request.text() },
      { status: 201, headers: { 'set-cookie': 'session=1' } }
    );
}`;

const worker = new Miniflare({
  workers: [
    {
      name: 'sliccy-ai',
      modules: true,
      modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
      scriptPath: fileURLToPath(new URL(config.main, root)),
      compatibilityDate: config.compatibility_date,
      r2Buckets: [config.r2_buckets[0].binding],
      bindings: { [config.version_metadata.binding]: { id: 'local' } },
      serviceBindings: { [config.services[0].binding]: 'hub' },
    },
    { name: 'hub', modules: true, script: hub, compatibilityDate: config.compatibility_date },
  ],
});
after(() => worker.dispose());

test('creates a tray through www.sliccy.ai without passing cookies either way', async () => {
  const response = await worker.dispatchFetch('https://seven.sliccy.ai/tray', {
    method: 'POST',
    headers: { cookie: 'ambient=1', 'content-type': 'application/json' },
    body: '{"leader":true}',
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-sliccy-ai-version'), 'local');
  assert.deepEqual(await response.json(), {
    url: 'https://www.sliccy.ai/tray',
    method: 'POST',
    cookie: null,
    body: '{"leader":true}',
  });
});

test('carries the leader WebSocket through to the hub', async () => {
  const response = await worker.dispatchFetch('https://feat-x.sliccy.ai/controller/abc', {
    headers: { upgrade: 'websocket', cookie: 'ambient=1' },
  });
  assert.equal(response.status, 101);
  const socket = response.webSocket;
  socket.accept();
  const reply = new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(event.data))
  );
  socket.send('hello');
  assert.equal(await reply, '/controller/abc null hello');
  socket.close();
});

test('a follower page gets the hub supersede redirect as an answer it can read', async () => {
  const response = await worker.dispatchFetch('https://seven.sliccy.ai/join/old', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-tray-status'), '308');
  assert.equal(response.headers.get('x-tray-location'), 'https://www.sliccy.ai/join/new');
  assert.deepEqual(await response.json(), { result: { action: 'redirect' } });
});

test('on www.sliccy.ai the tray routes are under /7, proxied without the prefix as on seven’s hosts', async () => {
  const created = await worker.dispatchFetch('https://www.sliccy.ai/7/tray', {
    method: 'POST',
    headers: { cookie: 'ambient=1', 'content-type': 'application/json' },
    body: '{"leader":true}',
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('set-cookie'), null);
  assert.deepEqual(await created.json(), {
    url: 'https://www.sliccy.ai/tray',
    method: 'POST',
    cookie: null,
    body: '{"leader":true}',
  });
  const moved = await worker.dispatchFetch('https://www.sliccy.ai/7/join/old', {
    method: 'POST',
    body: '{}',
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.headers.get('x-tray-status'), '308');
  assert.equal(moved.headers.get('x-tray-location'), 'https://www.sliccy.ai/join/new');
  await moved.arrayBuffer();
  const seat = await worker.dispatchFetch('https://www.sliccy.ai/7/api/tray/t1/biscotto/stop', {
    method: 'POST',
    body: '{"id":"g1"}',
  });
  assert.equal((await seat.json()).url, 'https://www.sliccy.ai/api/tray/t1/biscotto/stop');
  const socket = (
    await worker.dispatchFetch('https://www.sliccy.ai/7/controller/abc', {
      headers: { upgrade: 'websocket', cookie: 'ambient=1' },
    })
  ).webSocket;
  socket.accept();
  const reply = new Promise((resolve) =>
    socket.addEventListener('message', (event) => resolve(event.data))
  );
  socket.send('hello');
  assert.equal(await reply, '/controller/abc null hello');
  socket.close();
});

for (const path of [
  '/api/tray/t1/biscotto',
  '/api/tray/t1/biscotto/stop',
  '/api/tray/t1/supersede',
]) {
  test(`forwards POST ${path} to the hub`, async () => {
    const response = await worker.dispatchFetch(`https://seven.sliccy.ai${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer controller', 'content-type': 'application/json' },
      body: '{"id":"g1"}',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), {
      url: `https://www.sliccy.ai${path}`,
      method: 'POST',
      cookie: null,
      body: '{"id":"g1"}',
    });
  });
}

for (const path of [
  '/api/tray/t1/other',
  '/api/tray/t1/biscotto/stop/x',
  '/api/tray/t1/biscottox',
  '/api/tray/t1/biscotto/start',
  '/api/tray/t1/x/biscotto',
  '/api/tray/biscotto',
  '/api/tray/t1/biscotto/../other',
  '/api/tray/t1/biscotto/%2e%2e/other',
  '/api/tray/t1/biscotto%2Fstop',
]) {
  test(`does not forward POST ${path}`, async () => {
    const response = await worker.dispatchFetch(`https://seven.sliccy.ai${path}`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(response.status, 405);
  });
}

test('the guest-seat routes take POST only', async () => {
  for (const method of ['PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const response = await worker.dispatchFetch('https://seven.sliccy.ai/api/tray/t1/biscotto', {
      method,
      body: '{}',
    });
    assert.equal(response.status, 405);
  }
});

test('a GET of a guest-seat route never reaches the hub', async () => {
  const response = await worker.dispatchFetch('https://seven.sliccy.ai/api/tray/t1/biscotto');
  assert.equal(response.status, 404);
  await response.body?.cancel();
});

const answers = [
  ['GET', '/join/abc', 201],
  ['GET', '/controller/abc', 201],
  ['GET', '/tray', 201],
  ['GET', '/join/old', 200],
  ['GET', '/join/gone', 404],
  ['HEAD', '/join/abc', 201],
  ['POST', '/tray', 201],
  ['POST', '/api/tray/t1/biscotto', 201],
];
const policies = {
  '': [null, null],
  wide: ['default-src *; frame-ancestors *', 'ALLOWALL'],
  none: ["default-src 'self'; frame-ancestors 'none'", 'DENY'],
};

for (const [six, [csp, xfo]] of Object.entries(policies)) {
  test(`tray answers can only be framed by their own origin when six sends ${six || 'no'} frame headers`, async () => {
    for (const base of [
      'https://seven.sliccy.ai',
      'https://feat-x.sliccy.ai',
      'https://www.sliccy.ai/7',
    ]) {
      for (const [method, path, status] of answers) {
        const response = await worker.dispatchFetch(`${base}${path}`, {
          method,
          headers: six ? { 'x-six-frames': six } : {},
          body: method === 'POST' ? '{}' : undefined,
        });
        await response.arrayBuffer();
        const where = `${method} ${base}${path}`;
        assert.equal(response.status, status, where);
        assert.equal(
          response.headers.get('content-security-policy'),
          [csp, "frame-ancestors 'self'"].filter(Boolean).join(', '),
          where
        );
        assert.equal(
          response.headers.get('x-frame-options'),
          xfo === 'DENY' ? 'DENY' : 'SAMEORIGIN',
          where
        );
        assert.equal(response.headers.get('cache-control'), 'no-store', where);
        assert.equal(response.headers.get('set-cookie'), null, where);
      }
    }
  });
}

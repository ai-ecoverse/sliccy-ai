import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));

const hub = `export default {
  async fetch(request) {
    const url = new URL(request.url);
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
  },
};`;

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

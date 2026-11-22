import assert from 'node:assert/strict';
import { env } from 'node:process';
import { before, test } from 'node:test';
import WebSocket from 'ws';
import { deployed, get, override, version } from './live.mjs';

const api = 'https://seven.sliccy.ai/api/serve/host';
const branch = env.SLICCY_AI_STABLE
  ? 'a branch version at 0% runs no Durable Object: each one runs the version the deployment split assigns it, whatever the override header says'
  : false;

before(() => deployed('https://seven.sliccy.ai/'));

test('the serve hub API answers on seven.sliccy.ai from this worker', async () => {
  const listing = await get(api);
  assert.equal(listing.status, 405);
  assert.equal(listing.headers.get('allow'), 'POST');
  if (version) assert.equal(listing.headers.get('x-sliccy-ai-version'), version);
  const unknown = await get(`${api}/not-a-host/previews`);
  assert.equal((await unknown.json()).code, 'HOST_NOT_FOUND');
});

test('a publisher creates a host, holds its socket, and mints, lists and stops previews', {
  skip: branch,
}, async () => {
  const created = await get(api, { method: 'POST' });
  assert.equal(created.status, 201);
  const { hostId, secret } = await created.json();
  const call = (path, init = {}) =>
    get(`${api}/${hostId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${secret}`, ...init.headers },
    });
  const socket = new WebSocket(
    `wss://seven.sliccy.ai/api/serve/host/${hostId}/ws`,
    ['slicc-serve.v1', `bearer.${secret}`],
    { headers: override }
  );
  const hello = await new Promise((resolve, reject) => {
    socket.once('message', (data) => resolve(JSON.parse(String(data))));
    socket.once('error', reject);
  });
  assert.deepEqual(hello, { type: 'hello', hostId });
  assert.equal(socket.protocol, 'slicc-serve.v1');
  const mint = async (body) =>
    (
      await call('/previews', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).json();
  const live = await mint({ tag: 'live test' });
  assert.match(live.url, new RegExp(`^https://${hostId}-[0-9a-f]{32}\\.sliccy\\.now/$`));
  const snapshot = await mint({ ttlMs: 60_000 });
  const put = await call(`/previews/${snapshot.previewToken}/files/index.html`, {
    method: 'PUT',
    headers: { 'content-type': 'text/html', 'content-length': '5' },
    body: 'hello',
  });
  assert.deepEqual(await put.json(), { path: 'index.html', size: 5 });
  const ready = await (
    await call(`/previews/${snapshot.previewToken}/finalize`, { method: 'POST' })
  ).json();
  assert.equal(ready.state, 'ready');
  const { previews } = await (await call('/previews')).json();
  assert.deepEqual(
    previews.map(({ previewToken }) => previewToken).sort(),
    [live.previewToken, snapshot.previewToken].sort()
  );
  const revoked = new Promise((resolve) =>
    socket.on('message', (data) => {
      const message = JSON.parse(String(data));
      if (message.type === 'preview.revoked') resolve(message);
    })
  );
  await call(`/previews/${live.previewToken}`, { method: 'DELETE' });
  assert.equal((await revoked).previewToken, live.previewToken);
  await call(`/previews/${snapshot.previewToken}`, { method: 'DELETE' });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  assert.deepEqual(await (await call('', { method: 'DELETE' })).json(), { deleted: true });
  assert.equal(await closed, 4001);
  assert.equal((await call('/previews')).status, 410);
});

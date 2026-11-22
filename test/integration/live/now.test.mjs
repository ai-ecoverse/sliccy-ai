import assert from 'node:assert/strict';
import { env } from 'node:process';
import { before, test } from 'node:test';
import WebSocket from 'ws';
import { get, override, version } from './live.mjs';

const seven = 'https://seven.sliccy.ai';
const hubLabel = `https://${'0'.repeat(20)}-${'0'.repeat(32)}.sliccy.now/`;
const sixLabel = `https://${'a'.repeat(32)}--${'b'.repeat(20)}.sliccy.now/`;
const release = !env.SLICCY_AI_STABLE;
const state = { routed: false };

async function routed() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await get(hubLabel);
    const answered = response.headers.get('x-sliccy-ai-version');
    if (answered && (!version || answered === version)) return true;
    if (!answered && !release) return false;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}

before(async () => {
  state.routed = await routed();
});

const skip = (t) => {
  if (state.routed) return false;
  t.skip('*.sliccy.now still reaches slicc-preview, not this worker');
  return true;
};

const post = (url, body, headers = {}) =>
  get(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('the route reaches this worker after a release', () => {
  if (release) assert.equal(state.routed, true, `${hubLabel} isn't answered by this worker`);
});

test("a label in six's format gets six's own answer", async (t) => {
  if (skip(t)) return;
  const response = await get(sixLabel);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Preview not found');
  assert.equal(response.headers.get('x-sliccy-ai-version'), null);
});

test("a real six preview is served by six's hub, byte for byte", async (t) => {
  if (skip(t)) return;
  const tray = await (await post(`${seven}/tray`, {})).json();
  const token = tray.capabilities.controller.token;
  const path = new URL(tray.capabilities.controller.url).pathname;
  const controllerId = crypto.randomUUID();
  const { leaderKey } = await (
    await post(`${seven}${path}`, { controllerId, runtime: 'sliccy-ai-live' })
  ).json();
  const leader = new WebSocket(
    `wss://seven.sliccy.ai${path}?controllerId=${controllerId}&leaderKey=${leaderKey}`,
    { headers: override }
  );
  leader.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.type !== 'preview.request') return;
    leader.send(
      JSON.stringify({
        type: 'preview.response',
        reqId: message.reqId,
        ok: true,
        status: 200,
        mime: 'text/plain',
        encoding: 'utf-8',
        chunkIndex: 0,
        totalChunks: 1,
        content: `six ${message.vfsPath}`,
        size: 4 + message.vfsPath.length,
      })
    );
  });
  await new Promise((resolve, reject) => {
    leader.once('open', resolve);
    leader.once('error', reject);
  });
  const auth = { authorization: `Bearer ${token}` };
  try {
    const minted = await (
      await post(
        `${seven}/api/tray/${tray.trayId}/preview`,
        { servedRoot: '/srv/live', entryPath: '/srv/live/index.html', allowLive: true },
        auth
      )
    ).json();
    assert.match(minted.url, /^https:\/\/[0-9a-f]{32}--[0-9a-f]+\.sliccy\.now\/index\.html$/);
    const visited = await get(minted.url);
    assert.equal(visited.status, 200);
    assert.equal(await visited.text(), 'six /srv/live/index.html');
    assert.equal(visited.headers.get('x-sliccy-ai-version'), null);
    assert.match(visited.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    await post(
      `${seven}/api/tray/${tray.trayId}/preview/stop`,
      { previewToken: minted.previewToken },
      auth
    );
  } finally {
    leader.close();
  }
});

test("an unknown hub label is the hub's 404", async (t) => {
  if (skip(t)) return;
  const response = await get(hubLabel);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'preview not found');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  if (version) assert.equal(response.headers.get('x-sliccy-ai-version'), version);
});

test('a hub preview relays full HTTP to its publisher, and a snapshot is served', async (t) => {
  if (!release) return t.skip('a branch version at 0% runs no Durable Object of its own');
  if (skip(t)) return;
  const { hostId, secret } = await (
    await get(`${seven}/api/serve/host`, { method: 'POST' })
  ).json();
  const auth = { authorization: `Bearer ${secret}` };
  const call = (path, init = {}) =>
    get(`${seven}/api/serve/host/${hostId}${path}`, {
      ...init,
      headers: { ...auth, ...init.headers },
    });
  const socket = new WebSocket(`wss://seven.sliccy.ai/api/serve/host/${hostId}/ws`, {
    headers: { ...override, ...auth },
  });
  const seen = [];
  socket.on('message', (data, binary) => {
    if (binary) return;
    const message = JSON.parse(String(data));
    if (message.type !== 'http.request') return;
    seen.push(message);
    socket.send(
      JSON.stringify({
        type: 'http.response',
        id: message.id,
        status: 200,
        headers: [
          ['content-type', 'text/plain'],
          ['set-cookie', 'live=1; Domain=sliccy.now; Path=/'],
        ],
        body: true,
      })
    );
    const body = Buffer.from(`hub ${message.path}`);
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32BE(message.id, 0);
    body.copy(frame, 4);
    socket.send(frame);
    socket.send(JSON.stringify({ type: 'http.response.end', id: message.id }));
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  try {
    const mint = async (body) =>
      (await call('/previews', { method: 'POST', body: JSON.stringify(body) })).json();
    const live = await mint({});
    const visited = await get(`${live.url}a%20b?x=1`, { headers: { cookie: 'c=1' } });
    assert.equal(await visited.text(), 'hub /a%20b?x=1');
    assert.equal(visited.headers.get('set-cookie'), 'live=1; Path=/');
    const header = (name) => seen[0].headers.find(([key]) => key === name)?.[1];
    assert.equal(header('cookie'), 'c=1');
    assert.equal(header('cf-connecting-ip'), undefined);
    const snapshot = await mint({ ttlMs: 60_000 });
    await call(`/previews/${snapshot.previewToken}/files/index.html`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html', 'content-length': '8' },
      body: 'snapshot',
    });
    const ready = await (
      await call(`/previews/${snapshot.previewToken}/finalize`, { method: 'POST' })
    ).json();
    assert.equal(await (await get(ready.url)).text(), 'snapshot');
  } finally {
    await call('', { method: 'DELETE' });
    socket.close();
  }
});

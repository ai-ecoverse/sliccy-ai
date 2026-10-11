import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { deployed, get, override, version } from './live.mjs';

const seven = 'https://seven.sliccy.ai';

before(() => deployed(`${seven}/`));

test('a seven page becomes a tray leader on slicc-tray-hub through its own origin', async () => {
  const created = await get(`${seven}/tray`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(created.status, 201);
  if (version) assert.equal(created.headers.get('x-sliccy-ai-version'), version);
  const { capabilities } = await created.json();
  assert.match(capabilities.join.url, /^https:\/\/www\.sliccy\.ai\/join\//);
  const controller = new URL(capabilities.controller.url);
  assert.equal(controller.origin, 'https://www.sliccy.ai');
  const attached = await get(`${seven}${controller.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const attach = await attached.json();
  assert.equal(attach.role, 'leader');
  const leader = new URL(attach.websocket.url);
  assert.equal(leader.host, 'www.sliccy.ai');
  leader.host = 'seven.sliccy.ai';
  const socket = new WebSocket(leader, { headers: override });
  const first = await new Promise((resolve, reject) => {
    socket.addEventListener('message', (event) => resolve(JSON.parse(event.data)));
    socket.addEventListener('error', () => reject(new Error('the leader socket failed')));
  });
  assert.equal(first.type, 'leader.connected');
  socket.close();
});

test('a follower page joins the tray through its own origin', async () => {
  const created = await get(`${seven}/tray`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  const { capabilities } = await created.json();
  const join = new URL(capabilities.join.url);
  const attached = await get(`${seven}${join.pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime: 'slicc-seven/1' }),
  });
  assert.equal(attached.status, 200);
  if (version) assert.equal(attached.headers.get('x-sliccy-ai-version'), version);
  const answer = await attached.json();
  assert.equal(answer.role, 'follower');
  assert.equal(answer.result.code, 'LEADER_NOT_ELECTED');
});

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { deployed, get, override, version } from './live.mjs';

const host = 'https://echo.sliccy.ai/';

before(() => deployed(host));

test('wss://echo.sliccy.ai/ echoes text and binary through Cloudflare, with its public certificate', async () => {
  const plain = await get(host);
  assert.equal(plain.status, 426);
  if (version) assert.equal(plain.headers.get('x-sliccy-ai-version'), version);
  const { WebSocket } = await import('ws');
  const socket = new WebSocket('wss://echo.sliccy.ai/', ['echo'], { headers: override });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  assert.equal(socket.protocol, 'echo');
  const next = () =>
    new Promise((resolve) =>
      socket.once('message', (data, binary) => resolve([String(binary ? [...data] : data), binary]))
    );
  socket.send('hello');
  assert.deepEqual(await next(), ['hello', false]);
  socket.send(Buffer.from([1, 2, 3]));
  assert.deepEqual(await next(), ['1,2,3', true]);
  const closed = new Promise((resolve) => socket.once('close', (code) => resolve(code)));
  socket.close(1000, 'done');
  assert.equal(await closed, 1000);
});

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { env } from 'node:process';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const host = 'https://ntfy.sliccy.ai';
const post = (url, headers, body) =>
  get(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

const branch = env.SLICCY_AI_STABLE
  ? 'a branch version at 0% runs no Durable Object: each one runs the version the deployment split assigns it, whatever the override header says'
  : false;

before(() => deployed(`${host}/v1/health`));

test('ntfy.sliccy.ai answers its probes from this worker and refuses topics without a token', async () => {
  const health = await get(`${host}/v1/health`);
  assert.deepEqual(await health.json(), { healthy: true });
  if (version) assert.equal(health.headers.get('x-sliccy-ai-version'), version);
  assert.equal((await get(`${host}/github/json?poll=1`)).status, 401);
});

test('a real tray leader claims a home, and a signed webhook reaches its subscribers', {
  skip: branch,
}, async () => {
  const tray = await post('https://seven.sliccy.ai/tray', {}, '{}');
  assert.equal(tray.status, 201);
  const { capabilities } = await tray.json();
  const controllerToken = new URL(capabilities.controller.url).pathname.split('/').at(-1);
  const refused = await post(
    `${host}/api/home`,
    {},
    JSON.stringify({ controllerToken: `${controllerToken.split('.')[0]}.forged` })
  );
  assert.equal(refused.status, 403);
  const claimed = await post(`${host}/api/home`, {}, JSON.stringify({ controllerToken }));
  assert.equal(claimed.status, 201);
  const { homeId, ownerSecret } = await claimed.json();
  const owner = { authorization: `Bearer ${ownerSecret}` };
  try {
    const minted = await post(
      `${host}/api/home/${homeId}/tokens`,
      owner,
      JSON.stringify({ label: 'live test', member: 'kernel', scopes: ['subscribe', 'hooks'] })
    );
    const { token } = await minted.json();
    const auth = { authorization: `Bearer ${token}` };
    const created = await post(
      `${host}/api/hooks`,
      auth,
      JSON.stringify({ name: 'github', secret: 'live-test-secret' })
    );
    const { url } = await created.json();
    const payload = JSON.stringify({ zen: 'Keep it logically awesome.', pad: 'z'.repeat(60_000) });
    const signature = createHmac('sha256', 'live-test-secret').update(payload).digest('hex');
    const delivered = await post(
      url,
      { 'x-github-event': 'ping', 'x-hub-signature-256': `sha256=${signature}` },
      payload
    );
    assert.equal(delivered.status, 200);
    const polled = await get(`${host}/github/json?poll=1`, { headers: auth });
    const [message] = (await polled.text()).split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(message.title, 'ping');
    assert.equal(message.verified, true);
    const file = await get(message.attachment.url);
    assert.equal(await file.text(), payload);
  } finally {
    const deleted = await get(`${host}/api/home/${homeId}`, { method: 'DELETE', headers: owner });
    assert.equal(deleted.status, 204);
  }
});

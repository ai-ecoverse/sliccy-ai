import assert from 'node:assert/strict';
import { env } from 'node:process';
import { before, test } from 'node:test';
import { deployed, get } from './live.mjs';

const route = 'https://seven.sliccy.ai/api/publish/manifest';

before(() => deployed('https://seven.sliccy.ai/'));

test('the publish route refuses a request without a token', async () => {
  const response = await get(route);
  assert.equal(response.status, 401);
});

test("the publish route checks a real GitHub Actions token, and refuses this repository's", {
  skip: !env.ACTIONS_ID_TOKEN_REQUEST_URL,
}, async () => {
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  url.searchParams.set('audience', 'https://sliccy.ai');
  const issued = await fetch(url, {
    headers: { authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  });
  const { value } = await issued.json();
  const response = await get(route, { headers: { authorization: `Bearer ${value}` } });
  assert.deepEqual(
    [response.status, (await response.json()).error],
    [403, 'not from ai-ecoverse/slicc-bios']
  );
  const tampered = `${value.slice(0, -4)}AAAA`;
  const forged = await get(route, { headers: { authorization: `Bearer ${tampered}` } });
  assert.deepEqual([forged.status, (await forged.json()).error], [401, 'bad signature']);
});

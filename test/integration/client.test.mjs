import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const [{ binding }] = config.r2_buckets;

const upstream = [];
const worker = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: fileURLToPath(new URL(config.main, root)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [binding],
  bindings: { [config.version_metadata.binding]: { id: 'local' } },
  serviceBindings: {
    [config.services[0].binding]: (request) => {
      upstream.push(request.url);
      return new Response('six', { headers: { 'content-type': 'text/html' } });
    },
  },
});
after(() => worker.dispose());

const bucket = await worker.getR2Bucket(binding);
await bucket.put('seven/oauth/client.json', '{"client_id":"published"}');
await bucket.put('branches/feat-shell.json', '{"branch":"feat/shell","files":[]}');
await bucket.put('branches/feat-shell/oauth/client.json', '{"client_id":"published"}');
await bucket.put('vault/main/oauth/client.json', '{"vault":"main"}');
await bucket.put('vault/branches/x/oauth/client.json', '{"vault":"x"}');

const get = (url, init) => worker.dispatchFetch(url, { redirect: 'manual', ...init });
const path = '/oauth/client.json';

const documentAt = (origin) =>
  JSON.stringify(
    {
      client_id: `${origin}/oauth/client.json`,
      client_name: 'SLICC',
      redirect_uris: [`${origin}/oauth/mcp-callback`],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'web',
    },
    null,
    2
  );

const origins = [
  'https://seven.sliccy.ai',
  'https://feat-shell.sliccy.ai',
  'https://www.sliccy.ai/7',
];

function assertServed(response) {
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('x-sliccy-ai-version'), 'local');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('etag'), null);
}

for (const origin of origins) {
  test(`${origin} answers its own document, whose client_id is its own URL`, async () => {
    const response = await get(`${origin}${path}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assertServed(response);
    assert.equal(await response.text(), documentAt(origin));
  });

  test(`${origin} keeps the query out of the document`, async () => {
    const response = await get(`${origin}${path}?client_id=https://evil.example/`);
    assert.equal(await response.text(), documentAt(origin));
  });

  test(`${origin} answers HEAD with the headers and no body`, async () => {
    const response = await get(`${origin}${path}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assertServed(response);
    assert.equal(await response.text(), '');
  });

  test(`${origin} answers other methods 405`, async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await get(`${origin}${path}`, { method });
      assert.equal(response.status, 405, method);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
      assertServed(response);
      assert.equal(await response.text(), '');
    }
  });
}

test('the document is the https one when the request came over http', async () => {
  const response = await get(`http://seven.sliccy.ai${path}`);
  assert.equal(await response.text(), documentAt('https://seven.sliccy.ai'));
});

test('www/7 answers from the worker and never reaches six', async () => {
  upstream.length = 0;
  await (await get(`https://www.sliccy.ai/7${path}`)).arrayBuffer();
  assert.deepEqual(upstream, []);
});

test('a label nobody published keeps its 404, and writes their 405', async () => {
  const response = await get(`https://nobody.sliccy.ai${path}`);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'not found');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const write = await get(`https://nobody.sliccy.ai${path}`, { method: 'POST', body: 'x' });
  await write.arrayBuffer();
  assert.equal(write.status, 405);
  assert.equal(write.headers.get('content-security-policy'), "frame-ancestors 'self'");
});

test('vault hosts keep serving their own files', async () => {
  for (const [host, body] of [
    ['vault', '{"vault":"main"}'],
    ['vault-preview', '{"vault":"main"}'],
    ['vault-x', '{"vault":"x"}'],
  ]) {
    const response = await get(`https://${host}.sliccy.ai${path}`);
    assert.equal(response.status, 200, host);
    assert.equal(await response.text(), body);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
  }
  const missing = await get(`https://vault-y.sliccy.ai${path}`);
  await missing.arrayBuffer();
  assert.equal(missing.status, 404);
});

test('service hosts keep their own answers', async () => {
  const mcpcat = await (await get(`https://mcpcat.sliccy.ai${path}`)).json();
  assert.equal(mcpcat.client_id, `https://mcpcat.sliccy.ai${path}`);
  assert.equal(mcpcat.client_name, 'mcpcat');
  for (const host of ['get', 'echo']) {
    const response = await get(`https://${host}.sliccy.ai${path}`);
    assert.equal(response.status, 404, host);
    assert.doesNotMatch(await response.text(), /client_id/);
  }
  const ntfy = await get(`https://ntfy.sliccy.ai${path}`);
  assert.equal(ntfy.status, 401);
  assert.doesNotMatch(await ntfy.text(), /client_id/);
});

test('every other www path keeps its answer', async () => {
  upstream.length = 0;
  for (const other of [path, `/70${path}`, `/status${path}`]) {
    const response = await get(`https://www.sliccy.ai${other}`);
    assert.equal(await response.text(), 'six', other);
    assert.equal(response.headers.get('content-security-policy'), null, other);
  }
  assert.deepEqual(upstream, [
    `https://www.sliccy.ai${path}`,
    `https://www.sliccy.ai/70${path}`,
    `https://www.sliccy.ai/status${path}`,
  ]);
  for (const other of [`/os${path}`, `/7/nested${path}`, `/7${path}/`]) {
    const response = await get(`https://www.sliccy.ai${other}`);
    assert.equal(response.status, 404, other);
    assert.equal(await response.text(), 'not found', other);
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
  }
});

test('only the exact path is the document on seven hosts', async () => {
  for (const other of [`${path}/`, `/nested${path}`, '/oauth/client.jsonx']) {
    const response = await get(`https://seven.sliccy.ai${other}`);
    assert.equal(response.status, 404, other);
    assert.equal(await response.text(), 'not found', other);
  }
});

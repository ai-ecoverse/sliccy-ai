import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const [{ binding }] = config.r2_buckets;

const pair = await crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify']
);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'live' };
const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
async function sign(claims) {
  const head = b64(JSON.stringify({ alg: 'RS256', kid: 'live', typ: 'JWT' }));
  const body = b64(JSON.stringify(claims));
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`)
  );
  return `${head}.${body}.${b64(new Uint8Array(signature))}`;
}
const now = Math.floor(Date.now() / 1000);
const claims = (ref) => ({
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'https://sliccy.ai',
  repository: 'ai-ecoverse/slicc-bios',
  repository_owner: 'ai-ecoverse',
  ref,
  iat: now,
  nbf: now,
  exp: now + 300,
});

const outbound = [];
const worker = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: fileURLToPath(new URL(config.main, root)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [binding],
  bindings: { [config.version_metadata.binding]: { id: 'local' } },
  serviceBindings: { [config.services[0].binding]: () => new Response('', { status: 404 }) },
  outboundService: (request) => {
    outbound.push(request.url);
    return new Response(JSON.stringify({ keys: [jwk] }), {
      headers: { 'content-type': 'application/json' },
    });
  },
});
after(() => worker.dispose());
const bucket = await worker.getR2Bucket(binding);

test('a slicc-bios branch publishes through the route in workerd, and the router serves it', async () => {
  const token = await sign(claims('refs/heads/feat/edge'));
  const auth = { authorization: `Bearer ${token}` };
  const put = await worker.dispatchFetch('https://seven.sliccy.ai/api/publish/files/index.html', {
    method: 'PUT',
    headers: { ...auth, 'content-length': '24' },
    body: '<!doctype html><b>b</b>\n',
  });
  assert.equal(put.status, 200);
  const manifest = await worker.dispatchFetch('https://seven.sliccy.ai/api/publish/manifest', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ files: ['index.html'] }),
  });
  assert.deepEqual(await manifest.json(), {
    label: 'feat-edge',
    url: 'https://feat-edge.sliccy.ai/',
  });
  assert.deepEqual(await (await bucket.get('branches/feat-edge.json')).json(), {
    branch: 'feat/edge',
    files: ['index.html'],
  });
  const served = await worker.dispatchFetch('https://feat-edge.sliccy.ai/');
  assert.equal(await served.text(), '<!doctype html><b>b</b>\n');
  assert.deepEqual(outbound, ['https://token.actions.githubusercontent.com/.well-known/jwks']);
  const main = await worker.dispatchFetch('https://seven.sliccy.ai/api/publish/files/index.html', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${await sign(claims('refs/heads/main'))}`,
      'content-length': '1',
    },
    body: 'x',
  });
  assert.equal(main.status, 403);
  assert.equal(await bucket.get('seven/index.html'), null);
  const gateway = await worker.dispatchFetch(
    'https://seven.sliccy.ai/api/publish/files/index.html',
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${await sign(claims('refs/heads/ntfy'))}`,
        'content-length': '1',
      },
      body: 'x',
    }
  );
  assert.equal(gateway.status, 403);
  assert.equal(await bucket.get('branches/ntfy/index.html'), null);
});

const pullClaims = (overrides = {}) => ({
  ...claims('refs/pull/42/merge'),
  event_name: 'pull_request',
  environment: 'staging',
  head_ref: 'feat/pull-preview',
  base_ref: 'main',
  ...overrides,
});
const putFile = async (fields, body = 'x') =>
  worker.dispatchFetch('https://seven.sliccy.ai/api/publish/files/index.html', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${await sign(fields)}`,
      'content-length': String(body.length),
    },
    body,
  });
const putManifest = async (fields) =>
  worker.dispatchFetch('https://seven.sliccy.ai/api/publish/manifest', {
    method: 'PUT',
    headers: { authorization: `Bearer ${await sign(fields)}` },
    body: JSON.stringify({ files: ['index.html'] }),
  });

test('a slicc-bios pull request publishes the preview of its head_ref, as its branch push does', async () => {
  const put = await putFile(pullClaims(), 'pr');
  assert.equal(put.status, 200);
  assert.equal(await (await bucket.get('branches/feat-pull-preview/index.html')).text(), 'pr');
  const manifest = await putManifest(pullClaims());
  assert.deepEqual(await manifest.json(), {
    label: 'feat-pull-preview',
    url: 'https://feat-pull-preview.sliccy.ai/',
  });
  assert.deepEqual(await (await bucket.get('branches/feat-pull-preview.json')).json(), {
    branch: 'feat/pull-preview',
    files: ['index.html'],
  });
  const pushed = await putFile(claims('refs/heads/feat/pull-preview'), 'push');
  assert.equal(pushed.status, 200);
  const other = await putFile(pullClaims({ head_ref: 'feat-pull-preview' }));
  assert.equal(other.status, 409);
  assert.equal(await (await bucket.get('branches/feat-pull-preview/index.html')).text(), 'push');
});

test('a slicc-vault pull request publishes to vault/branches/<label>/ from its head_ref', async () => {
  const vault = { repository: 'ai-ecoverse/slicc-vault', head_ref: 'feat/vault-pr' };
  const put = await putFile(pullClaims(vault), 'vault pr');
  assert.equal(put.status, 200);
  assert.equal(
    await (await bucket.get('vault/branches/feat-vault-pr/index.html')).text(),
    'vault pr'
  );
  const manifest = await putManifest(pullClaims(vault));
  assert.deepEqual(await manifest.json(), {
    label: 'vault-feat-vault-pr',
    url: 'https://vault-feat-vault-pr.sliccy.ai/',
  });
  const pushed = await putFile(
    pullClaims({ ref: 'refs/heads/feat/push-only', head_ref: 'main', event_name: 'push' })
  );
  assert.equal(pushed.status, 200);
  assert.ok(await bucket.get('branches/feat-push-only/index.html'));
  const vaultMain = await putFile(
    {
      ...claims('refs/heads/main'),
      repository: 'ai-ecoverse/slicc-vault',
      environment: 'production',
    },
    'prod'
  );
  assert.equal(vaultMain.status, 200);
  assert.equal(await (await bucket.get('vault/main/index.html')).text(), 'prod');
});

test('pull request tokens with any other claim are refused, and never reach seven/ or vault/main/', async () => {
  const vault = 'ai-ecoverse/slicc-vault';
  const refused = [
    { event_name: 'push' },
    { event_name: 'pull_request_target' },
    { event_name: undefined },
    { environment: 'production' },
    { environment: 'preview' },
    { environment: undefined },
    { ref: 'refs/pull/42/head' },
    { ref: 'refs/pull/x/merge' },
    { ref: 'refs/pull/42/merge/x' },
    { ref: 'refs/tags/v1' },
    { repository_owner: 'someone' },
    { repository: 'ai-ecoverse/sliccy-ai' },
    { repository: 'someone/slicc-bios', repository_owner: 'someone' },
    { head_ref: undefined },
    { head_ref: '' },
    { head_ref: 42 },
    { head_ref: 'main' },
    { head_ref: 'seven' },
    { head_ref: 'www' },
    { head_ref: 'vault' },
    { head_ref: 'vault-x' },
    { head_ref: 'get' },
    { head_ref: 'ntfy' },
    { head_ref: 'mcpcat' },
    { head_ref: '---' },
    { repository: vault, head_ref: 'main' },
    { repository: vault, head_ref: 'main', environment: 'production' },
    { repository: vault, head_ref: 'preview' },
    { repository: vault, event_name: 'push', environment: 'production', head_ref: 'main' },
  ];
  const baseline = await putFile(pullClaims({ head_ref: 'feat/baseline' }));
  assert.equal(baseline.status, 200);
  for (const fields of refused) {
    const response = await putFile(pullClaims(fields));
    assert.equal(response.status, 403, JSON.stringify(fields));
  }
  assert.equal(await bucket.get('seven/index.html'), null);
  assert.equal(await (await bucket.get('vault/main/index.html')).text(), 'prod');
  for (const name of ['www', 'vault', 'vault-x', 'get', 'ntfy', 'mcpcat'])
    assert.equal(await bucket.get(`branches/${name}/index.html`), null);
  assert.equal(await bucket.get('vault/branches/preview/index.html'), null);
});

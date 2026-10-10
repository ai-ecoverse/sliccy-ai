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
});

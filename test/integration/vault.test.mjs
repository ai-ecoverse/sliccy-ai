import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const [{ binding }] = config.r2_buckets;

const worker = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: fileURLToPath(new URL(config.main, root)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [binding],
  bindings: { [config.version_metadata.binding]: { id: 'local' } },
  serviceBindings: { [config.services[0].binding]: () => new Response(null, { status: 404 }) },
});
after(() => worker.dispose());

const HEADER_BUDGET = 6144;
const longest = (prefix) => prefix.padEnd(63, 'x');

const bucket = await worker.getR2Bucket(binding);
await bucket.put('vault/main/index.html', '<!doctype html><title>vault</title>');
await bucket.put(`branches/${longest('stale')}.json`, '{"branch":"stale","files":[]}');
await sleep(20);
for (let i = 0; i < 400; i++) {
  await bucket.put(`branches/${longest(`b${i}-`)}.json`, '{"files":[]}');
}
await sleep(20);
await bucket.put(`branches/${longest('fresh')}.json`, '{"branch":"fresh","files":[]}');
await bucket.put(`branches/${longest('renovate-x')}.json`, '{"files":[]}');
await bucket.put(`branches/${longest('gh-readonly-queue-main-pr-1-')}.json`, '{"files":[]}');

const headerBytes = (response) =>
  [...response.headers].reduce((sum, [name, value]) => sum + name.length + value.length + 4, 0);

test('the preview vault lists a bounded set of the most recently published previews, under a fixed header budget', async () => {
  for (const host of ['vault-preview', 'vault-some-branch']) {
    const response = await worker.dispatchFetch(`https://${host}.sliccy.ai/embedders.json`);
    const { embedders } = await response.json();
    assert.ok(headerBytes(response) < HEADER_BUDGET, String(headerBytes(response)));
    const csp = response.headers.get('content-security-policy');
    const frames = csp.split('; ').find((part) => part.startsWith('frame-ancestors '));
    assert.equal(frames, `frame-ancestors ${embedders.join(' ')}`);
    assert.equal(embedders.length, 48 + 2);
    assert.equal(embedders[0], `https://${longest('fresh')}.sliccy.ai`);
    assert.ok(!embedders.includes(`https://${longest('stale')}.sliccy.ai`));
    assert.ok(embedders.every((origin) => !origin.includes('renovate-')));
    assert.ok(embedders.every((origin) => !origin.includes('gh-readonly-queue-')));
    assert.ok(!embedders.includes('https://seven.sliccy.ai'));
    assert.deepEqual(embedders.slice(-2), ['http://localhost:*', 'http://127.0.0.1:*']);
    assert.ok(
      embedders.slice(0, -2).every((origin) => /^https:\/\/[a-z0-9-]+\.sliccy\.ai$/.test(origin))
    );
  }
});

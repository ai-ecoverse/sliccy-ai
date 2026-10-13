import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { before, test } from 'node:test';
import { deployed, get, version } from './live.mjs';

const host = 'https://get.sliccy.ai';

before(() => deployed(`${host}/`));

test('get.sliccy.ai answers from this worker, and its jerk one-liner runs the real installer', async () => {
  const index = await get(`${host}/`);
  assert.equal(index.status, 200);
  if (version) assert.equal(index.headers.get('x-sliccy-ai-version'), version);
  assert.match(await index.text(), /curl -fsSL https:\/\/get\.sliccy\.ai\/jerk \| sh/);
  const moved = await get(`${host}/slicc`, { redirect: 'manual' });
  assert.equal(moved.status, 302);
  assert.match(
    moved.headers.get('location'),
    /^https:\/\/github\.com\/ai-ecoverse\/slicc-cli\/releases\/latest\/download\/install\.sh$/
  );
  const header = version
    ? ` -H 'cloudflare-workers-version-overrides: sliccy-ai="${version}"'`
    : '';
  const help = execFileSync('sh', ['-c', `curl -fsSL${header} ${host}/jerk | sh -s -- --help`], {
    encoding: 'utf8',
  });
  assert.match(help, /Usage: install\.sh/);
  const cdp = execFileSync(
    'sh',
    ['-c', `curl -fsSL${header} ${host}/playwright-cli | sh -s -- --help`],
    { encoding: 'utf8' }
  );
  assert.match(cdp, /--only/);
});

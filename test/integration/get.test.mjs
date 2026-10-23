import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));

const worker = new Miniflare({
  modules: true,
  modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
  scriptPath: fileURLToPath(new URL(config.main, root)),
  compatibilityDate: config.compatibility_date,
  r2Buckets: [config.r2_buckets[0].binding],
  bindings: { [config.version_metadata.binding]: { id: 'local' } },
  serviceBindings: { [config.services[0].binding]: () => new Response('six') },
});
after(() => worker.dispose());

const get = (path, init) =>
  worker.dispatchFetch(`https://get.sliccy.ai${path}`, { redirect: 'manual', ...init });
const releases = (repo) => `https://github.com/ai-ecoverse/${repo}/releases`;
const ps1 = (repo) => `${releases(repo)}/latest/download/install.ps1`;
const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0;

function headers(response) {
  assert.equal(response.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'max-age=300');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'");
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
}

test('a single-repo tool answers a PowerShell script that runs its latest install.ps1', async () => {
  const response = await get('/slicc.ps1');
  assert.equal(response.status, 200);
  headers(response);
  const script = await response.text();
  assert.ok(script.includes(`Invoke-RestMethod '${ps1('slicc-cli')}'`));
  assert.ok(script.includes('[int]$_.Exception.Response.StatusCode -ne 404'));
  assert.ok(
    script.includes(`throw 'slicc is not available for Windows yet; see ${releases('slicc-cli')}'`)
  );
  assert.ok(script.includes('& ([scriptblock]::Create($installer)) @args'));
  assert.doesNotMatch(script, /-Only/);
});

test('a multi-tool repo passes the same --only selection as -Only', async () => {
  for (const tool of ['playwright-cli', 'curlwright']) {
    const response = await get(`/${tool}.ps1`);
    assert.equal(response.status, 200);
    headers(response);
    const script = await response.text();
    assert.ok(script.includes(`Invoke-RestMethod '${ps1('slicc-cdp')}'`));
    assert.ok(
      script.includes(
        `throw '${tool} is not available for Windows yet; see ${releases('slicc-cdp')}'`
      )
    );
    assert.ok(script.includes(`& ([scriptblock]::Create($installer)) -Only ${tool} @args`));
  }
});

test('every tool has a PowerShell answer, and HEAD has no body', async () => {
  for (const tool of [
    'slicc',
    'jerk',
    'mcpcat',
    'open',
    'slicc-capture',
    'playwright-cli',
    'curlwright',
  ]) {
    const response = await get(`/${tool}.ps1`, { method: 'HEAD' });
    assert.equal(response.status, 200, tool);
    headers(response);
    assert.equal(await response.text(), '');
  }
});

test('the index lists the PowerShell one-liner next to each sh one-liner', async () => {
  const response = await get('/');
  headers(response);
  const text = await response.text();
  for (const tool of [
    'slicc',
    'jerk',
    'mcpcat',
    'open',
    'slicc-capture',
    'playwright-cli',
    'curlwright',
  ])
    assert.ok(
      text.includes(
        `  curl -fsSL https://get.sliccy.ai/${tool} | sh\n  irm https://get.sliccy.ai/${tool}.ps1 | iex\n`
      ),
      tool
    );
});

test('unknown .ps1 paths are 404s, and only GET and HEAD are answered', async () => {
  for (const path of [
    '/nothing.ps1',
    '/.ps1',
    '/slicc.ps1.ps1',
    '/slicc.PS1',
    '/hasOwnProperty.ps1',
  ]) {
    const response = await get(path);
    assert.equal(response.status, 404, path);
    headers(response);
    await response.arrayBuffer();
  }
  const post = await get('/slicc.ps1', { method: 'POST', body: 'x' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  await post.arrayBuffer();
});

test('the sh answers are unchanged', async () => {
  const moved = await get('/slicc');
  assert.equal(moved.status, 302);
  assert.equal(
    moved.headers.get('location'),
    `${releases('slicc-cli')}/latest/download/install.sh`
  );
  await moved.arrayBuffer();
  assert.match(await (await get('/curlwright')).text(), /\| sh -s -- --only curlwright "\$@"/);
});

test('every PowerShell answer parses', { skip: !pwsh && 'no pwsh' }, async () => {
  for (const tool of ['slicc', 'curlwright']) {
    const script = await (await get(`/${tool}.ps1`)).text();
    const check =
      '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:SCRIPT, [ref]$null, [ref]$e); exit $e.Count';
    const result = spawnSync('pwsh', ['-NoProfile', '-Command', check], {
      env: { ...process.env, SCRIPT: script },
    });
    assert.equal(result.status, 0, tool);
  }
});

test('open installs slicc-open from its latest release, on sh and on Windows', async () => {
  const moved = await get('/open');
  assert.equal(moved.status, 302);
  assert.equal(
    moved.headers.get('location'),
    `${releases('slicc-open')}/latest/download/install.sh`
  );
  await moved.arrayBuffer();
  const windows = await get('/open.ps1');
  assert.equal(windows.status, 200);
  headers(windows);
  const script = await windows.text();
  assert.ok(script.includes(`Invoke-RestMethod '${ps1('slicc-open')}'`));
  assert.doesNotMatch(script, /-Only/);
});

test('slicc-capture installs from its latest release, on sh and on Windows', async () => {
  const moved = await get('/slicc-capture');
  assert.equal(moved.status, 302);
  assert.equal(
    moved.headers.get('location'),
    `${releases('slicc-capture')}/latest/download/install.sh`
  );
  await moved.arrayBuffer();
  const windows = await get('/slicc-capture.ps1');
  assert.equal(windows.status, 200);
  headers(windows);
  const script = await windows.text();
  assert.ok(script.includes(`Invoke-RestMethod '${ps1('slicc-capture')}'`));
  assert.doesNotMatch(script, /-Only/);
});

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { env } from 'node:process';
import { after, test } from 'node:test';
import { commit, initFixtureRepo } from '@ai-ecoverse/slicc-shared-web/testing';

const script = new URL('../../scripts/deploy.mjs', import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), 'sliccy-deploy-'));
after(() => rmSync(root, { recursive: true, force: true }));

const fake = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const file = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const out = (entry) => appendFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify(entry) + '\\n');
const flag = (name) => args[args.indexOf(name) + 1];
const [command, sub] = args;
if (command === 'deployments') {
  process.stdout.write(JSON.stringify(state.deployments.slice(-10)));
} else if (command === 'versions' && sub === 'view') {
  process.stdout.write(JSON.stringify(state.versions.find((v) => v.id === args[2]) ?? {}));
} else if (command === 'versions' && sub === 'list') {
  process.stdout.write(JSON.stringify(state.versions.slice(-10)));
} else if (command === 'deploy') {
  const id = 'deployed-' + state.versions.length;
  state.versions.push({ id, annotations: { 'workers/tag': flag('--tag') } });
  state.deployments.push({ id: 'deployment-' + state.deployments.length, versions: [{ version_id: id, percentage: 100 }], annotations: { 'workers/message': flag('--message') } });
  out({ type: 'deploy', version_id: id });
} else if (command === 'versions' && sub === 'upload') {
  const id = 'branch-' + state.versions.length;
  state.versions.push({ id, annotations: { 'workers/tag': flag('--tag') } });
  out({ type: 'version-upload', version_id: id });
  if (state.uploadInject) state.deployments.push(state.uploadInject);
} else if (command === 'versions' && sub === 'deploy') {
  const traffic = [];
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === '--version-tag') {
      process.stderr.write('No deployable version found with tag ' + args[i + 1] + '\\n');
      process.exit(1);
    } else if (args[i] === '--message') {
      i += 1;
    } else if (args[i].includes('@')) {
      const [version_id, percentage] = args[i].split('@');
      traffic.push({ version_id, percentage: Number.parseInt(percentage, 10) });
    }
  }
  const id = 'deployment-' + state.deployments.length;
  state.deployments.push({ id, versions: traffic, annotations: { 'workers/message': flag('--message') } });
  out({ type: 'version-deploy', deployment_id: id });
  const late = state.inject?.shift();
  if (late) state.deployments.push(late);
}
writeFileSync(file, JSON.stringify(state));
`;

const liveWrites = `import { readFileSync, writeFileSync } from 'node:fs';
const file = process.env.FAKE_STATE;
const state = JSON.parse(readFileSync(file, 'utf8'));
state.deployments.push(...JSON.parse(process.env.FAKE_LIVE_WRITES ?? '[]'));
writeFileSync(file, JSON.stringify(state));
`;

let count = 0;

function setup({ tags, versions, inject = [], live = 'release-new' }) {
  count += 1;
  const dir = join(root, String(count));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  initFixtureRepo(repo, { hooks: false });
  writeFileSync(join(repo, 'README'), 'fixture\n');
  execFileSync('git', ['add', 'README'], { cwd: repo });
  commit(repo, 'fixture');
  for (const tag of tags) execFileSync('git', ['tag', tag], { cwd: repo });
  const wrangler = join(dir, 'wrangler.mjs');
  writeFileSync(join(dir, 'live.mjs'), liveWrites);
  writeFileSync(wrangler, fake);
  chmodSync(wrangler, 0o755);
  const deployments = Array.from({ length: 10 }, (_, i) => ({
    id: `history-${i}`,
    versions: [{ version_id: live, percentage: 100 }],
    annotations: { 'workers/message': `post-deploy tests for ${90 + i}/merge abc${i} done` },
  }));
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ deployments, versions, inject }));
  return { repo, wrangler, state, dir };
}

function run({ repo, wrangler, state, dir }, { mode = 'branch', ...extra } = {}) {
  const { GITHUB_STEP_SUMMARY: _summary, GITHUB_EVENT_PATH: _event, ...rest } = env;
  const result = spawnSync('node', [script, mode], {
    encoding: 'utf8',
    env: {
      ...rest,
      FAKE_STATE: state,
      SLICCY_AI_DEPLOY_TOKEN: 'fake',
      SLICCY_AI_WRANGLER: wrangler,
      SLICCY_AI_LIVE: `node ${join(dir, 'live.mjs')}`,
      SLICCY_AI_GIT_REMOTE: repo,
      GITHUB_REF_NAME: '76/merge',
      GITHUB_REPOSITORY: 'ai-ecoverse/sliccy-ai',
      GITHUB_SHA: 'feedfacecafebeef',
      ...extra,
    },
  });
  const { deployments, versions } = JSON.parse(readFileSync(state, 'utf8'));
  return { result, latest: deployments.at(-1), deployments, versions };
}

const released = [
  { id: 'release-old', annotations: { 'workers/tag': 'v1.9.0' } },
  { id: 'release-new', annotations: { 'workers/tag': 'v1.10.0' } },
];

test('with the release gone from the deployment history, the newest v* tag is what ends at 100%', () => {
  const { result, latest } = run(setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(latest.versions, [{ version_id: 'release-new', percentage: 100 }]);
});

test('the branch version runs next to the newest tag, never next to an older release', () => {
  const { deployments } = run(setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released }));
  const split = deployments.find((deployment) => deployment.versions.length === 2);
  assert.equal(split.versions[0].version_id, 'release-new');
  assert.equal(split.versions[1].percentage, 0);
});

test('a newest tag with no deployable version fails, and no older release is put back', () => {
  const { result, deployments } = run(
    setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released.slice(0, 1), live: 'release-old' })
  );
  assert.notEqual(result.status, 0);
  assert.equal(deployments.length, 10);
  assert.match(
    result.stdout,
    /no deployable version has the tag v1\.10\.0.*wrangler versions deploy release-old@100%/
  );
});

test('a rollback by hand that left the history fails the deploy and changes no traffic', () => {
  const fixture = setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released, live: 'release-old' });
  const before = JSON.parse(readFileSync(fixture.state, 'utf8'));
  const { result, deployments, versions } = run(fixture);
  assert.equal(result.status, 1);
  assert.deepEqual(deployments, before.deployments);
  assert.deepEqual(versions, before.versions);
  assert.match(
    result.stdout,
    /::error title=Deploy::release-old \(v1\.9\.0\) is at 100%, not the newest tag v1\.10\.0/
  );
  assert.match(
    result.stdout,
    /wrangler versions deploy release-old@100% -y --message "hold release-old"/
  );
});

test('a rollback by hand during the upload is the version the branch runs next to and leaves live', () => {
  const fixture = setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released });
  const state = JSON.parse(readFileSync(fixture.state, 'utf8'));
  state.uploadInject = {
    id: 'rollback',
    versions: [{ version_id: 'release-old', percentage: 100 }],
    annotations: { 'workers/message': 'rollback by hand' },
  };
  writeFileSync(fixture.state, JSON.stringify(state));
  const { result, deployments } = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  const split = deployments.find((deployment) => deployment.versions.length === 2);
  assert.equal(split.versions[0].version_id, 'release-old');
  assert.deepEqual(deployments.at(-1).versions, [{ version_id: 'release-old', percentage: 100 }]);
});

test('a rollback by hand that this run evicts from the history stays live', () => {
  const fixture = setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released, live: 'release-old' });
  const state = JSON.parse(readFileSync(fixture.state, 'utf8'));
  state.deployments[0].annotations['workers/message'] = 'manual rollback';
  writeFileSync(fixture.state, JSON.stringify(state));
  const { result, deployments } = run(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!deployments.slice(-10).some((deployment) => deployment.id === 'history-0'));
  assert.ok(
    deployments.slice(10).every((deployment) => deployment.versions[0].version_id === 'release-old')
  );
  assert.deepEqual(deployments.at(-1).versions, [{ version_id: 'release-old', percentage: 100 }]);
});

const staleWrites = (version) =>
  JSON.stringify(
    Array.from({ length: 10 }, (_, i) => ({
      id: `stale-${i}`,
      versions: [{ version_id: version, percentage: 100 }],
      annotations: { 'workers/message': `post-deploy tests for 77/merge abc${i} done` },
    }))
  );

test('a release that lands after the split stays live once branch writes push it out of the history', () => {
  const release = {
    id: 'release-mid-run',
    versions: [{ version_id: 'release-newer', percentage: 100 }],
    annotations: { 'workers/message': 'release v1.11.0' },
  };
  const fixture = setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released, inject: [release] });
  const { result, deployments } = run(fixture, { FAKE_LIVE_WRITES: staleWrites('release-new') });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!deployments.slice(-10).some((deployment) => deployment.id === 'release-mid-run'));
  assert.deepEqual(deployments.at(-1).versions, [{ version_id: 'release-newer', percentage: 100 }]);
});

test('a rollback by hand during the upload stays live once branch writes push it out of the history', () => {
  const fixture = setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released });
  const state = JSON.parse(readFileSync(fixture.state, 'utf8'));
  state.uploadInject = {
    id: 'rollback',
    versions: [{ version_id: 'release-old', percentage: 100 }],
    annotations: { 'workers/message': 'rollback by hand' },
  };
  writeFileSync(fixture.state, JSON.stringify(state));
  const { result, deployments } = run(fixture, { FAKE_LIVE_WRITES: staleWrites('release-new') });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!deployments.slice(-10).some((deployment) => deployment.id === 'rollback'));
  assert.deepEqual(deployments.at(-1).versions, [{ version_id: 'release-old', percentage: 100 }]);
});

test('the newest tag is deployed by its version id, found through the live deployment once the versions list has moved past it', () => {
  const uploads = Array.from({ length: 12 }, (_, i) => ({
    id: `branch-old-${i}`,
    annotations: { 'workers/tag': `abc${i}` },
  }));
  const { result, deployments } = run(
    setup({ tags: ['v1.9.0', 'v1.10.0'], versions: [...released, ...uploads] })
  );
  assert.equal(result.status, 0, result.stderr);
  const split = deployments.find((deployment) => deployment.versions.length === 2);
  assert.equal(split.versions[0].version_id, 'release-new');
  assert.deepEqual(deployments.at(-1).versions, [{ version_id: 'release-new', percentage: 100 }]);
});

test('a stale branch write that lands after ours is put back to the newest tag, keeping its 0% version', () => {
  const late = {
    id: 'late',
    versions: [
      { version_id: 'release-old', percentage: 100 },
      { version_id: 'other-pr', percentage: 0 },
    ],
    annotations: { 'workers/message': 'post-deploy tests for 77/merge 0123456789ab' },
  };
  const { result, deployments } = run(
    setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released, inject: [late] })
  );
  assert.equal(result.status, 0, result.stderr);
  const after = deployments.slice(
    deployments.findIndex((deployment) => deployment.id === 'late') + 1
  );
  assert.deepEqual(after[0].versions, [
    { version_id: 'release-new', percentage: 100 },
    { version_id: 'other-pr', percentage: 0 },
  ]);
  assert.equal(deployments.at(-1).versions[0].version_id, 'release-new');
  assert.match(
    result.stdout,
    /::warning title=Deploy::late put release-old at 100% instead of release-new \(v1\.10\.0\)/
  );
});

test('a version stuck at 0% by another pull request is waited on once, then replaced', () => {
  const fixture = setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released });
  const state = JSON.parse(readFileSync(fixture.state, 'utf8'));
  state.deployments.push({
    id: 'stuck',
    versions: [
      { version_id: 'release-new', percentage: 100 },
      { version_id: 'other-pr', percentage: 0 },
    ],
    annotations: { 'workers/message': 'post-deploy tests for 77/merge 0123456789ab' },
  });
  writeFileSync(fixture.state, JSON.stringify(state));
  const { result, latest } = run(fixture, { SLICCY_AI_WAIT_MS: '0' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/replacing it/g)?.length, 1);
  assert.deepEqual(latest.versions, [{ version_id: 'release-new', percentage: 100 }]);
});

test('a pull request from a fork skips the deploy, and one from this repository without the token fails', () => {
  const fixture = setup({ tags: ['v1.10.0'], versions: released });
  const event = join(root, `event-${count}.json`);
  const from = (name) => {
    writeFileSync(event, JSON.stringify({ pull_request: { head: { repo: { full_name: name } } } }));
    return run(fixture, { SLICCY_AI_DEPLOY_TOKEN: '', GITHUB_EVENT_PATH: event });
  };
  const forked = from('someone/sliccy-ai');
  assert.equal(forked.result.status, 0, forked.result.stderr);
  assert.match(forked.result.stdout, /fork gets no deploy token/);
  assert.equal(forked.deployments.length, 10);
  assert.equal(from('ai-ecoverse/sliccy-ai').result.status, 1);
});

test('a re-run release deploys the version it already uploaded, so its tag stays unique', () => {
  const { result, latest, versions } = run(setup({ tags: ['v1.10.0'], versions: released }), {
    mode: 'production',
    RELEASE_VERSION: '1.10.0',
    GITHUB_REF_NAME: 'main',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(versions.filter((v) => v.annotations['workers/tag'] === 'v1.10.0').length, 1);
  assert.deepEqual(latest.versions, [{ version_id: 'release-new', percentage: 100 }]);
  assert.equal(latest.annotations['workers/message'], 'release v1.10.0');
});

test('a first release deploys a new version tagged with it', () => {
  const { result, latest, versions } = run(setup({ tags: ['v1.10.0'], versions: released }), {
    mode: 'production',
    RELEASE_VERSION: '1.11.0',
    GITHUB_REF_NAME: 'main',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(versions.at(-1).annotations['workers/tag'], 'v1.11.0');
  assert.equal(latest.versions[0].version_id, versions.at(-1).id);
});

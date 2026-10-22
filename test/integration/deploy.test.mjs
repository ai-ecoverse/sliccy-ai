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
  process.stdout.write(JSON.stringify(state.versions.find((v) => v.id === args[2])));
} else if (command === 'versions' && sub === 'upload') {
  const id = 'branch-' + state.versions.length;
  state.versions.push({ id, annotations: { 'workers/tag': flag('--tag') } });
  out({ type: 'version-upload', version_id: id });
} else if (command === 'versions' && sub === 'deploy') {
  const traffic = [];
  for (let i = 2; i < args.length; i += 1) {
    if (args[i] === '--version-tag') {
      const [tag, percentage] = args[i + 1].split('@');
      const version = state.versions.find((v) => v.annotations['workers/tag'] === tag);
      if (!version) process.exit(1);
      traffic.push({ version_id: version.id, percentage: Number.parseInt(percentage, 10) });
      i += 1;
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

let count = 0;

function setup({ tags, versions, inject = [] }) {
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
  writeFileSync(wrangler, fake);
  chmodSync(wrangler, 0o755);
  const deployments = Array.from({ length: 10 }, (_, i) => ({
    id: `history-${i}`,
    versions: [{ version_id: 'release-old', percentage: 100 }],
    annotations: { 'workers/message': `post-deploy tests for ${90 + i}/merge abc${i} done` },
  }));
  const state = join(dir, 'state.json');
  writeFileSync(state, JSON.stringify({ deployments, versions, inject }));
  return { repo, wrangler, state };
}

function run({ repo, wrangler, state }) {
  const { GITHUB_STEP_SUMMARY: _summary, ...rest } = env;
  const result = spawnSync('node', [script, 'branch'], {
    encoding: 'utf8',
    env: {
      ...rest,
      FAKE_STATE: state,
      SLICCY_AI_DEPLOY_TOKEN: 'fake',
      SLICCY_AI_WRANGLER: wrangler,
      SLICCY_AI_LIVE: 'node -e 0',
      SLICCY_AI_GIT_REMOTE: repo,
      GITHUB_REF_NAME: '76/merge',
      GITHUB_SHA: 'feedfacecafebeef',
    },
  });
  const { deployments } = JSON.parse(readFileSync(state, 'utf8'));
  return { result, latest: deployments.at(-1), deployments };
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
    setup({ tags: ['v1.9.0', 'v1.10.0'], versions: released.slice(0, 1) })
  );
  assert.notEqual(result.status, 0);
  assert.equal(deployments.length, 10);
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
    /::warning title=Deploy::late put release-old at 100% instead of v1\.10\.0/
  );
});

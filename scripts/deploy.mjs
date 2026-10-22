import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { setTimeout } from 'node:timers/promises';

const bin = new URL('../node_modules/.bin/wrangler', import.meta.url).pathname;
const token = env.SLICCY_AI_DEPLOY_TOKEN;
const label = `${env.GITHUB_REF_NAME ?? 'local'} ${env.GITHUB_SHA?.slice(0, 12) ?? ''}`.trim();

function summary(line) {
  console.log(line);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

function wrangler(args) {
  const dir = mkdtempSync(join(tmpdir(), 'wrangler-'));
  const file = join(dir, 'output.ndjson');
  const stdout = execFileSync(bin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...env, CLOUDFLARE_API_TOKEN: token, WRANGLER_OUTPUT_FILE_PATH: file },
  });
  let entries = [];
  try {
    entries = readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    entries = [];
  }
  return { stdout, entries };
}

function output(entries, type, key) {
  const value = entries.find((entry) => entry.type === type)?.[key];
  if (!value) throw new Error(`wrangler wrote no ${type} ${key}`);
  return value;
}

const deployments = () => JSON.parse(wrangler(['deployments', 'list', '--json']).stdout);
const stableOf = (deployment) =>
  deployment.versions.reduce((a, b) => (b.percentage > a.percentage ? b : a)).version_id;
const specs = (deployment) => deployment.versions.map((v) => `${v.version_id}@${v.percentage}%`);

function split(versions, message) {
  const { entries } = wrangler(['versions', 'deploy', ...versions, '-y', '--message', message]);
  return output(entries, 'version-deploy', 'deployment_id');
}

function guard(expected, written, rounds = 5) {
  const list = deployments();
  const at = list.findIndex((deployment) => deployment.id === written);
  if (at < 0 || at !== list.length - 1) return;
  const before = list[at - 1];
  if (!before || before.id === expected) return;
  if (rounds === 0) throw new Error(`deployments kept landing while ${label} restored them`);
  const restored = split(specs(before), `restore ${before.id}, which ${label} overwrote`);
  guard(written, restored, rounds - 1);
  throw new Error(
    `deployment ${before.id} landed while ${label} switched versions; it is restored`
  );
}

const prefix = `post-deploy tests for ${env.GITHUB_REF_NAME ?? 'local'} `;
const stale = (deployment) =>
  deployment.annotations?.['workers/message']?.startsWith(prefix) ?? false;

async function quiet() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const latest = deployments().at(-1);
    if (latest.versions.length === 1 || stale(latest)) return;
    console.log(`another version is under test in ${latest.id}, waiting`);
    await setTimeout(15000);
  }
}

function live(vars) {
  const clean = { ...env, ...vars };
  delete clean.SLICCY_AI_DEPLOY_TOKEN;
  delete clean.CLOUDFLARE_API_TOKEN;
  summary(`Testing sliccy-ai version ${vars.SLICCY_AI_VERSION}`);
  return spawnSync('npm', ['run', 'test:live'], { stdio: 'inherit', env: clean }).status ?? 1;
}

function takeOut(version) {
  const base = deployments().at(-1);
  if (!base.versions.some((v) => v.version_id === version)) return;
  const stable = base.versions.filter((v) => v.version_id !== version);
  if (stable.length === 0)
    throw new Error(`${version} is the only version in ${base.id}; left as it is`);
  guard(
    base.id,
    split([`${stableOf({ versions: stable })}@100%`], `post-deploy tests for ${label} done`)
  );
  summary(`Took ${version} back out of the deployment`);
}

async function branch() {
  await quiet();
  const { entries } = wrangler([
    'versions',
    'upload',
    '--tag',
    label.split(' ').at(-1),
    '--message',
    label,
  ]);
  const version = output(entries, 'version-upload', 'version_id');
  const base = deployments().at(-1);
  const stable = stableOf(base);
  let status = 1;
  try {
    guard(
      base.id,
      split([`${stable}@100%`, `${version}@0%`], `${prefix}${label.split(' ').at(-1)}`)
    );
    status = live({ SLICCY_AI_VERSION: version, SLICCY_AI_STABLE: stable });
  } finally {
    takeOut(version);
  }
  return status;
}

function hold(version, release) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const latest = deployments().at(-1);
    if (stableOf(latest) === version) return;
    console.log(
      `::warning title=Deploy::${latest.id} replaced ${release}; putting ${version} back`
    );
    split([`${version}@100%`], `${release} again, after ${latest.id}`);
  }
  if (stableOf(deployments().at(-1)) === version) return;
  throw new Error(`${release} did not stay deployed`);
}

function production() {
  const release = env.RELEASE_VERSION ? `v${env.RELEASE_VERSION}` : label;
  const { entries } = wrangler(['deploy', '--tag', release, '--message', `release ${release}`]);
  const version = output(entries, 'deploy', 'version_id');
  summary(`Deployed ${release} as sliccy-ai version ${version}`);
  try {
    return live({ SLICCY_AI_VERSION: version });
  } finally {
    hold(version, release);
  }
}

if (!token) {
  console.error('deploy: SLICCY_AI_DEPLOY_TOKEN is not set in this job');
  exit(1);
}
process.on('SIGINT', () => exit(130));
process.on('SIGTERM', () => exit(143));
const modes = { branch, production };
const mode = modes[argv[2]];
if (!mode) {
  console.error('usage: node scripts/deploy.mjs branch|production');
  exit(2);
}
exit(await mode());

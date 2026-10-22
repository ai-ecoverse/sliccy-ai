import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { setTimeout } from 'node:timers/promises';

const bin =
  env.SLICCY_AI_WRANGLER ?? new URL('../node_modules/.bin/wrangler', import.meta.url).pathname;
const [liveCommand, ...liveArgs] = (env.SLICCY_AI_LIVE ?? 'npm run test:live').split(' ');
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
const message = (deployment) => deployment.annotations?.['workers/message'] ?? '';
const tests = 'post-deploy tests for ';
const prefix = `${tests}${env.GITHUB_REF_NAME ?? 'local'} `;
const branchWrite = (deployment) => message(deployment).startsWith(tests);
const authority = (list) => list.findLast((deployment) => !branchWrite(deployment));

function split(versions, note) {
  const { entries } = wrangler(['versions', 'deploy', ...versions, '-y', '--message', note]);
  return output(entries, 'version-deploy', 'deployment_id');
}

function newestTag() {
  const remote = env.SLICCY_AI_GIT_REMOTE ?? 'origin';
  const refs = execFileSync('git', ['ls-remote', '--tags', remote, 'v*'], { encoding: 'utf8' });
  const tags = [...refs.matchAll(/refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/gm)].map((m) => ({
    tag: m[1],
    parts: m.slice(2, 5).map(Number),
  }));
  tags.sort(
    (x, y) => x.parts[0] - y.parts[0] || x.parts[1] - y.parts[1] || x.parts[2] - y.parts[2]
  );
  return tags.at(-1)?.tag;
}

const tags = new Map();

function tagOf(version) {
  if (!tags.has(version)) {
    const view = JSON.parse(wrangler(['versions', 'view', version, '--json']).stdout || '{}');
    tags.set(version, view?.annotations?.['workers/tag']);
  }
  return tags.get(version);
}

function tagged(tag, list) {
  const versions = JSON.parse(wrangler(['versions', 'list', '--json']).stdout);
  const listed = versions.findLast((v) => v.annotations?.['workers/tag'] === tag)?.id;
  if (listed) return listed;
  const live = [...new Set(list.flatMap((d) => d.versions.map((v) => v.version_id)))];
  const found = live.find((version) => tagOf(version) === tag);
  if (found) return found;
  throw new Error(`no deployable version has the tag ${tag}; no traffic changed`);
}

function stableNow(list) {
  const source = authority(list);
  if (source) return { spec: [`${stableOf(source)}@100%`], id: stableOf(source), from: source.id };
  const tag = newestTag();
  if (!tag) return { spec: [`${stableOf(list.at(-1))}@100%`], id: stableOf(list.at(-1)) };
  const id = tagged(tag, list);
  return { spec: [`${id}@100%`], id, tag, from: `the git tag ${tag}` };
}

function settled(latest, stable) {
  return !stable.id || stableOf(latest) === stable.id;
}

function settle() {
  for (let round = 0; round < 5; round += 1) {
    const list = deployments();
    const latest = list.at(-1);
    if (!branchWrite(latest)) return;
    const stable = stableNow(list);
    if (!stable.from || settled(latest, stable)) return;
    const current = stableOf(latest);
    const extra = latest.versions.filter(
      (v) => v.version_id !== current && v.version_id !== stable.id
    );
    const name = stable.tag ? `${stable.id} (${stable.tag})` : stable.id;
    console.log(
      `::warning title=Deploy::${latest.id} put ${current} at 100% instead of ${name} from ${stable.from}; putting ${name} back`
    );
    split(
      [...stable.spec, ...extra.map((v) => `${v.version_id}@0%`)],
      `${tests}put-back by ${label}: ${name} from ${stable.from}`
    );
  }
  throw new Error(`the deployment kept changing while ${label} put the stable version back`);
}

const wait = { until: Date.now() + Number(env.SLICCY_AI_WAIT_MS ?? 600000), warned: false };

async function quiet() {
  while (Date.now() < wait.until) {
    const latest = deployments().at(-1);
    if (latest.versions.length === 1 || message(latest).startsWith(prefix)) return;
    console.log(`another version is under test in ${latest.id}, waiting`);
    await setTimeout(Math.min(15000, Math.max(0, wait.until - Date.now())));
  }
  const latest = deployments().at(-1);
  if (wait.warned || latest.versions.length === 1) return;
  wait.warned = true;
  const others = latest.versions.filter((v) => v.percentage === 0).map((v) => v.version_id);
  console.log(
    `::warning title=Deploy::${others.join(', ')} still at 0% in ${latest.id} (${message(latest)}) after 10 minutes; replacing it`
  );
}

function live(vars) {
  const clean = { ...env, ...vars };
  delete clean.SLICCY_AI_DEPLOY_TOKEN;
  delete clean.CLOUDFLARE_API_TOKEN;
  summary(`Testing sliccy-ai version ${vars.SLICCY_AI_VERSION}`);
  return spawnSync(liveCommand, liveArgs, { stdio: 'inherit', env: clean }).status ?? 1;
}

function takeOut(version) {
  const list = deployments();
  const latest = list.at(-1);
  if (latest.versions.some((v) => v.version_id === version)) {
    const stable = stableNow(list);
    if (stable.id === version) throw new Error(`${version} is the stable version; left as it is`);
    split(stable.spec, `${prefix}${label.split(' ').at(-1)} done`);
    summary(`Took ${version} back out of the deployment`);
  }
  settle();
}

function unaccounted(list) {
  const stable = stableNow(list);
  if (!stable.tag || settled(list.at(-1), stable)) return '';
  const current = stableOf(list.at(-1));
  return `${current} (${tagOf(current) ?? 'no tag'}) is at 100%, not the newest tag ${stable.tag}, and none of the last 10 deployments is a release or a rollback by hand that accounts for it; no traffic changed. To unblock pull request deploys, deploy the version that should be live by hand with a message that doesn't start with "${tests}", for example wrangler versions deploy ${current}@100% -y --message "hold ${current}", or roll back again`;
}

function refuse(reason) {
  summary(`::error title=Deploy::${reason}`);
  return 1;
}

async function branch() {
  await quiet();
  const before = unaccounted(deployments());
  if (before) return refuse(before);
  const { entries } = wrangler([
    'versions',
    'upload',
    '--tag',
    label.split(' ').at(-1),
    '--message',
    label,
  ]);
  const version = output(entries, 'version-upload', 'version_id');
  await quiet();
  const list = deployments();
  const reason = unaccounted(list);
  if (reason) return refuse(reason);
  const stable = stableNow(list);
  let status = 1;
  try {
    split([...stable.spec, `${version}@0%`], `${prefix}${label.split(' ').at(-1)}`);
    settle();
    status = live({ SLICCY_AI_VERSION: version, SLICCY_AI_STABLE: stable.id });
  } finally {
    takeOut(version);
  }
  return status;
}

function production() {
  const release = env.RELEASE_VERSION ? `v${env.RELEASE_VERSION}` : label;
  const versions = JSON.parse(wrangler(['versions', 'list', '--json']).stdout);
  const again = versions.findLast((v) => v.annotations?.['workers/tag'] === release)?.id;
  if (again) split([`${again}@100%`], `release ${release}`);
  const version =
    again ??
    output(
      wrangler(['deploy', '--tag', release, '--message', `release ${release}`]).entries,
      'deploy',
      'version_id'
    );
  summary(`Deployed ${release} as sliccy-ai version ${version}`);
  try {
    return live({ SLICCY_AI_VERSION: version });
  } finally {
    settle();
  }
}

function fork() {
  if (!env.GITHUB_EVENT_PATH) return false;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  const head = event.pull_request?.head?.repo?.full_name;
  return Boolean(head) && head !== env.GITHUB_REPOSITORY;
}

if (!token && argv[2] === 'branch' && fork()) {
  summary(
    '::notice title=Deploy::a pull request from a fork gets no deploy token; no post-deploy tests'
  );
  exit(0);
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
try {
  exit(await mode());
} catch (error) {
  summary(`::error title=Deploy::${error.message}`);
  exit(1);
}

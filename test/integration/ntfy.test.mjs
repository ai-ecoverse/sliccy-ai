import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));
const [homes, trays] = config.durable_objects.bindings;

const hub = `export class ${trays.class_name} {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/internal/confirm-controller') return new Response('no', { status: 404 });
    const { controllerToken } = await request.json();
    return Response.json({ confirmed: /^tray[0-9]\\.leader$/.test(controllerToken) });
  }
}
export default { fetch: () => new Response('hub') };`;

const worker = new Miniflare({
  workers: [
    {
      name: 'sliccy-ai',
      modules: true,
      modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }],
      scriptPath: fileURLToPath(new URL(config.main, root)),
      compatibilityDate: config.compatibility_date,
      r2Buckets: [config.r2_buckets[0].binding],
      bindings: { [config.version_metadata.binding]: { id: 'local' } },
      serviceBindings: { [config.services[0].binding]: 'hub' },
      durableObjects: {
        [homes.name]: { className: homes.class_name, useSQLite: true },
        [trays.name]: { className: trays.class_name, scriptName: 'hub' },
      },
    },
    {
      name: 'hub',
      modules: true,
      script: hub,
      compatibilityDate: config.compatibility_date,
      durableObjects: { TRAYS: trays.class_name },
    },
  ],
});
after(() => worker.dispose());

const host = 'https://ntfy.sliccy.ai';
const call = (path, init = {}) => worker.dispatchFetch(`${host}${path}`, init);
const bearer = (token, extra = {}) => ({ authorization: `Bearer ${token}`, ...extra });
const post = (path, headers, body) =>
  call(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const sign = (secret, data, encoding = 'hex') =>
  createHmac('sha256', secret).update(data).digest(encoding);

async function claim(controllerToken = 'tray1.leader') {
  const response = await post('/api/home', {}, JSON.stringify({ controllerToken }));
  assert.equal(response.status, 201);
  return response.json();
}

async function mint(home, draft) {
  const response = await post(
    `/api/home/${home.homeId}/tokens`,
    bearer(home.ownerSecret),
    JSON.stringify(draft)
  );
  assert.equal(response.status, 201);
  return (await response.json()).token;
}

async function poll(token, topic, query = '') {
  const response = await call(`/${topic}/json?poll=1${query}`, { headers: bearer(token) });
  assert.equal(response.status, 200);
  return (await response.text())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function hook(token, draft) {
  const response = await post('/api/hooks', bearer(token), JSON.stringify(draft));
  assert.equal(response.status, 201);
  return response.json();
}

function reader(response) {
  const stream = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  return async () => {
    while (!buffer.includes('\n')) {
      const { done, value } = await stream.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
    }
    const at = buffer.indexOf('\n');
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    return JSON.parse(line);
  };
}

test('answers ntfy health and config probes, and refuses topics without a token', async () => {
  const health = await call('/v1/health');
  assert.deepEqual(await health.json(), { healthy: true });
  assert.equal(health.headers.get('access-control-allow-origin'), '*');
  assert.equal(health.headers.get('x-sliccy-ai-version'), 'local');
  const config = await (await call('/v1/config')).json();
  assert.equal(config.enable_login, false);
  const anonymous = await call('/github/json?poll=1');
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json()).http, 401);
  const preflight = await call('/github', {
    method: 'OPTIONS',
    headers: { 'access-control-request-headers': 'authorization, x-title' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization, x-title');
});

test('claims a home only with a controller token the tray hub confirms', async () => {
  for (const controllerToken of ['tray1.follower', 'not-a-token', 'a.b.c', 42]) {
    const refused = await post('/api/home', {}, JSON.stringify({ controllerToken }));
    assert.equal(refused.status, 403);
  }
  const mismatched = await post(
    '/api/home',
    {},
    JSON.stringify({ trayId: 'tray2', controllerToken: 'tray1.leader' })
  );
  assert.equal(mismatched.status, 403);
  const home = await claim();
  assert.match(home.homeId, /^[a-z0-9]{8}$/);
  assert.match(home.ownerSecret, /^[A-Za-z0-9]{43}$/);
  assert.equal(home.trayId, 'tray1');
  const described = await call(`/api/home/${home.homeId}`, { headers: bearer(home.ownerSecret) });
  assert.equal((await described.json()).trayId, 'tray1');
});

test('only the owner mints tokens; a value is shown once and never listed', async () => {
  const home = await claim();
  const other = await claim();
  const stranger = await post(
    `/api/home/${home.homeId}/tokens`,
    bearer(other.ownerSecret),
    JSON.stringify({ member: 'kernel' })
  );
  assert.equal(stranger.status, 401);
  for (const draft of [
    {},
    { member: 'Kernel!' },
    { member: 'kernel', scopes: ['admin'] },
    { member: 'kernel', scopes: [] },
    { member: 'kernel', topics: ['api'] },
    { member: 'kernel', expires: 1 },
  ]) {
    const refused = await post(
      `/api/home/${home.homeId}/tokens`,
      bearer(home.ownerSecret),
      JSON.stringify(draft)
    );
    assert.equal(refused.status, 400, JSON.stringify(draft));
  }
  const token = await mint(home, { label: 'seven', member: 'kernel', scopes: ['subscribe'] });
  assert.match(token, /^tk_[a-z0-9]{29}$/);
  assert.equal(token.slice(3, 11), home.homeId);
  const listed = await call(`/api/home/${home.homeId}/tokens`, {
    headers: bearer(home.ownerSecret),
  });
  const { tokens } = await listed.json();
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].label, 'seven');
  assert.deepEqual(tokens[0].scopes, ['subscribe']);
  assert.ok(!JSON.stringify(tokens).includes(token.slice(11)));
  assert.equal(tokens[0].hash, undefined);
  const elsewhere = await call(`/github/json?poll=1`, {
    headers: bearer(`tk_${other.homeId}${token.slice(11)}`),
  });
  assert.equal(elsewhere.status, 401);
});

test('publishes and polls in ntfy json, sse and raw, with since cursors', async () => {
  const home = await claim();
  const token = await mint(home, { member: 'kernel', scopes: ['subscribe', 'publish'] });
  const first = await call('/news', {
    method: 'POST',
    headers: bearer(token, { title: 'Hello', tags: 'wave,tada', priority: 'high' }),
    body: 'first line\nsecond line',
  });
  assert.equal(first.status, 200);
  const sent = await first.json();
  assert.match(sent.id, /^[A-Za-z0-9]{12}$/);
  assert.equal(sent.event, 'message');
  assert.equal(sent.topic, 'news');
  assert.equal(sent.title, 'Hello');
  assert.deepEqual(sent.tags, ['wave', 'tada']);
  assert.equal(sent.priority, 4);
  const second = await post(
    '/',
    bearer(token),
    JSON.stringify({ topic: 'news', message: 'json', title: 'Two', markdown: true })
  );
  const two = await second.json();
  assert.equal(two.content_type, 'text/markdown');
  const empty = await call('/news', { method: 'PUT', headers: bearer(token) });
  assert.equal((await empty.json()).message, 'triggered');
  const all = await poll(token, 'news');
  assert.deepEqual(
    all.map((message) => message.message),
    ['first line\nsecond line', 'json', 'triggered']
  );
  const after = await poll(token, 'news', `&since=${sent.id}`);
  assert.deepEqual(
    after.map((message) => message.message),
    ['json', 'triggered']
  );
  assert.equal((await poll(token, 'news', '&since=latest')).length, 1);
  assert.equal((await poll(token, 'news', '&since=none')).length, 0);
  assert.equal((await poll(token, 'news', '&since=10m')).length, 3);
  assert.equal((await poll(token, 'other')).length, 0);
  const sse = await call('/news/sse?poll=1&since=all', { headers: bearer(token) });
  assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.match(await sse.text(), /^data: \{"id":"[A-Za-z0-9]{12}"/);
  const raw = await call('/news/raw?poll=1', { headers: bearer(token) });
  assert.equal(await raw.text(), 'first line second line\njson\ntriggered\n');
  const badSince = await call('/news/json?poll=1&since=yesterday', { headers: bearer(token) });
  assert.equal(badSince.status, 400);
});

test('streams the open event, the backlog and live messages; a revoked member is cut off', async () => {
  const home = await claim();
  const owner = await mint(home, { member: 'kernel', scopes: ['subscribe', 'publish'] });
  const device = await mint(home, { member: 'device:3fa9c210', scopes: ['subscribe'] });
  await call('/news', { method: 'POST', headers: bearer(owner), body: 'before' });
  const stream = await call('/news,alerts/json?since=all', { headers: bearer(device) });
  assert.equal(stream.headers.get('content-type'), 'application/x-ndjson; charset=utf-8');
  const next = reader(stream);
  const open = await next();
  assert.equal(open.event, 'open');
  assert.equal(open.topic, 'news,alerts');
  assert.equal((await next()).message, 'before');
  await call('/alerts', { method: 'POST', headers: bearer(owner), body: 'live' });
  const live = await next();
  assert.equal(live.topic, 'alerts');
  assert.equal(live.message, 'live');
  const auth = await call('/news/auth', { headers: bearer(device) });
  assert.deepEqual(await auth.json(), { success: true });
  const revoked = await call(`/api/home/${home.homeId}/tokens?member=device`, {
    method: 'DELETE',
    headers: bearer(home.ownerSecret),
  });
  assert.deepEqual(await revoked.json(), { revoked: 1 });
  assert.equal(await next(), null);
  assert.equal((await call('/news/json?poll=1', { headers: bearer(device) })).status, 401);
  assert.equal((await poll(owner, 'news')).length, 1);
});

test('scopes and topic lists bound what a token may do', async () => {
  const home = await claim();
  const owner = await mint(home, { member: 'kernel', scopes: ['subscribe', 'publish', 'hooks'] });
  const phone = await mint(home, { member: 'phone', scopes: ['subscribe'], topics: ['alerts'] });
  const published = await call('/alerts', { method: 'POST', headers: bearer(phone), body: 'x' });
  assert.equal(published.status, 403);
  assert.equal((await call('/news/json?poll=1', { headers: bearer(phone) })).status, 403);
  assert.equal((await call('/alerts,news/json?poll=1', { headers: bearer(phone) })).status, 403);
  assert.equal((await call('/alerts/json?poll=1', { headers: bearer(phone) })).status, 200);
  assert.equal((await call('/api/hooks', { headers: bearer(phone) })).status, 403);
  assert.equal((await call('/api/hooks', { headers: bearer(owner) })).status, 200);
  const reserved = await call('/v1/json?poll=1', { headers: bearer(owner) });
  assert.equal(reserved.status, 404);
  const expiring = await mint(home, {
    member: 'phone',
    scopes: ['subscribe'],
    expires: Math.floor(Date.now() / 1000) + 2,
  });
  assert.equal((await call('/alerts/json?poll=1', { headers: bearer(expiring) })).status, 200);
});

test('a GitHub webhook with a valid signature becomes one verified message', async () => {
  const home = await claim();
  const kernel = await mint(home, { member: 'kernel', scopes: ['subscribe', 'hooks'] });
  const created = await hook(kernel, { name: 'github', secret: 'it-is-a-secret' });
  assert.equal(created.topic, 'github');
  assert.equal(created.signed, true);
  assert.match(created.url, new RegExp(`^${host}/hook/${home.homeId}[a-z0-9]{24}$`));
  const duplicate = await post('/api/hooks', bearer(kernel), JSON.stringify({ name: 'github' }));
  assert.equal(duplicate.status, 409);
  const payload = JSON.stringify({ ref: 'refs/heads/main', commits: [] });
  const headers = {
    'content-type': 'application/json',
    'x-github-event': 'push',
    'x-github-delivery': 'd-1',
    authorization: 'token leaked',
    cookie: 'session=1',
  };
  const forged = await call(new URL(created.url).pathname, {
    method: 'POST',
    headers: { ...headers, 'x-hub-signature-256': `sha256=${sign('wrong', payload)}` },
    body: payload,
  });
  assert.equal(forged.status, 401);
  const unsigned = await call(new URL(created.url).pathname, {
    method: 'POST',
    headers,
    body: payload,
  });
  assert.equal(unsigned.status, 401);
  const delivered = await call(new URL(created.url).pathname, {
    method: 'POST',
    headers: { ...headers, 'x-hub-signature-256': `sha256=${sign('it-is-a-secret', payload)}` },
    body: payload,
  });
  assert.equal(delivered.status, 200);
  const messages = await poll(kernel, 'github');
  assert.equal(messages.length, 1);
  const [message] = messages;
  assert.equal(message.title, 'push');
  assert.deepEqual(message.tags, ['github']);
  assert.equal(message.message, payload);
  assert.equal(message.verified, true);
  assert.equal(message.hook, 'github');
  assert.equal(message.headers['x-github-event'], 'push');
  assert.equal(message.headers['x-github-delivery'], 'd-1');
  assert.ok(message.headers['x-hub-signature-256']);
  assert.equal(message.headers.authorization, undefined);
  assert.equal(message.headers.cookie, undefined);
  const { hooks } = await (await call('/api/hooks', { headers: bearer(kernel) })).json();
  assert.deepEqual(
    hooks.map((entry) => entry.name),
    ['github']
  );
  const dropped = await call('/api/hooks/github', { method: 'DELETE', headers: bearer(kernel) });
  assert.equal(dropped.status, 204);
  assert.equal((await call(new URL(created.url).pathname, { method: 'POST' })).status, 404);
});

test('a body over 48 KiB becomes an attachment its capability URL serves without a token', async () => {
  const home = await claim();
  const kernel = await mint(home, { member: 'kernel', scopes: ['subscribe', 'hooks'] });
  const created = await hook(kernel, { name: 'big' });
  const payload = JSON.stringify({ blob: 'x'.repeat(300 * 1024) });
  const delivered = await call(new URL(created.url).pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-github-event': 'issues' },
    body: payload,
  });
  assert.equal(delivered.status, 200);
  const [message] = await poll(kernel, 'big');
  assert.equal(message.verified, false);
  assert.equal(message.title, 'issues');
  assert.equal(message.message, 'You received a file: body.json');
  assert.equal(message.attachment.name, 'body.json');
  assert.equal(message.attachment.type, 'application/json');
  assert.equal(message.attachment.size, payload.length);
  assert.equal(message.attachment.expires, message.expires);
  const url = new URL(message.attachment.url);
  assert.equal(url.origin, host);
  assert.match(url.pathname, new RegExp(`^/file/${home.homeId}[a-z0-9]{32}\\.json$`));
  const file = await call(url.pathname);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-disposition'), 'attachment');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await file.text(), payload);
  const head = await call(url.pathname, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(payload.length));
  const guessed = await call(`/file/${home.homeId}${'a'.repeat(32)}.json`);
  assert.equal(guessed.status, 404);
});

test("a body that would escape past ntfy's 64 KiB line limit is attached instead", async () => {
  const home = await claim();
  const kernel = await mint(home, { member: 'kernel', scopes: ['subscribe', 'publish'] });
  const quoted = JSON.stringify({ q: '"'.repeat(40 * 1024) });
  const sent = await call('/quotes', { method: 'POST', headers: bearer(kernel), body: quoted });
  const message = await sent.json();
  assert.equal(message.attachment.size, quoted.length);
  const plain = 'p'.repeat(40 * 1024);
  const inline = await call('/quotes', { method: 'POST', headers: bearer(kernel), body: plain });
  assert.equal((await inline.json()).message, plain);
  const raw = await call('/quotes/json?poll=1', { headers: bearer(kernel) });
  for (const line of (await raw.text()).split('\n')) assert.ok(line.length < 64 * 1024);
});

test('verifies Stripe, Standard Webhooks, Slack and GitLab, and answers the handshakes', async () => {
  const home = await claim();
  const kernel = await mint(home, { member: 'kernel', scopes: ['subscribe', 'hooks'] });
  const time = String(Math.floor(Date.now() / 1000));
  const deliver = async (name, secret, headers, body) => {
    const { url } = await hook(kernel, { name, secret });
    return call(new URL(url).pathname, { method: 'POST', headers, body });
  };
  const stripeBody = '{"type":"invoice.paid"}';
  const stripe = await deliver(
    'stripe',
    'whsec_stripe-secret',
    { 'stripe-signature': `t=${time},v1=${sign('whsec_stripe-secret', `${time}.${stripeBody}`)}` },
    stripeBody
  );
  assert.equal(stripe.status, 200);
  const [paid] = await poll(kernel, 'stripe');
  assert.equal(paid.title, 'invoice.paid');
  assert.deepEqual(paid.tags, ['stripe']);
  const stale = String(Number(time) - 600);
  const replayed = await call(
    new URL((await hook(kernel, { name: 'stripe2', secret: 'whsec_stripe-secret' })).url).pathname,
    {
      method: 'POST',
      headers: {
        'stripe-signature': `t=${stale},v1=${sign('whsec_stripe-secret', `${stale}.${stripeBody}`)}`,
      },
      body: stripeBody,
    }
  );
  assert.equal(replayed.status, 401);
  const key = Buffer.from('standard-key-bytes');
  const standardBody = '{"type":"user.created"}';
  const standard = await deliver(
    'standard',
    `whsec_${key.toString('base64')}`,
    {
      'webhook-id': 'msg_1',
      'webhook-timestamp': time,
      'webhook-signature': `v1,bogus v1,${sign(key, `msg_1.${time}.${standardBody}`, 'base64')}`,
    },
    standardBody
  );
  assert.equal(standard.status, 200);
  assert.equal((await poll(kernel, 'standard'))[0].title, 'user.created');
  const slackBody = '{"type":"url_verification","challenge":"c-123"}';
  const slack = await deliver(
    'slack',
    'slack-signing-secret',
    {
      'x-slack-request-timestamp': time,
      'x-slack-signature': `v0=${sign('slack-signing-secret', `v0:${time}:${slackBody}`)}`,
    },
    slackBody
  );
  assert.deepEqual(await slack.json(), { challenge: 'c-123' });
  assert.equal((await poll(kernel, 'slack')).length, 0);
  const gitlab = await deliver(
    'gitlab',
    'gitlab-token-1',
    { 'x-gitlab-token': 'gitlab-token-1', 'x-gitlab-event': 'Push Hook' },
    '{}'
  );
  assert.equal(gitlab.status, 200);
  const [pushed] = await poll(kernel, 'gitlab');
  assert.equal(pushed.title, 'Push Hook');
  assert.equal(pushed.headers['x-gitlab-token'], undefined);
  const meta = await hook(kernel, { name: 'meta', secret: 'verify-me-please' });
  const path = new URL(meta.url).pathname;
  const challenged = await call(
    `${path}?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=42`
  );
  assert.equal(await challenged.text(), '42');
  const wrong = await call(`${path}?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`);
  assert.equal(wrong.status, 403);
  const graph = await call(`${path}?validationToken=graph%20token`, { method: 'POST' });
  assert.equal(await graph.text(), 'graph token');
  assert.equal((await poll(kernel, 'meta')).length, 0);
});

test('a home keeps the newest 1,000 messages', async () => {
  const home = await claim();
  const kernel = await mint(home, { member: 'kernel', scopes: ['subscribe', 'publish'] });
  for (let n = 0; n < 1003; n += 1) {
    const sent = await call('/flood', { method: 'POST', headers: bearer(kernel), body: `m${n}` });
    await sent.arrayBuffer();
  }
  const kept = await poll(kernel, 'flood');
  assert.equal(kept.length, 1000);
  assert.equal(kept[0].message, 'm3');
  assert.equal(kept.at(-1).message, 'm1002');
});

test('Basic auth and the auth query parameter carry the token as well', async () => {
  const home = await claim();
  const token = await mint(home, { member: 'phone', scopes: ['subscribe'] });
  const basic = Buffer.from(`:${token}`).toString('base64');
  const viaBasic = await call('/news/json?poll=1', {
    headers: { authorization: `Basic ${basic}` },
  });
  assert.equal(viaBasic.status, 200);
  const param = Buffer.from(`Bearer ${token}`).toString('base64url');
  assert.equal((await call(`/news/json?poll=1&auth=${param}`)).status, 200);
});

test('rebinding needs the owner secret and a confirmed controller of the new tray', async () => {
  const home = await claim();
  const path = `/api/home/${home.homeId}/rebind`;
  const body = JSON.stringify({ controllerToken: 'tray2.leader' });
  assert.equal((await post(path, {}, body)).status, 401);
  assert.equal((await post(path, bearer('wrong'), body)).status, 401);
  const unconfirmed = JSON.stringify({ controllerToken: 'tray2.follower' });
  assert.equal((await post(path, bearer(home.ownerSecret), unconfirmed)).status, 403);
  const rebound = await post(path, bearer(home.ownerSecret), body);
  assert.deepEqual(await rebound.json(), { homeId: home.homeId, trayId: 'tray2' });
});

test('deleting a home revokes its tokens, hooks and messages for good', async () => {
  const home = await claim();
  const token = await mint(home, { member: 'kernel', scopes: ['subscribe', 'publish', 'hooks'] });
  const { url } = await hook(token, { name: 'gone' });
  await call('/news', { method: 'POST', headers: bearer(token), body: 'x' });
  const deleted = await call(`/api/home/${home.homeId}`, {
    method: 'DELETE',
    headers: bearer(home.ownerSecret),
  });
  assert.equal(deleted.status, 204);
  assert.equal((await call('/news/json?poll=1', { headers: bearer(token) })).status, 410);
  assert.equal((await call(new URL(url).pathname, { method: 'POST' })).status, 410);
  const again = await call(`/api/home/${home.homeId}`, { headers: bearer(home.ownerSecret) });
  assert.equal(again.status, 410);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opspile, PORTAL_BRANCHES, PORTAL_SEVEN, SAME } from './opspile.mjs';

const proxy = opspile();
const SEVEN = 'https://seven.sliccy.ai';
const BRANCH = 'https://feat-shell.sliccy.ai';
const WWW = 'https://www.sliccy.ai';
const TOKEN = 'eyJhbGciOiJSUzI1NiJ9.eyJ1c2VyX2lkIjoiQUJDIn0.c2ln-_';
const V1 = `${PORTAL_SEVEN}/integrations/portal/v1`;

const call = (path, { method = 'GET', body, headers = {}, origin = SEVEN, mount = '' } = {}) =>
  proxy.fetch(`${origin}${mount}/api/support/${path}`, {
    method,
    headers: {
      ...SAME,
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json', origin }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const upstream = (status = 200, body = { ok: true }, headers = {}) =>
  proxy.answer(() =>
    typeof body === 'string'
      ? new Response(body, { status, headers })
      : Response.json(body, { status, headers })
  );

function assertPrivate(response) {
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'self'");
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-sliccy-ai-version'), 'local');
}

const credentials = {
  accept: 'application/json',
  authorization: `Bearer ${TOKEN}`,
  'cf-access-client-id': 'seven-access.access',
  'cf-access-client-secret': 'seven-access-secret',
};

const sent = ({ headers }) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) =>
        ![
          'content-length',
          'host',
          'accept-encoding',
          'cf-connecting-ip',
          'cf-worker',
          'connection',
          'transfer-encoding',
        ].includes(name)
    )
  );

const operations = [
  ['list', 'threads?limit=25&cursor=c1', {}, 'GET', `${V1}/threads?limit=25&cursor=c1`, undefined],
  [
    'create',
    'threads',
    {
      method: 'POST',
      body: { title: 'Build fails', body: 'Since Monday', topic: 'edge' },
      headers: { 'idempotency-key': 'k:1' },
    },
    'POST',
    `${V1}/threads`,
    { title: 'Build fails', body: 'Since Monday', topic: 'edge' },
  ],
  [
    'detail',
    'threads/1712.0001?limit=100',
    {},
    'GET',
    `${V1}/threads/1712.0001?limit=100`,
    undefined,
  ],
  [
    'reply',
    'threads/1712.0001/replies',
    { method: 'POST', body: { body: 'Still failing' }, headers: { 'idempotency-key': 'k-2' } },
    'POST',
    `${V1}/threads/1712.0001/replies`,
    { body: 'Still failing' },
  ],
  [
    'read',
    'threads/1712.0001/read',
    { method: 'PUT', body: { through: 'm9' } },
    'PUT',
    `${V1}/threads/1712.0001/read`,
    { through: 'm9' },
  ],
  [
    'changes',
    'changes?after=eyJ0IjoxfQ%3D%3D',
    {},
    'GET',
    `${V1}/changes?after=eyJ0IjoxfQ%3D%3D`,
    undefined,
  ],
];

for (const [name, path, init, method, url, body] of operations) {
  for (const [where, origin, mount] of [
    ['seven', SEVEN, ''],
    ['www/7', WWW, '/7'],
  ])
    test(`${name} on ${where} goes to its v1 operation with the service credentials and the user's token only`, async () => {
      upstream(200, { items: [], next: null });
      const response = await call(path, {
        ...init,
        origin,
        mount,
        headers: { cookie: 'a=b', 'x-extra': '1', ...init.headers },
      });
      assert.equal(response.status, 200);
      assertPrivate(response);
      assert.deepEqual(await response.json(), { items: [], next: null });
      assert.equal(proxy.seen.length, 1);
      const [forwarded] = proxy.seen;
      assert.equal(forwarded.method, method);
      assert.equal(forwarded.url, url);
      const expected = { ...credentials };
      if (body) expected['content-type'] = 'application/json';
      if (init.headers?.['idempotency-key'])
        expected['idempotency-key'] = init.headers['idempotency-key'];
      assert.deepEqual(sent(forwarded), expected);
      assert.equal(forwarded.body, body ? JSON.stringify(body) : '');
    });
}

test('a branch uses its own portal and service token', async () => {
  upstream(200, { items: [] });
  const response = await call('threads', { origin: BRANCH });
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const [forwarded] = proxy.seen;
  assert.equal(forwarded.url, `${PORTAL_BRANCHES}/integrations/portal/v1/threads`);
  assert.equal(forwarded.headers['cf-access-client-id'], 'branch-access.access');
  assert.equal(forwarded.headers['cf-access-client-secret'], 'branch-access-secret');
});

test('a created thread answers 201 with a Location on this origin', async () => {
  upstream(
    201,
    { threadId: 't1', channelId: 'c', channelName: 'Mill support', requestId: 'r' },
    {
      location: '/integrations/portal/v1/threads/t1',
      'set-cookie': 'portal=1',
    }
  );
  const response = await call('threads', {
    method: 'POST',
    body: { title: 'T', body: 'B' },
    headers: { 'idempotency-key': 'k' },
  });
  assert.equal(response.status, 201);
  assertPrivate(response);
  assert.equal(response.headers.get('location'), '/api/support/threads/t1');
  assert.equal((await response.json()).channelName, 'Mill support');
  upstream(201, { threadId: 't1' }, { location: 'https://elsewhere.example/x' });
  const elsewhere = await call('threads', {
    method: 'POST',
    body: { title: 'T', body: 'B' },
    headers: { 'idempotency-key': 'k' },
  });
  assert.equal(elsewhere.headers.get('location'), null);
  await elsewhere.arrayBuffer();
});

test('only the fixed routes and methods are answered', async () => {
  upstream();
  for (const [path, method, status, allow] of [
    ['', 'GET', 404, null],
    ['threads/', 'GET', 404, null],
    ['threads/a%2Fb', 'GET', 404, null],
    ['threads/a%20b', 'GET', 404, null],
    ['threads/a/b', 'GET', 404, null],
    ['threads/a/replies/x', 'POST', 404, null],
    ['channels', 'GET', 404, null],
    ['threads', 'DELETE', 405, 'GET, POST'],
    ['threads/a', 'POST', 405, 'GET'],
    ['threads/a/read', 'POST', 405, 'PUT'],
    ['threads/a/replies', 'GET', 405, 'POST'],
    ['changes', 'OPTIONS', 405, 'GET'],
  ]) {
    const response = await call(path, { method });
    assert.equal(response.status, status, `${method} ${path}`);
    assert.equal(response.headers.get('allow'), allow);
    assertPrivate(response);
    assert.equal(
      (await response.json()).error.code,
      status === 404 ? 'not_found' : 'method_not_allowed'
    );
  }
  assert.equal(proxy.seen.length, 0);
});

test('the proxy is same-origin only', async () => {
  upstream();
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': '' },
    { origin: 'https://evil.example' },
    { origin: BRANCH },
  ]) {
    const response = await call('threads', { headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { error: { code: 'forbidden' } });
  }
  assert.equal(proxy.seen.length, 0);
});

test('a missing or malformed token is invalid_assertion and reaches nobody', async () => {
  upstream();
  for (const authorization of [
    '',
    'Basic abc',
    'Bearer ',
    'Bearer a b',
    `Bearer ${'a'.repeat(9000)}`,
  ]) {
    const response = await call('threads', { headers: { authorization } });
    assert.equal(response.status, 401, authorization.slice(0, 20));
    assert.deepEqual(await response.json(), { error: { code: 'invalid_assertion' } });
  }
  assert.equal(proxy.seen.length, 0);
});

test('query parameters are allowlisted per operation', async () => {
  upstream();
  for (const path of [
    'threads?limit=0',
    'threads?limit=101',
    'threads?limit=10&limit=20',
    'threads?after=x',
    'threads?cursor=',
    'threads/a?x=1',
    'changes?cursor=c',
    'changes?after=%20',
  ]) {
    const response = await call(path);
    assert.equal(response.status, 400, path);
    assert.deepEqual(await response.json(), { error: { code: 'invalid_input' } });
  }
  assert.equal(proxy.seen.length, 0);
});

test('write bodies keep only their own string fields', async () => {
  upstream();
  const key = { 'idempotency-key': 'k' };
  for (const [path, method, body, headers] of [
    ['threads', 'POST', { title: 'T' }, key],
    ['threads', 'POST', { title: 'T', body: 'B', channel: 'other' }, key],
    ['threads', 'POST', { title: 'T', body: 1 }, key],
    ['threads', 'POST', { title: 'T', body: 'B', topic: null }, key],
    ['threads', 'POST', [], key],
    ['threads', 'POST', '{', key],
    ['threads', 'POST', { title: 'T', body: 'x'.repeat(17000) }, key],
    ['threads/a/replies', 'POST', { body: 'B', thread: 'b' }, key],
    ['threads/a/read', 'PUT', { through: 5 }, {}],
    ['threads/a/read', 'PUT', '{"through":"m","__proto__":{"x":1}}', {}],
    ['threads/a/read', 'PUT', { through: 'm' }, { 'content-type': 'text/plain' }],
  ]) {
    const response = await call(path, { method, body, headers });
    assert.equal(response.status, 400, JSON.stringify(body)?.slice(0, 60));
    assert.deepEqual(await response.json(), { error: { code: 'invalid_input' } });
  }
  assert.equal(proxy.seen.length, 0);
});

test('both POSTs need a valid Idempotency-Key', async () => {
  upstream();
  for (const [path, body] of [
    ['threads', { title: 'T', body: 'B' }],
    ['threads/a/replies', { body: 'B' }],
  ]) {
    for (const headers of [
      {},
      { 'idempotency-key': '' },
      { 'idempotency-key': 'a b' },
      { 'idempotency-key': 'k'.repeat(129) },
    ]) {
      const response = await call(path, { method: 'POST', body, headers });
      assert.equal(response.status, 400, `${path} ${JSON.stringify(headers)}`);
      await response.arrayBuffer();
    }
  }
  assert.equal(proxy.seen.length, 0);
});

test("Opspile's v1 errors pass through, with Retry-After", async () => {
  for (const [status, code, headers] of [
    [401, 'invalid_assertion', {}],
    [403, 'not_enrolled', {}],
    [404, 'not_found', {}],
    [409, 'key_conflict', {}],
    [410, 'cursor_expired', {}],
    [429, 'rate_limited', { 'retry-after': '12' }],
    [503, 'unavailable', { 'retry-after': '30' }],
  ]) {
    upstream(status, { error: { code, detail: 'the message text' } }, headers);
    const response = await call('threads');
    assert.equal(response.status, status, code);
    assertPrivate(response);
    assert.equal(response.headers.get('retry-after'), headers['retry-after'] ?? null);
    assert.deepEqual(await response.json(), { error: { code } });
  }
});

test('anything else from upstream is unavailable, and a bare 429 is rate_limited', async () => {
  for (const [status, body, headers, expected, code] of [
    [403, '<html>Forbidden</html>', { 'content-type': 'text/html' }, 503, 'unavailable'],
    [302, '', { location: 'https://access.example/login' }, 503, 'unavailable'],
    [200, 'not json', {}, 503, 'unavailable'],
    [500, { error: { code: 'Bad Code' } }, {}, 503, 'unavailable'],
    [429, 'slow down', { 'retry-after': '5' }, 429, 'rate_limited'],
    [503, 'down', { 'retry-after': 'soon; <script>' }, 503, 'unavailable'],
  ]) {
    upstream(status, body, headers);
    const response = await call('threads');
    assert.equal(response.status, expected, `${status} ${JSON.stringify(body)}`);
    assertPrivate(response);
    assert.equal(response.headers.get('location'), null);
    assert.equal(response.headers.get('retry-after'), status === 429 ? '5' : null);
    assert.deepEqual(await response.json(), { error: { code } });
  }
});

test('without its configuration a profile is unavailable and calls nobody', async () => {
  const bare = opspile({
    SUPPORT_ACCESS_SECRET_SEVEN: '',
    SUPPORT_PORTAL_BRANCHES: 'https://portal.example/path',
  });
  for (const origin of [SEVEN, BRANCH]) {
    const response = await bare.fetch(`${origin}/api/support/threads`, {
      headers: { ...SAME, authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 503, origin);
    assert.deepEqual(await response.json(), { error: { code: 'unavailable' } });
  }
  assert.equal(bare.seen.length, 0);
});

test('the proxy is only on seven, published branches and www/7', async () => {
  upstream();
  for (const url of [
    'https://nobody.sliccy.ai/api/support/threads',
    'https://vault.sliccy.ai/api/support/threads',
    'https://vault-feat.sliccy.ai/api/support/threads',
  ]) {
    const response = await proxy.fetch(url, {
      headers: { ...SAME, authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), 'not found');
  }
  assert.equal(proxy.seen.length, 0);
});

test('on www, a created thread points under /7/api/support/', async () => {
  upstream(201, { threadId: 't1' }, { location: '/integrations/portal/v1/threads/t1' });
  const response = await call('threads', {
    origin: WWW,
    mount: '/7',
    method: 'POST',
    body: { title: 'T', body: 'B' },
    headers: { 'idempotency-key': 'k' },
  });
  assert.equal(response.status, 201);
  assertPrivate(response);
  assert.equal(response.headers.get('location'), '/7/api/support/threads/t1');
  await response.arrayBuffer();
  assert.equal(proxy.seen[0].url, `${V1}/threads`);
  assert.equal(proxy.seen[0].headers['cf-access-client-id'], 'seven-access.access');
});

test('on www, only www itself may call /7/api/support/', async () => {
  upstream();
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { origin: SEVEN },
    { origin: 'https://www.sliccy.ai.evil.example' },
  ]) {
    const response = await call('threads', { origin: WWW, mount: '/7', headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assertPrivate(response);
    assert.deepEqual(await response.json(), { error: { code: 'forbidden' } });
  }
  assert.equal(proxy.seen.length, 0);
  const own = await call('threads', { origin: WWW, mount: '/7', headers: { origin: WWW } });
  assert.equal(own.status, 200);
  await own.arrayBuffer();
});

test('on www, /7/api/support/ has only the fixed routes, and the other checks', async () => {
  upstream();
  for (const [path, method, status] of [
    ['other', 'GET', 404],
    ['threads/a%2Fb', 'GET', 404],
    ['threads', 'DELETE', 405],
  ]) {
    const response = await call(path, { origin: WWW, mount: '/7', method });
    assert.equal(response.status, status, `${method} ${path}`);
    assertPrivate(response);
    await response.arrayBuffer();
  }
  for (const [path, init, status] of [
    ['threads', { headers: { authorization: '' } }, 401],
    ['threads?x=1', {}, 400],
    ['threads', { method: 'POST', body: { title: 'T', body: 'B' } }, 400],
  ]) {
    const response = await call(path, { origin: WWW, mount: '/7', ...init });
    assert.equal(response.status, status, path);
    await response.arrayBuffer();
  }
  assert.equal(proxy.seen.length, 0);
});

test("www's own /api/support/ stays SLICC 6's", async () => {
  upstream();
  proxy.six.length = 0;
  for (const path of ['/api/support/threads', '/70/api/support/threads']) {
    const response = await proxy.fetch(`${WWW}${path}`, {
      headers: { ...SAME, authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(await response.text(), 'six', path);
    assert.equal(response.headers.get('cache-control'), null);
  }
  assert.deepEqual(proxy.six, [
    { method: 'GET', url: `${WWW}/api/support/threads`, authorization: `Bearer ${TOKEN}` },
    { method: 'GET', url: `${WWW}/70/api/support/threads`, authorization: `Bearer ${TOKEN}` },
  ]);
  assert.equal(proxy.seen.length, 0);
});

test('www/7 uses the seven profile, and is unavailable without it', async () => {
  const bare = opspile({ SUPPORT_ACCESS_SECRET_SEVEN: '' });
  const response = await bare.fetch(`${WWW}/7/api/support/threads`, {
    headers: { ...SAME, authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'unavailable' } });
  assert.equal(bare.seen.length, 0);
});

const refusal = async (error, status = 403) => {
  upstream(status, { error });
  const response = await call('threads?limit=1');
  assert.equal(response.status, status);
  assertPrivate(response);
  return response.json();
};

test('not_enrolled passes a pending approval request on', async () => {
  assert.deepEqual(await refusal({ code: 'not_enrolled', request: 'pending', reason: 'hidden' }), {
    error: { code: 'not_enrolled', request: 'pending' },
  });
});

test('not_enrolled passes a declined request on, with or without its reason', async () => {
  assert.deepEqual(
    await refusal({
      code: 'not_enrolled',
      request: 'declined',
      reason: '  Ask Mara for access.  ',
    }),
    { error: { code: 'not_enrolled', request: 'declined', reason: 'Ask Mara for access.' } }
  );
  for (const reason of [undefined, '', '   ', 42, null, ['x'], { text: 'x' }, '\u0000\u0007']) {
    assert.deepEqual(
      await refusal({ code: 'not_enrolled', request: 'declined', reason }),
      { error: { code: 'not_enrolled', request: 'declined' } },
      JSON.stringify(reason)
    );
  }
});

test('a declined reason is stripped of control characters and capped at 500', async () => {
  const { error } = await refusal({
    code: 'not_enrolled',
    request: 'declined',
    reason: 'Line one.\r\n\tLine\u0000 two\u001b[31m\u007f\u0085 \u202eevil\u202c done',
  });
  assert.equal(error.reason, 'Line one. Line two[31m evil done');
  const long = await refusal({
    code: 'not_enrolled',
    request: 'declined',
    reason: `${'😀'.repeat(499)}ab${'x'.repeat(5000)}`,
  });
  assert.equal(Array.from(long.error.reason).length, 500);
  assert.equal(long.error.reason, `${'😀'.repeat(499)}a`);
});

test('any other request value, or field, is dropped', async () => {
  for (const request of [
    'approved',
    'Pending',
    'pending ',
    '',
    1,
    true,
    null,
    ['pending'],
    undefined,
  ]) {
    assert.deepEqual(
      await refusal({ code: 'not_enrolled', request, reason: 'x', detail: 'y' }),
      { error: { code: 'not_enrolled' } },
      JSON.stringify(request)
    );
  }
});

test('other codes keep only their code, whatever request they carry', async () => {
  for (const [status, code] of [
    [401, 'invalid_assertion'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
  ]) {
    assert.deepEqual(
      await refusal({ code, request: 'declined', reason: 'the message text' }, status),
      { error: { code } },
      code
    );
  }
});

test('on www, the approval state passes on too', async () => {
  upstream(403, { error: { code: 'not_enrolled', request: 'pending' } });
  const response = await call('threads?limit=1', { origin: WWW, mount: '/7' });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: { code: 'not_enrolled', request: 'pending' } });
});

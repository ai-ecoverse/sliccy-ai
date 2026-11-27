import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config, HOST, PILOT, row, SEVEN, source, UNKNOWN, WWW } from './relay.mjs';

const OPEN = { v: 1 };
const HIDDEN = {
  status: 404,
  headers: [
    ['cache-control', 'no-store'],
    ['referrer-policy', 'no-referrer'],
    ['x-content-type-options', 'nosniff'],
  ],
  text: '',
};
const preflight = (origin, method = 'POST', headers = 'content-type') => ({
  method: 'OPTIONS',
  headers: {
    ...(origin === null ? {} : { origin }),
    ...(method === null ? {} : { 'access-control-request-method': method }),
    ...(headers === null ? {} : { 'access-control-request-headers': headers }),
  },
});
const plain = ({ status, headers, text }) => ({ status, headers, text });
const untouched = (relay) => {
  assert.deepEqual(relay.live('Gate'), []);
  assert.deepEqual(relay.live('Mailbox'), []);
};
const ORIGIN_CHECK = 'return origin && allowed.includes(origin) ? origin : null;';

test('synthetic service test: the relay config is dark: gate off, no routes, no workers.dev, no previews, no logs', () => {
  assert.equal(config.vars.MAILBOX_GATE, 'off');
  assert.equal(config.vars.ALLOWED_ORIGINS, `${PILOT},${SEVEN}`);
  assert.equal(config.routes, undefined);
  assert.equal(config.route, undefined);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.observability, {
    enabled: false,
    logs: { enabled: false, invocation_logs: false },
  });
});

row(
  'gate off: every request, OPTIONS and a valid one included, is the same empty 404',
  async (relay) => {
    const answers = [
      await relay.post('/v1/open', OPEN),
      await relay.post('/v1/open', OPEN, { origin: SEVEN }),
      await relay.send('/v1/open', preflight(PILOT)),
      await relay.send('/v1/open', preflight(WWW)),
      await relay.send('/'),
      await relay.send('/v1/take', { method: 'GET', headers: { origin: PILOT } }),
      await relay.post('/v1/put', 'not json'),
      await relay.post('/v1/open', OPEN, { scheme: 'http://relay.test' }),
    ];
    for (const answer of answers) assert.deepEqual(plain(answer), HIDDEN);
    untouched(relay);
  },
  {
    options: { vars: { MAILBOX_GATE: config.vars.MAILBOX_GATE } },
    mutants: [
      {
        name: 'gate check removed',
        edits: [['worker.js', "if (env.MAILBOX_GATE !== 'on') return hidden();", '']],
      },
    ],
  }
);

for (const value of ['ON', 'true', '1', ' on', 'on ']) {
  row(
    `gate value ${JSON.stringify(value)} is not "on": the same empty 404`,
    async (relay) => {
      assert.deepEqual(plain(await relay.post('/v1/open', OPEN)), HIDDEN);
      untouched(relay);
    },
    { options: { vars: { MAILBOX_GATE: value } } }
  );
}

row(
  'gate on, plain http: the same empty 404 before the origin check, any body read or any DO',
  async (relay) => {
    for (const origin of [PILOT, SEVEN, null])
      assert.deepEqual(
        plain(await relay.post('/v1/open', OPEN, { origin, scheme: 'http://relay.test' })),
        HIDDEN
      );
    assert.deepEqual(
      plain(await relay.send('http://relay.test/v1/open', preflight(PILOT))),
      HIDDEN
    );
    untouched(relay);
    assert.equal((await relay.post('/v1/open', OPEN)).status, 200);
  },
  {
    mutants: [
      {
        name: 'https check removed',
        edits: [['worker.js', "if (url.protocol !== 'https:') return hidden();", '']],
      },
    ],
  }
);

row(
  'missing Origin is refused: the same empty 404, no CORS, no DO',
  async (relay) => {
    assert.deepEqual(plain(await relay.post('/v1/open', OPEN, { origin: null })), HIDDEN);
    assert.deepEqual(plain(await relay.post('/v1/open', OPEN, { origin: '' })), HIDDEN);
    assert.deepEqual(plain(await relay.send('/v1/open', preflight(null))), HIDDEN);
    untouched(relay);
  },
  {
    mutants: [
      {
        name: 'a missing Origin passes as the pilot origin',
        edits: [
          [
            'worker.js',
            ORIGIN_CHECK,
            `return !origin || allowed.includes(origin) ? origin || '${PILOT}' : null;`,
          ],
        ],
      },
    ],
  }
);

row(
  'https://www.sliccy.ai (and www/7) gets no CORS headers and no processing',
  async (relay) => {
    assert.deepEqual(plain(await relay.post('/v1/open', OPEN, { origin: WWW })), HIDDEN);
    assert.deepEqual(
      plain(await relay.post('/v1/open', OPEN, { origin: WWW, headers: { referer: `${WWW}/7/` } })),
      HIDDEN
    );
    assert.deepEqual(plain(await relay.send('/v1/open', preflight(WWW))), HIDDEN);
    assert.deepEqual(plain(await relay.post('/v1/take', { v: 1 }, { origin: WWW })), HIDDEN);
    untouched(relay);
  },
  {
    mutants: [
      {
        name: 'any *.sliccy.ai origin is allowed',
        edits: [
          [
            'worker.js',
            ORIGIN_CHECK,
            "return origin?.endsWith('.sliccy.ai') || allowed.includes(origin) ? origin : null;",
          ],
        ],
      },
    ],
  }
);

const OTHERS = [
  'https://evil.example',
  'https://sliccy.ai',
  'https://other.sliccy.ai',
  'https://lease-pilot.sliccy.ai.evil.example',
  'http://seven.sliccy.ai',
  'https://seven.sliccy.ai/',
  'https://SEVEN.sliccy.ai',
  'https://seven.sliccy.ai:443',
  'null',
  `${PILOT},${SEVEN}`,
];

row(
  'any other origin, sibling *.sliccy.ai included, gets no CORS headers and no processing',
  async (relay) => {
    for (const origin of OTHERS) {
      assert.deepEqual(plain(await relay.post('/v1/open', OPEN, { origin })), HIDDEN, origin);
      assert.deepEqual(plain(await relay.send('/v1/open', preflight(origin))), HIDDEN, origin);
    }
    untouched(relay);
  },
  {
    mutants: [
      { name: 'origin allowlist removed', edits: [['worker.js', ORIGIN_CHECK, 'return origin;']] },
    ],
  }
);

row(
  'an allowed origin gets its exact origin echoed, Vary: Origin and no Allow-Credentials',
  async (relay) => {
    for (const origin of [PILOT, SEVEN]) {
      const answers = [
        await relay.post('/v1/open', OPEN, { origin }),
        await relay.post('/v1/open', { v: 2 }, { origin }),
        await relay.send('/v1/open', preflight(origin)),
      ];
      for (const answer of answers) {
        assert.equal(answer.header('access-control-allow-origin'), origin);
        assert.equal(answer.header('vary'), 'Origin');
        assert.equal(answer.header('access-control-allow-credentials'), null);
      }
    }
  },
  {
    mutants: [
      {
        name: 'wildcard origin',
        edits: [
          [
            'worker.js',
            "{ 'access-control-allow-origin': origin, vary: 'Origin' }",
            "{ 'access-control-allow-origin': '*', vary: 'Origin' }",
          ],
        ],
      },
      {
        name: 'no Vary',
        edits: [
          [
            'worker.js',
            "{ 'access-control-allow-origin': origin, vary: 'Origin' }",
            "{ 'access-control-allow-origin': origin }",
          ],
        ],
      },
      {
        name: 'Allow-Credentials added',
        edits: [
          [
            'worker.js',
            "{ 'access-control-allow-origin': origin, vary: 'Origin' }",
            "{ 'access-control-allow-origin': origin, vary: 'Origin', 'access-control-allow-credentials': 'true' }",
          ],
        ],
      },
    ],
  }
);

row(
  'preflight: only POST with exactly content-type, short max-age, no DO',
  async (relay) => {
    for (const path of ['/v1/open', '/v1/put', '/v1/take']) {
      const ok = await relay.send(path, preflight(SEVEN));
      assert.equal(ok.status, 204);
      assert.equal(ok.text, '');
      assert.equal(ok.header('access-control-allow-methods'), 'POST');
      assert.equal(ok.header('access-control-allow-headers'), 'content-type');
      assert.ok(Number(ok.header('access-control-max-age')) <= 600);
    }
    assert.equal(
      (await relay.send('/v1/open', preflight(PILOT, 'POST', 'Content-Type'))).status,
      204
    );
    const refused = [
      preflight(PILOT, 'PUT'),
      preflight(PILOT, 'GET'),
      preflight(PILOT, 'post'),
      preflight(PILOT, null),
      preflight(PILOT, 'POST', null),
      preflight(PILOT, 'POST', 'content-type, x-extra'),
      preflight(PILOT, 'POST', 'authorization'),
      preflight(PILOT, 'POST', 'content-type,cookie'),
    ];
    for (const init of refused) assert.deepEqual(plain(await relay.send('/v1/open', init)), HIDDEN);
    assert.deepEqual(plain(await relay.send('/v1/other', preflight(PILOT))), HIDDEN);
    untouched(relay);
  },
  {
    mutants: [
      {
        name: 'requested method and headers not checked',
        edits: [
          [
            'worker.js',
            'return requested(request) ? preflight(cors, config.maxAge) : hidden();',
            'return preflight(cors, config.maxAge);',
          ],
        ],
      },
    ],
  }
);

row(
  'ids and tokens in a path or query are ignored and answer the same empty 404; GET and other paths 404',
  async (relay) => {
    const id = await relay.open();
    const body = { v: 1, id, slot: 'AAAAAAAAAAAAAAAAAAAAAA' };
    const tries = [
      () => relay.post(`/v1/take?id=${id}`, body),
      () => relay.post(`/v1/take?token=${id}`, body),
      () => relay.post('/v1/open?', OPEN),
      () => relay.post('/v1/open?x=1', OPEN),
      () => relay.post(`/v1/take/${id}`, body),
      () => relay.post(`/v1/take/${id}/AAAAAAAAAAAAAAAAAAAAAA`, body),
      () => relay.post('/v1/open/', OPEN),
      () => relay.post('/V1/open', OPEN),
      () => relay.post('//v1/open', OPEN),
      () => relay.post('/v1', OPEN),
      () => relay.post('/', OPEN),
      () => relay.post('/constructor', OPEN),
      () => relay.post('/__proto__', OPEN),
      () => relay.send('/v1/open', { headers: { origin: PILOT } }),
      () => relay.send('/v1/take', { method: 'DELETE', headers: { origin: PILOT } }),
      () => relay.send('/v1/put', { method: 'PUT', headers: { origin: PILOT }, body: '{}' }),
      () => relay.send('/v1/open', { method: 'HEAD', headers: { origin: PILOT } }),
    ];
    for (const [at, attempt] of tries.entries())
      assert.deepEqual(plain(await attempt()), HIDDEN, `attempt ${at}`);
    assert.equal(relay.live('Mailbox').length, 1);
    assert.equal(relay.live('Gate')[0].rows.opens.length, 1);
  },
  {
    mutants: [
      {
        name: 'query not refused',
        edits: [['worker.js', "url.href.includes('?') || ", '']],
      },
      {
        name: 'prefix path match',
        edits: [
          [
            'worker.js',
            'Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null',
            'ROUTES[Object.keys(ROUTES).find((path) => url.pathname.startsWith(path))] ?? null',
          ],
        ],
      },
      {
        name: 'any method accepted',
        edits: [['worker.js', "if (request.method !== 'POST') return hidden();", '']],
      },
    ],
  }
);

row(
  'every answer carries no-store, nosniff, no-referrer and nothing identifying',
  async (relay) => {
    const id = await relay.open();
    const answers = [
      await relay.post('/v1/open', OPEN),
      await relay.post('/v1/open', { v: 1 }),
      await relay.take(id, 'AAAAAAAAAAAAAAAAAAAAAA'),
      await relay.take(UNKNOWN, 'AAAAAAAAAAAAAAAAAAAAAA'),
      await relay.send('/v1/open', preflight(PILOT)),
      await relay.send('/nothing'),
      await relay.post('/v1/open', OPEN, { origin: WWW }),
    ];
    for (const answer of answers) {
      assert.equal(answer.header('cache-control'), 'no-store');
      assert.equal(answer.header('x-content-type-options'), 'nosniff');
      assert.equal(answer.header('referrer-policy'), 'no-referrer');
      for (const name of ['server', 'x-powered-by', 'set-cookie', 'x-sliccy-ai-version', 'etag'])
        assert.equal(answer.header(name), null);
    }
  },
  {
    mutants: [
      {
        name: 'nosniff dropped',
        edits: [['wire.js', "  'x-content-type-options': 'nosniff',\n", '']],
      },
      {
        name: 'no-store dropped',
        edits: [['wire.js', "  'cache-control': 'no-store',\n", '']],
      },
      {
        name: 'no-referrer dropped',
        edits: [['wire.js', "  'referrer-policy': 'no-referrer',\n", '']],
      },
    ],
  }
);

row(
  'no Set-Cookie ever, and a Cookie header changes nothing',
  async (relay) => {
    const cookie = { cookie: 'session=synthetic; relay=1' };
    const id = await relay.open({ headers: cookie });
    const with_ = await relay.take(id, 'AAAAAAAAAAAAAAAAAAAAAA', undefined, { headers: cookie });
    const without = await relay.take(id, 'AAAAAAAAAAAAAAAAAAAAAA');
    assert.deepEqual(plain(with_), plain(without));
    const answers = [
      with_,
      await relay.post('/v1/open', OPEN, { headers: cookie }),
      await relay.send('/v1/open', {
        ...preflight(PILOT),
        headers: { ...preflight(PILOT).headers, ...cookie },
      }),
      await relay.send('/', { headers: cookie }),
    ];
    for (const answer of answers) assert.equal(answer.header('set-cookie'), null);
    for (const file of ['worker.js', 'mailbox.js', 'gate.js', 'wire.js'])
      assert.doesNotMatch(source(file), /cookie/i);
  },
  {
    mutants: [
      {
        name: 'a cookie is set',
        edits: [
          [
            'wire.js',
            "  'referrer-policy': 'no-referrer',\n",
            "  'referrer-policy': 'no-referrer',\n  'set-cookie': 'relay=1; Secure',\n",
          ],
        ],
      },
      {
        name: 'a cookie is read',
        edits: [
          [
            'worker.js',
            "if (request.method !== 'POST') return hidden();",
            "if (request.method !== 'POST' || request.headers.has('cookie')) return hidden();",
          ],
        ],
      },
    ],
  }
);

row(
  'nothing is logged: no console output and no bodies, ids or tokens anywhere in the output',
  async (relay) => {
    const id = await relay.open();
    await relay.put(id, 'AAAAAAAAAAAAAAAAAAAAAA', 'A'.repeat(171), {});
    await relay.take(id, 'AAAAAAAAAAAAAAAAAAAAAA', 'B'.repeat(43));
    await relay.post('/v1/open', 'garbage');
    await relay.post('/v1/open', OPEN, { origin: WWW });
    await relay.take(UNKNOWN, 'AAAAAAAAAAAAAAAAAAAAAA');
    assert.equal(relay.output.join(''), '');
    for (const file of ['worker.js', 'mailbox.js', 'gate.js', 'wire.js'])
      assert.doesNotMatch(source(file), /console\.|debugger/);
  },
  {
    mutants: [
      {
        name: 'the body is logged',
        edits: [
          [
            'worker.js',
            'return route.run(body.value, env, config, cors);',
            'console.log(JSON.stringify(body.value));\n    return route.run(body.value, env, config, cors);',
          ],
        ],
      },
    ],
  }
);

test('synthetic service test: the relay is not wired to the main Worker', async () => {
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../../wrangler.json', import.meta.url), 'utf8');
  assert.doesNotMatch(main, /relay|Mailbox|MAILBOX/);
  assert.equal(new URL(HOST).protocol, 'https:');
});

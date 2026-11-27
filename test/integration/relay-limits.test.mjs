import assert from 'node:assert/strict';
import { bytes, config, PILOT, row, SEVEN, slot, token, UNKNOWN, verifier } from './relay.mjs';

const head = (lines) => `Origin: ${PILOT}\r\nContent-Type: application/json\r\n${lines}\r\n`;
const status = (raw) => Number(raw.split(' ')[1]);
const limit = (name) => config.ratelimits.find((entry) => entry.name === name).simple.limit;
const opens = (relay) => relay.live('Gate')[0]?.rows.opens.length ?? 0;

row(
  'an oversize Content-Length is refused from the header, before any body is read',
  async (relay) => {
    for (const length of ['8193', '9000', '99999999']) {
      const raw = await relay.raw('/v1/put', head(`Content-Length: ${length}\r\n`));
      assert.equal(status(raw), 413, length);
      assert.match(raw, /\r\ncache-control: no-store\r\n/i);
      assert.match(raw, /\{"v":1,"error":"too-large"\}$/);
    }
    assert.deepEqual(relay.live('Mailbox'), []);
  },
  {
    mutants: [
      {
        name: 'Content-Length cap not checked',
        edits: [
          [
            'worker.js',
            'if (!/^\\d{1,7}$/.test(header) || Number(header) > cap) return { status: 413 };',
            'if (!/^\\d{1,9}$/.test(header)) return { status: 413 };',
          ],
        ],
      },
    ],
  }
);

row(
  'a malformed Content-Length is refused before any body is read',
  async (relay) => {
    const json = JSON.stringify({ v: 1 });
    for (const length of ['-1', '1e3', '0x10', '10.0', '+5', '99999999999']) {
      const answer = await relay.lying('/v1/open', length, json);
      assert.equal(answer.status, 413, length);
    }
    assert.equal(relay.instances('Gate'), 0);
  },
  {
    mutants: [
      {
        name: 'Content-Length format not checked',
        edits: [
          [
            'worker.js',
            'if (!/^\\d{1,7}$/.test(header) || Number(header) > cap) return { status: 413 };',
            'if (Number(header) > cap) return { status: 413 };',
          ],
        ],
      },
    ],
  }
);

row(
  'a missing Content-Length (chunked) is refused before any body is read',
  async (relay) => {
    const raw = await relay.raw(
      '/v1/open',
      head('Transfer-Encoding: chunked\r\n') + '5\r\n{"v":\r\n'
    );
    assert.equal(status(raw), 411);
    assert.match(raw, /\{"v":1,"error":"length"\}$/);
  },
  {
    mutants: [
      {
        name: 'a missing Content-Length is read anyway',
        edits: [
          [
            'worker.js',
            'if (header === null) return { status: 411 };',
            'if (header === null) return { length: 8192 };',
          ],
        ],
      },
    ],
  }
);

row(
  'the body cap fits the largest legitimate put: a 4 KiB envelope is about 5.5 KiB of base64 in the JSON',
  async (relay) => {
    const id = await relay.open();
    const largest = {
      v: 1,
      id,
      slot: bytes(32, 9),
      data: bytes(4096),
      verifier: verifier(token(1)),
      final: true,
      reserve: [bytes(32, 10), bytes(32, 11), bytes(32, 12)],
    };
    const size = Buffer.byteLength(JSON.stringify(largest));
    assert.ok(size > 5462, String(size));
    assert.ok(size < 8192);
    assert.equal((await relay.post('/v1/put', largest)).status, 200);
    const padded = JSON.stringify({ ...largest, slot: bytes(32, 13) }).padEnd(8193, ' ');
    assert.equal((await relay.post('/v1/put', padded)).status, 413);
  },
  {
    mutants: [
      {
        name: 'body cap lowered to 4 KiB',
        edits: [['wire.js', 'body: 8192,', 'body: 4096,']],
      },
    ],
  }
);

row(
  'a closed schema: wrong content type, non-JSON, wrong version, unknown keys and wrong types are refused',
  async (relay) => {
    const id = await relay.open();
    const bad = [
      ['/v1/open', 'not json'],
      ['/v1/open', '[]'],
      ['/v1/open', 'null'],
      ['/v1/open', {}],
      ['/v1/open', { v: 2 }],
      ['/v1/open', { v: '1' }],
      ['/v1/open', { v: 1, extra: 1 }],
      ['/v1/open', '{"v":1,"__proto__":{}}'],
      ['/v1/open', { v: 1, ttlSeconds: 60 }],
      ['/v1/open', { v: 1, deadline: '1' }],
      ['/v1/open', { v: 1, deadline: 1.5 }],
      ['/v1/open', { v: 1, deadline: 1 }],
      ['/v1/put', { v: 1, id, slot: slot(1), data: bytes(128), token: token(1) }],
      ['/v1/put', { v: 1, id, slot: slot(1), data: 7 }],
      ['/v1/put', { v: 1, id: 7, slot: slot(1), data: bytes(128) }],
      ['/v1/put', { v: 1, id: `${id}A`, slot: slot(1), data: bytes(128) }],
      ['/v1/put', { v: 1, id, slot: bytes(15), data: bytes(128) }],
      ['/v1/put', { v: 1, id, slot: bytes(33), data: bytes(128) }],
      ['/v1/put', { v: 1, id, slot: slot(1), data: bytes(128), verifier: bytes(31) }],
      ['/v1/put', { v: 1, id, slot: slot(1), data: bytes(128), final: true }],
      ['/v1/put', { v: 1, id, slot: slot(1), data: bytes(128), reserve: [slot(2)] }],
      [
        '/v1/put',
        { v: 1, id, slot: slot(1), data: bytes(128), verifier: verifier(token(1)), final: false },
      ],
      [
        '/v1/put',
        {
          v: 1,
          id,
          slot: slot(1),
          data: bytes(128),
          verifier: verifier(token(1)),
          final: true,
          reserve: [slot(1)],
        },
      ],
      [
        '/v1/put',
        {
          v: 1,
          id,
          slot: slot(1),
          data: bytes(128),
          verifier: verifier(token(1)),
          final: true,
          reserve: [slot(2), slot(2)],
        },
      ],
      [
        '/v1/put',
        {
          v: 1,
          id,
          slot: slot(1),
          data: bytes(128),
          verifier: verifier(token(1)),
          final: true,
          reserve: [],
        },
      ],
      [
        '/v1/put',
        {
          v: 1,
          id,
          slot: slot(1),
          data: bytes(128),
          verifier: verifier(token(1)),
          final: true,
          reserve: [slot(2), slot(3), slot(4), slot(5)],
        },
      ],
      ['/v1/take', { v: 1, id, slot: slot(1), token: bytes(31) }],
      ['/v1/take', { v: 1, id, slot: slot(1), data: bytes(128) }],
      ['/v1/take', { v: 1, id }],
    ];
    for (const [path, body] of bad)
      assert.equal((await relay.post(path, body)).body?.error, 'invalid', JSON.stringify(body));
    const text = await relay.post(
      '/v1/open',
      { v: 1 },
      { headers: { 'content-type': 'text/plain' } }
    );
    assert.equal(text.status, 400);
    assert.equal(opens(relay), 1);
  },
  {
    mutants: [
      {
        name: 'unknown keys accepted',
        edits: [
          [
            'worker.js',
            "keys.every((key) => key === 'v' || required.includes(key) || optional.includes(key))",
            'true',
          ],
        ],
      },
      {
        name: 'version not checked',
        edits: [['worker.js', ' || input.v !== 1) return false;', ') return false;']],
      },
      {
        name: 'content type not checked',
        edits: [
          [
            'worker.js',
            "(request.headers.get('content-type') ?? '').toLowerCase() !== 'application/json'",
            'false',
          ],
        ],
      },
    ],
  }
);

row(
  'the per-source open rate limit acts before any DO is touched',
  async (relay) => {
    const cap = limit('OPENS');
    for (let at = 0; at < cap; at++) await relay.open({ ip: '198.51.100.1' });
    const refused = await relay.post('/v1/open', { v: 1 }, { ip: '198.51.100.1' });
    assert.equal(refused.status, 429);
    assert.deepEqual(refused.body, { v: 1, error: 'busy' });
    assert.equal(opens(relay), cap);
    assert.equal(relay.live('Mailbox').length, cap);
    await relay.open({ ip: '198.51.100.2' });
    assert.equal(opens(relay), cap + 1);
  },
  {
    options: { strict: { OPENS: { limit: limit('OPENS'), period: 60 } } },
    mutants: [
      {
        name: 'rate limit removed',
        edits: [['worker.js', 'if (!(await allow(env[route.limit], source))) {', 'if (false) {']],
      },
      {
        name: 'rate limit checked after the Gate DO',
        edits: [
          [
            'worker.js',
            'if (!(await allow(env[route.limit], source))) {',
            "if (route.limit !== 'OPENS' && !(await allow(env[route.limit], source))) {",
          ],
          [
            'worker.js',
            'if (!(await admitted.json()).admitted) return fail(429, cors);',
            "if (!(await admitted.json()).admitted || !(await allow(env.OPENS, 'all'))) return fail(429, cors);",
          ],
        ],
      },
    ],
  }
);

row(
  'the per-source put and take limits act before any DO is touched',
  async (relay) => {
    const id = await relay.open();
    for (let at = 0; at < 3; at++)
      assert.equal(
        (await relay.put(id, slot(at), bytes(128), {}, { ip: '198.51.100.3' })).status,
        200
      );
    const refused = await relay.put(id, slot(9), bytes(128), {}, { ip: '198.51.100.3' });
    assert.equal(refused.status, 429);
    assert.equal(
      (await relay.take(id, slot(9), undefined, { ip: '198.51.100.4' })).body.empty,
      true
    );
    for (let at = 0; at < 3; at++)
      assert.equal(
        (await relay.take(UNKNOWN, slot(at), undefined, { ip: '198.51.100.5' })).status,
        409
      );
    assert.equal((await relay.take(id, slot(0), undefined, { ip: '198.51.100.5' })).status, 429);
    assert.equal((await relay.take(id, slot(0), undefined, { ip: '198.51.100.6' })).status, 200);
  },
  {
    options: {
      strict: { WRITES: { limit: 3, period: 60 }, TAKES: { limit: 3, period: 60 } },
    },
    mutants: [
      {
        name: 'rate limit removed',
        edits: [['worker.js', 'if (!(await allow(env[route.limit], source))) {', 'if (false) {']],
      },
    ],
  }
);

row(
  'the per-id poll limit acts before any DO is touched, for every source',
  async (relay) => {
    const id = await relay.open();
    const other = await relay.open();
    for (let at = 0; at < 4; at++)
      assert.equal(
        (await relay.take(id, slot(1), undefined, { ip: `198.51.100.${10 + at}` })).status,
        200
      );
    const refused = await relay.take(id, slot(1), undefined, {
      ip: '198.51.100.20',
      origin: SEVEN,
    });
    assert.equal(refused.status, 429);
    assert.deepEqual(refused.body, { v: 1, error: 'busy' });
    const meta = relay.live('Mailbox').map(({ kv }) => kv.meta);
    assert.deepEqual(meta.map(({ empties }) => empties).sort(), [0, 4]);
    assert.equal((await relay.take(other, slot(1))).status, 200);
  },
  {
    options: { strict: { POLLS: { limit: 4, period: 60 } } },
    mutants: [
      {
        name: 'per-id poll limit removed',
        edits: [
          [
            'worker.js',
            'if (!(await allow(env.POLLS, await digest(new TextEncoder().encode(id))))) return fail(429, cors);',
            '',
          ],
        ],
      },
    ],
  }
);

row(
  'the per-id empty-read budget: empty polls stop, written slots and the token budget are untouched',
  async (relay) => {
    const id = await relay.open();
    const secret = token(1);
    await relay.put(id, slot(1), bytes(128));
    await relay.put(id, slot(2), bytes(256), { verifier: verifier(secret) });
    for (let at = 0; at < 3; at++) {
      const empty = await relay.take(id, slot(3));
      assert.deepEqual(empty.body, { v: 1, empty: true, retryAfterMs: 1000 });
    }
    assert.deepEqual((await relay.take(id, slot(3))).body, { v: 1, error: 'refused' });
    assert.equal((await relay.take(id, slot(1))).body.data, bytes(128));
    assert.equal((await relay.take(id, slot(2), secret)).body.data, bytes(256));
    assert.equal(relay.live('Mailbox')[0].kv.meta.attempts, 0);
  },
  {
    options: { limits: { empties: 3 } },
    mutants: [
      {
        name: 'empty-read budget removed',
        edits: [['mailbox.js', 'if (meta.empties >= this.limits.empties) return refused();', '']],
      },
    ],
  }
);

row(
  'the global cap on live mailboxes is counted by the Gate DO before any mailbox is made',
  async (relay) => {
    for (let at = 0; at < 3; at++) await relay.open({ ip: `198.51.100.${30 + at}` });
    const refused = await relay.post('/v1/open', { v: 1 }, { ip: '198.51.100.40' });
    assert.equal(refused.status, 429);
    assert.equal(relay.live('Mailbox').length, 3);
    assert.equal(opens(relay), 3);
    const stored = relay.live('Gate')[0].rows.opens;
    assert.deepEqual(Object.keys(stored[0]).sort(), ['expires', 'opened']);
  },
  {
    options: { limits: { live: 3 } },
    mutants: [
      {
        name: 'live cap removed',
        edits: [['gate.js', 'live >= this.limits.live || ', '']],
      },
    ],
  }
);

row(
  'the global cap on opens per hour',
  async (relay) => {
    for (let at = 0; at < 2; at++) await relay.open();
    assert.equal((await relay.post('/v1/open', { v: 1 })).status, 429);
    assert.equal(relay.live('Mailbox').length, 2);
  },
  {
    options: { limits: { hourly: 2 } },
    mutants: [
      { name: 'hourly cap removed', edits: [['gate.js', ' || hourly >= this.limits.hourly', '']] },
    ],
  }
);

row(
  'a lying Content-Length (smaller than the body) is caught while streaming, before any parse or DO',
  async (relay) => {
    const json = JSON.stringify({ v: 1 });
    for (const body of [json + ' '.repeat(9000), json + ' '.repeat(40)]) {
      const answer = await relay.lying('/v1/open', json.length, body);
      assert.equal(answer.status, 413);
      assert.equal(answer.text, '{"v":1,"error":"too-large"}');
    }
    assert.equal(relay.instances('Gate'), 0);
    assert.equal(relay.instances('Mailbox'), 0);
    const short = await relay.lying('/v1/open', 100, json);
    assert.equal(short.status, 400);
    assert.equal(relay.instances('Mailbox'), 0);
  },
  {
    mutants: [
      {
        name: 'streamed bytes not counted against the header',
        edits: [['worker.js', 'if (size > length || size > cap) {', 'if (size > cap) {']],
      },
      {
        name: 'streamed bytes not checked at all',
        edits: [
          ['worker.js', 'if (size > length || size > cap) {', 'if (false) {'],
          ['worker.js', 'if (size !== length) return { status: 400 };', ''],
        ],
      },
    ],
  }
);

const burn = async (relay, wrong) => {
  const id = await relay.open();
  await relay.put(id, slot(1), bytes(128));
  await relay.put(id, slot(2), bytes(256), { verifier: verifier(token(1)) });
  for (let at = 0; at < wrong; at++) await relay.take(id, slot(2), token(10 + at));
  return id;
};

row(
  'a RELAY_LIMITS value larger than a default leaves the default',
  async (relay) => {
    const id = await burn(relay, 5);
    assert.deepEqual((await relay.take(id, slot(1))).body, { v: 1, error: 'refused' });
    assert.deepEqual(relay.live('Mailbox'), []);
    const raw = await relay.raw('/v1/open', head('Content-Length: 9000\r\n'));
    assert.equal(status(raw), 413);
  },
  {
    options: { vars: { RELAY_LIMITS: '{"attempts":50,"body":100000}' } },
    mutants: [
      {
        name: 'a larger value is taken',
        edits: [
          [
            'wire.js',
            'merged[key] = Math.min(LIMITS[key], extra[key]);',
            'merged[key] = extra[key];',
          ],
        ],
      },
    ],
  }
);

row(
  'malformed RELAY_LIMITS values (a string, zero, negative, fractional) leave the defaults',
  async (relay) => {
    const id = await burn(relay, 4);
    assert.deepEqual((await relay.take(id, slot(1))).body, { v: 1, data: bytes(128) });
    assert.deepEqual((await relay.take(id, slot(3))).body, {
      v: 1,
      empty: true,
      retryAfterMs: 1000,
    });
    assert.equal(relay.live('Mailbox')[0].kv.meta.attempts, 4);
  },
  {
    options: {
      vars: { RELAY_LIMITS: '{"attempts":"1","empties":0,"refusals":-3,"requests":1.5}' },
    },
    mutants: [
      {
        name: 'values not type-checked',
        edits: [
          [
            'wire.js',
            'if (Number.isSafeInteger(extra[key]) && extra[key] > 0)',
            'if (extra[key] !== undefined)',
          ],
        ],
      },
    ],
  }
);

for (const value of ['not json', '[1]', 'null', '"1"'])
  row(
    `an unparsable or non-object RELAY_LIMITS (${value}) leaves the defaults`,
    async (relay) => {
      const id = await burn(relay, 4);
      assert.deepEqual((await relay.take(id, slot(1))).body, { v: 1, data: bytes(128) });
      assert.equal(relay.live('Mailbox')[0].kv.meta.attempts, 4);
    },
    {
      options: { vars: { RELAY_LIMITS: value } },
      mutants:
        value === 'not json'
          ? [
              {
                name: 'parse errors not caught',
                edits: [
                  [
                    'wire.js',
                    "try {\n    extra = JSON.parse(env.RELAY_LIMITS ?? '{}') ?? {};\n  } catch {}",
                    "extra = JSON.parse(env.RELAY_LIMITS ?? '{}') ?? {};",
                  ],
                ],
              },
            ]
          : [],
    }
  );

row(
  'an over-budget empty read is a plain refusal: it never counts as a refusal and never wipes the mailbox',
  async (relay) => {
    const id = await relay.open();
    await relay.put(id, slot(1), bytes(4096), { verifier: verifier(token(1)) });
    for (let at = 0; at < 2; at++)
      assert.deepEqual((await relay.take(id, slot(9))).body, {
        v: 1,
        empty: true,
        retryAfterMs: 1000,
      });
    for (let at = 0; at < 4; at++)
      assert.deepEqual((await relay.take(id, slot(9))).body, { v: 1, error: 'refused' });
    assert.equal(relay.live('Mailbox').length, 1);
    assert.equal(relay.live('Mailbox')[0].kv.meta.refusals, 0);
    assert.deepEqual((await relay.take(id, slot(1), token(1))).body, { v: 1, data: bytes(4096) });
  },
  {
    options: { limits: { empties: 2, refusals: 2 } },
    mutants: [
      {
        name: 'over-budget empty reads spend the refusal budget',
        edits: [
          [
            'mailbox.js',
            'if (meta.empties >= this.limits.empties) return refused();',
            'if (meta.empties >= this.limits.empties) return this.refuse(meta);',
          ],
        ],
      },
    ],
  }
);

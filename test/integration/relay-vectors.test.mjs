import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { LIMITS, MAX_TTL_SECONDS, SIZES } from '../../relay/src/wire.js';
import { config, row } from './relay.mjs';

const vectors = JSON.parse(readFileSync(new URL('../../relay/vectors.json', import.meta.url)));

const EXPRESSION = /^\$([A-Z_]+)\+(\d+)$/;

function fill(value, bound) {
  if (typeof value === 'string') {
    const sum = EXPRESSION.exec(value);
    if (sum) return bound[sum[1]] + Number(sum[2]);
    if (/^\$[A-Za-z_]+$/.test(value)) return bound[value.slice(1)];
    return value.replace(/\$([A-Za-z_]+)/g, (_, name) => bound[name]);
  }
  if (Array.isArray(value)) return value.map((entry) => fill(entry, bound));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, fill(entry, bound)])
    );
  return value;
}

function match(actual, expected, bound, where) {
  if (typeof expected === 'string' && EXPRESSION.test(expected)) {
    assert.equal(actual, fill(expected, bound), where);
    return;
  }
  if (typeof expected === 'string' && /^\$[A-Za-z_]+$/.test(expected)) {
    const name = expected.slice(1);
    if (name in bound) assert.deepEqual(actual, bound[name], where);
    else {
      assert.ok(['string', 'number'].includes(typeof actual), where);
      bound[name] = actual;
    }
    return;
  }
  if (expected && typeof expected === 'object') {
    assert.ok(actual && typeof actual === 'object', where);
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), where);
    for (const key of Object.keys(expected))
      match(actual[key], expected[key], bound, `${where}.${key}`);
    return;
  }
  assert.deepEqual(actual, expected, where);
}

async function replay(relay, scenario) {
  const created = Date.now();
  await relay.now(created);
  const deadline = created + MAX_TTL_SECONDS * 1000;
  const bound = { RETRY_AFTER_MS: LIMITS.retryAfterMs, CREATED: created, DEADLINE: deadline };
  for (const [at, step] of scenario.steps.entries()) {
    if (step.clock) {
      const base = step.clock.from === 'creation' ? created : deadline;
      await relay.now(base + step.clock.offsetMs);
      continue;
    }
    const where = `${scenario.name} step ${at}`;
    const request = fill(step.request, bound);
    const origin = request.origin ?? vectors.defaultOrigin;
    const method = request.method ?? 'POST';
    const answer =
      method === 'POST'
        ? await relay.post(request.path, request.body, { origin, headers: request.headers ?? {} })
        : await relay.send(request.path, { method, headers: { origin, ...request.headers } });
    const expected = step.response;
    assert.equal(answer.status, expected.status, where);
    if ('text' in expected) assert.equal(answer.text, expected.text, where);
    if ('body' in expected) match(answer.body, expected.body, bound, where);
    for (const [name, value] of Object.entries(expected.headers ?? {}))
      assert.equal(answer.header(name), value, `${where} ${name}`);
    for (const name of expected.absent ?? [])
      assert.equal(answer.header(name), null, `${where} ${name}`);
  }
}

test('synthetic service test: the vectors use the relay constants and whole-envelope sizes', () => {
  assert.deepEqual(vectors.envelopeSizes, SIZES);
  assert.deepEqual(vectors.origins, config.vars.ALLOWED_ORIGINS.split(','));
  assert.doesNotMatch(JSON.stringify(vectors), new RegExp(`\\b${MAX_TTL_SECONDS}(000)?\\b`));
  for (const { token, verifier } of vectors.tokens)
    assert.equal(
      createHash('sha256').update(Buffer.from(token, 'base64url')).digest('base64url'),
      verifier
    );
});

const MUTANTS = {
  'session: setup, audience, excerpt, receipt; only the reserved receipt slot is writable after the excerpt take':
    [
      {
        name: 'no closure',
        edits: [
          [
            'mailbox.js',
            'const closed = meta.closed || meta.final === slot;',
            'const closed = meta.closed;',
          ],
        ],
      },
      {
        name: 'unverified read is destructive',
        edits: [
          [
            'mailbox.js',
            "if (proof === null) return answer('data', { data: stored.data });",
            "if (proof === null) {\n        this.kv.delete(key);\n        return answer('data', { data: stored.data });\n      }",
          ],
        ],
      },
    ],
  'five wrong tokens destroy the mailbox': [
    {
      name: 'attempt budget removed',
      edits: [
        ['mailbox.js', 'if (attempts >= this.limits.attempts) await this.wipe();\n    else ', ''],
      ],
    },
  ],
  'absolute expiry: everything works just before the deadline and nothing at it': [
    {
      name: 'longer constant',
      edits: [
        ['wire.js', 'export const MAX_TTL_SECONDS = 120;', 'export const MAX_TTL_SECONDS = 121;'],
      ],
    },
    {
      name: 'deadline checked only by the alarm',
      edits: [['mailbox.js', 'if (meta.expiresAt <= Date.now()) {', 'if (false) {']],
    },
  ],
  'delayed setup and activity never extend the deadline: no renewal by put, take, poll or retry': [
    {
      name: 'renewal by any request',
      edits: [
        [
          'mailbox.js',
          'const counted = { ...meta, requests: meta.requests + 1 };',
          'const counted = { ...meta, requests: meta.requests + 1, expiresAt: Date.now() + 120000 };',
        ],
      ],
    },
  ],
  'only whole-envelope sizes; 4 KiB + 1 and base64 framing mistakes are refused': [
    {
      name: 'size allowlist removed',
      edits: [['worker.js', 'if (!SIZES.includes(bytes.length)) return fail(400, cors);', '']],
    },
  ],
};

for (const scenario of vectors.scenarios)
  row(`vector: ${scenario.name}`, (relay) => replay(relay, scenario), {
    options: { clock: true },
    mutants: MUTANTS[scenario.name] ?? [],
  });

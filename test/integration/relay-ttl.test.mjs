import assert from 'node:assert/strict';
import { MAX_TTL_SECONDS } from '../../relay/src/wire.js';
import { bytes, row, sleep, slot, token, verifier } from './relay.mjs';

const TTL = MAX_TTL_SECONDS * 1000;
const REFUSED = { v: 1, error: 'refused' };
const EMPTY = { v: 1, empty: true, retryAfterMs: 1000 };
const CLOCK = { clock: true };
const RENEW = 'expiresAt: Date.now() + 120000';
const EXPIRY = 'if (meta.expiresAt <= Date.now()) {';
const WIPE_ON_EXPIRY = `${EXPIRY}\n      await this.wipe();\n      return refused();\n    }`;
const PUT_META = "this.kv.put('meta', {\n      ...meta,\n      slots: meta.slots + fresh,";
const verified = (secret, extra = {}) => ({ verifier: verifier(secret), ...extra });

async function session(relay, extra = {}) {
  const t0 = Date.now();
  await relay.now(t0);
  const answer = await relay.post('/v1/open', { v: 1, ...extra });
  assert.equal(answer.status, 200);
  return { t0, id: answer.body.id, expiresAt: answer.body.expiresAt };
}

row(
  'one absolute constant: MAX_TTL_SECONDS is 120 and a mailbox expires exactly that long after creation',
  async (relay) => {
    assert.equal(MAX_TTL_SECONDS, 120);
    const { t0, id, expiresAt } = await session(relay);
    assert.equal(expiresAt, t0 + TTL);
    await relay.put(id, slot(1), bytes(128));
    await relay.now(t0 + TTL - 1);
    assert.equal((await relay.take(id, slot(1))).body.data, bytes(128));
    await relay.now(t0 + TTL);
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'longer constant',
        edits: [
          ['wire.js', 'export const MAX_TTL_SECONDS = 120;', 'export const MAX_TTL_SECONDS = 121;'],
        ],
      },
      {
        name: 'boundary off by one',
        edits: [['mailbox.js', EXPIRY, 'if (meta.expiresAt < Date.now()) {']],
      },
    ],
  }
);

row(
  'fake-clock delayed setup: the deadline runs from creation, not from the first slot',
  async (relay) => {
    const { t0, id } = await session(relay);
    await relay.now(t0 + 100_000);
    assert.equal((await relay.put(id, slot(1), bytes(128))).status, 200);
    await relay.now(t0 + TTL - 1);
    assert.equal((await relay.take(id, slot(1))).body.data, bytes(128));
    await relay.now(t0 + TTL);
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
    assert.deepEqual((await relay.put(id, slot(2), bytes(128))).body, REFUSED);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'clock starts at the first slot',
        edits: [
          [
            'mailbox.js',
            PUT_META,
            "this.kv.put('meta', {\n      ...meta,\n      expiresAt: meta.slots === 0 ? Date.now() + 120000 : meta.expiresAt,\n      slots: meta.slots + fresh,",
          ],
        ],
      },
    ],
  }
);

const PHASES = {
  async setup(relay, id) {
    return relay.put(id, slot(2), bytes(128));
  },
  async audience(relay, id) {
    await relay.put(id, slot(3), bytes(1024), verified(token(3)));
    return { take: () => relay.take(id, slot(3), token(3)) };
  },
  async excerpt(relay, id) {
    await relay.put(
      id,
      slot(4),
      bytes(4096),
      verified(token(4), { final: true, reserve: [slot(5)] })
    );
    return { take: () => relay.take(id, slot(4), token(4)) };
  },
  async receipt(relay, id) {
    await relay.put(
      id,
      slot(4),
      bytes(4096),
      verified(token(4), { final: true, reserve: [slot(5)] })
    );
    await relay.take(id, slot(4), token(4));
    return { put: () => relay.put(id, slot(5), bytes(256), verified(token(5))) };
  },
};

row(
  'the absolute deadline holds in every phase: setup, audience, excerpt and receipt',
  async (relay) => {
    for (const phase of Object.keys(PHASES)) {
      for (const offset of [-1, 0]) {
        const { t0, id } = await session(relay);
        await relay.put(id, slot(1), bytes(128));
        await relay.now(t0 + 1000);
        const prepared = await PHASES[phase](relay, id);
        await relay.now(t0 + TTL + offset);
        const answer =
          phase === 'setup'
            ? await relay.take(id, slot(2))
            : prepared.take
              ? await prepared.take()
              : await prepared.put();
        const where = `${phase} at deadline ${offset}`;
        if (offset < 0) assert.equal(answer.status, 200, where);
        else assert.deepEqual(answer.body, REFUSED, where);
      }
    }
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'boundary off by one',
        edits: [['mailbox.js', EXPIRY, 'if (meta.expiresAt < Date.now()) {']],
      },
    ],
  }
);

row(
  'an earlier deadline shortens the session; a later one never lengthens it',
  async (relay) => {
    const short = await session(relay, { deadline: Date.now() + 5000 });
    assert.equal(short.expiresAt, short.t0 + 5000);
    await relay.now(short.t0 + 4999);
    assert.deepEqual((await relay.take(short.id, slot(1))).body, EMPTY);
    await relay.now(short.t0 + 5000);
    assert.deepEqual((await relay.take(short.id, slot(1))).body, REFUSED);
    const long = await session(relay, { deadline: Date.now() + 10 * TTL });
    assert.equal(long.expiresAt, long.t0 + TTL);
    const t0 = Date.now();
    await relay.now(t0);
    assert.equal((await relay.post('/v1/open', { v: 1, deadline: t0 })).status, 400);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'deadline ignored',
        edits: [
          [
            'worker.js',
            'Math.min(now + MAX_TTL_SECONDS * 1000, deadline ?? Number.POSITIVE_INFINITY)',
            'now + MAX_TTL_SECONDS * 1000',
          ],
        ],
      },
      {
        name: 'a later deadline lengthens the session',
        edits: [
          [
            'worker.js',
            'Math.min(now + MAX_TTL_SECONDS * 1000, deadline ?? Number.POSITIVE_INFINITY)',
            'Math.max(now + MAX_TTL_SECONDS * 1000, deadline ?? 0)',
          ],
        ],
      },
    ],
  }
);

row(
  'a late message is refused although the expiry alarm has not run yet',
  async (relay) => {
    const { t0, id } = await session(relay);
    await relay.put(id, slot(1), bytes(128));
    await relay.put(id, slot(2), bytes(256), verified(token(2)));
    await relay.now(t0 + TTL);
    assert.equal(relay.live('Mailbox').length, 1);
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(2), token(2))).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(3))).body, REFUSED);
    assert.deepEqual((await relay.put(id, slot(4), bytes(128))).body, REFUSED);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'deadline checked only by the alarm',
        edits: [['mailbox.js', EXPIRY, 'if (false) {']],
      },
    ],
  }
);

row(
  'no extension or reset by poll, read, write, wrong-token retry or any other request',
  async (relay) => {
    const { t0, id } = await session(relay);
    await relay.put(id, slot(1), bytes(128));
    await relay.put(id, slot(2), bytes(256), verified(token(2)));
    for (let at = 10_000; at < TTL; at += 10_000) {
      await relay.now(t0 + at);
      assert.deepEqual((await relay.take(id, slot(9))).body, EMPTY);
    }
    await relay.now(t0 + TTL - 1000);
    await relay.take(id, slot(1));
    await relay.take(id, slot(2), token(7));
    await relay.put(id, slot(3), bytes(128));
    await relay.put(id, slot(3), bytes(128));
    await relay.take(id, slot(9));
    await relay.now(t0 + TTL);
    assert.deepEqual((await relay.take(id, slot(9))).body, REFUSED);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'renewal by poll',
        edits: [
          [
            'mailbox.js',
            "this.kv.put('meta', { ...meta, empties: meta.empties + 1 });",
            `this.kv.put('meta', { ...meta, empties: meta.empties + 1, ${RENEW} });`,
          ],
        ],
      },
      {
        name: 'renewal by read',
        edits: [
          [
            'mailbox.js',
            "if (proof === null) return answer('data', { data: stored.data });",
            `if (proof === null) {\n        this.kv.put('meta', { ...meta, ${RENEW} });\n        return answer('data', { data: stored.data });\n      }`,
          ],
        ],
      },
      {
        name: 'renewal by write',
        edits: [
          [
            'mailbox.js',
            PUT_META,
            `this.kv.put('meta', {\n      ...meta,\n      ${RENEW},\n      slots: meta.slots + fresh,`,
          ],
        ],
      },
      {
        name: 'renewal by wrong-token retry',
        edits: [
          [
            'mailbox.js',
            "else this.kv.put('meta', { ...meta, attempts });",
            `else this.kv.put('meta', { ...meta, attempts, ${RENEW} });`,
          ],
        ],
      },
      {
        name: 'renewal by a refused retry',
        edits: [
          [
            'mailbox.js',
            "else this.kv.put('meta', { ...meta, refusals });",
            `else this.kv.put('meta', { ...meta, refusals, ${RENEW} });`,
          ],
        ],
      },
      {
        name: 'renewal by any request',
        edits: [
          [
            'mailbox.js',
            'const counted = { ...meta, requests: meta.requests + 1 };',
            `const counted = { ...meta, requests: meta.requests + 1, ${RENEW} };`,
          ],
        ],
      },
    ],
  }
);

row(
  'no consume, replay or reopen on a late message',
  async (relay) => {
    const { t0, id } = await session(relay);
    await relay.now(t0 + 1000);
    await relay.put(id, slot(1), bytes(4096), verified(token(1), { final: true }));
    await relay.now(t0 + TTL);
    assert.deepEqual((await relay.take(id, slot(1), token(1))).body, REFUSED);
    assert.deepEqual(relay.live('Mailbox'), []);
    await relay.now(t0 + 1000);
    assert.deepEqual((await relay.take(id, slot(1), token(1))).body, REFUSED);
    assert.deepEqual((await relay.put(id, slot(1), bytes(128))).body, REFUSED);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'a late take is served',
        edits: [['mailbox.js', EXPIRY, "if (op === '/put' && meta.expiresAt <= Date.now()) {"]],
      },
      {
        name: 'transparent reopen',
        edits: [
          [
            'mailbox.js',
            WIPE_ON_EXPIRY,
            `${EXPIRY}\n      this.kv.put('meta', { ...meta, ${RENEW} });\n      return refused();\n    }`,
          ],
        ],
      },
    ],
  }
);

row(
  'no put at Prepare: open takes no payload and creates an empty mailbox',
  async (relay) => {
    for (const extra of [{ data: bytes(128) }, { slot: slot(1) }, { ttlSeconds: 60 }])
      assert.equal((await relay.post('/v1/open', { v: 1, ...extra })).status, 400);
    const { id } = await session(relay);
    const [{ kv }] = relay.live('Mailbox');
    assert.deepEqual(Object.keys(kv), ['meta']);
    assert.deepEqual((await relay.take(id, slot(1))).body, EMPTY);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'open accepts a payload',
        edits: [
          [
            'worker.js',
            "if (!shape(input, [], ['deadline'])) return fail(400, cors);",
            "if (!shape(input, [], ['deadline', 'data', 'slot', 'ttlSeconds'])) return fail(400, cors);",
          ],
        ],
      },
    ],
  }
);

row(
  'the alarm at the absolute deadline deletes everything without any further request',
  async (relay) => {
    await relay.now(Date.now() - TTL + 1000);
    const id = (await relay.post('/v1/open', { v: 1 })).body.id;
    await relay.put(id, slot(1), bytes(128));
    await relay.put(id, slot(2), bytes(4096), verified(token(1)));
    assert.equal(relay.live('Mailbox').length, 1);
    await sleep(2000);
    assert.deepEqual(relay.live('Mailbox'), []);
  },
  {
    options: CLOCK,
    mutants: [
      {
        name: 'no alarm',
        edits: [['mailbox.js', 'await this.ctx.storage.setAlarm(expiresAt);', '']],
      },
    ],
  }
);

const CRASH_PUT = ['mailbox.js', PUT_META, `throw new Error('synthetic crash');\n    ${PUT_META}`];
const CATCH = "  } catch {\n    return { state: 'failed' };\n  }";

row(
  'lost ack: an unknown outcome is not proof of no insertion, and the relay never retries',
  async (relay) => {
    const id = await relay.open();
    const lost = await relay.put(id, slot(1), bytes(128));
    assert.equal(lost.status, 503);
    assert.deepEqual(lost.body, { v: 1, error: 'failed' });
    assert.deepEqual((await relay.put(id, slot(1), bytes(128))).body, REFUSED);
    assert.equal((await relay.take(id, slot(1))).body.data, bytes(128));
  },
  {
    options: { edits: [CRASH_PUT] },
    mutants: [
      {
        name: 'the relay retries on failure',
        edits: [
          CRASH_PUT,
          [
            'worker.js',
            CATCH,
            "  } catch {\n    const again = await stub.fetch(`https://mailbox/${op}`, { method: 'POST', body: JSON.stringify(body) });\n    return await again.json();\n  }",
          ],
        ],
      },
      {
        name: 'an unknown outcome reported as success',
        edits: [CRASH_PUT, ['worker.js', CATCH, "  } catch {\n    return { state: 'ok' };\n  }"]],
      },
    ],
  }
);

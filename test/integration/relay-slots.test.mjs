import assert from 'node:assert/strict';
import { MAX_TTL_SECONDS } from '../../relay/src/wire.js';
import { bytes, PILOT, row, SEVEN, slot, token, UNKNOWN, verifier } from './relay.mjs';

const REFUSED = { v: 1, error: 'refused' };
const ENVELOPES = [128, 256, 1024, 4096];
const plain = ({ status, headers, text }) => ({ status, headers, text });
const verified = (secret, extra = {}) => ({ verifier: verifier(secret), ...extra });
const VERIFY =
  'if (proof === null || !this.matches(stored.verifier, proof)) return this.wrong(meta);';
const TAKEN = 'this.kv.put(key, { written: true, taken: true, reserved: stored.reserved });';
const CRASH_TAKE = ['mailbox.js', TAKEN, `${TAKEN}\n      throw new Error('synthetic crash');`];
const TAKE_TX = 'this.ctx.storage.transactionSync(() => {\n      this.kv.put(key,';
const NO_TAKE_TX = ['mailbox.js', TAKE_TX, '((run) => run())(() => {\n      this.kv.put(key,'];

row(
  'slots are write-once, and of racing writes to one slot exactly one wins',
  async (relay) => {
    const id = await relay.open();
    assert.equal((await relay.put(id, slot(1), bytes(128, 1))).status, 200);
    assert.deepEqual((await relay.put(id, slot(1), bytes(128, 2))).body, REFUSED);
    assert.deepEqual(
      (await relay.put(id, slot(1), bytes(128, 2), verified(token(1)))).body,
      REFUSED
    );
    assert.equal((await relay.take(id, slot(1))).body.data, bytes(128, 1));
    assert.equal((await relay.put(id, slot(2), bytes(256), verified(token(2)))).status, 200);
    assert.deepEqual((await relay.put(id, slot(2), bytes(256, 3))).body, REFUSED);
    const racers = await Promise.all(
      Array.from({ length: 8 }, (_, at) => relay.put(id, slot(3), bytes(128, at)))
    );
    assert.equal(racers.filter(({ status }) => status === 200).length, 1);
  },
  {
    mutants: [
      {
        name: 'second write accepted',
        edits: [['mailbox.js', 'if (held?.written) return this.refuse(meta);', '']],
      },
    ],
  }
);

row(
  'only whole-envelope sizes 128 B, 256 B, 1 KiB and 4 KiB are stored; 4 KiB + 1 and base64 framing mistakes are refused',
  async (relay) => {
    const id = await relay.open();
    for (const [at, size] of ENVELOPES.entries())
      assert.equal((await relay.put(id, slot(at), bytes(size))).status, 200, String(size));
    for (const size of [1, 127, 129, 255, 257, 512, 1023, 1025, 4095, 4097]) {
      const answer = await relay.put(id, slot(100 + size), bytes(size));
      assert.deepEqual(answer.body, { v: 1, error: 'invalid' }, String(size));
    }
    const envelope = Buffer.from(bytes(4096), 'base64url');
    const mistakes = [
      envelope.toString('base64'),
      Buffer.from(envelope.toString('base64url')).toString('base64url'),
      `${bytes(4096)}=`,
      `${bytes(4096)}\n`,
      ` ${bytes(128)}`,
      bytes(128).replace(/.$/, 'B'),
    ];
    for (const [at, data] of mistakes.entries())
      assert.equal((await relay.put(id, slot(200 + at), data)).status, 400, String(at));
  },
  {
    mutants: [
      {
        name: 'size allowlist removed',
        edits: [['worker.js', 'if (!SIZES.includes(bytes.length)) return fail(400, cors);', '']],
      },
      {
        name: 'non-canonical base64url accepted',
        edits: [['wire.js', ' || encode(bytes) !== text) return null;', ') return null;']],
      },
    ],
  }
);

row(
  'at most 12 slots (reservations included) and 16 KiB per mailbox',
  async (relay) => {
    const id = await relay.open();
    for (let at = 0; at < 4; at++)
      assert.equal((await relay.put(id, slot(at), bytes(4096))).status, 200);
    assert.deepEqual((await relay.put(id, slot(4), bytes(128))).body, REFUSED);
    const other = await relay.open();
    for (let at = 0; at < 9; at++)
      assert.equal((await relay.put(other, slot(at), bytes(128))).status, 200);
    const extra = verified(token(1), { final: true, reserve: [slot(20), slot(21)] });
    assert.equal((await relay.put(other, slot(9), bytes(128), extra)).status, 200);
    assert.deepEqual((await relay.put(other, slot(22), bytes(128))).body, REFUSED);
    assert.equal((await relay.put(other, slot(20), bytes(128), verified(token(2)))).status, 200);
  },
  {
    mutants: [
      {
        name: 'slot count not capped',
        edits: [['mailbox.js', 'meta.slots + fresh > this.limits.slots || ', '']],
      },
      {
        name: 'total not capped',
        edits: [['mailbox.js', ' || meta.total + size > this.limits.total', '']],
      },
    ],
  }
);

row(
  'an unverified slot is read non-destructively by a second client until expiry',
  async (relay) => {
    const id = await relay.open();
    await relay.put(id, slot(1), bytes(128), {}, { origin: PILOT, ip: '198.51.100.1' });
    for (const [origin, ip] of [
      [SEVEN, '198.51.100.2'],
      [PILOT, '198.51.100.3'],
      [SEVEN, '198.51.100.2'],
      [PILOT, '198.51.100.1'],
    ]) {
      const answer = await relay.take(id, slot(1), undefined, { origin, ip });
      assert.deepEqual(answer.body, { v: 1, data: bytes(128) });
    }
  },
  {
    mutants: [
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
  }
);

row(
  'a verified slot is one-shot: a wrong token is refused, the right one reads the bytes unmodified once, a replay is refused',
  async (relay) => {
    const id = await relay.open();
    const secret = token(1);
    await relay.put(id, slot(1), bytes(1024), verified(secret));
    assert.deepEqual((await relay.take(id, slot(1), token(2))).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(1), secret)).body, { v: 1, data: bytes(1024) });
    assert.deepEqual((await relay.take(id, slot(1), secret)).body, REFUSED);
  },
  {
    mutants: [
      { name: 'token not checked', edits: [['mailbox.js', VERIFY, '']] },
      { name: 'not deleted on read', edits: [['mailbox.js', TAKEN, '']] },
    ],
  }
);

row(
  'a wrong token burns only the attempt budget: the slot, the empty-read budget and later right tokens are untouched',
  async (relay) => {
    const id = await relay.open();
    const secret = token(1);
    await relay.put(id, slot(1), bytes(256), verified(secret));
    for (let at = 0; at < 4; at++) await relay.take(id, slot(1), token(10 + at));
    const meta = relay.live('Mailbox')[0].kv.meta;
    assert.equal(meta.attempts, 4);
    assert.equal(meta.empties, 0);
    assert.equal(meta.refusals, 0);
    assert.deepEqual((await relay.take(id, slot(1), secret)).body, { v: 1, data: bytes(256) });
  },
  {
    mutants: [
      {
        name: 'a wrong token consumes the slot',
        edits: [
          [
            'mailbox.js',
            VERIFY,
            'if (proof === null || !this.matches(stored.verifier, proof)) {\n      this.kv.delete(key);\n      return this.wrong(meta);\n    }',
          ],
        ],
      },
    ],
  }
);

row(
  'five wrong tokens destroy the mailbox and everything in it',
  async (relay) => {
    const id = await relay.open();
    const secret = token(1);
    await relay.put(id, slot(1), bytes(128));
    await relay.put(id, slot(2), bytes(256), verified(secret));
    for (let at = 0; at < 5; at++)
      assert.deepEqual((await relay.take(id, slot(2), token(10 + at))).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(2), secret)).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
    assert.deepEqual((await relay.put(id, slot(3), bytes(128))).body, REFUSED);
    assert.deepEqual(relay.live('Mailbox'), []);
  },
  {
    mutants: [
      {
        name: 'attempt budget removed',
        edits: [
          ['mailbox.js', 'if (attempts >= this.limits.attempts) await this.wipe();\n    else ', ''],
        ],
      },
    ],
  }
);

row(
  'cross-id and reused tokens are refused: a token works only on its own slot in its own mailbox',
  async (relay) => {
    const first = await relay.open();
    const second = await relay.open();
    const a = token(1);
    const b = token(2);
    await relay.put(first, slot(1), bytes(128, 1), verified(a));
    await relay.put(second, slot(1), bytes(128, 2), verified(b));
    await relay.put(first, slot(2), bytes(128, 3), verified(b));
    await relay.put(first, slot(3), bytes(128, 4));
    assert.deepEqual((await relay.take(second, slot(1), a)).body, REFUSED);
    assert.deepEqual((await relay.take(first, slot(2), a)).body, REFUSED);
    assert.deepEqual((await relay.take(first, slot(3), a)).body, REFUSED);
    assert.equal((await relay.take(first, slot(1), a)).body.data, bytes(128, 1));
    assert.deepEqual((await relay.take(first, slot(1), a)).body, REFUSED);
    assert.equal((await relay.take(second, slot(1), b)).body.data, bytes(128, 2));
    const meta = Object.fromEntries(relay.live('Mailbox').map(({ kv }) => [kv.meta.attempts, 1]));
    assert.deepEqual(Object.keys(meta).sort(), ['1', '2']);
  },
  {
    mutants: [
      { name: 'token not checked', edits: [['mailbox.js', VERIFY, '']] },
      {
        name: 'a token on an unverified slot is ignored',
        edits: [
          [
            'mailbox.js',
            "if (proof === null) return answer('data', { data: stored.data });\n      return this.wrong(meta);",
            "return answer('data', { data: stored.data });",
          ],
        ],
      },
    ],
  }
);

row(
  'the verdict on a token comes from crypto.subtle.timingSafeEqual',
  async (relay) => {
    const id = await relay.open();
    await relay.put(id, slot(1), bytes(128), verified(token(1)));
    assert.deepEqual((await relay.take(id, slot(1), token(2))).body, { v: 1, data: bytes(128) });
  },
  {
    options: {
      prelude:
        "Object.defineProperty(crypto.subtle, 'timingSafeEqual', { value: (a, b) => a.byteLength === 32 && b.byteLength === 32 });\n",
    },
    mutants: [
      {
        name: 'plain string compare',
        edits: [
          [
            'mailbox.js',
            'return crypto.subtle.timingSafeEqual(decode(verifier, 32, 32), decode(proof, 32, 32));',
            'return verifier === proof;',
          ],
        ],
      },
      {
        name: 'early-exit byte loop',
        edits: [
          [
            'mailbox.js',
            'return crypto.subtle.timingSafeEqual(decode(verifier, 32, 32), decode(proof, 32, 32));',
            'const a = decode(verifier, 32, 32);\n    const b = decode(proof, 32, 32);\n    for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;\n    return true;',
          ],
        ],
      },
    ],
  }
);

row(
  'racing takes of a verified slot: exactly one wins',
  async (relay) => {
    const id = await relay.open();
    const secret = token(1);
    await relay.put(id, slot(1), bytes(4096), verified(secret));
    const racers = await Promise.all(
      Array.from({ length: 10 }, (_, at) =>
        relay.take(id, slot(1), secret, { ip: `198.51.100.${at + 1}` })
      )
    );
    assert.equal(racers.filter(({ body }) => body.data === bytes(4096)).length, 1);
    assert.equal(racers.filter(({ body }) => body.error === 'refused').length, 9);
  },
  {
    mutants: [
      {
        name: 'read and delete not atomic',
        edits: [
          [
            'mailbox.js',
            'const stored = this.kv.get(key);',
            'const stored = this.kv.get(key);\n    await new Promise((resolve) => setTimeout(resolve, 20));',
          ],
        ],
      },
    ],
  }
);

row(
  'after the final slot is taken only already-reserved response slots are writable; the receipt slot then closes the mailbox',
  async (relay) => {
    const id = await relay.open();
    const excerpt = token(1);
    const receipt = token(2);
    await relay.put(id, slot(1), bytes(128, 1));
    await relay.put(id, slot(2), bytes(128, 2));
    await relay.put(id, slot(3), bytes(1024), verified(token(3)));
    const final = verified(excerpt, { final: true, reserve: [slot(9)] });
    assert.equal((await relay.put(id, slot(4), bytes(4096), final)).status, 200);
    assert.deepEqual(
      (await relay.put(id, slot(5), bytes(128), verified(token(5), { final: true }))).body,
      REFUSED
    );
    assert.equal((await relay.take(id, slot(4), excerpt)).body.data, bytes(4096));
    assert.deepEqual((await relay.put(id, slot(6), bytes(128))).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(4), excerpt)).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(9), receipt)).body.empty, true);
    assert.equal((await relay.put(id, slot(9), bytes(256), verified(receipt))).status, 200);
    assert.deepEqual((await relay.put(id, slot(9), bytes(256), verified(receipt))).body, REFUSED);
    assert.equal((await relay.take(id, slot(1))).body.data, bytes(128, 1));
    assert.equal((await relay.take(id, slot(9), receipt)).body.data, bytes(256));
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
    assert.deepEqual(relay.live('Mailbox'), []);
  },
  {
    mutants: [
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
        name: 'reservations ignored',
        edits: [
          [
            'mailbox.js',
            'if (meta.closed && !held?.reserved) return this.refuse(meta);',
            'if (meta.closed) return this.refuse(meta);',
          ],
        ],
      },
      {
        name: 'a settled mailbox is kept',
        edits: [['mailbox.js', 'if (closed && this.settled()) await this.wipe();', '']],
      },
    ],
  }
);

row(
  'a final slot taken without reservations closes and destroys the mailbox at once',
  async (relay) => {
    const id = await relay.open();
    await relay.put(id, slot(1), bytes(128));
    await relay.put(id, slot(2), bytes(4096), verified(token(1), { final: true }));
    assert.equal((await relay.take(id, slot(2), token(1))).body.data, bytes(4096));
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
    assert.deepEqual((await relay.put(id, slot(3), bytes(128))).body, REFUSED);
    assert.deepEqual(relay.live('Mailbox'), []);
  },
  {
    mutants: [
      {
        name: 'a settled mailbox is kept',
        edits: [['mailbox.js', 'if (closed && this.settled()) await this.wipe();', '']],
      },
    ],
  }
);

row(
  'uniform errors: unknown, guessed, expired, closed, destroyed, taken, written and wrong-token answers are byte-identical',
  async (relay) => {
    const answers = [];
    const live = await relay.open();
    await relay.put(live, slot(1), bytes(128), verified(token(1)));
    await relay.put(live, slot(2), bytes(128));
    answers.push(await relay.take(UNKNOWN, slot(1)));
    answers.push(await relay.take(UNKNOWN, slot(1), token(1)));
    answers.push(await relay.put(UNKNOWN, slot(1), bytes(128)));
    answers.push(
      await relay.take(
        live.replace(/.$/, (c) => (c === '0' ? '1' : '0')),
        slot(1)
      )
    );
    answers.push(await relay.take(live, slot(1), token(2)));
    answers.push(await relay.take(live, slot(2), token(2)));
    answers.push(await relay.put(live, slot(2), bytes(128)));
    await relay.take(live, slot(1), token(1));
    answers.push(await relay.take(live, slot(1), token(1)));
    const closed = await relay.open();
    await relay.put(
      closed,
      slot(1),
      bytes(128),
      verified(token(1), { final: true, reserve: [slot(5)] })
    );
    await relay.take(closed, slot(1), token(1));
    answers.push(await relay.put(closed, slot(2), bytes(128)));
    const short = await relay.open();
    await relay.put(short, slot(1), bytes(128));
    const gone = await relay.open();
    await relay.put(gone, slot(1), bytes(128), verified(token(1), { final: true }));
    await relay.take(gone, slot(1), token(1));
    answers.push(await relay.take(gone, slot(1), token(1)));
    answers.push(await relay.put(gone, slot(2), bytes(128)));
    await relay.now(Date.now() + MAX_TTL_SECONDS * 1000);
    answers.push(await relay.take(short, slot(1)));
    answers.push(await relay.put(short, slot(2), bytes(128)));
    const reference = plain(answers[0]);
    assert.deepEqual(answers[0].body, REFUSED);
    for (const [at, answer] of answers.entries())
      assert.deepEqual(plain(answer), reference, String(at));
  },
  {
    options: { clock: true },
    mutants: [
      {
        name: 'an unknown id answers differently',
        edits: [
          [
            'worker.js',
            "if (!stub) return { state: 'refused' };",
            "if (!stub) return { state: 'unknown' };",
          ],
          [
            'worker.js',
            "return fail(result.state === 'failed' ? 503 : 409, cors);",
            'return reply(409, { error: result.state }, cors);',
          ],
        ],
      },
      {
        name: 'a wrong token answers differently',
        edits: [
          [
            'mailbox.js',
            '    return refused();\n  }\n\n  async wipe() {',
            "    return answer('wrong');\n  }\n\n  async wipe() {",
          ],
          [
            'worker.js',
            "return fail(result.state === 'failed' ? 503 : 409, cors);",
            "return result.state === 'wrong' ? reply(403, { error: 'refused' }, cors) : fail(409, cors);",
          ],
        ],
      },
    ],
  }
);

row(
  'storage holds only envelopes, public values, hashes and counters: no token, slot id or mailbox id',
  async (relay) => {
    const id = await relay.open();
    const secret = token(1);
    const receipt = token(2);
    await relay.put(id, slot(1), bytes(128));
    await relay.put(
      id,
      slot(2),
      bytes(4096),
      verified(secret, { final: true, reserve: [slot(3)] })
    );
    await relay.take(id, slot(2), token(9));
    await relay.put(id, slot(3), bytes(256), verified(receipt));
    const [{ blob, kv }] = relay.live('Mailbox');
    for (const value of [secret, receipt, token(9), slot(1), slot(2), slot(3), id])
      assert.equal(blob.includes(value), false, value);
    assert.equal(blob.includes(bytes(4096)), true);
    assert.equal(blob.includes(verifier(secret)), true);
    for (const key of Object.keys(kv)) assert.match(key, /^(meta|slot:[A-Za-z0-9_-]{43})$/);
    const [gate] = relay.live('Gate');
    assert.deepEqual(Object.keys(gate.rows.opens[0]).sort(), ['expires', 'opened']);
    assert.equal(gate.blob.includes(id), false);
  },
  {
    mutants: [
      {
        name: 'slot ids stored in the clear',
        edits: [['worker.js', 'slot: await digest(name),\n    data,', 'slot,\n    data,']],
      },
    ],
  }
);

row(
  'guessed or malformed ids never touch or allocate a DO',
  async (relay) => {
    const id = await relay.open();
    assert.equal(relay.instances('Mailbox'), 1);
    const guesses = [
      UNKNOWN,
      'f'.repeat(64),
      id.replace(/^./, (c) => (c === '0' ? '1' : '0')),
      id.replace(/.$/, (c) => (c === '0' ? '1' : '0')),
    ];
    for (const guess of guesses) {
      assert.deepEqual((await relay.take(guess, slot(1))).body, REFUSED);
      assert.deepEqual((await relay.put(guess, slot(1), bytes(128))).body, REFUSED);
    }
    for (const malformed of [id.toUpperCase(), `${id}0`, id.slice(1), 'gate', '', 7])
      assert.equal((await relay.take(malformed, slot(1))).status, 400);
    assert.equal(relay.instances('Mailbox'), 1);
    assert.equal(relay.instances('Gate'), 1);
  },
  {
    mutants: [
      {
        name: 'mailboxes addressed with idFromName',
        edits: [
          [
            'worker.js',
            'return env.MAILBOX.get(env.MAILBOX.idFromString(id));',
            'return env.MAILBOX.get(env.MAILBOX.idFromName(id));',
          ],
        ],
      },
    ],
  }
);

row(
  'a take that fails inside its transaction answers 503 and consumes nothing; the relay never replays',
  async (relay) => {
    const id = await relay.open();
    const secret = token(1);
    await relay.put(id, slot(1), bytes(1024), verified(secret));
    const failed = await relay.take(id, slot(1), secret);
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { v: 1, error: 'failed' });
    assert.equal(failed.header('cache-control'), 'no-store');
    assert.equal(
      relay.live('Mailbox')[0].kv[
        Object.keys(relay.live('Mailbox')[0].kv).find((key) => key.startsWith('slot:'))
      ].data,
      bytes(1024)
    );
    assert.equal((await relay.take(id, slot(1), secret)).status, 503);
  },
  {
    options: { edits: [CRASH_TAKE] },
    mutants: [
      { name: 'take not transactional', edits: [CRASH_TAKE, NO_TAKE_TX] },
      {
        name: 'a DO failure is not caught',
        options: {},
        edits: [
          CRASH_TAKE,
          ['worker.js', "  } catch {\n    return { state: 'failed' };\n  }", '  } finally {\n  }'],
        ],
      },
    ],
  }
);

row(
  'the per-mailbox total request budget destroys the mailbox',
  async (relay) => {
    const id = await relay.open();
    await relay.put(id, slot(1), bytes(128));
    for (let at = 0; at < 4; at++) assert.equal((await relay.take(id, slot(1))).status, 200);
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
    assert.deepEqual(relay.live('Mailbox'), []);
  },
  {
    options: { limits: { requests: 5 } },
    mutants: [
      {
        name: 'total budget removed',
        edits: [['mailbox.js', 'if (counted.requests > this.limits.requests) {', 'if (false) {']],
      },
    ],
  }
);

row(
  'repeated refused puts and takes are bounded: the refusal budget destroys the mailbox',
  async (relay) => {
    const id = await relay.open();
    await relay.put(id, slot(1), bytes(128));
    await relay.put(id, slot(2), bytes(128), verified(token(1)));
    await relay.take(id, slot(2), token(1));
    assert.deepEqual((await relay.put(id, slot(1), bytes(128))).body, REFUSED);
    assert.deepEqual((await relay.take(id, slot(2), token(1))).body, REFUSED);
    assert.equal(relay.live('Mailbox').length, 1);
    assert.deepEqual((await relay.put(id, slot(1), bytes(128))).body, REFUSED);
    assert.deepEqual(relay.live('Mailbox'), []);
    assert.deepEqual((await relay.take(id, slot(1))).body, REFUSED);
  },
  {
    options: { limits: { refusals: 3 } },
    mutants: [
      {
        name: 'refusal budget removed',
        edits: [
          ['mailbox.js', 'if (refusals >= this.limits.refusals) await this.wipe();\n    else ', ''],
        ],
      },
    ],
  }
);

row(
  'a well-formed but never-opened id stores nothing, keeps no DO state and is refused uniformly',
  async (relay) => {
    const forged = [await relay.mint(), await relay.mint()];
    const reference = plain(await relay.take(UNKNOWN, slot(1)));
    for (const id of forged) {
      assert.deepEqual(plain(await relay.take(id, slot(1))), reference);
      assert.deepEqual(plain(await relay.take(id, slot(1), token(1))), reference);
      assert.deepEqual(plain(await relay.put(id, slot(1), bytes(128))), reference);
      assert.deepEqual(
        plain(await relay.put(id, slot(2), bytes(256), verified(token(1)))),
        reference
      );
      assert.deepEqual(plain(await relay.take(id, slot(1))), reference);
    }
    assert.deepEqual(relay.live('Mailbox'), []);
    for (const { rows } of relay.stored('Mailbox')) assert.deepEqual(rows, {});
    assert.equal(relay.instances('Gate'), 0);
  },
  {
    mutants: [
      {
        name: 'an unknown id is counted',
        edits: [
          [
            'mailbox.js',
            'if (!meta) return refused();',
            "if (!meta) {\n      this.kv.put('seen', 1);\n      return refused();\n    }",
          ],
        ],
      },
      {
        name: 'an unknown id is opened on first use',
        edits: [
          [
            'mailbox.js',
            'if (!meta) return refused();',
            "if (!meta) await this.open({ expiresAt: Date.now() + 120000 });\n    if (!this.kv.get('meta')) return refused();",
          ],
          [
            'mailbox.js',
            'const counted = { ...meta, requests: meta.requests + 1 };',
            "const current = this.kv.get('meta');\n    const counted = { ...current, requests: current.requests + 1 };",
          ],
        ],
      },
    ],
  }
);

row(
  'a final-slot take that fails inside its transaction keeps the only copy and leaves the mailbox open',
  async (relay) => {
    const id = await relay.open();
    await relay.put(
      id,
      slot(1),
      bytes(4096),
      verified(token(1), { final: true, reserve: [slot(2)] })
    );
    assert.equal((await relay.take(id, slot(1), token(1))).status, 503);
    const [{ kv }] = relay.live('Mailbox');
    assert.equal(kv.meta.closed, false);
    const stored = Object.entries(kv)
      .filter(([key]) => key.startsWith('slot:'))
      .map(([, v]) => v);
    assert.equal(stored.filter((value) => value.data === bytes(4096) && !value.taken).length, 1);
    assert.equal((await relay.put(id, slot(3), bytes(128))).status, 200);
  },
  {
    options: { edits: [CRASH_TAKE] },
    mutants: [{ name: 'take not transactional', edits: [CRASH_TAKE, NO_TAKE_TX] }],
  }
);

row(
  'a reserved slot is writable only with a verifier, so the receipt is one-shot and settles the mailbox',
  async (relay) => {
    const id = await relay.open();
    await relay.put(
      id,
      slot(1),
      bytes(4096),
      verified(token(1), { final: true, reserve: [slot(2)] })
    );
    assert.deepEqual((await relay.put(id, slot(2), bytes(256))).body, REFUSED);
    assert.equal((await relay.take(id, slot(1), token(1))).body.data, bytes(4096));
    assert.deepEqual((await relay.put(id, slot(2), bytes(256))).body, REFUSED);
    assert.equal((await relay.put(id, slot(2), bytes(256), verified(token(2)))).status, 200);
    assert.equal((await relay.take(id, slot(2), token(2))).body.data, bytes(256));
    assert.deepEqual(relay.live('Mailbox'), []);
  },
  {
    mutants: [
      {
        name: 'an unverified reserved write accepted',
        edits: [['mailbox.js', 'if (held?.reserved && !verifier) return this.refuse(meta);', '']],
      },
    ],
  }
);

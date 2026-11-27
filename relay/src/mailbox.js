import { answer, decode, limits } from './wire.js';

const refused = () => answer('refused');

export class Mailbox {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.kv = ctx.storage.kv;
    this.limits = limits(env);
  }

  async fetch(request) {
    const op = new URL(request.url).pathname;
    const input = await request.json();
    if (op === '/open') return this.open(input);
    const meta = this.kv.get('meta');
    if (!meta) return refused();
    if (meta.expiresAt <= Date.now()) {
      await this.wipe();
      return refused();
    }
    const counted = { ...meta, requests: meta.requests + 1 };
    if (counted.requests > this.limits.requests) {
      await this.wipe();
      return refused();
    }
    this.kv.put('meta', counted);
    if (op === '/put') return this.put(counted, input);
    return this.take(counted, input);
  }

  async open({ expiresAt }) {
    if (this.kv.get('meta')) return refused();
    this.kv.put('meta', {
      expiresAt,
      requests: 0,
      refusals: 0,
      attempts: 0,
      empties: 0,
      slots: 0,
      total: 0,
      final: null,
      closed: false,
    });
    await this.ctx.storage.setAlarm(expiresAt);
    return answer('ok');
  }

  put(meta, { slot, data, size, verifier, final, reserve }) {
    const key = `slot:${slot}`;
    const held = this.kv.get(key);
    if (held?.written) return this.refuse(meta);
    if (meta.closed && !held?.reserved) return this.refuse(meta);
    if (final && meta.final !== null) return this.refuse(meta);
    const named = [...new Set([slot, ...reserve])];
    const fresh = named.filter((name) => this.kv.get(`slot:${name}`) === undefined).length;
    if (meta.slots + fresh > this.limits.slots || meta.total + size > this.limits.total)
      return this.refuse(meta);
    for (const name of reserve)
      if (this.kv.get(`slot:${name}`) === undefined)
        this.kv.put(`slot:${name}`, { reserved: true });
    this.kv.put(key, {
      written: true,
      reserved: held?.reserved === true,
      data,
      ...(verifier ? { verifier } : {}),
    });
    this.kv.put('meta', {
      ...meta,
      slots: meta.slots + fresh,
      total: meta.total + size,
      final: final ? slot : meta.final,
    });
    return answer('ok');
  }

  async take(meta, { slot, proof }) {
    const key = `slot:${slot}`;
    const stored = this.kv.get(key);
    if (!stored?.written) {
      if (meta.empties >= this.limits.empties) return this.refuse(meta);
      this.kv.put('meta', { ...meta, empties: meta.empties + 1 });
      return answer('empty', { retryAfterMs: this.limits.retryAfterMs });
    }
    if (stored.taken) return this.refuse(meta);
    if (stored.verifier === undefined) {
      if (proof === null) return answer('data', { data: stored.data });
      return this.wrong(meta);
    }
    if (proof === null || !this.matches(stored.verifier, proof)) return this.wrong(meta);
    this.kv.put(key, { written: true, taken: true, reserved: stored.reserved });
    const closed = meta.closed || meta.final === slot;
    this.kv.put('meta', { ...meta, closed });
    if (closed && this.settled()) await this.wipe();
    return answer('data', { data: stored.data });
  }

  matches(verifier, proof) {
    return crypto.subtle.timingSafeEqual(decode(verifier, 32, 32), decode(proof, 32, 32));
  }

  settled() {
    for (const [, value] of this.kv.list({ prefix: 'slot:' }))
      if (value.reserved && !value.taken) return false;
    return true;
  }

  async refuse(meta) {
    const refusals = meta.refusals + 1;
    if (refusals >= this.limits.refusals) await this.wipe();
    else this.kv.put('meta', { ...meta, refusals });
    return refused();
  }

  async wrong(meta) {
    const attempts = meta.attempts + 1;
    if (attempts >= this.limits.attempts) await this.wipe();
    else this.kv.put('meta', { ...meta, attempts });
    return refused();
  }

  async wipe() {
    for (const [key] of [...this.kv.list()]) this.kv.delete(key);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm() {
    await this.wipe();
  }
}

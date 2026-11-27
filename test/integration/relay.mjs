import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { deserialize } from 'node:v8';
import { Miniflare } from 'miniflare';

const root = new URL('../../relay/', import.meta.url);
const FILES = ['worker.js', 'mailbox.js', 'gate.js', 'wire.js'];
export const config = JSON.parse(readFileSync(new URL('wrangler.jsonc', root), 'utf8'));
export const PILOT = 'https://lease-pilot.sliccy.ai';
export const SEVEN = 'https://seven.sliccy.ai';
export const WWW = 'https://www.sliccy.ai';
export const HOST = 'https://relay.test';

export const source = (file) => readFileSync(new URL(`src/${file}`, root), 'utf8');

export const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
export const bytes = (size, seed = 1) =>
  b64(Uint8Array.from({ length: size }, (_, at) => (seed * 131 + at * 37) & 255));
const derived = (label, seed, size) =>
  createHash('sha256').update(`${label}:${seed}`).digest().subarray(0, size).toString('base64url');
export const slot = (seed) => derived('slot', seed, 16);
export const token = (seed) => derived('token', seed, 32);
export const verifier = (value) =>
  createHash('sha256').update(Buffer.from(value, 'base64url')).digest('base64url');

const DRIVER = `export default {
  async fetch(request, env) {
    const { path, origin, declared, body } = await request.json();
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
    const response = await env.RELAY.fetch('https://relay.test' + path, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json', 'content-length': declared },
      body: stream,
    });
    return Response.json({ status: response.status, text: await response.text() });
  },
};`;

const CLOCK = [
  'worker.js',
  'async fetch(request, env) {',
  "async fetch(request, env) {\n    if (request.headers.has('x-test-now')) globalThis.fakeNow = Number(request.headers.get('x-test-now'));",
];
const CLOCK_PRELUDE =
  'const realNow = Date.now;\nDate.now = () => globalThis.fakeNow ?? realNow();\n';

export function mutate(edits) {
  const files = Object.fromEntries(FILES.map((file) => [file, source(file)]));
  for (const [file, from, to] of edits) {
    assert.equal(files[file].split(from).length, 2, `the mutant anchor is unique in ${file}`);
    files[file] = files[file].replace(from, () => to);
  }
  return files;
}

function ratelimits(strict) {
  return Object.fromEntries(
    config.ratelimits.map(({ name, ...rest }) => [
      name,
      {
        ...rest,
        simple: strict === true ? rest.simple : (strict?.[name] ?? { limit: 100000, period: 60 }),
      },
    ])
  );
}

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
      )
    : [];

export function snap(response, text) {
  const transport = ['transfer-encoding', 'content-length'];
  const headers = [...response.headers]
    .filter(([name]) => !name.startsWith('mf-') && !transport.includes(name))
    .sort();
  return { status: response.status, headers, text };
}

export async function start({ edits = [], vars = {}, limits, strict, prelude = '', clock } = {}) {
  const files = mutate(clock ? [CLOCK, ...edits] : edits);
  files['worker.js'] = (clock ? CLOCK_PRELUDE : '') + prelude + files['worker.js'];
  const dir = mkdtempSync(join(tmpdir(), 'relay-'));
  const output = [];
  const mf = new Miniflare({
    workers: [
      {
        name: config.name,
        modules: FILES.map((file) => ({
          type: 'ESModule',
          path: fileURLToPath(new URL(`src/${file}`, root)),
          contents: files[file],
        })),
        modulesRoot: fileURLToPath(new URL('src/', root)),
        compatibilityDate: config.compatibility_date,
        bindings: {
          ...config.vars,
          MAILBOX_GATE: 'on',
          ...(limits ? { RELAY_LIMITS: JSON.stringify(limits) } : {}),
          ...vars,
        },
        durableObjects: Object.fromEntries(
          config.durable_objects.bindings.map((entry) => [
            entry.name,
            { className: entry.class_name, useSQLite: true },
          ])
        ),
        ratelimits: ratelimits(strict),
      },
      {
        name: 'driver',
        modules: true,
        script: DRIVER,
        compatibilityDate: config.compatibility_date,
        serviceBindings: { RELAY: config.name },
      },
    ],
    durableObjectsPersist: dir,
    port: 0,
    handleRuntimeStdio(out, err) {
      out.on('data', (chunk) => output.push(String(chunk)));
      err.on('data', (chunk) => output.push(String(chunk)));
    },
  });
  const url = await mf.ready;

  const relay = {
    mf,
    output,
    async send(path, init = {}) {
      const response = await mf.dispatchFetch(new URL(path, HOST), init);
      const text = await response.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {}
      return { ...snap(response, text), response, body, header: (n) => response.headers.get(n) };
    },
    post(path, body, { origin = PILOT, ip = '203.0.113.7', headers = {}, scheme = HOST } = {}) {
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return relay.send(new URL(path, scheme), {
        method: 'POST',
        headers: {
          ...(origin === null ? {} : { origin }),
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(text)),
          'cf-connecting-ip': ip,
          ...headers,
        },
        body: text,
      });
    },
    async open(options = {}, extra = {}) {
      const answer = await relay.post('/v1/open', { v: 1, ...extra }, options);
      assert.equal(answer.status, 200);
      return answer.body.id;
    },
    put(id, name, data, extra = {}, options = {}) {
      return relay.post('/v1/put', { v: 1, id, slot: name, data, ...extra }, options);
    },
    take(id, name, secret, options = {}) {
      const body = { v: 1, id, slot: name, ...(secret === undefined ? {} : { token: secret }) };
      return relay.post('/v1/take', body, options);
    },
    raw(path, head, { wait = 1500 } = {}) {
      return new Promise((resolve, reject) => {
        const socket = net.connect(Number(url.port), url.hostname, () => {
          socket.write(
            `POST ${path} HTTP/1.1\r\nHost: relay.test\r\nMF-Original-URL: ${HOST}${path}\r\n${head}`
          );
        });
        let data = '';
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new assert.AssertionError({ message: 'no answer before the body was sent' }));
        }, wait);
        socket.on('data', (chunk) => {
          data += String(chunk);
          const [top, rest] = data.split('\r\n\r\n');
          if (rest === undefined) return;
          const length = Number(/content-length: (\d+)/i.exec(top)?.[1] ?? 0);
          if (Buffer.byteLength(rest) < length) return;
          clearTimeout(timer);
          socket.destroy();
          resolve(data);
        });
        socket.on('error', () => {});
      });
    },
    async now(ms) {
      await mf.dispatchFetch(`${HOST}/`, { headers: { 'x-test-now': String(ms) } });
    },
    async lying(path, declared, body, origin = PILOT) {
      const driver = await mf.getWorker('driver');
      const response = await driver.fetch('https://driver.test/', {
        method: 'POST',
        body: JSON.stringify({ path, origin, declared: String(declared), body }),
      });
      return response.json();
    },
    instances(className) {
      return walk(join(dir, `${config.name}-${className}`)).filter(
        (file) => file.endsWith('.sqlite') && !file.endsWith('metadata.sqlite')
      ).length;
    },
    stored(className) {
      const files = walk(join(dir, `${config.name}-${className}`)).filter(
        (file) => file.endsWith('.sqlite') && !file.endsWith('metadata.sqlite')
      );
      return files.map((file) => {
        const db = new DatabaseSync(file, { readOnly: true });
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all()
          .map(({ name }) => name);
        const rows = Object.fromEntries(
          tables.map((name) => {
            const statement = db.prepare(`SELECT * FROM "${name}"`);
            statement.setReadBigInts(true);
            return [name, statement.all()];
          })
        );
        db.close();
        const kv = Object.fromEntries(
          (rows._cf_KV ?? []).map(({ key, value }) => [key, deserialize(Buffer.from(value))])
        );
        const blob = Buffer.concat(
          Object.values(rows)
            .flat()
            .flatMap((row) => Object.values(row))
            .map((value) =>
              value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(String(value))
            )
        );
        return { file, rows, kv, blob };
      });
    },
    live(className) {
      return relay
        .stored(className)
        .filter(({ rows }) => Object.values(rows).some((list) => list.length > 0));
    },
    async close() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return relay;
}

export function row(name, run, { options = {}, mutants = [] } = {}) {
  test(`synthetic service test: ${name}`, async () => {
    const relay = await start(options);
    try {
      await run(relay);
    } finally {
      await relay.close();
    }
  });
  for (const mutant of mutants)
    test(`synthetic service test, mutant must fail the row: ${name} / ${mutant.name}`, async () => {
      const relay = await start({ ...options, ...mutant.options, edits: mutant.edits });
      try {
        await assert.rejects(() => run(relay), assert.AssertionError);
      } finally {
        await relay.close();
      }
    });
}

export const UNKNOWN = 'a'.repeat(64);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

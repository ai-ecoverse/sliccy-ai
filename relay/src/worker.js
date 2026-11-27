import { Gate } from './gate.js';
import { Mailbox } from './mailbox.js';
import {
  decode,
  digest,
  hidden,
  limits,
  MAX_TTL_SECONDS,
  preflight,
  reply,
  SIZES,
} from './wire.js';

export { Gate, Mailbox };

const ROUTES = {
  '/v1/open': { limit: 'OPENS', run: open },
  '/v1/put': { limit: 'WRITES', run: put },
  '/v1/take': { limit: 'TAKES', run: take },
};
const ERRORS = {
  400: 'invalid',
  409: 'refused',
  411: 'length',
  413: 'too-large',
  429: 'busy',
  503: 'failed',
};
const MAX_RESERVE = 3;

const fail = (status, cors) => reply(status, { error: ERRORS[status] }, cors);

function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  const allowed = String(env.ALLOWED_ORIGINS ?? '').split(',');
  return origin && allowed.includes(origin) ? origin : null;
}

function requested(request) {
  const method = request.headers.get('access-control-request-method');
  const headers = (request.headers.get('access-control-request-headers') ?? '')
    .toLowerCase()
    .split(',')
    .map((name) => name.trim());
  return method === 'POST' && headers.length === 1 && headers[0] === 'content-type';
}

async function discard(request) {
  await request.body?.cancel();
}

async function allow(binding, key) {
  const { success } = await binding.limit({ key });
  return success;
}

function declared(request, cap) {
  const header = request.headers.get('content-length');
  if (header === null) return { status: 411 };
  if (!/^\d{1,7}$/.test(header) || Number(header) > cap) return { status: 413 };
  return { length: Number(header) };
}

async function read(request, length, cap) {
  const reader = request.body?.getReader();
  const parts = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > length || size > cap) {
      await reader.cancel();
      return { status: 413 };
    }
    parts.push(value);
  }
  if (size !== length) return { status: 400 };
  try {
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return { status: 400 };
  }
}

function shape(input, required, optional = []) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.v !== 1) return false;
  const keys = Object.keys(input);
  return (
    required.every((key) => keys.includes(key)) &&
    keys.every((key) => key === 'v' || required.includes(key) || optional.includes(key))
  );
}

const ID = /^[0-9a-f]{64}$/;

function mailbox(env, id) {
  try {
    return env.MAILBOX.get(env.MAILBOX.idFromString(id));
  } catch {
    return null;
  }
}

async function call(stub, op, body) {
  if (!stub) return { state: 'refused' };
  try {
    const response = await stub.fetch(`https://mailbox/${op}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    return await response.json();
  } catch {
    return { state: 'failed' };
  }
}

function answered(result, cors) {
  if (result.state === 'data') return reply(200, { data: result.data }, cors);
  if (result.state === 'empty')
    return reply(200, { empty: true, retryAfterMs: result.retryAfterMs }, cors);
  if (result.state === 'ok') return reply(200, { ok: true }, cors);
  return fail(result.state === 'failed' ? 503 : 409, cors);
}

async function open(input, env, config, cors) {
  if (!shape(input, [], ['deadline'])) return fail(400, cors);
  const { deadline } = input;
  const now = Date.now();
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline <= now))
    return fail(400, cors);
  const expiresAt = Math.min(now + MAX_TTL_SECONDS * 1000, deadline ?? Number.POSITIVE_INFINITY);
  const gate = env.GATE.get(env.GATE.idFromName('gate'));
  const admitted = await gate.fetch('https://gate/admit', {
    method: 'POST',
    body: JSON.stringify({ expiresAt }),
  });
  if (!(await admitted.json()).admitted) return fail(429, cors);
  const id = env.MAILBOX.newUniqueId().toString();
  const made = await call(mailbox(env, id), 'open', { expiresAt });
  if (made.state !== 'ok') return fail(503, cors);
  return reply(200, { id, expiresAt }, cors);
}

function reservations(list, slot) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_RESERVE) return null;
  const bytes = list.map((name) => decode(name, 16, 32));
  if (bytes.includes(null) || new Set([slot, ...list]).size !== list.length + 1) return null;
  return bytes;
}

async function put(input, env, config, cors) {
  if (!shape(input, ['id', 'slot', 'data'], ['verifier', 'final', 'reserve']))
    return fail(400, cors);
  const { id, slot, data, verifier, final, reserve } = input;
  const box = typeof id === 'string' && ID.test(id);
  const name = decode(slot, 16, 32);
  const bytes = decode(data, 1, 4096);
  const checked = verifier === undefined || decode(verifier, 32, 32) !== null;
  const closing = final === undefined || (final === true && verifier !== undefined);
  const reserved = reservations(reserve, slot);
  if (!box || !name || !bytes || !checked || !closing || !reserved) return fail(400, cors);
  if (!SIZES.includes(bytes.length)) return fail(400, cors);
  if (reserve !== undefined && final !== true) return fail(400, cors);
  const result = await call(mailbox(env, id), 'put', {
    slot: await digest(name),
    data,
    size: bytes.length,
    verifier,
    final: final === true,
    reserve: await Promise.all(reserved.map((value) => digest(value))),
  });
  return answered(result, cors);
}

async function take(input, env, config, cors) {
  if (!shape(input, ['id', 'slot'], ['token'])) return fail(400, cors);
  const { id, slot, token } = input;
  const box = typeof id === 'string' && ID.test(id);
  const name = decode(slot, 16, 32);
  const secret = token === undefined ? undefined : decode(token, 32, 32);
  if (!box || !name || secret === null) return fail(400, cors);
  if (!(await allow(env.POLLS, await digest(new TextEncoder().encode(id))))) return fail(429, cors);
  const result = await call(mailbox(env, id), 'take', {
    slot: await digest(name),
    proof: secret === undefined ? null : await digest(secret),
  });
  return answered(result, cors);
}

export default {
  async fetch(request, env) {
    if (env.MAILBOX_GATE !== 'on') return hidden();
    const url = new URL(request.url);
    if (url.protocol !== 'https:') return hidden();
    const origin = allowedOrigin(request, env);
    if (!origin) return hidden();
    const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : null;
    if (url.href.includes('?') || !route) return hidden();
    const cors = { 'access-control-allow-origin': origin, vary: 'Origin' };
    const config = limits(env);
    if (request.method === 'OPTIONS')
      return requested(request) ? preflight(cors, config.maxAge) : hidden();
    if (request.method !== 'POST') return hidden();
    if ((request.headers.get('content-type') ?? '').toLowerCase() !== 'application/json') {
      await discard(request);
      return fail(400, cors);
    }
    const sized = declared(request, config.body);
    if (sized.status) {
      await discard(request);
      return fail(sized.status, cors);
    }
    const source = request.headers.get('cf-connecting-ip') ?? '';
    if (!(await allow(env[route.limit], source))) {
      await discard(request);
      return fail(429, cors);
    }
    const body = await read(request, sized.length, config.body);
    if (body.status) return fail(body.status, cors);
    return route.run(body.value, env, config, cors);
  },
};

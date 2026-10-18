export const TOKEN = /^tk_[a-z0-9]{29}$/;
export const HOME = /^[a-z0-9]{8}$/;
export const LOWER = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const MIXED = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const CORS = { 'access-control-allow-origin': '*', 'access-control-expose-headers': '*' };

const ROUTED = /^\/(?:hook|file)\/([a-z0-9]{8})[a-z0-9]*(?:\.[A-Za-z0-9]{1,16})?$/;
const OWNED = /^\/api\/home\/([a-z0-9]{8})(?:\/|$)/;
const CONFIG = {
  base_url: '',
  app_root: '/',
  enable_login: false,
  require_login: false,
  enable_signup: false,
  enable_payments: false,
  enable_calls: false,
  enable_emails: false,
  enable_reservations: false,
  enable_web_push: false,
  billing_contact: '',
  web_push_public_key: '',
  disallowed_topics: ['api', 'file', 'hook', 'v1'],
};
const ABOUT =
  'An ntfy-compatible webhook gateway for SLICC, with the tray as auth: https://github.com/ai-ecoverse/sliccy-ai\n';

export function random(length, alphabet = LOWER) {
  let out = '';
  const limit = 256 - (256 % alphabet.length);
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

export async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function fail(http, error, headers = {}) {
  return Response.json(
    { code: http * 100 + 1, http, error },
    { status: http, headers: { ...CORS, 'cache-control': 'no-store', ...headers } }
  );
}

export function answer(body, status = 200) {
  return Response.json(body, { status, headers: { ...CORS, 'cache-control': 'no-store' } });
}

function decoded(text) {
  try {
    return atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return '';
  }
}

export function tokenOf(request, url) {
  const param = url.searchParams.get('auth');
  const header = request.headers.get('authorization') ?? (param ? decoded(param) : '');
  const [scheme = '', value = ''] = header.trim().split(/\s+/);
  if (/^bearer$/i.test(scheme)) return TOKEN.test(value) ? value : null;
  if (!/^basic$/i.test(scheme)) return null;
  const pair = decoded(value);
  const colon = pair.indexOf(':');
  if (colon < 0) return null;
  return [pair.slice(colon + 1), pair.slice(0, colon)].find((part) => TOKEN.test(part)) ?? null;
}

function preflight(request) {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS,
      'access-control-allow-methods': 'GET, HEAD, PUT, POST, DELETE, OPTIONS',
      'access-control-allow-headers':
        request.headers.get('access-control-request-headers') ?? 'authorization, content-type',
      'access-control-max-age': '86400',
    },
  });
}

const relay = (response) => {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(CORS)) out.headers.set(name, value);
  return out;
};

function stub(env, homeId) {
  return env.HOMES.get(env.HOMES.idFromName(homeId));
}

async function claim(request, env) {
  const body = await request.text();
  if (body.length > 4096) return fail(413, 'the request body is too large');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const homeId = random(8);
    const response = await stub(env, homeId).fetch('https://home/api/home', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-home-id': homeId },
      body,
    });
    if (response.status !== 409) return relay(response);
    await response.body?.cancel();
  }
  return fail(503, 'no free home id; try again');
}

function about(path) {
  if (path === '/v1/health') return answer({ healthy: true });
  if (path === '/v1/config') return answer(CONFIG);
  return new Response(ABOUT, {
    headers: { ...CORS, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function ntfy(request, url, env) {
  if (request.method === 'OPTIONS') return preflight(request);
  const path = url.pathname;
  if (['/', '/v1/health', '/v1/config'].includes(path) && request.method === 'GET') {
    return about(path);
  }
  if (path === '/api/home' && request.method === 'POST') return claim(request, env);
  const token = tokenOf(request, url);
  const homeId = ROUTED.exec(path)?.[1] ?? OWNED.exec(path)?.[1] ?? token?.slice(3, 11);
  if (!homeId) return fail(401, 'unauthorized');
  const headers = new Headers(request.headers);
  headers.set('x-home-id', homeId);
  headers.delete('x-home-token');
  if (token) headers.set('x-home-token', token);
  return relay(await stub(env, homeId).fetch(new Request(request, { headers })));
}

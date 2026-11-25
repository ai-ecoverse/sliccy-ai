import {
  answer,
  bearer,
  failure,
  imsConfig,
  input,
  is,
  origin,
  PRIVATE,
  SCOPE,
  sameOrigin,
} from './adobe.js';

export const IMS_PATH = '/auth/ims/';
const CALLBACK = `${IMS_PATH}callback`;
const RANDOM = /^[A-Za-z0-9_-]{22,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const CODE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{1,8192}$/;
const MAX_BODY = 8192;
const TIMEOUT_MS = 10_000;
const SKEW_S = 60;
const ASKED = new Set(['state', 'nonce', 'code_challenge', 'prompt']);
const ROUTES = new Map([
  ['authorize', 'GET'],
  ['callback', 'GET'],
  ['token', 'POST'],
  ['revoke', 'POST'],
]);

const RELAY = `(() => {
  const query = new URLSearchParams(location.search);
  history.replaceState(null, '', location.pathname);
  const pick = (name) => {
    const value = query.get(name);
    return value && value.length <= 4096 ? value : null;
  };
  const message = { type: 'slicc-ims', state: pick('state'), code: pick('code'), error: pick('error') };
  const channel = new BroadcastChannel('slicc-ims');
  channel.postMessage(message);
  channel.close();
  if (window.opener) window.opener.postMessage(message, location.origin);
  window.close();
})();`;

function callback() {
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const page = `<!doctype html><meta charset="utf-8"><title>Signing in</title><p>Signing in with Adobe. You can close this window.</p><script nonce="${nonce}">${RELAY}</script>`;
  return new Response(page, {
    headers: {
      ...PRIVATE,
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`,
    },
  });
}

function authorize(request, url, config) {
  if (!sameOrigin(request, url)) return failure(403, 'forbidden');
  const query = url.searchParams;
  const one = (name) => (query.getAll(name).length === 1 ? query.get(name) : null);
  const [state, nonce, challenge] = ['state', 'nonce', 'code_challenge'].map(one);
  const prompt = query.has('prompt') ? one('prompt') : undefined;
  if (
    [...query.keys()].some((name) => !ASKED.has(name)) ||
    !is(RANDOM, state) ||
    !is(RANDOM, nonce) ||
    !is(CHALLENGE, challenge) ||
    (prompt !== undefined && prompt !== 'login')
  )
    return failure(400, 'invalid_input');
  const target = new URL('/ims/authorize/v2', config.ims);
  target.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${origin(url)}${CALLBACK}`,
    scope: SCOPE,
    response_type: 'code',
    response_mode: 'query',
    state,
    nonce,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(prompt ? { prompt } : {}),
  }).toString();
  return new Response(null, { status: 302, headers: { ...PRIVATE, location: target.href } });
}

async function call(config, path, { form, token }) {
  const target = new URL(path, config.ims);
  const headers = {};
  if (form) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (token) headers.authorization = `Bearer ${token}`;
  else if (config.secret)
    headers.authorization = `Basic ${btoa(`${config.clientId}:${config.secret}`)}`;
  if (token || !config.secret) target.searchParams.set('client_id', config.clientId);
  try {
    return await fetch(target, {
      method: form ? 'POST' : 'GET',
      headers,
      body: form,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return null;
  }
}

function claimsOf(token) {
  try {
    const part = String(token).split('.')[1].replaceAll('-', '+').replaceAll('_', '/');
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function issuedFor(claims, config, nonce, now) {
  const audience = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud];
  return (
    claims?.iss === config.ims &&
    audience.includes(config.clientId) &&
    claims.nonce === nonce &&
    claims.exp > now / 1000 - SKEW_S
  );
}

const text = (value) => (typeof value === 'string' && value ? value : null);

async function exchange(request, url, config) {
  if (!sameOrigin(request, url)) return failure(403, 'forbidden');
  const asked = await input(request, MAX_BODY);
  const { code, verifier, nonce } = asked ?? {};
  if (
    !asked ||
    Object.keys(asked).length !== 3 ||
    !is(CODE, code) ||
    !is(VERIFIER, verifier) ||
    !is(RANDOM, nonce)
  )
    return failure(400, 'invalid_input');
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
  });
  const issued = await call(config, '/ims/token/v3', { form });
  if (!issued || issued.status >= 500) return failure(503, 'unavailable');
  const tokens = await issued.json().catch(() => null);
  if (!issued.ok || !tokens) return failure(400, 'sign_in_failed');
  const now = Date.now();
  const access = tokens.access_token;
  const lifetime = Number(tokens.expires_in);
  if (
    !is(TOKEN, access) ||
    !(lifetime > 0) ||
    !issuedFor(claimsOf(tokens.id_token), config, nonce, now)
  )
    return failure(502, 'sign_in_failed');
  const found = await call(config, '/ims/profile/v1', { token: access });
  const profile = found?.ok ? await found.json().catch(() => null) : null;
  if (!profile) return failure(503, 'unavailable');
  return answer(200, {
    accessToken: access,
    expiresAt: now + lifetime * 1000,
    user: {
      id: text(profile.userId),
      name: text(profile.displayName) ?? text(profile.name),
      email: text(profile.email),
    },
    org: text(profile.ownerOrg),
  });
}

async function revoke(request, url, config) {
  if (!sameOrigin(request, url)) return failure(403, 'forbidden');
  const token = bearer(request);
  if (!token) return failure(401, 'invalid_assertion');
  const revoked = await call(config, '/ims/revoke', { form: new URLSearchParams({ token }) });
  await revoked?.body?.cancel();
  return revoked?.ok
    ? new Response(null, { status: 204, headers: PRIVATE })
    : failure(503, 'unavailable');
}

export async function ims(request, env, url) {
  const route = url.pathname.slice(IMS_PATH.length);
  const method = ROUTES.get(route);
  if (!method) return failure(404, 'not_found');
  if (request.method !== method) return failure(405, 'method_not_allowed', { allow: method });
  if (route === 'callback') return callback();
  const config = imsConfig(env, url);
  if (!config) return failure(503, 'unavailable');
  if (route === 'authorize') return authorize(request, url, config);
  if (route === 'token') return exchange(request, url, config);
  return revoke(request, url, config);
}

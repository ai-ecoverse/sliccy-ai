export const TOLERANCE_S = 300;
export const HEADER_BUDGET = 8192;

const encoder = new TextEncoder();
const KEPT =
  /^(content-type|user-agent|idempotency-key|x-request-id|x-hub-signature(-256)?|x-(github|gitlab|slack|shopify|event|webhook)-[a-z0-9-]+|stripe-[a-z0-9-]+|webhook-[a-z0-9-]+|svix-[a-z0-9-]+)$/;
const SECRET = /secret|token|passw|auth|cookie|api-?key|signing-key|credential/;
const ECHO = /^[\x20-\x7e]{1,1024}$/;

const hex = (bytes) =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

function base64(bytes) {
  let text = '';
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text);
}

function unbase64(text) {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function joined(prefix, body) {
  const head = encoder.encode(prefix);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

async function hmac(key, data) {
  const raw = typeof key === 'string' ? encoder.encode(key) : key;
  const imported = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', imported, data);
}

export function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const fresh = (seconds, now) =>
  /^\d{1,12}$/.test(seconds ?? '') && Math.abs(now / 1000 - Number(seconds)) <= TOLERANCE_S;

async function github(headers, body, secret) {
  const [scheme, signature] = (headers.get('x-hub-signature-256') ?? '').split('=');
  return scheme === 'sha256' && same(signature, hex(await hmac(secret, body)));
}

async function stripe(headers, body, secret, now) {
  const fields = (headers.get('stripe-signature') ?? '').split(',').map((part) => part.split('='));
  const time = fields.find(([key]) => key === 't')?.[1];
  if (!fresh(time, now)) return false;
  const expected = hex(await hmac(secret, joined(`${time}.`, body)));
  return fields.some(([key, value]) => key === 'v1' && same(value, expected));
}

async function standard(headers, body, secret, now) {
  const prefix = headers.has('webhook-id') ? 'webhook' : 'svix';
  const id = headers.get(`${prefix}-id`);
  const time = headers.get(`${prefix}-timestamp`);
  if (!id || !fresh(time, now)) return false;
  const key = secret.startsWith('whsec_') ? unbase64(secret.slice(6)) : encoder.encode(secret);
  if (!key) return false;
  const expected = base64(await hmac(key, joined(`${id}.${time}.`, body)));
  return (headers.get(`${prefix}-signature`) ?? '')
    .split(' ')
    .some((part) => part.startsWith('v1,') && same(part.slice(3), expected));
}

async function slack(headers, body, secret, now) {
  const time = headers.get('x-slack-request-timestamp');
  if (!fresh(time, now)) return false;
  const expected = `v0=${hex(await hmac(secret, joined(`v0:${time}:`, body)))}`;
  return same(headers.get('x-slack-signature') ?? '', expected);
}

const SCHEMES = [
  ['x-hub-signature-256', github],
  ['stripe-signature', stripe],
  ['webhook-signature', standard],
  ['svix-signature', standard],
  ['x-slack-signature', slack],
  ['x-gitlab-token', async (headers, body, secret) => same(headers.get('x-gitlab-token'), secret)],
];

export function signable(headers) {
  return SCHEMES.some(([header]) => headers.has(header));
}

export async function signed(headers, body, secret, now = Date.now()) {
  const scheme = SCHEMES.find(([header]) => headers.has(header));
  return scheme ? scheme[1](headers, body, secret, now) : false;
}

export function provider(headers) {
  if (headers.has('x-github-event')) return 'github';
  if (headers.has('x-gitlab-event')) return 'gitlab';
  if (headers.has('stripe-signature')) return 'stripe';
  if (headers.has('x-slack-signature')) return 'slack';
  if (headers.has('webhook-id') || headers.has('svix-id')) return 'standard-webhooks';
  return 'webhook';
}

export function event(headers, json) {
  const named = headers.get('x-github-event') ?? headers.get('x-gitlab-event');
  if (named) return named;
  const nested = json?.event?.type;
  if (typeof nested === 'string') return nested;
  return typeof json?.type === 'string' ? json.type : null;
}

export function kept(headers) {
  const out = {};
  let total = 0;
  for (const [name, value] of headers) {
    if (!KEPT.test(name) || SECRET.test(name)) continue;
    total += name.length + value.length;
    if (total > HEADER_BUDGET) break;
    out[name] = value;
  }
  return out;
}

export function parsed(body) {
  if (body.length === 0 || body.length > 1024 * 1024) return null;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
}

const SAFE = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
};
const text = (body, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...SAFE } });
const echoed = (value) => (ECHO.test(value) ? text(value) : text('bad challenge\n', 400));

export function verification(request, url, hook) {
  if (request.method === 'GET') {
    const challenge = url.searchParams.get('hub.challenge');
    if (url.searchParams.get('hub.mode') !== 'subscribe' || !challenge) return null;
    const expected = hook.verify ?? hook.secret;
    const token = url.searchParams.get('hub.verify_token');
    return expected && !same(token, expected) ? text('forbidden\n', 403) : echoed(challenge);
  }
  const validation = url.searchParams.get('validationToken');
  return request.method === 'POST' && validation ? echoed(validation) : null;
}

export function slackChallenge(json) {
  if (json?.type !== 'url_verification' || typeof json.challenge !== 'string') return null;
  if (!ECHO.test(json.challenge)) return text('bad challenge\n', 400);
  return Response.json({ challenge: json.challenge }, { headers: SAFE });
}

export const MAX_TTL_SECONDS = 120;

export const LIMITS = {
  body: 8192,
  slots: 12,
  total: 16384,
  attempts: 5,
  empties: 300,
  requests: 400,
  refusals: 10,
  retryAfterMs: 1000,
  live: 100,
  hourly: 600,
  maxAge: 60,
};

export const SIZES = [128, 256, 1024, 4096];

const BASE = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

export function limits(env) {
  let extra = {};
  try {
    extra = JSON.parse(env.RELAY_LIMITS ?? '{}') ?? {};
  } catch {}
  const merged = { ...LIMITS };
  for (const key of Object.keys(LIMITS))
    if (Number.isSafeInteger(extra[key]) && extra[key] > 0)
      merged[key] = Math.min(LIMITS[key], extra[key]);
  return merged;
}

export function hidden() {
  return new Response(null, { status: 404, headers: BASE });
}

export function reply(status, body, cors) {
  return new Response(JSON.stringify({ v: 1, ...body }), {
    status,
    headers: { ...BASE, 'content-type': 'application/json', ...cors },
  });
}

export function preflight(cors, maxAge) {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE,
      ...cors,
      'access-control-allow-methods': 'POST',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': String(maxAge),
    },
  });
}

export function encode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function decode(text, min, max) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  let binary;
  try {
    binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.length < min || bytes.length > max || encode(bytes) !== text) return null;
  return bytes;
}

export async function digest(bytes) {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
}

export function answer(state, extra = {}) {
  return Response.json({ state, ...extra });
}

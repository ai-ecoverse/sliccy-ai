export const ISSUER = 'https://token.actions.githubusercontent.com';
export const AUDIENCE = 'https://sliccy.ai';
export const REPOSITORY = 'ai-ecoverse/slicc-bios';
const JWKS_TTL_MS = 10 * 60 * 1000;
const SKEW_S = 60;
const MAX_BYTES = 100 * 1024 * 1024;
const RESERVED = new Set(['seven', 'www']);
const keys = { at: 0, byKid: new Map() };

export function label(branch) {
  const name = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  return !name || RESERVED.has(name) || branch === 'main' ? null : name;
}

export function safePath(path) {
  if (!path || path.length > 1024 || path.includes('\\')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  const parts = decoded.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null;
  return decoded;
}

const unbase64 = (text) => {
  const padded = text.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)), (c) =>
    c.charCodeAt(0)
  );
};

async function key(kid, fetcher, now) {
  if (!keys.byKid.has(kid) || now - keys.at > JWKS_TTL_MS) {
    const response = await fetcher(`${ISSUER}/.well-known/jwks`);
    if (!response.ok) throw new Error(`GitHub's keys answered ${response.status}`);
    const { keys: list } = await response.json();
    keys.byKid = new Map(list.filter((jwk) => jwk.kty === 'RSA').map((jwk) => [jwk.kid, jwk]));
    keys.at = now;
  }
  const jwk = keys.byKid.get(kid);
  if (!jwk) return null;
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

export function forgetKeys() {
  keys.at = 0;
  keys.byKid = new Map();
}

export async function verify(token, { fetcher = fetch, now = Date.now() } = {}) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return { error: 'not a JWT' };
  let header;
  let claims;
  try {
    header = JSON.parse(new TextDecoder().decode(unbase64(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(unbase64(parts[1])));
  } catch {
    return { error: 'not a JWT' };
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string')
    return { error: 'not an RS256 token' };
  const verifier = await key(header.kid, fetcher, now);
  if (!verifier) return { error: 'signed by an unknown key' };
  const signed = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    verifier,
    unbase64(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!signed) return { error: 'bad signature' };
  const seconds = Math.floor(now / 1000);
  if (claims.iss !== ISSUER) return { error: 'wrong issuer' };
  if (claims.aud !== AUDIENCE) return { error: 'wrong audience' };
  if (!(claims.exp > seconds - SKEW_S)) return { error: 'expired' };
  if (claims.nbf > seconds + SKEW_S || claims.iat > seconds + SKEW_S)
    return { error: 'not valid yet' };
  if (claims.repository !== REPOSITORY || claims.repository_owner !== REPOSITORY.split('/')[0]) {
    return { error: `not from ${REPOSITORY}`, status: 403 };
  }
  const ref = String(claims.ref ?? '');
  if (!ref.startsWith('refs/heads/')) return { error: 'not a branch', status: 403 };
  const branch = ref.slice('refs/heads/'.length);
  const name = label(branch);
  if (!name) return { error: `${branch} doesn't publish through this route`, status: 403 };
  return { branch, label: name };
}

const reply = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function owner(env, name) {
  const manifest = await env.BIOS.get(`branches/${name}.json`);
  if (!manifest) return { files: [] };
  return manifest.json();
}

export async function publish(request, env, options = {}) {
  const url = new URL(request.url);
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer '))
    return reply(401, { error: 'a GitHub Actions OIDC token is required' });
  const checked = await verify(authorization.slice(7), options).catch((error) => ({
    error: error.message,
    status: 502,
  }));
  if (checked.error) return reply(checked.status ?? 401, { error: checked.error });
  const { branch, label: name } = checked;
  const current = await owner(env, name);
  if (current.branch && current.branch !== branch) {
    return reply(409, {
      error: `${name}.sliccy.ai already serves ${current.branch}, rename ${branch}`,
    });
  }
  const rest = url.pathname.slice('/api/publish/'.length);
  if (rest === 'manifest') {
    if (request.method === 'GET')
      return reply(200, { label: name, branch, files: current.files ?? [] });
    if (request.method !== 'PUT') return reply(405, { error: 'GET or PUT the manifest' });
    const body = await request.json().catch(() => null);
    const files = body?.files;
    if (
      !Array.isArray(files) ||
      files.some((file) => typeof file !== 'string' || !safePath(file))
    ) {
      return reply(400, { error: 'expected { files: [paths] }' });
    }
    await env.BIOS.put(`branches/${name}.json`, JSON.stringify({ branch, files }), {
      httpMetadata: { contentType: 'application/json' },
    });
    return reply(200, { label: name, url: `https://${name}.sliccy.ai/` });
  }
  if (!rest.startsWith('files/')) return reply(404, { error: 'no such route' });
  const path = safePath(rest.slice('files/'.length));
  if (!path) return reply(400, { error: 'a file path inside the branch' });
  const object = `branches/${name}/${path}`;
  if (request.method === 'DELETE') {
    await env.BIOS.delete(object);
    return reply(200, { deleted: path });
  }
  if (request.method !== 'PUT') return reply(405, { error: 'PUT or DELETE a file' });
  const length = request.headers.get('content-length') ?? '';
  const size = Number(length);
  if (!/^\d+$/.test(length) || size > MAX_BYTES) {
    return reply(411, { error: `a Content-Length of at most ${MAX_BYTES} bytes` });
  }
  await env.BIOS.put(object, request.body);
  return reply(200, { put: path, bytes: size });
}

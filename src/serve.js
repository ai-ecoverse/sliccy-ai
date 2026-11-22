const HOST_ID = /^[0-9a-f]{20}$/;
const LABEL = /^([0-9a-f]{20})-[0-9a-f]{32}$/;
const SUFFIX = '.sliccy.now';
const INTERNAL = 'https://serve.internal';

function fail(status, code, error, headers = {}) {
  return Response.json(
    { error, code },
    {
      status,
      headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers },
    }
  );
}

function hex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function rewrapped(response) {
  if (response.webSocket)
    return new Response(null, {
      status: 101,
      webSocket: response.webSocket,
      headers: response.headers,
    });
  return new Response(response.body, response);
}

export function onNow(url) {
  return url.hostname.endsWith(SUFFIX);
}

export function hubHost(url) {
  if (!onNow(url)) return null;
  return LABEL.exec(url.hostname.slice(0, -SUFFIX.length))?.[1] ?? null;
}

function host(env, hostId) {
  return env.SERVE.get(env.SERVE.idFromName(hostId));
}

async function create(env) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const hostId = hex(10);
    const response = await host(env, hostId).fetch(`${INTERNAL}/api/serve/host`, {
      method: 'POST',
      headers: { 'x-serve-host': hostId },
    });
    if (response.status !== 409) return rewrapped(response);
  }
  return fail(503, 'UNAVAILABLE', 'could not create a host; try again');
}

export async function api(request, env, pathname) {
  if (pathname === '/api/serve/host')
    return request.method === 'POST'
      ? create(env)
      : fail(405, 'METHOD_NOT_ALLOWED', 'method not allowed', { allow: 'POST' });
  const match = /^\/api\/serve\/host\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match) return fail(404, 'NOT_FOUND', 'not found');
  if (!HOST_ID.test(match[1])) return fail(404, 'HOST_NOT_FOUND', 'no such host');
  const inner = new Request(`${INTERNAL}${pathname}`, request);
  inner.headers.set('x-serve-host', match[1]);
  return rewrapped(await host(env, match[1]).fetch(inner));
}

export async function visit(request, env, hostId) {
  return rewrapped(await host(env, hostId).fetch(request));
}

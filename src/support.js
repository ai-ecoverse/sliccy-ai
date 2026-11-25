export const SUPPORT_PATH = '/api/support/';
const UPSTREAM = '/integrations/portal/v1/';
const ROOT = '([A-Za-z0-9._:-]{1,128})';
const KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const CODE = /^[a-z_]{1,64}$/;
const RETRY = /^[A-Za-z0-9 ,:+-]{1,64}$/;
const CURSOR = /^[\x21-\x7e]{1,2048}$/;
const LIMIT = /^(100|[1-9][0-9]?)$/;
const MAX_BODY = 16384;
const TIMEOUT_MS = 15_000;
const paging = { limit: LIMIT, cursor: CURSOR };
const OPERATIONS = [
  { method: 'GET', path: /^threads$/, query: paging },
  { method: 'POST', path: /^threads$/, fields: ['title', 'body'], optional: ['topic'], key: true },
  { method: 'GET', path: new RegExp(`^threads/${ROOT}$`), query: paging },
  { method: 'POST', path: new RegExp(`^threads/${ROOT}/replies$`), fields: ['body'], key: true },
  { method: 'PUT', path: new RegExp(`^threads/${ROOT}/read$`), fields: ['through'] },
  { method: 'GET', path: /^changes$/, query: { after: CURSOR } },
];
const CREATED = new RegExp(`^${UPSTREAM}threads/${ROOT}$`);

const PRIVATE = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$/;

const is = (pattern, value) => typeof value === 'string' && pattern.test(value);

async function input(request, max) {
  if (
    Number(request.headers.get('content-length')) > max ||
    !request.headers.get('content-type')?.startsWith('application/json')
  )
    return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of request.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(await new Blob(chunks).text());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const answer = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { ...PRIVATE, ...headers } });

const failure = (status, code, headers = {}) => answer(status, { error: { code } }, headers);

const origin = (url) => `https://${url.hostname}`;

const sameOrigin = (request, url) =>
  request.headers.get('sec-fetch-site') === 'same-origin' &&
  (request.headers.get('origin') ?? origin(url)) === origin(url);

const bearer = (request) => BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;

const SEVEN = new Set(['seven.sliccy.ai', 'www.sliccy.ai']);

const setting = (env, url, name) =>
  env[`${name}_${SEVEN.has(url.hostname) ? 'SEVEN' : 'BRANCHES'}`];

const portalOf = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? value : null;
  } catch {
    return null;
  }
};

function portalConfig(env, url) {
  const portal = portalOf(setting(env, url, 'SUPPORT_PORTAL'));
  const id = setting(env, url, 'SUPPORT_ACCESS_ID');
  const secret = setting(env, url, 'SUPPORT_ACCESS_SECRET');
  return portal && id && secret ? { portal, id, secret } : null;
}

function search(url, allowed = {}) {
  const query = new URLSearchParams();
  for (const name of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(name);
    if (!Object.hasOwn(allowed, name) || values.length !== 1 || !allowed[name].test(values[0]))
      return null;
    query.set(name, values[0]);
  }
  return query;
}

async function body(request, { fields, optional = [] }) {
  const asked = await input(request, MAX_BODY);
  const known = [...fields, ...optional];
  const given = (name) => Object.hasOwn(asked, name);
  if (
    !asked ||
    Object.keys(asked).some((name) => !known.includes(name)) ||
    !known.every(
      (name) => typeof asked[name] === 'string' || (!given(name) && optional.includes(name))
    )
  )
    return null;
  return JSON.stringify(Object.fromEntries(known.filter(given).map((name) => [name, asked[name]])));
}

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const moved = (location, target) => {
  try {
    return CREATED.exec(new URL(location, target).pathname);
  } catch {
    return null;
  }
};

async function relay(upstream, target, mount) {
  const retry = upstream.headers.get('retry-after');
  const headers = retry && RETRY.test(retry) ? { 'retry-after': retry } : {};
  const parsed = parse(await upstream.text().catch(() => ''));
  const { status } = upstream;
  if (status >= 200 && status < 300 && parsed && typeof parsed === 'object') {
    const location = upstream.headers.get('location');
    const created = location && moved(location, target);
    if (created) headers.location = `${mount}${SUPPORT_PATH}threads/${created[1]}`;
    return answer(status, parsed, headers);
  }
  const code = parsed?.error?.code;
  if (status >= 400 && status < 600 && is(CODE, code)) return failure(status, code, headers);
  if (status === 429) return failure(429, 'rate_limited', headers);
  return failure(503, 'unavailable', headers);
}

export async function support(request, env, url, mount = '') {
  const path = url.pathname.slice(`${mount}${SUPPORT_PATH}`.length);
  const matching = OPERATIONS.filter(({ path: pattern }) => pattern.test(path));
  if (!matching.length) return failure(404, 'not_found');
  const operation = matching.find(({ method }) => method === request.method);
  if (!operation)
    return failure(405, 'method_not_allowed', {
      allow: matching.map(({ method }) => method).join(', '),
    });
  if (!sameOrigin(request, url)) return failure(403, 'forbidden');
  const config = portalConfig(env, url);
  if (!config) return failure(503, 'unavailable');
  const token = bearer(request);
  if (!token) return failure(401, 'invalid_assertion');
  const query = search(url, operation.query);
  const key = request.headers.get('idempotency-key');
  if (!query || (operation.key && !is(KEY, key))) return failure(400, 'invalid_input');
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${token}`,
    'cf-access-client-id': config.id,
    'cf-access-client-secret': config.secret,
  };
  let sent;
  if (operation.fields) {
    sent = await body(request, operation);
    if (!sent) return failure(400, 'invalid_input');
    headers['content-type'] = 'application/json';
  }
  if (operation.key) headers['idempotency-key'] = key;
  const target = new URL(`${UPSTREAM}${path}`, config.portal);
  target.search = query.toString();
  let upstream;
  try {
    upstream = await fetch(target, {
      method: operation.method,
      headers,
      body: sent,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return failure(503, 'unavailable');
  }
  return relay(upstream, target, mount);
}

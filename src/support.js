import { answer, bearer, failure, input, is, portalConfig, sameOrigin } from './adobe.js';

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

async function relay(upstream, target) {
  const retry = upstream.headers.get('retry-after');
  const headers = retry && RETRY.test(retry) ? { 'retry-after': retry } : {};
  const parsed = parse(await upstream.text().catch(() => ''));
  const { status } = upstream;
  if (status >= 200 && status < 300 && parsed && typeof parsed === 'object') {
    const location = upstream.headers.get('location');
    const created = location && moved(location, target);
    if (created) headers.location = `${SUPPORT_PATH}threads/${created[1]}`;
    return answer(status, parsed, headers);
  }
  const code = parsed?.error?.code;
  if (status >= 400 && status < 600 && is(CODE, code)) return failure(status, code, headers);
  if (status === 429) return failure(429, 'rate_limited', headers);
  return failure(503, 'unavailable', headers);
}

export async function support(request, env, url) {
  const path = url.pathname.slice(SUPPORT_PATH.length);
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
  return relay(upstream, target);
}

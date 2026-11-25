export const IMS = {
  prod: 'https://ims-na1.adobelogin.com',
  stg1: 'https://ims-na1-stg1.adobelogin.com',
};
export const SCOPE = 'AdobeID,openid,additional_info.ownerOrg';
export const PRIVATE = {
  'cache-control': 'private, no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

const CLIENT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const BEARER = /^Bearer ([A-Za-z0-9._~+/=-]{1,8192})$/;

export const is = (pattern, value) => typeof value === 'string' && pattern.test(value);

export async function input(request, max) {
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

export const answer = (status, body, headers = {}) =>
  Response.json(body, { status, headers: { ...PRIVATE, ...headers } });

export const failure = (status, code, headers = {}) => answer(status, { error: { code } }, headers);

export const origin = (url) => `https://${url.hostname}`;

export const sameOrigin = (request, url) =>
  request.headers.get('sec-fetch-site') === 'same-origin' &&
  (request.headers.get('origin') ?? origin(url)) === origin(url);

export const bearer = (request) =>
  BEARER.exec(request.headers.get('authorization') ?? '')?.[1] ?? null;

const setting = (env, url, name) =>
  env[`${name}_${url.hostname.split('.')[0] === 'seven' ? 'SEVEN' : 'BRANCHES'}`];

const portalOf = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value ? value : null;
  } catch {
    return null;
  }
};

export function imsConfig(env, url) {
  const name = setting(env, url, 'SUPPORT_IMS');
  const clientId = setting(env, url, 'IMS_CLIENT_ID');
  if (!Object.hasOwn(IMS, name ?? '') || !is(CLIENT_ID, clientId)) return null;
  return { ims: IMS[name], clientId, secret: setting(env, url, 'IMS_CLIENT_SECRET') || null };
}

export function portalConfig(env, url) {
  const portal = portalOf(setting(env, url, 'SUPPORT_PORTAL'));
  const id = setting(env, url, 'SUPPORT_ACCESS_ID');
  const secret = setting(env, url, 'SUPPORT_ACCESS_SECRET');
  return portal && id && secret ? { portal, id, secret } : null;
}

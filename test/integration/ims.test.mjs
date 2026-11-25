import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { adobe, IMS_PROD, IMS_STG1, idToken, SAME } from './adobe.mjs';

const gateway = adobe();
const SEVEN = 'https://seven.sliccy.ai';
const BRANCH = 'https://feat-shell.sliccy.ai';
const STATE = 'Zm9vYmFyYmF6cXV4cXV1eDEyMzQ';
const NONCE = 'bm9uY2Vub25jZW5vbmNlbm9uY2U';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const NAVIGATE = { 'sec-fetch-site': 'same-origin' };
const hour = () => Math.floor(Date.now() / 1000) + 3600;

const start = (
  origin = SEVEN,
  query = `state=${STATE}&nonce=${NONCE}&code_challenge=${CHALLENGE}`
) => gateway.fetch(`${origin}/auth/ims/authorize?${query}`, { headers: NAVIGATE });

const exchange = (
  origin = SEVEN,
  body = { code: 'eyJcode.part-1', verifier: VERIFIER, nonce: NONCE },
  headers = {}
) =>
  gateway.fetch(`${origin}/auth/ims/token`, {
    method: 'POST',
    headers: { ...SAME, origin, 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

function assertPrivate(response) {
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('x-sliccy-ai-version'), 'local');
}

function ims({
  claims = {},
  token = {},
  profile = {},
  tokenStatus = 200,
  profileStatus = 200,
} = {}) {
  gateway.answer(({ url }) => {
    const { pathname, origin } = new URL(url);
    if (pathname === '/ims/token/v3')
      return Response.json(
        {
          access_token: 'eyJaccess.token-1',
          refresh_token: 'eyJrefresh.token',
          id_token: idToken({
            iss: origin,
            aud: origin === IMS_PROD ? 'seven-client' : 'branch-client',
            nonce: NONCE,
            exp: hour(),
            sub: 'ABC@AdobeID',
            ...claims,
          }),
          expires_in: 86399,
          token_type: 'bearer',
          ...token,
        },
        { status: tokenStatus }
      );
    if (pathname === '/ims/profile/v1')
      return Response.json(
        {
          userId: 'ABC@AdobeID',
          displayName: 'Mara Lopes',
          email: 'mara@paper-mill.example',
          ownerOrg: '1234@AdobeOrg',
          ...profile,
        },
        { status: profileStatus }
      );
    if (pathname === '/ims/revoke') return new Response(null, { status: 200 });
    return new Response('unexpected', { status: 500 });
  });
}

test('authorize sends seven to IMS prod with its client, PKCE, state and nonce', async () => {
  const response = await start();
  assert.equal(response.status, 302);
  assertPrivate(response);
  const location = new URL(response.headers.get('location'));
  assert.equal(`${location.origin}${location.pathname}`, `${IMS_PROD}/ims/authorize/v2`);
  assert.deepEqual(Object.fromEntries(location.searchParams), {
    client_id: 'seven-client',
    redirect_uri: `${SEVEN}/auth/ims/callback`,
    scope: 'AdobeID,openid,additional_info.ownerOrg',
    response_type: 'code',
    response_mode: 'query',
    state: STATE,
    nonce: NONCE,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  });
});

test('authorize sends a branch to IMS stg1 with the branch client and its own callback', async () => {
  const response = await start(
    BRANCH,
    `state=${STATE}&nonce=${NONCE}&code_challenge=${CHALLENGE}&prompt=login`
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.origin, IMS_STG1);
  assert.equal(location.searchParams.get('client_id'), 'branch-client');
  assert.equal(location.searchParams.get('redirect_uri'), `${BRANCH}/auth/ims/callback`);
  assert.equal(location.searchParams.get('prompt'), 'login');
});

test('authorize refuses a caller from another origin', async () => {
  for (const headers of [
    {},
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': 'none' },
    { ...NAVIGATE, origin: 'https://evil.example' },
  ]) {
    const response = await gateway.fetch(
      `${SEVEN}/auth/ims/authorize?state=${STATE}&nonce=${NONCE}&code_challenge=${CHALLENGE}`,
      { headers }
    );
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { error: { code: 'forbidden' } });
    assert.equal(response.headers.get('location'), null);
  }
});

test('authorize refuses a missing, short, repeated or extra parameter', async () => {
  const good = { state: STATE, nonce: NONCE, code_challenge: CHALLENGE };
  const cases = [
    { ...good, state: undefined },
    { ...good, nonce: 'short' },
    { ...good, code_challenge: `${CHALLENGE}x` },
    { ...good, state: `${STATE}!` },
    { ...good, prompt: 'none' },
    { ...good, redirect_uri: 'https://evil.example/' },
    { ...good, scope: 'AdobeID' },
  ];
  for (const query of cases) {
    const search = new URLSearchParams(Object.entries(query).filter(([, value]) => value));
    const response = await start(SEVEN, search.toString());
    assert.equal(response.status, 400, search.toString());
    assert.deepEqual(await response.json(), { error: { code: 'invalid_input' } });
  }
  const repeated = await start(
    SEVEN,
    `state=${STATE}&state=${STATE}&nonce=${NONCE}&code_challenge=${CHALLENGE}`
  );
  assert.equal(repeated.status, 400);
  await repeated.arrayBuffer();
});

test('the callback page relays the code to its own origin only and drops it from the URL', async () => {
  const response = await gateway.fetch(
    `${SEVEN}/auth/ims/callback?code=secret-code&state=${STATE}`
  );
  assert.equal(response.status, 200);
  assertPrivate(response);
  assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
  const page = await response.text();
  assert.doesNotMatch(page, /secret-code/);
  const csp = response.headers.get('content-security-policy');
  const nonce = /'nonce-([0-9a-f]{32})'/.exec(csp)[1];
  assert.equal(
    csp,
    `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`
  );
  const script = new RegExp(`<script nonce="${nonce}">([\\s\\S]*)</script>`).exec(page)[1];
  const broadcast = [];
  const posted = [];
  const replaced = [];
  let closed = false;
  const run = (opener) =>
    runInNewContext(script, {
      URLSearchParams,
      location: {
        search: `?code=secret-code&state=${STATE}&x=1`,
        pathname: '/auth/ims/callback',
        origin: SEVEN,
      },
      history: { replaceState: (...args) => replaced.push(args) },
      BroadcastChannel: class {
        constructor(name) {
          this.name = name;
        }
        postMessage(message) {
          broadcast.push([this.name, message]);
        }
        close() {}
      },
      window: {
        opener,
        close: () => {
          closed = true;
        },
      },
    });
  run({ postMessage: (...args) => posted.push(args) });
  const message = { type: 'slicc-ims', state: STATE, code: 'secret-code', error: null };
  assert.deepEqual(replaced, [[null, '', '/auth/ims/callback']]);
  assert.deepEqual(JSON.parse(JSON.stringify(broadcast)), [['slicc-ims', message]]);
  assert.deepEqual(JSON.parse(JSON.stringify(posted)), [[message, SEVEN]]);
  assert.equal(closed, true);
  run(null);
  assert.equal(broadcast.length, 2);
  assert.equal(posted.length, 1);
});

test('the token exchange uses the client secret, checks the ID token and hands out no refresh token', async () => {
  ims();
  const response = await exchange();
  assert.equal(response.status, 200);
  assertPrivate(response);
  const body = await response.json();
  assert.equal(body.accessToken, 'eyJaccess.token-1');
  assert.ok(Math.abs(body.expiresAt - (Date.now() + 86399000)) < 60_000);
  assert.deepEqual(
    { user: body.user, org: body.org },
    {
      user: { id: 'ABC@AdobeID', name: 'Mara Lopes', email: 'mara@paper-mill.example' },
      org: '1234@AdobeOrg',
    }
  );
  assert.doesNotMatch(JSON.stringify(body), /refresh|id_token/);
  const [token, profile] = gateway.seen;
  assert.equal(token.url, `${IMS_PROD}/ims/token/v3`);
  assert.equal(token.method, 'POST');
  assert.equal(token.headers.authorization, `Basic ${btoa('seven-client:seven-client-secret')}`);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(token.body)), {
    grant_type: 'authorization_code',
    code: 'eyJcode.part-1',
    code_verifier: VERIFIER,
  });
  assert.equal(profile.url, `${IMS_PROD}/ims/profile/v1?client_id=seven-client`);
  assert.equal(profile.headers.authorization, 'Bearer eyJaccess.token-1');
  assert.equal(profile.headers.cookie, undefined);
});

test('a branch exchanges as a public client on IMS stg1', async () => {
  ims();
  const response = await exchange(BRANCH);
  assert.equal(response.status, 200);
  await response.arrayBuffer();
  const [token] = gateway.seen;
  assert.equal(token.url, `${IMS_STG1}/ims/token/v3?client_id=branch-client`);
  assert.equal(token.headers.authorization, undefined);
});

test('the token exchange is same-origin only', async () => {
  ims();
  for (const headers of [
    { origin: 'https://evil.example' },
    { origin: BRANCH },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
  ]) {
    const response = await exchange(SEVEN, undefined, headers);
    assert.equal(response.status, 403, JSON.stringify(headers));
    await response.arrayBuffer();
  }
  assert.equal(gateway.seen.length, 0);
});

test('the token exchange refuses malformed input before calling IMS', async () => {
  ims();
  const good = { code: 'eyJcode', verifier: VERIFIER, nonce: NONCE };
  for (const body of [
    '{',
    '[]',
    { ...good, extra: 1 },
    { ...good, code: 42 },
    { ...good, code: 'has space' },
    { ...good, verifier: 'short' },
    { ...good, nonce: undefined },
    { ...good, code: 'x'.repeat(5000) },
  ]) {
    const response = await exchange(SEVEN, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error: { code: 'invalid_input' } });
  }
  const text = await exchange(SEVEN, undefined, { 'content-type': 'text/plain' });
  assert.equal(text.status, 400);
  await text.arrayBuffer();
  assert.equal(gateway.seen.length, 0);
});

test('an ID token for another nonce, client, issuer or time is refused', async () => {
  for (const claims of [
    { nonce: 'b3RoZXJub25jZW90aGVybm9uY2U' },
    { nonce: undefined },
    { aud: 'other-client' },
    { iss: IMS_STG1 },
    { exp: Math.floor(Date.now() / 1000) - 600 },
  ]) {
    ims({ claims });
    const response = await exchange();
    assert.equal(response.status, 502, JSON.stringify(claims));
    assert.deepEqual(await response.json(), { error: { code: 'sign_in_failed' } });
    assert.equal(gateway.seen.length, 1, 'no profile call');
  }
  for (const token of [
    { id_token: undefined },
    { id_token: 'not-a-jwt' },
    { access_token: 7 },
    { expires_in: 0 },
  ]) {
    ims({ token });
    const response = await exchange();
    assert.equal(response.status, 502, JSON.stringify(token));
    await response.arrayBuffer();
  }
  ims({ claims: { aud: ['other', 'seven-client'] } });
  const listed = await exchange();
  assert.equal(listed.status, 200);
  await listed.arrayBuffer();
});

test('IMS refusals and failures map to sign_in_failed and unavailable', async () => {
  for (const [options, status, code] of [
    [{ tokenStatus: 400 }, 400, 'sign_in_failed'],
    [{ tokenStatus: 503 }, 503, 'unavailable'],
    [{ profileStatus: 401 }, 503, 'unavailable'],
  ]) {
    ims(options);
    const response = await exchange();
    assert.equal(response.status, status, JSON.stringify(options));
    assert.deepEqual(await response.json(), { error: { code } });
  }
});

test('sign-out revokes the token at IMS with the client credentials', async () => {
  ims();
  const response = await gateway.fetch(`${SEVEN}/auth/ims/revoke`, {
    method: 'POST',
    headers: { ...SAME, origin: SEVEN, authorization: 'Bearer eyJaccess.token-1' },
  });
  assert.equal(response.status, 204);
  assertPrivate(response);
  const [revoke] = gateway.seen;
  assert.equal(revoke.url, `${IMS_PROD}/ims/revoke`);
  assert.equal(revoke.headers.authorization, `Basic ${btoa('seven-client:seven-client-secret')}`);
  assert.equal(revoke.body, 'token=eyJaccess.token-1');
  const branch = await gateway.fetch(`${BRANCH}/auth/ims/revoke`, {
    method: 'POST',
    headers: { ...SAME, authorization: 'Bearer eyJaccess.token-1' },
  });
  assert.equal(branch.status, 204);
  assert.equal(gateway.seen[1].url, `${IMS_STG1}/ims/revoke?client_id=branch-client`);
});

test('sign-out needs a token and a same-origin caller, and says when IMS fails', async () => {
  ims();
  const missing = await gateway.fetch(`${SEVEN}/auth/ims/revoke`, {
    method: 'POST',
    headers: SAME,
  });
  assert.equal(missing.status, 401);
  assert.deepEqual(await missing.json(), { error: { code: 'invalid_assertion' } });
  const foreign = await gateway.fetch(`${SEVEN}/auth/ims/revoke`, {
    method: 'POST',
    headers: { 'sec-fetch-site': 'cross-site', authorization: 'Bearer eyJ' },
  });
  assert.equal(foreign.status, 403);
  await foreign.arrayBuffer();
  assert.equal(gateway.seen.length, 0);
  gateway.answer(() => new Response('down', { status: 502 }));
  const failed = await gateway.fetch(`${SEVEN}/auth/ims/revoke`, {
    method: 'POST',
    headers: { ...SAME, authorization: 'Bearer eyJ' },
  });
  assert.equal(failed.status, 503);
  await failed.arrayBuffer();
});

test('unknown routes and methods get the v1 error shape', async () => {
  for (const [path, init, status, allow] of [
    ['/auth/ims/other', {}, 404, null],
    ['/auth/ims/constructor', {}, 404, null],
    ['/auth/ims/callback', { method: 'POST' }, 405, 'GET'],
    ['/auth/ims/token', {}, 405, 'POST'],
    ['/auth/ims/authorize', { method: 'HEAD' }, 405, 'GET'],
  ]) {
    const response = await gateway.fetch(`${SEVEN}${path}`, init);
    assert.equal(response.status, status, path);
    assert.equal(response.headers.get('allow'), allow);
    assertPrivate(response);
    if (init.method !== 'HEAD') assert.ok((await response.json()).error.code);
  }
});

test('the gateway is only on seven and published branches, never on vault or www', async () => {
  for (const url of [
    'https://nobody.sliccy.ai/auth/ims/callback',
    'https://vault.sliccy.ai/auth/ims/callback',
    'https://vault-preview.sliccy.ai/auth/ims/callback',
    'https://www.sliccy.ai/7/auth/ims/callback',
  ]) {
    const response = await gateway.fetch(url);
    assert.equal(response.status, 404, url);
    assert.equal(await response.text(), 'not found');
  }
});

test('without a client ID the gateway is unavailable', async () => {
  const bare = adobe({ IMS_CLIENT_ID_SEVEN: '', SUPPORT_IMS_BRANCHES: 'qa' });
  for (const origin of [SEVEN, BRANCH]) {
    const response = await bare.fetch(
      `${origin}/auth/ims/authorize?state=${STATE}&nonce=${NONCE}&code_challenge=${CHALLENGE}`,
      { headers: NAVIGATE }
    );
    assert.equal(response.status, 503, origin);
    assert.deepEqual(await response.json(), { error: { code: 'unavailable' } });
  }
  assert.equal(bare.seen.length, 0);
});

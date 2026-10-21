import { echo } from './echo.js';
import { framed, SELF_FRAMED } from './frames.js';
import { get } from './get.js';
import { mcpcat } from './mcpcat.js';
import { ntfy } from './ntfy.js';
import { publish } from './publish.js';

export { NtfyHome } from './home.js';

const types = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
  svg: 'image/svg+xml',
  png: 'image/png',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
  webmanifest: 'application/manifest+json',
  txt: 'text/plain; charset=utf-8',
};

function failed(headers, object) {
  const match = headers.get('if-match');
  if (match) {
    const tags = match.split(',').map((tag) => tag.trim());
    return match === '*' || tags.includes(object.httpEtag) ? 304 : 412;
  }
  const since = Date.parse(headers.get('if-unmodified-since'));
  return Math.floor(object.uploaded / 1000) * 1000 > since ? 412 : 304;
}

const STAGING = [];
const PREVIEW_VAULT = 'vault-preview';

export function vaultOf(url) {
  const label = url.hostname.split('.')[0];
  if (label === 'vault') return { root: 'vault/main', production: true };
  if (label === PREVIEW_VAULT) return { root: 'vault/main', production: false };
  return label.startsWith('vault-')
    ? { root: `vault/branches/${label.slice('vault-'.length)}`, production: false }
    : null;
}

const VAULT_PAGES = { '/auth/callback': '/auth/callback.html' };

function key(url, root, label = url.hostname.split('.')[0]) {
  const page = root ? VAULT_PAGES[url.pathname] : undefined;
  const path = page ?? (url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname);
  return `${root ?? (label === 'seven' ? label : `branches/${label}`)}${path}`;
}

const SEVEN = 'https://seven.sliccy.ai';
const WWW = 'https://www.sliccy.ai';
const BIOS_ON_WWW = '/7';
const DEV = ['http://localhost:*', 'http://127.0.0.1:*'];
const ANCESTORS_MS = 60_000;
const PREVIEW_ANCESTORS = 48;
const TRANSIENT = ['renovate-', 'gh-readonly-queue-'];
const ancestors = { at: 0, list: null };

export function forgetAncestors() {
  ancestors.at = 0;
  ancestors.list = null;
}

async function previews(env, now) {
  if (ancestors.list && now - ancestors.at < ANCESTORS_MS) return ancestors.list;
  const published = [];
  let cursor;
  do {
    const page = await env.BIOS.list({ prefix: 'branches/', delimiter: '/', cursor });
    for (const object of page.objects)
      if (object.key.endsWith('.json'))
        published.push({ label: object.key.slice(9, -5), at: object.uploaded.getTime() });
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  ancestors.list = published
    .filter(({ label }) => !TRANSIENT.some((prefix) => label.startsWith(prefix)))
    .sort((a, b) => b.at - a.at || (a.label < b.label ? -1 : 1))
    .slice(0, PREVIEW_ANCESTORS)
    .map(({ label }) => `https://${label}.sliccy.ai`);
  ancestors.at = now;
  return ancestors.list;
}

export async function embedders(env, vault, now = Date.now()) {
  if (vault.production) return [SEVEN, WWW, ...STAGING];
  return [...(await previews(env, now)), ...DEV];
}

export async function vaultHeaders(env, vault, now = Date.now()) {
  const frames = await embedders(env, vault, now);
  return {
    'content-security-policy': [
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' https: http://localhost:* http://127.0.0.1:*",
      "worker-src 'self'",
      "manifest-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frames.join(' ')}`,
    ].join('; '),
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-site',
    'cross-origin-opener-policy': 'same-origin',
    'strict-transport-security': 'max-age=31536000',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'origin-agent-cluster': '?1',
  };
}

async function fonts(url, request, env) {
  const upstream = await env.V6.fetch(
    new Request(new URL(url.pathname, 'https://www.sliccy.ai'), { method: request.method })
  );
  const type = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !type.startsWith('font/')) {
    await upstream.body?.cancel();
    return null;
  }
  return new Response(upstream.body, {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
  });
}

const TRAY = /^\/(tray|controller\/[^/]+|join\/[^/]+|api\/tray\/[^/]+\/supersede)$/;
const SEAT = /^\/api\/tray\/[^/]+\/biscotto(\/stop)?$/;
const proxied = (url, request) =>
  TRAY.test(url.pathname) || (request.method === 'POST' && SEAT.test(url.pathname));
const readable = (request) => request.method === 'GET' || request.method === 'HEAD';

async function tray(url, request, env) {
  const forwarded = new Request(
    new Request(new URL(url.pathname + url.search, 'https://www.sliccy.ai'), request),
    { redirect: 'manual' }
  );
  forwarded.headers.delete('cookie');
  const upstream = await env.V6.fetch(forwarded);
  if (upstream.webSocket) return new Response(null, { status: 101, webSocket: upstream.webSocket });
  const moved = upstream.status >= 300 && upstream.status < 400;
  const response = new Response(
    upstream.body,
    moved ? { status: 200, headers: upstream.headers } : upstream
  );
  if (moved) {
    response.headers.set('x-tray-status', String(upstream.status));
    const location = upstream.headers.get('location');
    if (location) response.headers.set('x-tray-location', location);
    response.headers.delete('location');
  }
  response.headers.delete('set-cookie');
  response.headers.set('cache-control', 'no-store');
  return response;
}

const navigation = (headers) =>
  headers.get('sec-fetch-mode') === 'navigate' || headers.get('sec-fetch-dest') === 'document';

async function six(request, env) {
  const upstream = await env.V6.fetch(request);
  return upstream.webSocket ? upstream : new Response(upstream.body, upstream);
}

async function www(request, env, url) {
  const bios = url.pathname.startsWith(`${BIOS_ON_WWW}/`);
  if (!bios && url.pathname !== BIOS_ON_WWW && !url.pathname.startsWith('/os/'))
    return six(request, env);
  const inner = new URL(url);
  inner.pathname = url.pathname.slice(BIOS_ON_WWW.length);
  if (bios && proxied(inner, request)) return tray(inner, request, env);
  return framed(await sevenOnWww(request, env, url, inner), SELF_FRAMED);
}

async function sevenOnWww(request, env, url, inner) {
  if (url.pathname === BIOS_ON_WWW)
    return new Response(null, {
      status: 301,
      headers: { location: `${BIOS_ON_WWW}/${url.search}` },
    });
  if (url.pathname.startsWith('/os/')) {
    return navigation(request.headers)
      ? new Response(null, { status: 302, headers: { location: `${BIOS_ON_WWW}/` } })
      : new Response('not found', { status: 404 });
  }
  if (!readable(request)) {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  const response = await asset(request, env, inner, null, 'seven');
  if (inner.pathname === '/sw.js') response.headers.set('service-worker-allowed', '/');
  return response;
}

async function serve(request, env) {
  const url = new URL(request.url);
  if (url.origin === WWW) return www(request, env, url);
  if (url.hostname.split('.')[0] === 'mcpcat') return mcpcat(request, url);
  if (url.hostname.split('.')[0] === 'get') return get(request, url);
  if (url.hostname.split('.')[0] === 'echo') return echo(request, url);
  if (url.hostname.split('.')[0] === 'ntfy') return ntfy(request, url, env);
  const vault = vaultOf(url);
  if (vault) return asset(request, env, url, vault);
  if (proxied(url, request)) return tray(url, request, env);
  const font =
    readable(request) && url.pathname.startsWith('/fonts/') && (await fonts(url, request, env));
  if (font) return font;
  return framed(await seven(request, env, url), SELF_FRAMED);
}

async function seven(request, env, url) {
  if (url.pathname.startsWith('/api/publish/')) return publish(request, env);
  if (!readable(request)) {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (url.pathname.startsWith('/fonts/')) return new Response('not found', { status: 404 });
  return asset(request, env, url, null);
}

async function asset(request, env, url, vault, label) {
  const root = vault?.root ?? null;
  const extra = vault ? await vaultHeaders(env, vault) : {};
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { ...extra, allow: 'GET, HEAD' } });
  }
  if (root && url.pathname === '/embedders.json') {
    const body = JSON.stringify({ embedders: await embedders(env, vault) });
    return new Response(request.method === 'HEAD' ? null : body, {
      headers: { ...extra, 'content-type': 'application/json', 'cache-control': 'no-cache' },
    });
  }
  const name = key(url, root, label);
  const object = await env.BIOS.get(name, { onlyIf: request.headers });
  if (!object) return new Response('not found', { status: 404, headers: extra });
  const type = types[name.split('.').pop()] ?? 'application/octet-stream';
  const headers = {
    ...extra,
    'content-type': type,
    'cache-control': 'no-cache',
    etag: object.httpEtag,
  };
  if (!('body' in object)) {
    return new Response(null, { status: failed(request.headers, object), headers });
  }
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

export default {
  async fetch(request, env) {
    const response = await serve(request, env);
    if (response.status === 101) return response;
    response.headers.set('x-sliccy-ai-version', env.VERSION.id);
    return response;
  },
};

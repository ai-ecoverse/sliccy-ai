import { publish } from './publish.js';

const types = {
  css: 'text/css; charset=utf-8',
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  wasm: 'application/wasm',
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

function key(url) {
  const label = url.hostname.split('.')[0];
  const path = url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  return `${label === 'seven' ? label : `branches/${label}`}${path}`;
}

async function fonts(url, request, env) {
  const upstream = await env.V6.fetch(
    new Request(new URL(url.pathname, 'https://www.sliccy.ai'), { method: request.method })
  );
  const type = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !type.startsWith('font/')) {
    await upstream.body?.cancel();
    return new Response('not found', { status: 404 });
  }
  return new Response(upstream.body, {
    headers: { 'content-type': type, 'cache-control': 'public, max-age=86400' },
  });
}

const TRAY = /^\/(tray|controller\/[^/]+|api\/tray\/[^/]+\/supersede)$/;

async function tray(url, request, env) {
  const forwarded = new Request(
    new URL(url.pathname + url.search, 'https://www.sliccy.ai'),
    request
  );
  forwarded.headers.delete('cookie');
  const upstream = await env.V6.fetch(forwarded);
  if (upstream.webSocket) return new Response(null, { status: 101, webSocket: upstream.webSocket });
  const response = new Response(upstream.body, upstream);
  response.headers.delete('set-cookie');
  response.headers.set('cache-control', 'no-store');
  return response;
}

async function serve(request, env) {
  const url = new URL(request.url);
  if (TRAY.test(url.pathname)) return tray(url, request, env);
  if (url.pathname.startsWith('/api/publish/')) return publish(request, env);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
  }
  if (url.pathname.startsWith('/fonts/')) return fonts(url, request, env);
  const name = key(url);
  const object = await env.BIOS.get(name, { onlyIf: request.headers });
  if (!object) return new Response('not found', { status: 404 });
  const headers = {
    'content-type': types[name.split('.').pop()] ?? 'application/octet-stream',
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

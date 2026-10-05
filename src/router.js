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
  return `${label}${path}`;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } });
    }
    const name = key(new URL(request.url));
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
  },
};

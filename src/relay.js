const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const PROXY = new Set(['host', 'cdn-loop', 'forwarded', 'x-real-ip', 'true-client-ip']);
const PROXY_PREFIX = /^(cf-|x-forwarded-|x-sliccy-)/;
const NO_BODY = new Set([204, 304]);

function listed(value) {
  return new Set(
    (value ?? '')
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function requestHeaders(headers, bridged) {
  const dropped = listed(headers.get('connection'));
  const out = [];
  for (const [name, value] of headers) {
    if (HOP.has(name) || dropped.has(name) || PROXY.has(name) || PROXY_PREFIX.test(name)) continue;
    if (bridged && name === 'accept-encoding') continue;
    out.push([name, value]);
  }
  if (bridged) out.push(['accept-encoding', 'identity']);
  return out;
}

export function hostOnly(cookie) {
  return cookie
    .split(';')
    .filter((part, index) => index === 0 || !/^\s*domain\s*=/i.test(part))
    .join(';');
}

export function responseHeaders(pairs) {
  const names = pairs.map(([name]) => name.toLowerCase());
  const dropped = listed(
    pairs
      .filter((_, index) => names[index] === 'connection')
      .map(([, value]) => value)
      .join(',')
  );
  const out = new Headers();
  pairs.forEach(([, value], index) => {
    const name = names[index];
    if (HOP.has(name) || dropped.has(name) || name === 'alt-svc' || name.startsWith('x-sliccy-'))
      return;
    out.append(name, name === 'set-cookie' ? hostOnly(value) : value);
  });
  return out;
}

export function validPairs(pairs, limits) {
  if (!Array.isArray(pairs) || pairs.length > limits.headerCount) return false;
  let bytes = 0;
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) return false;
    if (typeof pair[0] !== 'string' || typeof pair[1] !== 'string') return false;
    bytes += pair[0].length + pair[1].length + 4;
  }
  return bytes <= limits.headerBytes;
}

export function bodiless(method, status) {
  return method === 'HEAD' || NO_BODY.has(status);
}

export function frame(id, bytes) {
  const out = new Uint8Array(bytes.byteLength + 4);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out;
}

export function pieces(bytes, size) {
  const out = [];
  for (let at = 0; at < bytes.byteLength; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

export function inject(response, previewToken, host) {
  const type = response.headers.get('content-type') ?? '';
  if (response.status !== 200 || !type.toLowerCase().includes('text/html')) return response;
  if (response.headers.has('content-encoding') || !response.body) return response;
  const socket = `wss://${host}`;
  const tag = `<script src="/__slicc/preview-bridge.js" data-slicc-token="${previewToken}" data-slicc-ws="${socket}/__slicc/bridge"></script>`;
  let done = false;
  const place = {
    element(element) {
      if (done) return;
      done = true;
      element.prepend(tag, { html: true });
    },
  };
  const rewritten = new HTMLRewriter()
    .on('head', place)
    .on('body', place)
    .onDocument({
      end(end) {
        if (!done) end.append(tag, { html: true });
      },
    })
    .transform(response);
  const headers = new Headers(rewritten.headers);
  headers.delete('content-length');
  headers.set(
    'content-security-policy',
    connectable(headers.get('content-security-policy'), socket)
  );
  return new Response(rewritten.body, { status: rewritten.status, headers });
}

export function connectable(policy, socket) {
  if (!policy) return `connect-src 'self' ${socket}`;
  return policy
    .split(',')
    .map((single) => {
      const directives = single.split(';');
      const at = directives.findIndex((part) => /^\s*connect-src(\s|$)/i.test(part));
      if (at < 0) return `${single.trim()}; connect-src 'self' ${socket}`;
      directives[at] = `${directives[at].trimEnd()} ${socket}`;
      return directives.join(';');
    })
    .join(',');
}

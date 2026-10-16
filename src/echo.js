export const MAX_MESSAGE = 64 * 1024;
export const MAX_MESSAGES = 256;
export const LIFETIME_MS = 60_000;

const HEADERS = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' };

export function echoSocket(server, { setTimeout: later = setTimeout } = {}) {
  let count = 0;
  const end = (code, reason) => {
    try {
      server.close(code, reason);
    } catch {}
  };
  later(() => end(1000, 'the echo closes after 60 s'), LIFETIME_MS);
  server.addEventListener('message', ({ data }) => {
    const size = typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
    if (size > MAX_MESSAGE) return end(1009, 'at most 64 KiB per message');
    count += 1;
    if (count > MAX_MESSAGES) return end(1008, 'at most 256 messages per connection');
    server.send(data);
  });
  server.addEventListener('close', ({ code, reason }) => end(code === 1005 ? 1000 : code, reason));
}

export function echo(
  request,
  url,
  { Pair = globalThis.WebSocketPair, Reply = Response, later = setTimeout } = {}
) {
  if (url.pathname !== '/') return new Response('not found\n', { status: 404, headers: HEADERS });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return new Response(
      'A WebSocket echo for SLICC tests: wss://echo.sliccy.ai/ sends every message back.\n',
      { status: 426, headers: { ...HEADERS, upgrade: 'websocket' } }
    );
  const { 0: client, 1: server } = new Pair();
  server.accept();
  echoSocket(server, { setTimeout: later });
  const protocol = request.headers.get('sec-websocket-protocol')?.split(',')[0]?.trim();
  return new Reply(null, {
    status: 101,
    webSocket: client,
    headers: protocol ? { 'sec-websocket-protocol': protocol } : {},
  });
}

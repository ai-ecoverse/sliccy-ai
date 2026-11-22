const WINDOW = 1024 * 1024;
const CHUNK = 64 * 1024;

function frame(id, bytes) {
  const out = new Uint8Array(bytes.byteLength + 4);
  new DataView(out.buffer).setUint32(0, id);
  out.set(bytes, 4);
  return out;
}

async function* chunks(body) {
  if (body == null) return;
  if (typeof body === 'string') yield new TextEncoder().encode(body);
  else if (body instanceof Uint8Array) yield body;
  else yield* body;
}

export async function connect(mf, url, { secret, protocols } = {}) {
  const headers = { upgrade: 'websocket' };
  if (protocols) headers['sec-websocket-protocol'] = protocols.join(', ');
  else headers.authorization = `Bearer ${secret}`;
  const response = await mf.dispatchFetch(url, { headers });
  if (response.status !== 101) return { refused: response };
  const ws = response.webSocket;
  ws.accept();
  return { ws, protocol: response.headers.get('sec-websocket-protocol') };
}

export function publisher(ws, handler) {
  const messages = [];
  const waiters = [];
  const streams = new Map();
  const state = { messages, streams, maxUnacked: 0, holdAcks: false, closed: null };

  const send = (message) => ws.send(JSON.stringify(message));
  const notify = () => {
    for (const waiter of [...waiters])
      if (waiter.test()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(waiter.test());
      }
  };

  const answer = async (stream) => {
    let reply;
    try {
      reply = await handler(stream.request, state);
    } catch {
      return;
    }
    if (!reply || stream.cancelled) return;
    const body = reply.body != null;
    send({
      type: 'http.response',
      id: stream.id,
      status: reply.status ?? 200,
      headers: reply.headers ?? [],
      body,
    });
    if (!body) return;
    for await (const piece of chunks(reply.body)) {
      for (let at = 0; at < piece.byteLength; at += CHUNK) {
        const part = piece.subarray(at, at + CHUNK);
        while (stream.sent - stream.acked + part.byteLength > WINDOW && !stream.cancelled)
          await new Promise((resolve) => {
            stream.credit = resolve;
          });
        if (stream.cancelled) return;
        ws.send(frame(stream.id, part));
        stream.sent += part.byteLength;
        state.maxUnacked = Math.max(state.maxUnacked, stream.sent - stream.acked);
      }
    }
    if (reply.end !== false) send({ type: 'http.response.end', id: stream.id });
  };

  ws.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') {
      const bytes = new Uint8Array(event.data);
      const id = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0);
      const stream = streams.get(id);
      if (!stream) return;
      const part = bytes.slice(4);
      stream.received.push(part);
      if (!state.holdAcks) send({ type: 'http.ack', id, bytes: part.byteLength });
      return;
    }
    if (event.data === 'pong') {
      messages.push({ type: 'pong' });
      notify();
      return;
    }
    const message = JSON.parse(event.data);
    messages.push(message);
    if (message.type === 'http.request') {
      const stream = {
        id: message.id,
        sent: 0,
        acked: 0,
        received: [],
        cancelled: false,
        request: { ...message },
      };
      let ended;
      stream.request.ended = new Promise((resolve) => {
        ended = resolve;
      });
      stream.end = ended;
      stream.request.text = async () => {
        await stream.request.ended;
        return Buffer.concat(stream.received).toString();
      };
      stream.request.bytes = async () => {
        await stream.request.ended;
        return Buffer.concat(stream.received);
      };
      if (!message.body) ended();
      streams.set(message.id, stream);
      answer(stream).catch(() => {});
    } else if (message.type === 'http.request.end') streams.get(message.id)?.end();
    else if (message.type === 'http.ack') {
      const stream = streams.get(message.id);
      if (stream) {
        stream.acked += message.bytes;
        stream.credit?.();
      }
    } else if (message.type === 'http.cancel') {
      const stream = streams.get(message.id);
      if (stream) {
        stream.cancelled = true;
        stream.credit?.();
        stream.end();
      }
    }
    notify();
  });
  ws.addEventListener('close', (event) => {
    state.closed = { code: event.code, reason: event.reason };
    notify();
  });

  return Object.assign(state, {
    send,
    raw: (data) => ws.send(data),
    close: () => ws.close(1000, 'done'),
    next(type, test = () => true, ms = 5000) {
      const find = () =>
        type === 'close' ? state.closed : messages.find((m) => m.type === type && test(m));
      return new Promise((resolve, reject) => {
        const waiter = { test: find, resolve };
        waiters.push(waiter);
        notify();
        setTimeout(() => reject(new Error(`no ${type} within ${ms} ms`)), ms).unref();
      });
    },
    take(type) {
      const at = messages.findIndex((m) => m.type === type);
      return at < 0 ? null : messages.splice(at, 1)[0];
    },
  });
}

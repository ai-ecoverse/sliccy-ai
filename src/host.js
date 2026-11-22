import BRIDGE_JS from '../node_modules/@ai-ecoverse/cherry/dist/preview-bridge.js';
import {
  bodiless,
  frame,
  inject,
  pieces,
  requestHeaders,
  responseHeaders,
  validPairs,
} from './relay.js';

const KIB = 1024;
const MIB = KIB * KIB;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const LIMITS = {
  json: MIB,
  chunk: 64 * KIB,
  window: MIB,
  headerBytes: 64 * KIB,
  headerCount: 256,
  requestBody: 100 * MIB,
  streams: 256,
  head: 30_000,
  idle: 120_000,
  ack: 60_000,
  quiet: 90_000,
  file: 25 * MIB,
  files: 1000,
  total: 50 * MIB,
  ttl: 30 * DAY,
  pending: HOUR,
  idleHost: 90 * DAY,
  tabFrame: MIB,
  emit: 16 * KIB,
  emits: 20,
  emitWindow: 10_000,
};

export const ZONE = 'sliccy.now';
const PROTOCOL = 'slicc-serve.v1';
const HUB = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  `CREATE TABLE IF NOT EXISTS previews (token TEXT PRIMARY KEY, mode TEXT, state TEXT, entry TEXT,
    tag TEXT, bridge INTEGER, max_tabs INTEGER, quiet INTEGER, announced INTEGER,
    created_at INTEGER, expires_at INTEGER, ttl_ms INTEGER, files INTEGER, bytes INTEGER)`,
  `CREATE TABLE IF NOT EXISTS files (token TEXT, path TEXT, key TEXT, size INTEGER, type TEXT,
    etag TEXT, PRIMARY KEY (token, path))`,
];

function hex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...headers },
  });
}

function fail(status, code, error, headers = {}) {
  return json({ error, code }, status, headers);
}

function text(status, message, headers = {}) {
  return new Response(message, {
    status,
    headers: {
      ...HUB,
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  });
}

function iso(time) {
  return time == null ? null : new Date(time).toISOString();
}

export function snapshotPath(entry) {
  const path = entry.slice(1);
  return path === '' || path.endsWith('/') ? `${path}index.html` : path;
}

export function filePath(encoded) {
  let segments;
  try {
    segments = decodeURIComponent(encoded).split('/');
  } catch {
    return null;
  }
  const bad = (segment) =>
    segment === '' ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('\\') ||
    segment.includes('\0');
  return segments.some(bad) ? null : segments.join('/');
}

export function byteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '');
  if (!match || (match[1] === '' && match[2] === '')) return null;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { offset: Math.max(0, size - suffix), length: Math.min(suffix, size) };
  }
  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { offset: start, length: end - start + 1 };
}

function validEntry(entry) {
  return (
    typeof entry === 'string' &&
    entry.startsWith('/') &&
    entry.length <= 2048 &&
    !entry.includes('\\') &&
    !/[\u0000-\u001f\u007f]/.test(entry)
  );
}

export class ServeHost {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.limits = { ...LIMITS, ...JSON.parse(env.SERVE_LIMITS ?? '{}') };
    this.streams = new Map();
    this.next = Number.parseInt(hex(2), 16) + 1;
    this.emits = new Map();
    this.heard = 0;
    for (const statement of SCHEMA) this.sql.exec(statement);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  rows(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray();
  }

  one(query, ...bindings) {
    return this.rows(query, ...bindings)[0] ?? null;
  }

  meta(key) {
    return this.one('SELECT v FROM meta WHERE k = ?', key)?.v ?? null;
  }

  remember(entries) {
    for (const [key, value] of Object.entries(entries))
      this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', key, String(value));
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname.endsWith(`.${ZONE}`)) return this.visit(request, url);
    const hostId = request.headers.get('x-serve-host');
    const rest = url.pathname.slice('/api/serve/host'.length);
    if (rest === '') return this.create(hostId);
    return this.api(request, hostId, rest.slice(1 + hostId.length));
  }

  async create(hostId) {
    if (this.meta('host')) return fail(409, 'HOST_EXISTS', 'host exists');
    const secret = hex(32);
    this.remember({ host: hostId, secret: await sha256(secret), created: Date.now() });
    await this.touch();
    return json({ hostId, secret }, 201);
  }

  async touch() {
    this.remember({ used: Date.now() });
    await this.schedule();
  }

  credential(request) {
    const auth = request.headers.get('authorization') ?? '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const offered = (request.headers.get('sec-websocket-protocol') ?? '').split(',');
    const bearer = offered
      .map((value) => value.trim())
      .find((value) => value.startsWith('bearer.'));
    return bearer ? bearer.slice(7) : null;
  }

  async api(request, hostId, path) {
    if (!this.meta('host')) return fail(404, 'HOST_NOT_FOUND', 'no such host');
    if (this.meta('deleted')) return fail(410, 'HOST_GONE', 'this host was deleted');
    const secret = this.credential(request);
    if (!secret || (await sha256(secret)) !== this.meta('secret'))
      return fail(401, 'UNAUTHORIZED', 'wrong or missing secret', {
        'www-authenticate': 'Bearer',
      });
    await this.touch();
    const method = request.method;
    const allow = (methods) =>
      fail(405, 'METHOD_NOT_ALLOWED', 'method not allowed', { allow: methods });
    if (path === '') return method === 'DELETE' ? this.destroy() : allow('DELETE');
    if (path === '/ws') return method === 'GET' ? this.connect(request, hostId) : allow('GET');
    if (path === '/previews') {
      if (method === 'GET') return json({ previews: this.list() });
      return method === 'POST' ? this.mint(request, hostId) : allow('GET, POST');
    }
    const match = /^\/previews\/([^/]+)(\/finalize|\/files\/(.+))?$/.exec(path);
    const row = match && this.preview(match[1]);
    if (!row) return fail(404, 'PREVIEW_NOT_FOUND', 'no such preview');
    if (!match[2]) return method === 'DELETE' ? this.stop(row) : allow('DELETE');
    if (match[2] === '/finalize') return method === 'POST' ? this.finalize(row) : allow('POST');
    return method === 'PUT' ? this.upload(request, hostId, row, match[3]) : allow('PUT');
  }

  preview(token) {
    return this.one('SELECT * FROM previews WHERE token = ?', token);
  }

  record(row) {
    return {
      previewToken: row.token,
      url: `https://${row.token}.${ZONE}${row.entry}`,
      entry: row.entry,
      tag: row.tag,
      mode: row.mode,
      state: row.state,
      bridge: row.bridge === 1,
      maxTabs: row.max_tabs,
      quiet: row.quiet === 1,
      createdAt: iso(row.created_at),
      expiresAt: iso(row.expires_at),
      files: row.files,
      bytes: row.bytes,
    };
  }

  list() {
    return this.rows('SELECT * FROM previews ORDER BY created_at, token').map((row) =>
      this.record(row)
    );
  }

  async mint(request, hostId) {
    let body;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'INVALID_BODY', 'the body must be a JSON object');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return fail(400, 'INVALID_BODY', 'the body must be a JSON object');
    const { entry = '/', tag = null, bridge = false, maxTabs = 20, quiet = false, ttlMs } = body;
    if (!validEntry(entry)) return fail(400, 'INVALID_ENTRY', 'invalid entry');
    if (tag !== null && (typeof tag !== 'string' || tag.length > 256))
      return fail(400, 'INVALID_TAG', 'tag must be a string of at most 256 characters');
    if (typeof bridge !== 'boolean' || typeof quiet !== 'boolean')
      return fail(400, 'INVALID_BODY', 'bridge and quiet must be booleans');
    if (!Number.isInteger(maxTabs) || maxTabs < 1 || maxTabs > 100)
      return fail(400, 'INVALID_MAX_TABS', 'maxTabs must be 1 to 100');
    const snapshot = ttlMs !== undefined;
    if (snapshot && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > this.limits.ttl))
      return fail(400, 'INVALID_TTL', 'ttlMs must be a positive duration of at most 30 days');
    if (snapshot && bridge) return fail(400, 'INVALID_BODY', 'a snapshot cannot be bridged');
    if (snapshot && !filePath(snapshotPath(entry)))
      return fail(400, 'INVALID_ENTRY', 'invalid entry');
    const token = `${hostId}-${hex(16)}`;
    this.sql.exec(
      `INSERT INTO previews (token, mode, state, entry, tag, bridge, max_tabs, quiet, announced,
        created_at, expires_at, ttl_ms, files, bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, 0, 0)`,
      token,
      snapshot ? 'snapshot' : 'live',
      snapshot ? 'uploading' : 'ready',
      entry,
      tag,
      bridge ? 1 : 0,
      maxTabs,
      quiet ? 1 : 0,
      Date.now(),
      snapshot ? ttlMs : null
    );
    await this.schedule();
    return json(this.record(this.preview(token)), 201);
  }

  async stop(row) {
    await this.drop(row);
    await this.schedule();
    return json({ stopped: true });
  }

  async drop(row) {
    if (row.mode === 'snapshot') {
      const keys = this.rows('SELECT key FROM files WHERE token = ?', row.token).map(
        ({ key }) => key
      );
      for (let at = 0; at < keys.length; at += 1000)
        await this.env.SERVE_STORAGE.delete(keys.slice(at, at + 1000));
      this.sql.exec('DELETE FROM files WHERE token = ?', row.token);
    }
    this.sql.exec('DELETE FROM previews WHERE token = ?', row.token);
    if (row.mode !== 'live') return;
    for (const stream of [...this.streams.values()])
      if (stream.token === row.token) this.cancel(stream, 'the preview was stopped', 404);
    for (const tab of this.ctx.getWebSockets(`tab:${row.token}`)) this.close(tab, 1000, 'stopped');
    this.toPublisher({ type: 'preview.revoked', previewToken: row.token });
  }

  async destroy() {
    for (const row of this.rows('SELECT * FROM previews')) await this.drop(row);
    for (const ws of this.ctx.getWebSockets('pub')) this.close(ws, 4001, 'host deleted');
    this.remember({ deleted: Date.now() });
    await this.ctx.storage.deleteAlarm();
    return json({ deleted: true });
  }

  async upload(request, hostId, row, encoded) {
    if (row.mode !== 'snapshot') return fail(404, 'PREVIEW_NOT_FOUND', 'not a snapshot');
    if (row.state !== 'uploading')
      return fail(409, 'SNAPSHOT_FINALIZED', 'the snapshot is finalized');
    const path = filePath(encoded);
    if (!path) return fail(400, 'INVALID_PATH', 'invalid file path');
    const header = request.headers.get('content-length');
    if (header === null) return fail(411, 'LENGTH_REQUIRED', 'Content-Length is required');
    const size = Number(header);
    if (!/^\d+$/.test(header)) return fail(400, 'INVALID_LENGTH', 'invalid Content-Length');
    const fits = () => {
      const current = this.preview(row.token);
      const old = this.one('SELECT size FROM files WHERE token = ? AND path = ?', row.token, path);
      if (current?.state !== 'uploading')
        return fail(409, 'SNAPSHOT_FINALIZED', 'the snapshot is finalized');
      if (size > this.limits.file) return fail(413, 'FILE_TOO_LARGE', 'a file is at most 25 MiB');
      if (!old && current.files + 1 > this.limits.files)
        return fail(413, 'TOO_MANY_FILES', 'a snapshot has at most 1,000 files');
      if (current.bytes - (old?.size ?? 0) + size > this.limits.total)
        return fail(413, 'SNAPSHOT_TOO_LARGE', 'a snapshot is at most 50 MiB');
      return null;
    };
    const refused = fits();
    if (refused) {
      await request.body?.cancel();
      return refused;
    }
    const type = request.headers.get('content-type') ?? 'application/octet-stream';
    const key = `serve/${hostId}/${row.token.slice(hostId.length + 1)}/${crypto.randomUUID()}`;
    let object;
    try {
      const fixed = new FixedLengthStream(size);
      const piped = (request.body ?? new ReadableStream({ start: (c) => c.close() })).pipeTo(
        fixed.writable
      );
      [object] = await Promise.all([
        this.env.SERVE_STORAGE.put(key, fixed.readable, { httpMetadata: { contentType: type } }),
        piped,
      ]);
    } catch {
      await this.env.SERVE_STORAGE.delete(key);
      return fail(400, 'INVALID_BODY', 'the body did not match its Content-Length');
    }
    const late = fits();
    if (late) {
      await this.env.SERVE_STORAGE.delete(key);
      return late;
    }
    const old = this.one('SELECT * FROM files WHERE token = ? AND path = ?', row.token, path);
    this.sql.exec(
      'INSERT OR REPLACE INTO files (token, path, key, size, type, etag) VALUES (?, ?, ?, ?, ?, ?)',
      row.token,
      path,
      key,
      size,
      type,
      object.httpEtag
    );
    this.sql.exec(
      'UPDATE previews SET files = files + ?, bytes = bytes + ? WHERE token = ?',
      old ? 0 : 1,
      size - (old?.size ?? 0),
      row.token
    );
    if (old) await this.env.SERVE_STORAGE.delete(old.key);
    return json({ path, size });
  }

  async finalize(row) {
    if (row.mode !== 'snapshot') return fail(404, 'PREVIEW_NOT_FOUND', 'not a snapshot');
    if (row.state !== 'uploading')
      return fail(409, 'SNAPSHOT_FINALIZED', 'the snapshot is finalized');
    const entry = snapshotPath(row.entry);
    if (!this.one('SELECT 1 FROM files WHERE token = ? AND path = ?', row.token, entry))
      return fail(400, 'ENTRY_MISSING', `the entry file ${entry} was not uploaded`);
    this.sql.exec(
      "UPDATE previews SET state = 'ready', expires_at = ? WHERE token = ?",
      Date.now() + row.ttl_ms,
      row.token
    );
    await this.schedule();
    return json(this.record(this.preview(row.token)));
  }

  async schedule() {
    if (this.meta('deleted')) return;
    const times = [Number(this.meta('used')) + this.limits.idleHost];
    for (const row of this.rows('SELECT state, created_at, expires_at FROM previews'))
      if (row.state === 'uploading') times.push(row.created_at + this.limits.pending);
      else if (row.expires_at != null) times.push(row.expires_at);
    await this.ctx.storage.setAlarm(Math.min(...times));
  }

  async alarm() {
    if (this.meta('deleted') || !this.meta('host')) return;
    const now = Date.now();
    for (const row of this.rows("SELECT * FROM previews WHERE mode = 'snapshot'")) {
      const due = row.state === 'uploading' ? row.created_at + this.limits.pending : row.expires_at;
      if (due <= now) await this.drop(row);
    }
    const idle = Number(this.meta('used')) + this.limits.idleHost <= now;
    const kept = this.one("SELECT 1 FROM previews WHERE mode = 'snapshot'");
    if (idle && !kept && this.ctx.getWebSockets('pub').length === 0) {
      await this.destroy();
      return;
    }
    if (idle) this.remember({ used: now });
    await this.schedule();
  }

  connect(request, hostId) {
    if ((request.headers.get('upgrade') ?? '').toLowerCase() !== 'websocket')
      return fail(426, 'UPGRADE_REQUIRED', 'expected a WebSocket upgrade');
    const offered = request.headers.get('sec-websocket-protocol');
    const protocols = (offered ?? '').split(',').map((value) => value.trim());
    if (offered !== null && !protocols.includes(PROTOCOL))
      return fail(400, 'UNSUPPORTED_PROTOCOL', `offer the subprotocol ${PROTOCOL}`);
    for (const old of this.ctx.getWebSockets('pub')) this.gone(old, 4000, 'replaced');
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, ['pub']);
    server.serializeAttachment({ at: Date.now() });
    this.heard = Date.now();
    const send = (message) => server.send(JSON.stringify(message));
    send({ type: 'hello', hostId });
    for (const row of this.rows("SELECT * FROM previews WHERE mode = 'live' AND bridge = 1")) {
      send({
        type: 'preview.state',
        previewToken: row.token,
        quiet: row.quiet === 1,
        announced: row.announced === 1,
      });
      for (const tab of this.ctx.getWebSockets(`tab:${row.token}`))
        send({ type: 'bridge.connected', ...tab.deserializeAttachment(), replay: true });
    }
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: offered === null ? {} : { 'sec-websocket-protocol': PROTOCOL },
    });
  }

  close(ws, code, reason) {
    try {
      ws.close(code, reason);
    } catch {}
  }

  gone(ws, code, reason) {
    for (const stream of [...this.streams.values()])
      if (stream.ws === ws) this.cancel(stream, 'the publisher went offline', 502, false);
    this.close(ws, code, reason);
  }

  current() {
    return (
      this.ctx
        .getWebSockets('pub')
        .filter((ws) => ws.readyState === WebSocket.OPEN)
        .sort((a, b) => b.deserializeAttachment().at - a.deserializeAttachment().at)[0] ?? null
    );
  }

  publisher() {
    const ws = this.current();
    if (!ws) return null;
    const seen = Math.max(
      this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0,
      ws.deserializeAttachment().at,
      this.heard
    );
    if (Date.now() - seen <= this.limits.quiet) return ws;
    this.gone(ws, 1001, 'no keepalive');
    return null;
  }

  toPublisher(message) {
    const ws = this.current();
    if (!ws) return;
    try {
      ws.send(JSON.stringify(message));
    } catch {}
  }

  async webSocketMessage(ws, message) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('pub')) return this.fromPublisher(ws, message);
    return this.fromTab(ws, message);
  }

  async webSocketClose(ws, code, reason) {
    const tags = this.ctx.getTags(ws);
    if (tags.includes('pub')) return this.gone(ws, 1000, 'closed');
    const meta = ws.deserializeAttachment();
    this.emits.delete(meta.connId);
    this.close(ws, 1000, 'closed');
    this.toPublisher({
      type: 'bridge.disconnected',
      previewToken: meta.previewToken,
      connId: meta.connId,
      reason: reason || `closed (${code})`,
    });
  }

  async webSocketError(ws) {
    return this.webSocketClose(ws, 1006, 'error');
  }

  fromPublisher(ws, message) {
    this.heard = Date.now();
    if (typeof message !== 'string') return this.bytes(ws, new Uint8Array(message));
    if (message.length > this.limits.json) return this.gone(ws, 1009, 'frame too large');
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return this.gone(ws, 1008, 'not JSON');
    }
    if (!parsed || typeof parsed.type !== 'string') return this.gone(ws, 1008, 'no type');
    const stream = this.streams.get(parsed.id);
    const live = stream && stream.ws === ws ? stream : null;
    switch (parsed.type) {
      case 'http.response':
        return live && this.head(live, parsed);
      case 'http.response.end':
        return live && this.ended(live);
      case 'http.ack':
        return live && this.acked(live, parsed.bytes);
      case 'http.cancel':
        return (
          live &&
          this.cancel(live, String(parsed.reason ?? 'cancelled by the publisher'), 502, false)
        );
      case 'bridge.cdp.request':
        return this.cdp(parsed);
      case 'bridge.close':
        for (const tab of this.ctx.getWebSockets(`conn:${parsed.connId}`))
          this.close(tab, 1000, 'closed by the publisher');
        return;
      case 'preview.state.update':
        this.sql.exec(
          'UPDATE previews SET announced = ? WHERE token = ?',
          parsed.announced ? 1 : 0,
          String(parsed.previewToken)
        );
        return;
      default:
        return;
    }
  }

  bytes(ws, bytes) {
    if (bytes.byteLength < 5) return this.gone(ws, 1008, 'body frame too short');
    if (bytes.byteLength > this.limits.chunk + 4) return this.gone(ws, 1009, 'frame too large');
    const stream = this.streams.get(new DataView(bytes.buffer, bytes.byteOffset).getUint32(0));
    if (!stream || stream.ws !== ws || !stream.queue) return;
    stream.received += bytes.byteLength - 4;
    if (stream.received - stream.passed > this.limits.window)
      return this.cancel(stream, 'the publisher overran its window', 502);
    stream.queue.push(bytes.slice(4));
    stream.wake?.();
  }

  async visit(request, url) {
    const token = url.hostname.slice(0, -(ZONE.length + 1));
    const row = this.meta('deleted') ? null : this.preview(token);
    if (row?.state !== 'ready' || (row.expires_at ?? Number.POSITIVE_INFINITY) <= Date.now())
      return text(404, 'preview not found');
    if (row.mode === 'snapshot') return this.file(request, url, row);
    const upgrade = (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';
    if (row.bridge === 1) {
      const bridged = await this.bridge(request, url, row, upgrade);
      if (bridged) return bridged;
    }
    if (upgrade) return text(501, 'WebSockets are not relayed to previews yet');
    const response = await this.relay(request, url, row);
    return row.bridge === 1 ? inject(response, row.token, url.host) : response;
  }

  async relay(request, url, row) {
    const ws = this.publisher();
    if (!ws) return text(502, 'the publisher of this preview is offline');
    if (this.streams.size >= this.limits.streams)
      return text(503, 'too many requests in flight for this publisher', { 'retry-after': '1' });
    const length = request.headers.get('content-length');
    if (length !== null && Number(length) > this.limits.requestBody)
      return text(413, 'the request body is larger than 100 MiB');
    this.next = (this.next % 0xffffffff) + 1;
    const stream = {
      id: this.next,
      ws,
      token: row.token,
      method: request.method,
      sent: 0,
      acked: 0,
      received: 0,
      passed: 0,
      queue: null,
      done: false,
    };
    this.streams.set(stream.id, stream);
    const headed = new Promise((resolve) => {
      stream.resolve = resolve;
    });
    stream.timer = setTimeout(
      () => this.cancel(stream, "the publisher didn't answer within 30 s", 504),
      this.limits.head
    );
    this.send(stream, {
      type: 'http.request',
      id: stream.id,
      previewToken: row.token,
      method: request.method,
      url: request.url,
      path: request.url.slice(url.origin.length),
      headers: requestHeaders(request.headers, row.bridge === 1),
      body: request.body !== null,
    });
    if (request.body) this.ctx.waitUntil(this.pump(stream, request.body));
    return headed;
  }

  async pump(stream, body) {
    const reader = body.getReader();
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (stream.done) break;
        if (done) {
          stream.ws.send(JSON.stringify({ type: 'http.request.end', id: stream.id }));
          break;
        }
        total += value.byteLength;
        if (total > this.limits.requestBody) {
          this.cancel(stream, 'the request body is larger than 100 MiB', 413);
          break;
        }
        for (const piece of pieces(value, this.limits.chunk)) {
          if (!(await this.credit(stream, piece.byteLength))) break;
          stream.ws.send(frame(stream.id, piece));
          stream.sent += piece.byteLength;
        }
      }
    } catch {
      this.cancel(stream, 'the visitor went away', 502);
    }
    if (stream.done) await reader.cancel().catch(() => {});
  }

  credit(stream, size) {
    if (stream.done) return false;
    if (stream.sent - stream.acked + size <= this.limits.window) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.cancel(stream, "the publisher didn't read the request body for 60 s", 504);
        resolve(false);
      }, this.limits.ack);
      stream.credit = () => {
        if (stream.done || stream.sent - stream.acked + size <= this.limits.window) {
          clearTimeout(timer);
          stream.credit = null;
          resolve(!stream.done);
        }
      };
    });
  }

  acked(stream, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) return;
    stream.acked += bytes;
    stream.credit?.();
  }

  head(stream, message) {
    if (!stream.resolve) return;
    const status = message.status;
    if (!Number.isInteger(status) || status < 200 || status > 599 || status === 101)
      return this.cancel(stream, 'the publisher sent an invalid status', 502);
    if (!validPairs(message.headers, this.limits))
      return this.cancel(stream, 'the publisher sent invalid headers', 502);
    let headers;
    try {
      headers = responseHeaders(message.headers);
    } catch {
      return this.cancel(stream, 'the publisher sent invalid headers', 502);
    }
    clearTimeout(stream.timer);
    const resolve = stream.resolve;
    stream.resolve = null;
    if (message.body !== true || bodiless(stream.method, status)) {
      this.finish(stream);
      resolve(new Response(null, { status, headers }));
      return;
    }
    stream.queue = [];
    const length = headers.get('content-length');
    let body = this.body(stream);
    if (length !== null && /^\d+$/.test(length)) {
      const fixed = new FixedLengthStream(Number(length));
      body.pipeTo(fixed.writable).catch(() => {});
      body = fixed.readable;
    } else headers.delete('content-length');
    const encoded = headers.has('content-encoding');
    resolve(new Response(body, { status, headers, ...(encoded ? { encodeBody: 'manual' } : {}) }));
  }

  body(stream) {
    return new ReadableStream(
      {
        pull: async (controller) => {
          while (!stream.queue.length && !stream.ended && !stream.failed) {
            const idle = setTimeout(
              () => this.cancel(stream, 'the publisher stopped sending for 120 s', 504),
              this.limits.idle
            );
            await new Promise((wake) => {
              stream.wake = wake;
            });
            clearTimeout(idle);
            stream.wake = null;
          }
          if (stream.queue.length) {
            const bytes = stream.queue.shift();
            stream.passed += bytes.byteLength;
            controller.enqueue(bytes);
            this.send(stream, { type: 'http.ack', id: stream.id, bytes: bytes.byteLength });
            return;
          }
          if (stream.failed) controller.error(new Error(stream.failed));
          else controller.close();
        },
        cancel: () => this.cancel(stream, 'the visitor went away', 502),
      },
      { highWaterMark: 0 }
    );
  }

  ended(stream) {
    if (!stream.queue) return;
    stream.ended = true;
    this.finish(stream);
    stream.wake?.();
  }

  send(stream, message) {
    try {
      stream.ws.send(JSON.stringify(message));
    } catch {}
  }

  finish(stream) {
    stream.done = true;
    clearTimeout(stream.timer);
    this.streams.delete(stream.id);
    stream.credit?.();
  }

  cancel(stream, reason, status, tell = true) {
    if (!this.streams.has(stream.id)) return;
    if (tell) this.send(stream, { type: 'http.cancel', id: stream.id, reason });
    this.finish(stream);
    if (stream.resolve) {
      const resolve = stream.resolve;
      stream.resolve = null;
      resolve(text(status, reason));
    }
    stream.failed = reason;
    stream.wake?.();
  }

  async bridge(request, url, row, upgrade) {
    if (url.pathname === '/__slicc/preview-bridge.js' && request.method === 'GET')
      return new Response(BRIDGE_JS, {
        headers: {
          ...HUB,
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=86400',
        },
      });
    if (url.pathname === '/__slicc/emit' && request.method === 'POST')
      return this.beacon(request, row);
    if (url.pathname === '/__slicc/bridge' && upgrade) return this.tab(request, row);
    return null;
  }

  async beacon(request, row) {
    const parts = [];
    let size = 0;
    const reader = request.body?.getReader();
    for (;;) {
      const { done, value } = reader ? await reader.read() : { done: true };
      if (done) break;
      size += value.byteLength;
      if (size > this.limits.emit) {
        await reader.cancel();
        return text(413, 'expected one emit of at most 16 KiB');
      }
      parts.push(value);
    }
    let parsed;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await new Blob(parts).arrayBuffer()));
    } catch {}
    if (parsed?.t !== 'emit') return text(400, 'expected one emit of at most 16 KiB');
    this.emit(row.token, null, parsed);
    return new Response(null, { status: 204, headers: HUB });
  }

  emit(previewToken, connId, parsed) {
    const key = connId ?? previewToken;
    const now = Date.now();
    const recent = (this.emits.get(key) ?? []).filter((at) => now - at < this.limits.emitWindow);
    if (recent.length >= this.limits.emits) return;
    recent.push(now);
    this.emits.set(key, recent);
    this.toPublisher({
      type: 'bridge.emit',
      previewToken,
      connId,
      name: parsed.name,
      detail: parsed.detail,
      at: new Date(now).toISOString(),
    });
  }

  tab(request, row) {
    if (this.ctx.getWebSockets(`tab:${row.token}`).length >= row.max_tabs)
      return json({ error: 'Too many bridged tabs', code: 'BRIDGE_CAP' }, 429, HUB);
    const [client, server] = Object.values(new WebSocketPair());
    const connId = crypto.randomUUID();
    const meta = {
      previewToken: row.token,
      connId,
      origin: request.headers.get('origin') ?? '',
      userAgent: request.headers.get('user-agent') ?? '',
      connectedAt: new Date().toISOString(),
    };
    this.ctx.acceptWebSocket(server, ['tab', `tab:${row.token}`, `conn:${connId}`]);
    server.serializeAttachment(meta);
    server.send(JSON.stringify({ t: 'welcome', connId }));
    this.toPublisher({ type: 'bridge.connected', ...meta });
    return new Response(null, { status: 101, webSocket: client });
  }

  fromTab(ws, message) {
    if (typeof message !== 'string') return;
    if (message.length > this.limits.tabFrame) return this.close(ws, 1009, 'frame too large');
    const meta = ws.deserializeAttachment();
    let parsed;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed?.t === 'cdp.res')
      this.toPublisher({
        type: 'bridge.cdp.response',
        connId: meta.connId,
        id: parsed.id,
        result: parsed.result,
        error: parsed.error,
      });
    else if (parsed?.t === 'emit' && message.length <= this.limits.emit)
      this.emit(meta.previewToken, meta.connId, parsed);
  }

  cdp(message) {
    const [tab] = this.ctx.getWebSockets(`conn:${message.connId}`);
    if (!tab)
      return this.toPublisher({
        type: 'bridge.cdp.response',
        connId: message.connId,
        id: message.id,
        error: { code: -32000, message: 'Preview bridge connection is gone' },
      });
    try {
      tab.send(
        JSON.stringify({
          t: 'cdp.req',
          id: message.id,
          method: message.method,
          params: message.params,
          sessionId: message.sessionId,
        })
      );
    } catch {}
  }

  async file(request, url, row) {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return text(405, 'method not allowed', { allow: 'GET, HEAD' });
    let path;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      return text(404, 'not found');
    }
    const name = snapshotPath(path);
    const found = this.one('SELECT * FROM files WHERE token = ? AND path = ?', row.token, name);
    if (!found) {
      const directory =
        !path.endsWith('/') &&
        this.one(
          'SELECT 1 FROM files WHERE token = ? AND path = ?',
          row.token,
          `${name}/index.html`
        );
      if (directory)
        return new Response(null, {
          status: 301,
          headers: { ...HUB, location: `${url.pathname}/${url.search}` },
        });
      return text(404, 'not found');
    }
    const headers = {
      ...HUB,
      'content-type': found.type,
      etag: found.etag,
      'accept-ranges': 'bytes',
      'cache-control': 'no-cache',
    };
    const match = request.headers.get('if-none-match');
    if (match?.split(',').some((tag) => tag.trim() === found.etag || tag.trim() === '*'))
      return new Response(null, { status: 304, headers });
    const range = byteRange(request.headers.get('range'), found.size);
    if (range === 'unsatisfiable')
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'content-range': `bytes */${found.size}` },
      });
    if (request.method === 'HEAD')
      return new Response(null, {
        headers: { ...headers, 'content-length': String(found.size) },
      });
    const object = await this.env.SERVE_STORAGE.get(found.key, range ? { range } : {});
    if (!object) return text(404, 'not found');
    if (!range) return new Response(object.body, { headers });
    const end = range.offset + range.length - 1;
    return new Response(object.body, {
      status: 206,
      headers: { ...headers, 'content-range': `bytes ${range.offset}-${end}/${found.size}` },
    });
  }
}

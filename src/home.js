import { event, kept, parsed, provider, signed, slackChallenge, verification } from './hook.js';
import { answer, fail, HOME, MIXED, random, sha256, TOKEN } from './ntfy.js';

export const RETENTION_S = 7 * 24 * 60 * 60;
export const IDLE_S = 90 * 24 * 60 * 60;
export const MAX_MESSAGES = 1000;
export const MAX_FILES = 100 * 1024 * 1024;
export const MAX_BODY = 25 * 1024 * 1024;
export const INLINE = 48 * 1024;
export const LINE = 60 * 1024;
export const KEEPALIVE_MS = 45_000;
export const MAX_TOKENS = 256;
export const MAX_HOOKS = 64;
export const MAX_STREAMS = 64;

const CHUNK = 512 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const SCOPES = ['subscribe', 'publish', 'hooks'];
const TOPIC = /^[-_A-Za-z0-9]{1,64}$/;
const RESERVED = new Set(['api', 'file', 'hook', 'v1']);
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MEMBER = /^[a-z]{1,16}(:[A-Za-z0-9._-]{1,128})?$/;
const TRAY = /^[A-Za-z0-9_-]{1,128}$/;
const PRIORITIES = { min: 1, low: 2, default: 3, high: 4, max: 5, urgent: 5 };
const TYPES = {
  'application/json': 'json',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/x-www-form-urlencoded': 'txt',
};
const FORMATS = {
  json: ['application/x-ndjson; charset=utf-8', (message) => `${JSON.stringify(message)}\n`],
  sse: [
    'text/event-stream; charset=utf-8',
    (message) =>
      message.event === 'message'
        ? `data: ${JSON.stringify(message)}\n\n`
        : `event: ${message.event}\ndata: ${JSON.stringify(message)}\n\n`,
  ],
  raw: [
    'text/plain; charset=utf-8',
    (message) =>
      message.event === 'message' ? `${message.message.replaceAll('\n', ' ')}\n` : '\n',
  ],
};

const encoder = new TextEncoder();
const seconds = () => Math.floor(Date.now() / 1000);
const truthy = (value) => ['1', 'yes', 'true'].includes(value?.toLowerCase());
const text = (bytes) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

async function capped(request, max) {
  if (Number(request.headers.get('content-length')) > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

async function body(request) {
  try {
    const value = await request.json();
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function param(request, url, ...names) {
  for (const name of names) {
    const value = request.headers.get(`x-${name}`) ?? request.headers.get(name);
    if (value) return value;
  }
  for (const name of names) {
    const value = url.searchParams.get(name);
    if (value) return value;
  }
  return null;
}

function priority(value) {
  if (value == null || value === '') return null;
  const level = PRIORITIES[value.toLowerCase?.() ?? value] ?? Number(value);
  return Number.isInteger(level) && level >= 1 && level <= 5 ? level : undefined;
}

function tags(value) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((tag) => String(tag).trim()).filter(Boolean);
}

function since(value, poll) {
  if (!value) return poll ? { all: true } : { none: true };
  if (value === 'all') return { all: true };
  if (value === 'none') return { none: true };
  if (value === 'latest') return { latest: true };
  if (/^[-_A-Za-z0-9]{12}$/.test(value)) return { id: value };
  if (/^\d{1,12}$/.test(value)) return { time: Number(value) };
  const span = /^(\d{1,9})(s|m|h|d)$/.exec(value);
  if (!span) return null;
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[span[2]];
  return { time: seconds() - Number(span[1]) * unit };
}

const extension = (type) => TYPES[type?.split(';')[0].trim().toLowerCase()] ?? 'bin';

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)',
  'CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, hash TEXT UNIQUE, label TEXT, member TEXT, scopes TEXT, topics TEXT, created INTEGER, expires INTEGER, used INTEGER)',
  'CREATE TABLE IF NOT EXISTS hooks (name TEXT PRIMARY KEY, id TEXT UNIQUE, topic TEXT, secret TEXT, created INTEGER)',
  'CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, time INTEGER, topic TEXT, json TEXT)',
  'CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, msg TEXT, type TEXT, size INTEGER, expires INTEGER)',
  'CREATE TABLE IF NOT EXISTS chunks (file TEXT, n INTEGER, data BLOB, PRIMARY KEY (file, n))',
];

export class NtfyHome {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.streams = new Set();
    this.timer = null;
    for (const statement of SCHEMA) this.sql.exec(statement);
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
    for (const [key, value] of Object.entries(entries)) {
      if (value == null) this.sql.exec('DELETE FROM meta WHERE k = ?', key);
      else this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', key, String(value));
    }
  }

  touch() {
    if (Number(this.meta('touched')) + 3600 < seconds()) this.remember({ touched: seconds() });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const homeId = request.headers.get('x-home-id');
    if (!HOME.test(homeId ?? '')) return fail(404, 'not found');
    if (url.pathname === '/api/home' && request.method === 'POST') {
      return this.claim(request, homeId);
    }
    if (this.meta('revoked')) return fail(410, 'this home was deleted');
    if (this.meta('home') !== homeId) return fail(404, 'not found');
    this.origin = url.origin;
    return this.route(request, url);
  }

  route(request, url) {
    const [first, ...rest] = url.pathname.slice(1).split('/');
    if (first === 'hook' && rest.length === 1) return this.ingress(request, url, rest[0]);
    if (first === 'file' && rest.length === 1) return this.file(request, rest[0]);
    if (first === 'api' && rest[0] === 'home') return this.owned(request, url, rest.slice(2));
    if (first === 'api' && rest[0] === 'hooks') return this.hooks(request, rest.slice(1));
    if (first === 'api') return fail(404, 'not found');
    return this.topics(request, url, first, rest);
  }

  async confirm(trayId, controllerToken) {
    try {
      const hub = this.env.TRAY_HUB;
      const response = await hub
        .get(hub.idFromName(trayId))
        .fetch('https://internal/internal/confirm-controller', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ controllerToken }),
          signal: AbortSignal.timeout(5000),
        });
      if (response.status !== 200) {
        await response.body?.cancel();
        return false;
      }
      return (await response.json())?.confirmed === true;
    } catch {
      return false;
    }
  }

  async controller(request) {
    const value = await body(request);
    const controllerToken = value?.controllerToken;
    if (typeof controllerToken !== 'string' || controllerToken.length > 512) return null;
    const [trayId, secret, ...extra] = controllerToken.split('.');
    if (!TRAY.test(trayId ?? '') || !secret || extra.length) return null;
    if (value.trayId != null && value.trayId !== trayId) return null;
    return (await this.confirm(trayId, controllerToken)) ? trayId : null;
  }

  async claim(request, homeId) {
    if (this.meta('home') || this.meta('revoked')) return fail(409, 'this home id is taken');
    const trayId = await this.controller(request);
    if (!trayId) return fail(403, 'the tray hub did not confirm this controller token');
    const ownerSecret = random(43, MIXED);
    const now = seconds();
    this.remember({
      home: homeId,
      owner: await sha256(ownerSecret),
      tray: trayId,
      created: now,
      rebound: now,
      touched: now,
    });
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
    return answer({ homeId, ownerSecret, trayId }, 201);
  }

  async owner(request) {
    const [scheme, secret] = (request.headers.get('authorization') ?? '').split(' ');
    if (!/^bearer$/i.test(scheme) || !secret) return false;
    return (await sha256(secret)) === this.meta('owner');
  }

  async owned(request, url, rest) {
    if (!(await this.owner(request))) return fail(401, 'unauthorized');
    this.touch();
    const [section, id, ...extra] = rest;
    if (extra.length) return fail(404, 'not found');
    if (section === undefined && request.method === 'GET') return this.describe();
    if (section === undefined && request.method === 'DELETE') return this.forget();
    if (section === 'rebind' && !id && request.method === 'POST') return this.rebind(request);
    if (section !== 'tokens') return fail(404, 'not found');
    if (id)
      return request.method === 'DELETE' ? this.revoke([id]) : fail(405, 'method not allowed');
    if (request.method === 'GET') return this.listTokens();
    if (request.method === 'POST') return this.mint(request);
    if (request.method === 'DELETE') return this.revokeMember(url.searchParams.get('member'));
    return fail(405, 'method not allowed');
  }

  describe() {
    const count = (table) => this.one(`SELECT COUNT(*) AS n FROM ${table}`).n;
    return answer({
      homeId: this.meta('home'),
      trayId: this.meta('tray'),
      created: Number(this.meta('created')),
      rebound: Number(this.meta('rebound')),
      tokens: count('tokens'),
      hooks: count('hooks'),
      messages: count('messages'),
    });
  }

  async rebind(request) {
    const trayId = await this.controller(request);
    if (!trayId) return fail(403, 'the tray hub did not confirm this controller token');
    this.remember({ tray: trayId, rebound: seconds() });
    return answer({ homeId: this.meta('home'), trayId });
  }

  async forget() {
    for (const table of ['tokens', 'hooks', 'messages', 'files', 'chunks', 'meta']) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    this.remember({ revoked: seconds() });
    this.close(() => true);
    await this.ctx.storage.deleteAlarm();
    return new Response(null, { status: 204 });
  }

  async mint(request) {
    const value = await body(request);
    const draft = value && this.draft(value);
    if (!draft) return fail(400, 'invalid token request');
    if (this.one('SELECT COUNT(*) AS n FROM tokens').n >= MAX_TOKENS) {
      return fail(429, `a home holds at most ${MAX_TOKENS} tokens`);
    }
    const token = `tk_${this.meta('home')}${random(21)}`;
    const record = { id: random(12, MIXED), ...draft, created: seconds() };
    this.sql.exec(
      'INSERT INTO tokens (id, hash, label, member, scopes, topics, created, expires, used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)',
      record.id,
      await sha256(token),
      record.label,
      record.member,
      JSON.stringify(record.scopes),
      record.topics ? JSON.stringify(record.topics) : null,
      record.created,
      record.expires
    );
    return answer({ ...record, token }, 201);
  }

  draft({ label = '', member, scopes = ['subscribe'], topics = null, expires = null }) {
    if (typeof label !== 'string' || label.length > 64) return null;
    if (typeof member !== 'string' || !MEMBER.test(member)) return null;
    if (!Array.isArray(scopes) || !scopes.length || scopes.some((s) => !SCOPES.includes(s))) {
      return null;
    }
    const listed = topics === null || (Array.isArray(topics) && topics.length <= 32);
    if (!listed || topics?.some((topic) => !this.topical(topic))) return null;
    if (expires !== null && !(Number.isInteger(expires) && expires > seconds())) return null;
    return { label, member, scopes: [...new Set(scopes)], topics, expires };
  }

  topical(topic) {
    return typeof topic === 'string' && TOPIC.test(topic) && !RESERVED.has(topic);
  }

  listTokens() {
    const tokens = this.rows('SELECT * FROM tokens ORDER BY created').map((row) => ({
      id: row.id,
      label: row.label,
      member: row.member,
      scopes: JSON.parse(row.scopes),
      topics: row.topics ? JSON.parse(row.topics) : null,
      created: row.created,
      expires: row.expires,
      last_access: row.used,
    }));
    return answer({ tokens });
  }

  revoke(ids) {
    const gone = ids.filter((id) => this.one('DELETE FROM tokens WHERE id = ? RETURNING id', id));
    this.close((stream) => gone.includes(stream.token));
    return answer({ revoked: gone.length });
  }

  revokeMember(member) {
    if (!member || !MEMBER.test(member)) return fail(400, 'name a member to revoke');
    const ids = this.rows(
      member.includes(':')
        ? 'SELECT id FROM tokens WHERE member = ?'
        : "SELECT id FROM tokens WHERE member = ? OR member LIKE ? || ':%'",
      ...(member.includes(':') ? [member] : [member, member])
    ).map((row) => row.id);
    return this.revoke(ids);
  }

  async member(request) {
    const token = request.headers.get('x-home-token');
    if (!TOKEN.test(token ?? '')) return null;
    const row = this.one('SELECT * FROM tokens WHERE hash = ?', await sha256(token));
    const now = seconds();
    if (!row || (row.expires && row.expires <= now)) return null;
    if (!row.used || row.used + 60 < now) {
      this.sql.exec('UPDATE tokens SET used = ? WHERE id = ?', now, row.id);
    }
    this.touch();
    return {
      id: row.id,
      scopes: JSON.parse(row.scopes),
      topics: row.topics ? JSON.parse(row.topics) : null,
    };
  }

  async allowed(request, scope, topics) {
    const member = await this.member(request);
    if (!member) return fail(401, 'unauthorized');
    const covered = !member.topics || topics.every((topic) => member.topics.includes(topic));
    if (!member.scopes.includes(scope) || !covered) return fail(403, 'forbidden');
    return member;
  }

  async hooks(request, rest) {
    const member = await this.member(request);
    if (!member) return fail(401, 'unauthorized');
    if (!member.scopes.includes('hooks')) return fail(403, 'forbidden');
    if (rest.length === 1 && request.method === 'DELETE') return this.dropHook(member, rest[0]);
    if (rest.length) return fail(404, 'not found');
    if (request.method === 'GET') return answer({ hooks: this.listHooks(member) });
    if (request.method === 'POST') return this.createHook(request, member);
    return fail(405, 'method not allowed');
  }

  visible(member, topic) {
    return !member.topics || member.topics.includes(topic);
  }

  shownHook(row) {
    return {
      name: row.name,
      topic: row.topic,
      url: `${this.origin}/hook/${row.id}`,
      signed: Boolean(row.secret),
      created: row.created,
    };
  }

  listHooks(member) {
    return this.rows('SELECT * FROM hooks ORDER BY created')
      .filter((row) => this.visible(member, row.topic))
      .map((row) => this.shownHook(row));
  }

  async createHook(request, member) {
    const value = await body(request);
    const name = value?.name;
    const topic = value?.topic ?? name;
    const secret = value?.secret ?? null;
    if (typeof name !== 'string' || !NAME.test(name) || !this.topical(topic)) {
      return fail(400, 'a hook needs a name and a topic');
    }
    if (
      secret !== null &&
      (typeof secret !== 'string' || secret.length < 8 || secret.length > 256)
    ) {
      return fail(400, 'a hook secret is 8 to 256 characters');
    }
    if (!this.visible(member, topic)) return fail(403, 'forbidden');
    if (this.one('SELECT name FROM hooks WHERE name = ?', name)) return fail(409, 'hook exists');
    if (this.one('SELECT COUNT(*) AS n FROM hooks').n >= MAX_HOOKS) {
      return fail(429, `a home holds at most ${MAX_HOOKS} hooks`);
    }
    const row = {
      name,
      id: `${this.meta('home')}${random(24)}`,
      topic,
      secret,
      created: seconds(),
    };
    this.sql.exec(
      'INSERT INTO hooks (name, id, topic, secret, created) VALUES (?, ?, ?, ?, ?)',
      row.name,
      row.id,
      row.topic,
      row.secret,
      row.created
    );
    return answer(this.shownHook(row), 201);
  }

  dropHook(member, name) {
    const row = this.one('SELECT * FROM hooks WHERE name = ?', name);
    if (!row || !this.visible(member, row.topic)) return fail(404, 'no such hook');
    this.sql.exec('DELETE FROM hooks WHERE name = ?', name);
    return new Response(null, { status: 204 });
  }

  async ingress(request, url, hookId) {
    const hook = this.one('SELECT * FROM hooks WHERE id = ?', hookId);
    if (!hook) return fail(404, 'no such hook');
    const handshake = verification(request, url, hook);
    if (handshake) return handshake;
    if (request.method !== 'POST') return fail(405, 'method not allowed', { allow: 'POST' });
    const bytes = await capped(request, MAX_BODY);
    if (!bytes) return fail(413, 'the webhook body is too large');
    if (hook.secret && !(await signed(request.headers, bytes, hook.secret))) {
      return fail(401, 'the webhook signature did not verify');
    }
    const json = parsed(bytes);
    const challenge = slackChallenge(json);
    if (challenge) return challenge;
    const message = this.store({
      topic: hook.topic,
      title: event(request.headers, json),
      tags: [provider(request.headers)],
      bytes,
      type: request.headers.get('content-type'),
      extra: { headers: kept(request.headers), verified: Boolean(hook.secret), hook: hook.name },
    });
    return answer({ id: message.id, topic: message.topic });
  }

  store({
    topic,
    title,
    tags: list = [],
    priority: level,
    click,
    icon,
    bytes,
    type,
    name,
    note,
    extra,
  }) {
    const now = seconds();
    const message = { id: random(12, MIXED), time: now, expires: now + RETENTION_S };
    Object.assign(message, { event: 'message', topic });
    if (title) message.title = title.slice(0, 1024);
    if (list.length) message.tags = list.slice(0, 16).map((tag) => tag.slice(0, 128));
    if (level) message.priority = level;
    if (click) message.click = click.slice(0, 2048);
    if (icon) message.icon = icon.slice(0, 2048);
    const short = note?.slice(0, 4096);
    const body = text(bytes);
    const inline =
      body !== null && bytes.length <= INLINE && !name
        ? { ...message, message: short ?? (body || 'triggered'), ...extra }
        : null;
    if (inline && encoder.encode(JSON.stringify(inline)).length <= LINE) {
      Object.assign(message, inline);
    } else {
      message.attachment = this.attach(message, bytes, type, name);
      message.message = short ?? `You received a file: ${message.attachment.name}`;
      Object.assign(message, extra);
    }
    this.sql.exec(
      'INSERT INTO messages (id, time, topic, json) VALUES (?, ?, ?, ?)',
      message.id,
      now,
      topic,
      JSON.stringify(message)
    );
    this.prune();
    this.broadcast(message);
    return message;
  }

  attach(message, bytes, type, name) {
    const ext = extension(type);
    const id = `${this.meta('home')}${random(32)}`;
    const clean = type && /^[\w.+-]+\/[\w.+-]+$/.test(type.split(';')[0].trim());
    const mime = clean ? type.split(';')[0].trim() : 'application/octet-stream';
    this.sql.exec(
      'INSERT INTO files (id, msg, type, size, expires) VALUES (?, ?, ?, ?, ?)',
      id,
      message.id,
      mime,
      bytes.length,
      message.expires
    );
    for (let n = 0; n * CHUNK < bytes.length || n === 0; n += 1) {
      const slice = bytes.subarray(n * CHUNK, (n + 1) * CHUNK);
      this.sql.exec('INSERT INTO chunks (file, n, data) VALUES (?, ?, ?)', id, n, slice);
    }
    return {
      name: name ?? `body.${ext}`,
      type: mime,
      size: bytes.length,
      expires: message.expires,
      url: `${this.origin}/file/${id}.${ext}`,
    };
  }

  prune() {
    this.sql.exec('DELETE FROM messages WHERE time < ?', seconds() - RETENTION_S);
    const cut = this.one(
      'SELECT seq FROM messages ORDER BY seq DESC LIMIT 1 OFFSET ?',
      MAX_MESSAGES
    );
    if (cut) this.sql.exec('DELETE FROM messages WHERE seq <= ?', cut.seq);
    let total = 0;
    const files = this.rows(
      'SELECT files.size, messages.seq FROM files JOIN messages ON files.msg = messages.id ORDER BY messages.seq DESC'
    );
    const over = files.find((file) => (total += file.size) > MAX_FILES);
    if (over) this.sql.exec('DELETE FROM messages WHERE seq <= ?', over.seq);
    this.sql.exec('DELETE FROM files WHERE msg NOT IN (SELECT id FROM messages)');
    this.sql.exec('DELETE FROM chunks WHERE file NOT IN (SELECT id FROM files)');
  }

  file(request, name) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return fail(405, 'method not allowed', { allow: 'GET, HEAD' });
    }
    const row = this.one('SELECT * FROM files WHERE id = ?', name.split('.')[0]);
    if (!row || row.expires <= seconds()) return fail(404, 'no such file');
    const headers = {
      'content-type': row.type,
      'content-length': String(row.size),
      'content-disposition': 'attachment',
      'content-security-policy': "default-src 'none'; sandbox",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store',
    };
    if (request.method === 'HEAD') return new Response(null, { headers });
    let n = 0;
    const stream = new ReadableStream({
      pull: (controller) => {
        const chunk = this.one('SELECT data FROM chunks WHERE file = ? AND n = ?', row.id, n);
        n += 1;
        if (chunk) controller.enqueue(new Uint8Array(chunk.data));
        if (!chunk || n * CHUNK >= row.size) controller.close();
      },
    });
    return new Response(stream, { headers });
  }

  async topics(request, url, first, rest) {
    if (!first && !rest.length && ['POST', 'PUT'].includes(request.method)) {
      return this.publishJson(request);
    }
    const names = first.split(',');
    if (!first || names.some((topic) => !this.topical(topic))) return fail(404, 'not found');
    const [action, ...extra] = rest;
    if (extra.length) return fail(404, 'not found');
    if (FORMATS[action] && request.method === 'GET')
      return this.subscribe(request, url, names, action);
    if (action === 'auth' && request.method === 'GET') {
      const member = await this.allowed(request, 'subscribe', names);
      return member instanceof Response ? member : answer({ success: true });
    }
    if (action === undefined && names.length === 1 && ['POST', 'PUT'].includes(request.method)) {
      return this.publish(request, url, names[0]);
    }
    return fail(404, 'not found');
  }

  async publish(request, url, topic) {
    const member = await this.allowed(request, 'publish', [topic]);
    if (member instanceof Response) return member;
    const bytes = await capped(request, MAX_BODY);
    if (!bytes) return fail(413, 'the message is too large');
    const get = (...names) => param(request, url, ...names);
    const level = priority(get('priority', 'prio', 'p'));
    if (level === undefined) return fail(400, 'invalid priority');
    const name = get('filename', 'file', 'f');
    const note = get('message', 'm');
    const message = this.store({
      topic,
      title: get('title', 'ti', 't'),
      tags: tags(get('tags', 'tag', 'ta')),
      priority: level,
      click: get('click'),
      icon: get('icon'),
      bytes,
      type: request.headers.get('content-type'),
      name: name ?? (note && bytes.length ? 'attachment' : null),
      note,
      extra: truthy(get('markdown', 'md')) ? { content_type: 'text/markdown' } : {},
    });
    return answer(message);
  }

  async publishJson(request) {
    const bytes = await capped(request, MAX_BODY);
    const value = bytes && parsed(bytes);
    if (!value || typeof value !== 'object') return fail(400, 'invalid JSON message');
    if (!this.topical(value.topic)) return fail(400, 'invalid topic');
    const member = await this.allowed(request, 'publish', [value.topic]);
    if (member instanceof Response) return member;
    const level = priority(value.priority == null ? null : String(value.priority));
    if (level === undefined) return fail(400, 'invalid priority');
    const message = this.store({
      topic: value.topic,
      title: typeof value.title === 'string' ? value.title : null,
      tags: tags(value.tags),
      priority: level,
      click: typeof value.click === 'string' ? value.click : null,
      icon: typeof value.icon === 'string' ? value.icon : null,
      bytes: encoder.encode(typeof value.message === 'string' ? value.message : ''),
      type: 'text/plain',
      name: typeof value.filename === 'string' ? value.filename : null,
      extra: value.markdown === true ? { content_type: 'text/markdown' } : {},
    });
    return answer(message);
  }

  select(names, marker) {
    const marks = names.map(() => '?').join(', ');
    const base = `SELECT json FROM messages WHERE topic IN (${marks})`;
    if (marker.none) return [];
    if (marker.latest) return this.rows(`${base} ORDER BY seq DESC LIMIT 1`, ...names);
    const after = marker.id ? this.one('SELECT seq FROM messages WHERE id = ?', marker.id) : null;
    if (after) return this.rows(`${base} AND seq > ? ORDER BY seq`, ...names, after.seq);
    if (marker.time) return this.rows(`${base} AND time >= ? ORDER BY seq`, ...names, marker.time);
    return this.rows(`${base} ORDER BY seq`, ...names);
  }

  async subscribe(request, url, names, format) {
    const member = await this.allowed(request, 'subscribe', names);
    if (member instanceof Response) return member;
    const poll = truthy(param(request, url, 'poll', 'po'));
    const marker = since(param(request, url, 'since', 'si'), poll);
    if (!marker) return fail(400, 'invalid since');
    const [type, encode] = FORMATS[format];
    const headers = { 'content-type': type, 'cache-control': 'no-store' };
    const backlog = this.select(names, marker).map((row) => encode(JSON.parse(row.json)));
    if (poll) return new Response(backlog.join(''), { headers });
    if (this.streams.size >= MAX_STREAMS) return fail(429, 'too many subscriptions');
    const { readable, writable } = new TransformStream();
    const stream = this.open(writable.getWriter(), names, member.id, encode);
    stream.write(this.marker('open', names));
    for (const line of backlog) stream.write(line, true);
    return new Response(readable, { headers });
  }

  marker(kind, names) {
    return { id: random(12, MIXED), time: seconds(), event: kind, topic: names.join(',') };
  }

  open(writer, names, token, encode) {
    const stream = {
      names,
      token,
      write: (message, encoded = false) =>
        writer.write(encoder.encode(encoded ? message : encode(message))).catch(() => {
          this.streams.delete(stream);
        }),
      end: () => writer.close().catch(() => {}),
    };
    this.streams.add(stream);
    this.timer ??= setInterval(() => this.keepalive(), KEEPALIVE_MS);
    return stream;
  }

  broadcast(message) {
    for (const stream of this.streams) {
      if (stream.names.includes(message.topic)) stream.write(message);
    }
  }

  keepalive() {
    const now = seconds();
    const valid = new Set(
      this.rows('SELECT id FROM tokens WHERE expires IS NULL OR expires > ?', now).map((r) => r.id)
    );
    this.close((stream) => !valid.has(stream.token));
    for (const stream of this.streams) stream.write(this.marker('keepalive', stream.names));
    if (!this.streams.size) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  close(test) {
    for (const stream of [...this.streams]) {
      if (!test(stream)) continue;
      this.streams.delete(stream);
      stream.end();
    }
  }

  async alarm() {
    if (this.meta('revoked') || !this.meta('home')) return;
    if (Number(this.meta('touched')) + IDLE_S < seconds()) {
      await this.forget();
      return;
    }
    this.prune();
    await this.ctx.storage.setAlarm(Date.now() + DAY_MS);
  }
}

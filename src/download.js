const REPOSITORY = 'https://github.com/ai-ecoverse/sliccy-app';
const LATEST = `${REPOSITORY}/releases/latest`;
const API = 'https://api.github.com/repos/ai-ecoverse/sliccy-app/releases/latest';
const LIMIT = 256 * 1024;
const CACHE_MS = 60_000;

export const DOWNLOAD_PATH = '/download/sliccy.dmg';

async function metadata(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    await response.body?.cancel();
    throw new Error('release metadata unavailable');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMIT) throw new Error('release metadata too large');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel();
  }
}

async function discover(fetcher, signal) {
  const release = await metadata(
    await fetcher(API, {
      headers: { accept: 'application/json', 'user-agent': 'sliccy-ai-download' },
      redirect: 'manual',
      signal,
      cf: { cacheEverything: true, cacheTtlByStatus: { 200: 300, '201-599': -1 } },
    })
  );
  const version = /^v(\d+\.\d+\.\d+)$/.exec(release?.tag_name)?.[1];
  if (
    !version ||
    release.draft !== false ||
    release.prerelease !== false ||
    release.html_url !== `${REPOSITORY}/releases/tag/v${version}` ||
    !Array.isArray(release.assets)
  )
    throw new Error('invalid release');
  const name = `Sliccy-${version}.dmg`;
  const location = `${REPOSITORY}/releases/download/v${version}/${name}`;
  const assets = release.assets.filter((asset) => asset?.name === name);
  if (
    assets.length !== 1 ||
    assets[0].browser_download_url !== location ||
    assets[0].state !== 'uploaded' ||
    !Number.isSafeInteger(assets[0].size) ||
    assets[0].size <= 0
  )
    throw new Error('invalid DMG');
  return location;
}

export function createDownload({ fetcher = fetch, now = Date.now, timeoutMs = 5000 } = {}) {
  let cached;
  let pending;
  async function latest() {
    if (cached && now() < cached.until) return cached.location;
    if (!pending || now() - pending.started >= timeoutMs) {
      const current = { started: now() };
      current.location = (async () => {
        const controller = new AbortController();
        let timer;
        let location = null;
        try {
          location = await Promise.race([
            discover(fetcher, controller.signal),
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                controller.abort();
                reject(new Error('release discovery timed out'));
              }, timeoutMs);
            }),
          ]);
        } catch {
          location = null;
        } finally {
          clearTimeout(timer);
        }
        if (pending === current) cached = { location, until: now() + CACHE_MS };
        return location;
      })().finally(() => {
        if (pending === current) pending = null;
      });
      pending = current;
    }
    let deadline;
    try {
      return await Promise.race([
        pending.location,
        new Promise((resolve) => {
          deadline = setTimeout(resolve, timeoutMs, null);
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
  }
  return async (request) => {
    const headers = {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      link: `<${LATEST}>; rel="alternate"`,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
    const location = await latest();
    if (location) return new Response(null, { status: 302, headers: { ...headers, location } });
    return new Response(
      request.method === 'HEAD' ? null : `Sliccy download temporarily unavailable. See ${LATEST}\n`,
      { status: 503, headers: { ...headers, 'retry-after': '60' } }
    );
  };
}

export const download = createDownload();

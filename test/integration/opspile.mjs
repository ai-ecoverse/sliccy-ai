import { readFileSync } from 'node:fs';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

const root = new URL('../../', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.json', root)));

export const PORTAL_SEVEN = 'https://portal.opspile.test';
export const PORTAL_BRANCHES = 'https://portal-stage.opspile.test';

export const secrets = {
  SUPPORT_PORTAL_SEVEN: PORTAL_SEVEN,
  SUPPORT_ACCESS_ID_SEVEN: 'seven-access.access',
  SUPPORT_ACCESS_SECRET_SEVEN: 'seven-access-secret',
  SUPPORT_PORTAL_BRANCHES: PORTAL_BRANCHES,
  SUPPORT_ACCESS_ID_BRANCHES: 'branch-access.access',
  SUPPORT_ACCESS_SECRET_BRANCHES: 'branch-access-secret',
};

export const SAME = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };

export function opspile(extra = {}) {
  const seen = [];
  const state = { answer: () => new Response('unexpected', { status: 500 }) };
  const worker = new Miniflare({
    modules: true,
    modulesRules: [
      { type: 'Text', include: ['**/cherry/dist/preview-bridge.js'] },
      { type: 'ESModule', include: ['**/*.js'] },
    ],
    scriptPath: fileURLToPath(new URL(config.main, root)),
    compatibilityDate: config.compatibility_date,
    r2Buckets: [config.r2_buckets[0].binding],
    bindings: {
      ...secrets,
      ...extra,
      [config.version_metadata.binding]: { id: 'local' },
    },
    outboundService: async (request) => {
      const call = {
        method: request.method,
        url: request.url,
        headers: Object.fromEntries(request.headers),
        body: await request.text(),
      };
      seen.push(call);
      return state.answer(call);
    },
  });
  after(() => worker.dispose());
  const ready = worker
    .getR2Bucket(config.r2_buckets[0].binding)
    .then((bucket) => bucket.put('branches/feat-shell.json', '{"branch":"feat/shell","files":[]}'));
  return {
    seen,
    answer(handler) {
      state.answer = handler;
      seen.length = 0;
    },
    async fetch(url, init = {}) {
      await ready;
      return worker.dispatchFetch(url, { redirect: 'manual', ...init });
    },
  };
}

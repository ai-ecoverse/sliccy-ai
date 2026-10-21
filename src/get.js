import { UNFRAMED } from './frames.js';

const RELEASES = 'https://github.com/ai-ecoverse';
const latest = (repo) => `${RELEASES}/${repo}/releases/latest/download/install.sh`;

export const TOOLS = {
  slicc: { repo: 'slicc-cli', about: 'the slicc CLI' },
  jerk: { repo: 'slicc-jerk', about: 'slicc-jerk, sign-ins and tokens' },
  'playwright-cli': {
    repo: 'slicc-cdp',
    only: 'playwright-cli',
    about: 'playwright-cli from slicc-cdp',
  },
  curlwright: { repo: 'slicc-cdp', only: 'curlwright', about: 'curlwright from slicc-cdp' },
  mcpcat: { repo: 'mcpcat', about: 'mcpcat, the MCP client and proxy' },
};

const HEADERS = {
  ...UNFRAMED,
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'max-age=300',
};

export function wrapper(tool) {
  const { repo, only } = TOOLS[tool];
  return `#!/bin/sh\nset -eu\ncurl -fsSL ${latest(repo)} | sh -s -- --only ${only} "$@"\n`;
}

function index() {
  const width = Math.max(...Object.keys(TOOLS).map((tool) => tool.length));
  const lines = Object.entries(TOOLS).map(
    ([tool, { about }]) =>
      `curl -fsSL https://get.sliccy.ai/${tool} | sh${' '.repeat(width - tool.length)}  # ${about}`
  );
  return `Install SLICC tools:\n\n${lines.join('\n')}\n\nAppend "-s -- --help" to sh for each installer's options.\n`;
}

export function get(request, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response('only GET and HEAD\n', {
      status: 405,
      headers: { ...HEADERS, allow: 'GET, HEAD' },
    });
  const body = (text, status = 200, extra = {}) =>
    new Response(request.method === 'HEAD' ? null : text, {
      status,
      headers: { ...HEADERS, ...extra },
    });
  const name = url.pathname.slice(1);
  if (url.pathname === '/') return body(index());
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return body(`no installer named ${name}; see https://get.sliccy.ai/\n`, 404);
  if (tool.only) return body(wrapper(name));
  return body(`${latest(tool.repo)}\n`, 302, { location: latest(tool.repo) });
}

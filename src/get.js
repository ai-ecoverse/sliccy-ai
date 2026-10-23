import { UNFRAMED } from './frames.js';

const RELEASES = 'https://github.com/ai-ecoverse';
const latest = (repo, file = 'install.sh') =>
  `${RELEASES}/${repo}/releases/latest/download/${file}`;

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
  open: { repo: 'slicc-open', about: 'slicc-open, the scopen command' },
  'slicc-capture': { repo: 'slicc-capture', about: 'slicc-capture, the sccapture command' },
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

export function powershell(tool) {
  const { repo, only } = TOOLS[tool];
  const select = only ? ` -Only ${only}` : '';
  return [
    '& {',
    "  $ErrorActionPreference = 'Stop'",
    '  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor 3072',
    `  try { $installer = Invoke-RestMethod '${latest(repo, 'install.ps1')}' }`,
    '  catch {',
    '    if ([int]$_.Exception.Response.StatusCode -ne 404) { throw }',
    `    throw '${tool} is not available for Windows yet; see ${RELEASES}/${repo}/releases'`,
    '  }',
    `  & ([scriptblock]::Create($installer))${select} @args`,
    '} @args',
    '',
  ].join('\n');
}

function index() {
  const blocks = Object.entries(TOOLS).map(
    ([tool, { about }]) =>
      `${about}\n  curl -fsSL https://get.sliccy.ai/${tool} | sh\n  irm https://get.sliccy.ai/${tool}.ps1 | iex`
  );
  return [
    'Install SLICC tools with sh on macOS and Linux, or with PowerShell on Windows:',
    '',
    blocks.join('\n\n'),
    '',
    'Append "-s -- --help" to sh for each installer\'s options. In PowerShell, pass options with',
    '  & ([scriptblock]::Create((irm https://get.sliccy.ai/<tool>.ps1))) <options>',
    '',
  ].join('\n');
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
  const windows = name.endsWith('.ps1') ? name.slice(0, -4) : null;
  if (windows !== null && Object.hasOwn(TOOLS, windows)) return body(powershell(windows));
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : null;
  if (!tool) return body(`no installer named ${name}; see https://get.sliccy.ai/\n`, 404);
  if (tool.only) return body(wrapper(name));
  return body(`${latest(tool.repo)}\n`, 302, { location: latest(tool.repo) });
}

import { UNFRAMED } from './frames.js';

export const CLIENT_PATH = '/oauth/client.json';

export const metadata = (root) => ({
  client_id: `${root}${CLIENT_PATH}`,
  client_name: 'SLICC',
  redirect_uris: [`${root}/oauth/mcp-callback`],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
  application_type: 'web',
});

export function client(request, root) {
  const headers = {
    ...UNFRAMED,
    'cache-control': 'public, max-age=3600',
    'access-control-allow-origin': '*',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
  const body = JSON.stringify(metadata(root), null, 2);
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { ...headers, 'content-type': 'application/json' },
  });
}

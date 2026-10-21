import { UNFRAMED } from './frames.js';

export const CLIENT = {
  client_id: 'https://mcpcat.sliccy.ai/oauth/client.json',
  client_name: 'mcpcat',
  client_uri: 'https://github.com/ai-ecoverse/mcpcat',
  application_type: 'native',
  redirect_uris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

export function mcpcat(request, url) {
  const headers = {
    ...UNFRAMED,
    'cache-control': 'public, max-age=3600',
    'access-control-allow-origin': '*',
  };
  if (url.pathname !== '/oauth/client.json')
    return new Response('not found', { status: 404, headers });
  if (request.method !== 'GET' && request.method !== 'HEAD')
    return new Response(null, { status: 405, headers: { ...headers, allow: 'GET, HEAD' } });
  const body = JSON.stringify(CLIENT, null, 2);
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { ...headers, 'content-type': 'application/json' },
  });
}

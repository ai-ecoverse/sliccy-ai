export const SELF_FRAMED = {
  'content-security-policy': "frame-ancestors 'self'",
  'x-frame-options': 'SAMEORIGIN',
};

export const UNFRAMED = {
  'content-security-policy': "frame-ancestors 'none'",
  'x-frame-options': 'DENY',
};

export function framed(response, frames) {
  for (const [name, value] of Object.entries(frames))
    if (!response.headers.has(name)) response.headers.set(name, value);
  return response;
}

export function unframed(response) {
  return response.status === 101 ? response : framed(response, UNFRAMED);
}

export function bounded(response) {
  response.headers.append('content-security-policy', SELF_FRAMED['content-security-policy']);
  const xfo = (response.headers.get('x-frame-options') ?? '').toLowerCase().split(',');
  if (!xfo.some((value) => value.trim() === 'deny'))
    response.headers.set('x-frame-options', SELF_FRAMED['x-frame-options']);
  response.headers.set('referrer-policy', 'no-referrer');
  return response;
}

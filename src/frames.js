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

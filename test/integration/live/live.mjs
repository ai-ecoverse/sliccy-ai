import { env } from 'node:process';
import { setTimeout } from 'node:timers/promises';

export const version = env.SLICCY_AI_VERSION;
export const override = version
  ? { 'cloudflare-workers-version-overrides': `sliccy-ai="${version}"` }
  : {};

export async function get(url, { headers, ...init } = {}) {
  const response = await fetch(url, { ...init, headers: { ...override, ...headers } });
  await response.clone().arrayBuffer();
  return response;
}

export async function deployed(url) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const response = await get(url);
    if (!version || response.headers.get('x-sliccy-ai-version') === version) return response;
    await setTimeout(2000);
  }
  throw new Error(`${url} never answered from version ${version}`);
}

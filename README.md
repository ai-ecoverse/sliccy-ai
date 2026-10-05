# sliccy-ai

The Cloudflare Worker behind `*.sliccy.ai`. It serves the new SLICC from the R2 bucket `slicc-bios`, one origin per release:

- <https://seven.sliccy.ai/>: the `main` branch of [slicc-bios](https://github.com/ai-ecoverse/slicc-bios);
- `https://<branch>.sliccy.ai/`: every other slicc-bios branch. `feat/edge-hosting` becomes <https://feat-edge-hosting.sliccy.ai/>.

Each host is its own origin, so a branch gets its own OPFS and service worker and can't disturb `seven`.

## How it works

[`src/router.js`](src/router.js) runs on the route `*.sliccy.ai/*`. For a request to `https://<label>.sliccy.ai/<path>`, it:
- returns the R2 object `<label>/<path>`, with `index.html` for paths ending in `/`;
- takes the content type from the file extension;
- sends `cache-control: no-cache` and the object's ETag, so `If-None-Match` gets 304 and failed `If-Match`/`If-Unmodified-Since` get 412;
- answers 404 for anything missing and 405 for methods other than GET and HEAD.

`www.sliccy.ai` and `sliccy.ai` have more specific routes to `slicc-tray-hub` (SLICC v6), so they never reach this worker, and `*.` doesn't match the bare domain. A proxied wildcard record `AAAA *.sliccy.ai 100::` makes every other subdomain resolve.

The worker only reads. slicc-bios's `edge/publish.mjs` writes each branch's files under its label, plus a `<label>.json` manifest at the bucket root that records the owning branch. The router never serves it, because every key it builds contains a `/` after the label.

## Develop

```sh
npm install
npm test
npm run lint
```

`npm test` runs the router in workerd through [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare) against a local R2 bucket, using `wrangler.json` for the compatibility date and binding.

## Deploy

Every push to `main` runs `wrangler deploy` (the Deploy workflow; it also runs on demand). It needs the `CLOUDFLARE_API_TOKEN` secret, an account token with:
- Workers Scripts Write on the account;
- Workers Routes Write and Zone Read on `sliccy.ai`.

## Rules

The Biome, lefthook, Renovate and CI configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web):
- no comments;
- unit tests stay in the gitignored `test/unit/`, and lefthook requires full diff coverage of `src/` from them;
- integration tests run in CI.

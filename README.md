# sliccy-ai

The Cloudflare Worker behind `*.sliccy.ai`. It serves the new SLICC from the R2 bucket `slicc-bios`, one origin per release:

- <https://seven.sliccy.ai/>: the `main` branch of [slicc-bios](https://github.com/ai-ecoverse/slicc-bios);
- `https://<branch>.sliccy.ai/`: every other slicc-bios branch. `feat/edge-hosting` becomes <https://feat-edge-hosting.sliccy.ai/>.

Each host is its own origin, so a branch gets its own OPFS and service worker and can't disturb `seven`.

## How it works

[`src/router.js`](src/router.js) runs on the route `*.sliccy.ai/*`. For a request to `https://<label>.sliccy.ai/<path>`, it:
- returns the R2 object `seven/<path>` for `seven` and `branches/<label>/<path>` for every other label, with `index.html` for paths ending in `/`;
- takes the content type from the file extension;
- sends `cache-control: no-cache` and the object's ETag, so `If-None-Match` gets 304 and failed `If-Match`/`If-Unmodified-Since` get 412;
- answers 404 for anything missing and 405 for methods other than GET and HEAD;
- names the worker version that answered in `x-sliccy-ai-version`.

`www.sliccy.ai` and `sliccy.ai` have more specific routes to `slicc-tray-hub` (SLICC v6), so they never reach this worker, and `*.` doesn't match the bare domain. A proxied wildcard record `AAAA *.sliccy.ai 100::` makes every other subdomain resolve.

The worker only reads. slicc-bios's `edge/publish.mjs` writes `main` to `seven/` and every other branch to `branches/<label>/`, each with a manifest next to it (`seven.json`, `branches/<label>.json`) that records the owning branch. The router never serves a manifest, because every key it builds has a `/` after the label.

The bucket's lifecycle rule `branch-releases` expires everything under `branches/` 30 days after it was uploaded. Every push to a branch uploads all of its files again, so active branches stay up, and nobody has to clean up after deleted ones. `seven/` never expires.

## Develop

```sh
npm install
npm test
npm run lint
```

`npm test` runs the router in workerd through [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare) against a local R2 bucket, using `wrangler.json` for the compatibility date and bindings.

## Deploy and post-deploy tests

The Deploy workflow runs on every push:
- **`main`:** `wrangler deploy`, then the post-deploy tests against the version it just deployed.
- **Any other branch:**
  1. `wrangler versions upload`;
  2. add that version to the live deployment at 0% of the traffic;
  3. run the post-deploy tests against it;
  4. put the previous version back at 100% alone, even if the tests fail.

  Production traffic never reaches the branch's version.

The post-deploy tests in [`test/integration/live/`](test/integration/live/) (`npm run test:live`) send `Cloudflare-Workers-Version-Overrides: sliccy-ai="<version>"` on every request to `*.sliccy.ai`, so they reach the version under test, and they wait until `x-sliccy-ai-version` names it. They check:
- serving `seven`;
- 404 for an unknown host;
- 304/412 for conditional requests and 405 for writes;
- that `www.sliccy.ai` and `sliccy.ai` still reach `slicc-tray-hub`;
- that Chromium boots <https://seven.sliccy.ai/> into `bash` in the terminal, cross-origin isolated. The screenshot is uploaded as a workflow artifact.

Without `SLICCY_AI_VERSION` they run against whatever is live.

The workflow needs the `CLOUDFLARE_API_TOKEN` secret, an account token with:
- Workers Scripts Write on the account;
- Workers Routes Write and Zone Read on `sliccy.ai`.

## Rules

The Biome, lefthook, Renovate and CI configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web):
- no comments;
- unit tests stay in the gitignored `test/unit/`, and lefthook requires full diff coverage of `src/` from them;
- integration tests run in CI.

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

`/fonts/*` on every host is passed through to SLICC v6's `slicc-tray-hub` worker, which serves Adobe Clean at `https://www.sliccy.ai/fonts/*`. It goes through a service binding (`V6`), because a plain `fetch` from a Worker to its own zone skips that zone's other Workers and would hit the placeholder origin. That makes the fonts same-origin for the new UI, which can't load them cross-origin because v6 sends no CORS headers. Only `font/*` responses pass through (anything else is a 404), and they're cached for a day.

The tray hub's leader routes are passed through to `slicc-tray-hub` the same way, so a seven page can link devices as a tray leader without CORS:
- `POST /tray`;
- `/controller/<token>`, including the leader's WebSocket upgrade;
- `POST /api/tray/<trayId>/supersede`.

The request goes to `https://www.sliccy.ai/<path>`, so the join and controller URLs the hub mints stay on `www.sliccy.ai`, and followers use them there directly. `Cookie` is dropped on the way in and `Set-Cookie` on the way out, so the page's requests and its leader socket carry no ambient credentials. The page swaps the `www.sliccy.ai` host in the controller and WebSocket URLs for its own. Every other tray route, `/join/*` included, stays on `www.sliccy.ai` only.

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
- that a tray created through `seven.sliccy.ai` gets `www.sliccy.ai` capability URLs and its leader WebSocket connects through `seven.sliccy.ai`;
- that Chromium boots <https://seven.sliccy.ai/> into `bash` in the terminal, cross-origin isolated. The screenshot is uploaded as a workflow artifact.

Without `SLICCY_AI_VERSION` they run against whatever is live.

The workflow needs the `CLOUDFLARE_API_TOKEN` secret, an account token with:
- Workers Scripts Write on the account;
- Workers Routes Write and Zone Read on `sliccy.ai`.

That token can change every Worker on the account, SLICC v6's `slicc-tray-hub` included. So it is **not** a repository secret, which any pushed branch could read by changing the workflow. It's stored in two GitHub environments, and the deploy job runs in one of them:
- **`production`:** used by `main`. Its deployment branch policy allows `main` only, so a branch that names `production` in its workflow is refused before the job starts.
- **`preview`:** used by every other branch, with no approval step, so a branch deploys as soon as it's pushed. Anyone who can push a branch here can use the token through the workflow; forks never get it.

To set them up, a repository admin:
1. creates `production` (deployment branches: selected, `main`) and adds `CLOUDFLARE_API_TOKEN` to it;
2. creates `preview` (deployment branches: all; no required reviewers) and adds `CLOUDFLARE_API_TOKEN` to it;
3. deletes the repository-level `CLOUDFLARE_API_TOKEN`.

## Rules

The Biome, lefthook, Renovate and CI configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web):
- no comments;
- unit tests stay in the gitignored `test/unit/`, and lefthook requires full diff coverage of `src/` from them;
- integration tests run in CI.

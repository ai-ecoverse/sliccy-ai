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
- `/join/<token>`, a follower's attach and bootstrap poll, so a seven page can follow another seven's tray;
- `POST /api/tray/<trayId>/supersede`.

The proxy doesn't follow redirects. A browser can't read a redirect it doesn't follow, so a 3xx from the hub (the 308 a superseded tray answers) comes back as **200**, with:
- the hub's body, which names the new join URL;
- its `Link` header;
- `x-tray-status`: the original status;
- `x-tray-location`: the original `Location`.

The request goes to `https://www.sliccy.ai/<path>`, so the join and controller URLs the hub mints stay on `www.sliccy.ai`, and followers use them there directly. `Cookie` is dropped on the way in and `Set-Cookie` on the way out, so the page's requests and its leader socket carry no ambient credentials. The page swaps the `www.sliccy.ai` host in the controller and WebSocket URLs for its own. Every other tray route stays on `www.sliccy.ai` only.

**Publishing branches without a secret:** `/api/publish/*` on every host lets slicc-bios's branch builds publish with their GitHub Actions OIDC token instead of a Cloudflare token, so a branch never holds a secret that could overwrite `seven/`.
- **The token:** an RS256 JWT, checked against GitHub's keys (`https://token.actions.githubusercontent.com/.well-known/jwks`, cached for 10 minutes). It has to have:
  - `iss` `https://token.actions.githubusercontent.com` and `aud` `https://sliccy.ai`;
  - a valid `exp`, `nbf` and `iat`, with a minute's leeway;
  - `repository` `ai-ecoverse/slicc-bios`, owned by `ai-ecoverse`;
  - a `ref` of `refs/heads/<branch>`.
- **The label comes from the token, not the URL:** `<branch>` maps to `branches/<label>/` by the same rule as slicc-bios's `edge/publish.mjs`. `main`, `seven` and `www` are refused, so `seven/` can't be written this way at all.
- **Owners:** if `branches/<label>.json` already names another branch (`feat/x` and `feat-x` share a label), every call gets 409.
- **The API:**
  - `GET /api/publish/manifest` reads the branch's manifest, and `PUT` with `{ files }` writes it as `{ branch, files }`;
  - `PUT /api/publish/files/<path>` writes a file, with a `Content-Length` of at most 100 MiB;
  - `DELETE /api/publish/files/<path>` removes one.

  Paths with empty, `.` or `..` segments (decoded first) or backslashes are refused.

**The vault:** `vault.sliccy.ai` serves [slicc-vault](https://github.com/ai-ecoverse/slicc-vault)'s `main` release from `vault/main/`, `vault-preview.sliccy.ai` serves the same `main` release to seven's previews as a separate origin with its own storage, and `vault-<branch>.sliccy.ai` serves slicc-vault's other branches from `vault/branches/<label>/`, in the same bucket. Seven embeds it as a hidden iframe and opens it as a popup (the secrets design, §3.2). It is served from the network only: no seven route works on a vault host (tray, fonts, publish), so only GET and HEAD of the vault's own files are answered.
- **Headers on every vault response:**
  - **CSP:** `default-src 'none'`, `script-src 'self' 'wasm-unsafe-eval'`, `style-src 'self'`, and `img-src 'self' data:`; `font-src`, `worker-src` and `manifest-src` are `'self'`; `connect-src 'self' https:` plus the local proxy on `localhost`/`127.0.0.1`; `base-uri 'none'` and `form-action 'none'`.
  - **`frame-ancestors`:**
    - **The production vault** (`vault.sliccy.ai`) allows only `https://seven.sliccy.ai`, plus any staging host named in `STAGING` in `src/router.js`. A preview runs unreviewed branch code, including its own bios, which the vault would trust for attestations, so no preview may embed the production vault.
    - **`vault-preview` and the vault's branch previews** allow every published slicc-bios branch (`https://<label>.sliccy.ai`, read from the `branches/<label>.json` manifests and cached for a minute), except `renovate-*` branches, which never embed a vault. They also allow `http://localhost:*` and `http://127.0.0.1:*`. They never list `seven.sliccy.ai`.
  - **Isolation:** `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-site` and `Cross-Origin-Opener-Policy: same-origin`.
  - **Transport and the rest:** `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Origin-Agent-Cluster: ?1`, so seven's script can't reach the vault's realm even when Chrome runs the same-site frame in seven's process.
- **`/auth/callback`** serves the build's `auth/callback.html`, the OAuth callback six's relay sends to (source `origin`). It's the only extensionless page.
- **`GET /embedders.json`** answers `{ "embedders": [...] }`. It's the same list as `frame-ancestors`, from the same code, and the vault checks `event.origin` against it.
  - **Caching:** `cache-control: no-cache` and the ETag, as for seven.
  - **Cookies:** none set.
- **Publishing:** slicc-vault publishes through the same `/api/publish/*` route (on any host but a vault host), with an OIDC token whose `repository` is `ai-ecoverse/slicc-vault`.
  - `main` publishes to `vault/main/` only when the token's `environment` is `production`, i.e. from a job in slicc-vault's `production` environment.
  - Every other branch publishes to `vault/branches/<label>/`. The label is the branch name lower-cased, with runs of other characters turned into `-`, cut to 57 characters so `vault-<label>` fits a DNS label. slicc-bios's reserved names don't apply here, so `vault-seven` is fine. A vault branch named `preview` can't publish, since `vault-preview` is the shared preview vault.
- **Reserved names:** slicc-bios branches named `vault` or `vault-*` can't publish, so they can never take a vault host.

**Installers:** `https://get.sliccy.ai/<tool>` is a short installer URL, so a tool installs with `curl -fsSL https://get.sliccy.ai/<tool> | sh`. The table is in [`src/get.js`](src/get.js).

| `<tool>` | Answer |
|---|---|
| `slicc` | `302` to slicc-cli's latest `install.sh` |
| `jerk` | `302` to slicc-jerk's latest `install.sh` |
| `mcpcat` | `302` to mcpcat's latest `install.sh` |
| `playwright-cli`, `curlwright` | a three-line `sh` script, fixed here, that pipes slicc-cdp's latest `install.sh` to `sh -s -- --only <tool>` and passes on the caller's arguments (a release URL can't carry them) |

- `/` lists the one-liners, and everything else is a 404.
- Every answer is `text/plain`, with `cache-control: max-age=300`, no cookies and no CORS headers.
- Only GET and HEAD are answered.
- A slicc-bios branch named `get` can't publish.

**A WebSocket echo for tests:** `wss://echo.sliccy.ai/` sends every message back, text and binary. Seven's integration tests use it as a public `wss://` target that SLICC controls, with Cloudflare's real certificate, so a client's certificate-chain check is tested without depending on a third party. The code is in [`src/echo.js`](src/echo.js).
- **Subprotocols:** the first one offered is accepted.
- **Limits:**
  - at most 64 KiB per message, otherwise close 1009;
  - 256 messages per connection, otherwise close 1008;
  - 60 s per connection, then close 1000.
- **Other requests:** a plain request answers 426 with a short note, and every other path is a 404.

**mcpcat's client document:** `https://mcpcat.sliccy.ai/oauth/client.json` is [mcpcat](https://github.com/ai-ecoverse/mcpcat)'s OAuth Client ID Metadata Document (mcpcat's spec §11.2). An authorization server fetches it to learn the client, so mcpcat needs no dynamic registration. The document is in [`src/mcpcat.js`](src/mcpcat.js), so it changes only through a reviewed PR here.
- **What it says:** a public native client (`token_endpoint_auth_method: none`), signing in with the code flow and refresh tokens, with the loopback redirects `http://127.0.0.1/callback` and `http://localhost/callback`. The authorization server lets the port vary (RFC 8252 §7.3).
- **How it's served:** `application/json`, `cache-control: public, max-age=3600`, `access-control-allow-origin: *`, and no cookies. Every other path on `mcpcat.sliccy.ai` is a 404, and a slicc-bios branch named `mcpcat` can't publish.

`www.sliccy.ai` and `sliccy.ai` have more specific routes to `slicc-tray-hub` (SLICC v6), so they never reach this worker, and `*.` doesn't match the bare domain. A proxied wildcard record `AAAA *.sliccy.ai 100::` makes every other subdomain resolve.

The worker only reads. slicc-bios's `edge/publish.mjs` writes `main` to `seven/` and every other branch to `branches/<label>/`, each with a manifest next to it (`seven.json`, `branches/<label>.json`) that records the owning branch. Seven's HTML responses (`seven` and branch previews) send `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so no other site can frame seven; vault hosts send their own `frame-ancestors` instead. The router never serves a manifest, because every key it builds has a `/` after the label.

The bucket's lifecycle rule `branch-releases` expires everything under `branches/` 30 days after it was uploaded. Every push to a branch uploads all of its files again, so active branches stay up, and nobody has to clean up after deleted ones. `seven/` never expires.

## Service hosts

A `*.sliccy.ai` label is either a seven deployment (`seven`, or a published slicc-bios branch preview), one of these service hosts, or unpublished:

| Label | What it is |
|---|---|
| `www`, and the bare `sliccy.ai` | SLICC v6 and the tray hub (`slicc-tray-hub`); they don't reach this worker |
| `vault` | slicc-vault's production release |
| `vault-preview` | slicc-vault's `main` release, as the preview vault for seven's previews |
| `vault-<label>` | slicc-vault's branch previews (the prefix `vault-`) |
| `get` | the installer URLs |
| `mcpcat` | mcpcat's OAuth client document |
| `echo` | a WebSocket echo for tests |

A label nobody published answers 404 through the wildcard record; there's no page there, seven or otherwise.

**Adding a service host** takes three steps:
1. route it in `src/router.js`, before the seven routes;
2. reserve its label (or prefix) in `src/publish.js`, so no slicc-bios branch can publish to it;
3. add it to [slicc-browsers](https://github.com/ai-ecoverse/slicc-browsers)' catalog (`seven.excludedLabels`, or the prefix list), so slicc-cli doesn't take it for seven when it sets up CDP or pairs over loopback.

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
- that the publish route refuses no token, refuses this repository's own real OIDC token (`not from ai-ecoverse/slicc-bios`, so GitHub's keys and the signature check are exercised), and refuses a tampered one (the deploy job has `id-token: write`);
- that a follower attaches to a tray through `seven.sliccy.ai` (`role: follower`, waiting for a leader);
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

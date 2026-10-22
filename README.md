# sliccy-ai

The Cloudflare Worker behind `*.sliccy.ai`. It serves the new SLICC from the R2 bucket `slicc-bios`, one origin per release:

- <https://seven.sliccy.ai/>: the `main` branch of [slicc-bios](https://github.com/ai-ecoverse/slicc-bios);
- `https://<branch>.sliccy.ai/`: every other slicc-bios branch. `feat/edge-hosting` becomes <https://feat-edge-hosting.sliccy.ai/>.

Each host is its own origin, so a branch gets its own OPFS and service worker and can't disturb `seven`.

<https://www.sliccy.ai/7/> serves the same `main` release next to SLICC 6, the first step of the in-place upgrade from six (ai-ecoverse/slicc-bios#648, see [Seven on www.sliccy.ai](#seven-on-wwwsliccyai)).

## How it works

[`src/router.js`](src/router.js) runs on the route `*.sliccy.ai/*`. For a request to `https://<label>.sliccy.ai/<path>`, it:
- returns the R2 object `seven/<path>` for `seven` and `branches/<label>/<path>` for every other label, with `index.html` for paths ending in `/`;
- takes the content type from the file extension;
- sends the object's ETag, so `If-None-Match` gets 304 and failed `If-Match`/`If-Unmodified-Since` get 412, with `cache-control: no-store` for HTML documents and `no-cache` for everything else;
- answers 404 for anything missing and 405 for methods other than GET and HEAD;
- names the worker version that answered in `x-sliccy-ai-version`.

`/fonts/*` on every host is passed through to SLICC v6's `slicc-tray-hub` worker, which serves Adobe Clean at `https://www.sliccy.ai/fonts/*`. It goes through a service binding (`V6`), because a plain `fetch` from a Worker to its own zone skips that zone's other Workers and would hit the placeholder origin. That makes the fonts same-origin for the new UI, which can't load them cross-origin because v6 sends no CORS headers. Only `font/*` responses pass through (anything else is this worker's own 404, with seven's frame headers), and they're cached for a day.

The tray hub's leader routes are passed through to `slicc-tray-hub` the same way, so a seven page can link devices as a tray leader without CORS:
- `POST /tray`;
- `/controller/<token>`, including the leader's WebSocket upgrade;
- `/join/<token>`, a follower's attach and bootstrap poll, so a seven page can follow another seven's tray;
- `POST /api/tray/<trayId>/supersede`;
- `POST /api/tray/<trayId>/biscotto` and `POST /api/tray/<trayId>/biscotto/stop`, which mint and stop a guest seat (POST only).

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
    - **The production vault** (`vault.sliccy.ai`) allows only `https://seven.sliccy.ai` and `https://www.sliccy.ai`, plus any staging host named in `STAGING` in `src/router.js`. A preview runs unreviewed branch code, including its own bios, which the vault would trust for attestations, so no preview may embed the production vault.
    - **`vault-preview` and the vault's branch previews** allow the 48 most recently published slicc-bios branches (`https://<label>.sliccy.ai`, read from the `branches/<label>.json` manifests, ordered by when each manifest was last written, and cached for a minute), except `renovate-*` branches, which never embed a vault, and `gh-readonly-queue-*` branches, the transient merge-queue runs. A branch that hasn't published lately drops out until it publishes again, so the header stays bounded (about 4 KB at most) however many branches have ever been pushed; nothing outside the published previews is ever added, and no wildcard is used. They also allow `http://localhost:*` and `http://127.0.0.1:*`. They never list `seven.sliccy.ai`.
  - **Isolation:** `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-site` and `Cross-Origin-Opener-Policy: same-origin`.
  - **Transport and the rest:** `Strict-Transport-Security: max-age=31536000`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and `Origin-Agent-Cluster: ?1`, so seven's script can't reach the vault's realm even when Chrome runs the same-site frame in seven's process.
- **Caching:** as for seven, HTML documents (`index.html`, `popup.html`, `button.html`) are `no-store` and every other file is `no-cache`, each with its ETag.
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
- Every answer is `text/plain`, with `cache-control: max-age=300`, `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, no cookies and no CORS headers.
- Only GET and HEAD are answered.
- A slicc-bios branch named `get` can't publish.

**A WebSocket echo for tests:** `wss://echo.sliccy.ai/` sends every message back, text and binary. Seven's integration tests use it as a public `wss://` target that SLICC controls, with Cloudflare's real certificate, so a client's certificate-chain check is tested without depending on a third party. The code is in [`src/echo.js`](src/echo.js).
- **Subprotocols:** the first one offered is accepted.
- **Limits:**
  - at most 64 KiB per message, otherwise close 1009;
  - 256 messages per connection, otherwise close 1008;
  - 60 s per connection, then close 1000.
- **Other requests:** a plain request answers 426 with a short note, and every other path is a 404.

**The ntfy gateway:** `https://ntfy.sliccy.ai/` receives webhooks at public URLs and serves them to a seven's tray over [ntfy](https://ntfy.sh)'s subscribe protocol, so native `ntfy`, seven's `ntfy` and the ntfy phone apps work against it unchanged (#42). It replaces SLICC v6's `webhook`. The code is in [`src/ntfy.js`](src/ntfy.js) (the edge), [`src/home.js`](src/home.js) (the Durable Object) and [`src/hook.js`](src/hook.js) (signatures and handshakes).
- **A home per seven:** each seven owns a *home*, one `NtfyHome` Durable Object (SQLite storage) named by an 8-character `homeId` that never changes, so a home outlives the trays a seven leads.
  - **Claim:** `POST /api/home` with `{ controllerToken }` creates a home only if `slicc-tray-hub` confirms that the token leads its tray. The gateway asks the tray's own Durable Object (`/internal/confirm-controller`, through the cross-script binding `TRAY_HUB`), and a refusal, an error or a timeout all answer 403. The answer is `{ homeId, ownerSecret, trayId }`; only the owner secret's SHA-256 is kept. A client may claim at most 10 times a minute, and an id nobody has claimed answers 404 without writing anything.
  - **Rebind:** `POST /api/home/<homeId>/rebind`, with `Authorization: Bearer <ownerSecret>` and the new tray's `{ controllerToken }`. It needs both, so a leaked owner secret can't point the home at a tray its holder doesn't lead. The owner secret is still the home's root credential (it mints tokens and deletes the home), so `POST /api/home/<homeId>/owner` replaces it with a new one, answered once as `{ homeId, ownerSecret }`; the old one stops working at once.
  - **Delete:** `DELETE /api/home/<homeId>` removes every token, hook and message, and the home answers 410 from then on. A home with no owner call, token use, webhook delivery or open subscription for 90 days is deleted the same way.
- **Tokens:** the owner mints one token per consumer with `POST /api/home/<homeId>/tokens` and `{ label, member, scopes, topics?, expires? }`.
  - **The value** is `tk_` + the `homeId` + 21 random characters, the 32 characters of an ntfy token. It's shown once, in the mint's answer; only its SHA-256 is stored, and `GET …/tokens` lists everything else.
  - **`member`** says whom it's for (`kernel`, `phone`, `device:<fingerprint>`, `seat:<id>`). **`scopes`** are `subscribe` (the default), `publish` and `hooks`; `topics` narrows them to a list; `expires` is a Unix time.
  - **Revoking:** `DELETE …/tokens/<id>`, or `DELETE …/tokens?member=device:<fingerprint>` for one member and `?member=device` for every member of a kind. Every request looks its token up in the home, so a revoked token stops working at once, and its open streams end. When a member's last token is revoked or expires, so do the hooks it created, so a kicked follower's hook URLs stop working too; minting the new token before revoking the old one keeps a member's hooks.
  - **Accepted as** `Authorization: Bearer`, as the password (or user) of `Authorization: Basic`, or as `?auth=<base64url of the header>`.
- **ntfy's protocol**, with every topic private to its home (`api`, `file`, `hook` and `v1` aren't topics):
  - `GET /<topic>[,<topic>…]/json`, `/sse` and `/raw`, streaming (an `open` event, the backlog `since` asks for, live messages, a `keepalive` every 45 s) or with `poll=1`. `since` takes `all`, `latest`, `none`, a message id, a Unix time or a duration (`10m`, `2h`, `1d`). Needs `subscribe`.
  - `GET /<topic>/auth` answers `{ "success": true }`, the apps' credential check.
  - `POST`/`PUT /<topic>` with ntfy's headers or query parameters (`title`, `tags`, `priority`, `click`, `icon`, `message`, `filename`, `markdown`), and `POST /` with a JSON message (at most 1 MiB, refused before it's read without a `publish` token). Needs `publish`. `click` and `icon` are kept only if they're `http(s)` links.
  - `GET /v1/health` and `GET /v1/config` answer without a token; every other request needs one.
- **Hooks:** a token with `hooks` manages them with `POST /api/hooks` (`{ name, topic?, secret?, verifyToken? }`; the topic defaults to the name), `GET /api/hooks` and `DELETE /api/hooks/<name>`, for the topics it covers. A hook's URL is `https://ntfy.sliccy.ai/hook/<id>`, an unguessable id, and anyone holding it can post to its topic, so `hooks` is as strong as `publish` there.
  - **Signatures:** a hook with a secret checks the signature before anything is stored, and answers 401 otherwise (a request with no signature header at all is refused before its body is read): GitHub's (and Meta's) `X-Hub-Signature-256`, Stripe's `Stripe-Signature`, Standard Webhooks (`webhook-*`, `svix-*`, with a `whsec_` secret or a raw one), Slack's `X-Slack-Signature`, and GitLab's `X-Gitlab-Token`. Timestamps may be at most 5 minutes off.
  - **Handshakes** are answered at the edge and never stored: Meta's `hub.challenge` (checked against `verifyToken`, or the secret if there's none, since Meta's verify token is a different value from its app secret), Microsoft Graph's `validationToken`, and Slack's `url_verification`. A challenge is echoed only if it's at most 1 KiB of printable ASCII, with `nosniff` and a sandboxing CSP.
  - **The message:** `title` is the event (`X-GitHub-Event`, `X-Gitlab-Event`, or the body's `type`), `tags` names the provider, `message` is the body, and `headers` (an allowlist that drops any name with `secret`, `token`, `password`, `auth`, `cookie`, `api-key` or `credential` in it, so never `Authorization` or `X-Gitlab-Token`), `verified` and `hook` are added. They reach a handler through `$NTFY_RAW`.
- **Large bodies:** a body over 48 KiB, one that isn't UTF-8, or one whose JSON line would pass 60 KiB (ntfy's client reads lines of up to 64 KiB) becomes an `attachment`. Its URL, `https://ntfy.sliccy.ai/file/<id>.<ext>`, is a capability, as in ntfy: an unguessable id, served without a token, as `Content-Disposition: attachment` with `nosniff` and a sandboxing CSP, until the message expires.
- **Limits:** messages are kept 7 days, at most 1,000 per home, with at most 100 MiB of attachments; the oldest go first. A webhook or message body is at most 25 MiB. A home holds at most 256 tokens, 64 hooks and 64 open streams, 8 of them per token, and takes at most 300 messages and webhook deliveries a minute (429 with `retry-after: 60` past that), counted only once a token or a hook id has been checked, so knowing a `homeId` isn't enough to use up its budget. A backlog is read from storage page by page as the subscriber reads it, and a subscriber that falls 1 MiB behind live messages (or 16 MiB across the home) is dropped; ntfy clients reconnect with `since`.
- **CORS:** every answer has `access-control-allow-origin: *`, and preflights allow the headers they ask for, so seven's page and the ntfy web app can call it. No cookies are read or set, and every answer sends `referrer-policy: no-referrer`. `?auth=` is ntfy's and works, but it puts the token in URLs and logs; prefer the header, or give such tokens an `expires`.
- A slicc-bios branch named `ntfy` can't publish.

**mcpcat's client document:** `https://mcpcat.sliccy.ai/oauth/client.json` is [mcpcat](https://github.com/ai-ecoverse/mcpcat)'s OAuth Client ID Metadata Document (mcpcat's spec §11.2). An authorization server fetches it to learn the client, so mcpcat needs no dynamic registration. The document is in [`src/mcpcat.js`](src/mcpcat.js), so it changes only through a reviewed PR here.
- **What it says:** a public native client (`token_endpoint_auth_method: none`), signing in with the code flow and refresh tokens, with the loopback redirects `http://127.0.0.1/callback` and `http://localhost/callback`. The authorization server lets the port vary (RFC 8252 §7.3).
- **How it's served:** `application/json`, `cache-control: public, max-age=3600`, `access-control-allow-origin: *`, and no cookies. Every answer, the 404 included, sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. Every other path on `mcpcat.sliccy.ai` is a 404, and a slicc-bios branch named `mcpcat` can't publish.

`www.sliccy.ai/*` and `sliccy.ai/*` have more specific routes to `slicc-tray-hub` (SLICC v6), and `*.` doesn't match the bare domain. Only seven's paths on www (`/7`, `/7/*` and `/os/*`) have routes of their own here, more specific still (see below). A proxied wildcard record `AAAA *.sliccy.ai 100::` makes every other subdomain resolve.

The worker only reads. slicc-bios's `edge/publish.mjs` writes `main` to `seven/` and every other branch to `branches/<label>/`, each with a manifest next to it (`seven.json`, `branches/<label>.json`) that records the owning branch. Every answer this worker makes for `seven` and the branch previews, whatever its status or type (404s, 405s, 304s, 412s, publish errors, scripts), sends `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so no other site can frame seven; what's passed through from six (fonts, the tray routes) keeps six's headers, and vault hosts send their own `frame-ancestors` instead. The router never serves a manifest, because every key it builds has a `/` after the label.

The bucket's lifecycle rule `branch-releases` expires everything under `branches/` 30 days after it was uploaded. Every push to a branch uploads all of its files again, so active branches stay up, and nobody has to clean up after deleted ones. `seven/` never expires.

## Seven on www.sliccy.ai

Seven shares `www.sliccy.ai` with SLICC 6 while six's users upgrade in place (ai-ecoverse/slicc-bios#648). The BIOS is `/7/` and its UI `/os/`; every other path stays six's.

- **Routes:** `www.sliccy.ai/7*` and `www.sliccy.ai/os/*` in `wrangler.json`, more specific than tray-hub's `www.sliccy.ai/*`. The `*` after `7` is what catches `/7?<query>`, which a bare `www.sliccy.ai/7` route doesn't match. A www request that reaches this worker on another path (`/70`, say) goes to six through `V6`, unchanged.
- **`/7`** answers 301 to `/7/`, keeping the query.
- **`/7/<path>`** is R2's `seven/<path>`, exactly as `seven.sliccy.ai` serves it: `index.html` for directories, the ETag with 304 and 412, `no-store` on HTML documents, and `frame-ancestors 'self'` with `X-Frame-Options` on every answer, as are `/7`'s 301 and `/os/`'s 302 and 404. `/7/sw.js` also gets `Service-Worker-Allowed: /`, so the BIOS registers its service worker at scope `/` and the UI is `/os/`. After the upgrade, seven's service worker answers `/` too.
- **The tray hub under `/7`:** `POST /7/tray`, `/7/controller/<token>` (WebSocket included), `/7/join/<token>`, `POST /7/api/tray/<trayId>/supersede` and the guest-seat routes are the tray routes above without the `/7`: cookies dropped both ways, a 3xx answered as 200 with `x-tray-status` and `x-tray-location`. Seven could reach the hub on www directly, but then it would send www's cookies and couldn't read the hub's redirects.
- **`/os/*`** is answered from OPFS by seven's service worker. A navigation that reaches the network instead (`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`: a first visit, a cleared site, a hard reload) gets a 302 to `/7/`, so it goes through the BIOS; anything else there is a 404. Without this route, tray-hub's single-page fallback would answer `/os/` with six's `index.html`.
- **Nothing is written on www:** `/7/` answers only GET and HEAD outside the tray routes, so `/7/api/publish/*` is a 404 (405 for writes).
- **The vault:** production seven runs on www too, so the production vault lets it embed (see the vault above). In a browser that hasn't upgraded yet, six's `/preview/` service worker serves agent-written HTML unsandboxed on www, and that HTML could frame the production vault. The vault's storage there is partitioned under www, though, and stays empty until seven runs in that browser, and the upgrade unregisters six's `/preview/` before seven stores anything (ai-ecoverse/slicc#4051).
- **Fonts** on www stay tray-hub's own `/fonts/*`, same-origin for seven there.
- **Later:** when `www.sliccy.ai/` serves the BIOS, `/7/` keeps working, because bookmarks and the service worker's script URL `/7/sw.js` must not move.

## Service hosts

A `*.sliccy.ai` label is either a seven deployment (`seven`, or a published slicc-bios branch preview), one of these service hosts, or unpublished:

| Label | What it is |
|---|---|
| `www`, and the bare `sliccy.ai` | SLICC v6 and the tray hub (`slicc-tray-hub`); only seven's `/7` and `/os/` paths on www reach this worker |
| `vault` | slicc-vault's production release |
| `vault-preview` | slicc-vault's `main` release, as the preview vault for seven's previews |
| `vault-<label>` | slicc-vault's branch previews (the prefix `vault-`) |
| `get` | the installer URLs |
| `mcpcat` | mcpcat's OAuth client document |
| `echo` | a WebSocket echo for tests |
| `ntfy` | the ntfy-compatible webhook gateway |

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

`npm test` runs the router in workerd through [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare) against a local R2 bucket, using `wrangler.json` for the compatibility date and bindings. The ntfy tests run the `NtfyHome` Durable Object and a stand-in `slicc-tray-hub` that exports a `SessionTrayDurableObject`, reached through the same cross-script binding as in production.

## CI, releases and deploys

CI is one caller workflow, [`ci.yml`](.github/workflows/ci.yml), that runs [slicc-shared-web's `pipeline.yml`](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the same v2 tag as the `@ai-ecoverse/slicc-shared-web` devDependency, with `secrets: inherit`, on pull requests, in the merge queue and on `main`:
- **Everywhere:** `npm run lint`.
- **Pull requests and the merge queue:** `npm test` (`test/integration/*.test.mjs`), split across the pipeline's shards. `ci / integration` and `ci / review` are the checks to require.
- **Pull requests:** the branch's post-deploy tests (the pipeline's `deploy` input, in the `staging` environment, see below), then a Claude and a Codex review.
- **`main`:** semantic-release, in the `production` environment. It tags `vX.Y.Z` and writes a GitHub release from the conventional commits; nothing goes to npm (`release.config.mjs` has no npm plugin). `fix:` and `feat:` release; `chore:`, `ci:`, `docs:` and `test:` don't, so a Renovate `chore(deps)` merge deploys nothing until the next release.

[`scripts/deploy.mjs`](scripts/deploy.mjs) does both deploys:
- **A release (`after-release`):** `wrangler deploy`, tagged with the release, then the post-deploy tests against the version it just deployed. A push to `main` that releases nothing deploys nothing.
- **A pull request (`deploy`):**
  1. wait while another branch's version is in the deployment (up to 10 minutes);
  2. `wrangler versions upload`;
  3. add that version to the live deployment at 0% of the traffic, next to the stable version read just before;
  4. run the post-deploy tests against it;
  5. put the version at 100% back alone, even if the tests fail.

  Production traffic never reaches the branch's version. Each switch is checked against the deployment history afterwards: if another deployment (a release, say) landed between reading the deployment and writing it, that deployment is put back and the job fails.

The post-deploy tests in [`test/integration/live/`](test/integration/live/) (`npm run test:live`) send `Cloudflare-Workers-Version-Overrides: sliccy-ai="<version>"` on every request to `*.sliccy.ai`, so they reach the version under test, and they wait until `x-sliccy-ai-version` names it. They check:
- serving `seven`;
- `cache-control: no-store` on `seven.sliccy.ai/` and `vault.sliccy.ai/`, and `no-cache` on `bios.js`;
- 404 for an unknown host;
- 304/412 for conditional requests and 405 for writes;
- that `www.sliccy.ai` and `sliccy.ai` still reach `slicc-tray-hub`;
- that the publish route refuses no token, refuses this repository's own real OIDC token (`not from ai-ecoverse/slicc-bios`, so GitHub's keys and the signature check are exercised), and refuses a tampered one (both deploying jobs have `id-token: write`);
- that a follower attaches to a tray through `seven.sliccy.ai` (`role: follower`, waiting for a leader);
- that a tray created through `seven.sliccy.ai` gets `www.sliccy.ai` capability URLs and its leader WebSocket connects through `seven.sliccy.ai`;
- that `ntfy.sliccy.ai` answers its health probe and refuses a topic without a token;
- after a release only, that a tray created through `seven.sliccy.ai` claims an ntfy home with its controller token (and a forged token is refused), and a signed GitHub webhook over 48 KiB reaches a subscriber as a verified message with an attachment. A branch version at 0% can't run this one: each Durable Object runs the version the deployment split assigns it, whatever the override header says, so every home still runs the stable version;
- that Chromium boots <https://seven.sliccy.ai/> into `bash` in the terminal, cross-origin isolated;
- after a release only, that `www.sliccy.ai/7/` serves the BIOS with `Service-Worker-Allowed` on `sw.js`, `/7` (with its query) and an `/os/` navigation go to `/7/`, `/status` is still six's, and Chromium boots `www.sliccy.ai/7/` into `bash` with the UI at `/os/`. A branch version can't run these: `wrangler versions upload` doesn't change routes, so www's paths reach the stable version until a release deploys.

Without `SLICCY_AI_VERSION` they run against whatever is live.

Both need the `SLICCY_AI_DEPLOY_TOKEN` secret, an account token with:
- Workers Scripts Write on the account;
- Workers Routes Write and Zone Read on `sliccy.ai`.

`scripts/deploy.mjs` hands it to wrangler as `CLOUDFLARE_API_TOKEN`, and runs the post-deploy tests without it. The pipeline never passes its own `CLOUDFLARE_API_TOKEN` (the reviewers' screenshot token) to `deploy` or `after-release`, hence the separate name.

That token can change every Worker on the account, SLICC v6's `slicc-tray-hub` included. So it is **not** a repository secret, which any pushed branch could read by changing the workflow. It's stored in two GitHub environments, and `ci.yml` hands it only to the two jobs that deploy (`deploy-secrets` and `release-secrets`):
- **`production`:** the release job's. Its deployment branch policy allows `main` only, so a branch that names `production` in its workflow is refused before the job starts.
- **`staging`:** the pipeline's `deploy` job's, on every pull request, with no approval step, so a pull request deploys as soon as it's pushed. Anyone who can push a branch here can use the token through the workflow; forks never get it.

To set them up, a repository admin:
1. creates `production` (deployment branches: selected, `main`) and adds `SLICCY_AI_DEPLOY_TOKEN` to it;
2. creates `staging` (deployment branches: all; no required reviewers) and adds `SLICCY_AI_DEPLOY_TOKEN` to it;
3. keeps the token out of the repository and organization secrets.

## Rules

The Biome, lefthook, Renovate and CI configuration comes from [slicc-shared-web](https://github.com/ai-ecoverse/slicc-shared-web):
- no comments;
- unit tests stay in the gitignored `test/unit/`, and lefthook requires full diff coverage of `src/` from them;
- integration tests run in CI, through the pipeline above.

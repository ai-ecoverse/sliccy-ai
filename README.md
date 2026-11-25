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

`/fonts/*` on every host is passed through to SLICC v6's `slicc-tray-hub` worker, which serves Adobe Clean at `https://www.sliccy.ai/fonts/*`. It goes through a service binding (`V6`), because a plain `fetch` from a Worker to its own zone skips that zone's other Workers and would hit the placeholder origin. That makes the fonts same-origin for the new UI, which can't load them cross-origin because v6 sends no CORS headers. Only `font/*` responses pass through, with `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` (anything else is this worker's own 404, with seven's frame headers), and they're cached for a day.

The tray hub's leader routes are passed through to `slicc-tray-hub` the same way, so a seven page can link devices as a tray leader without CORS:
- `POST /tray`;
- `/controller/<token>`, including the leader's WebSocket upgrade;
- `/join/<token>`, a follower's attach and bootstrap poll, so a seven page can follow another seven's tray;
- `POST /api/tray/<trayId>/supersede`;
- `POST /api/tray/<trayId>/biscotto` and `POST /api/tray/<trayId>/biscotto/stop`, which mint and stop a guest seat (POST only);
- `POST /api/tray/<trayId>/preview` and `POST /api/tray/<trayId>/preview/stop`, which mint and revoke a live preview (POST only), and `GET /api/tray/<trayId>/previews`, which lists the tray's previews (GET only), for `serve` in seven ([slicc-serve#6](https://github.com/ai-ecoverse/slicc-serve/issues/6));
- `PUT /api/tray/<trayId>/preview/<previewToken>/file?path=…` (PUT only, the query kept) and `POST /api/tray/<trayId>/preview/<previewToken>/finalize` (POST only), which upload a `--ttl` snapshot's files with its upload token and finalize it ([slicc-serve#4](https://github.com/ai-ecoverse/slicc-serve/issues/4)).

The proxy doesn't follow redirects. A browser can't read a redirect it doesn't follow, so a 3xx from the hub (the 308 a superseded tray answers) comes back as **200**, with:
- the hub's body, which names the new join URL;
- its `Link` header;
- `x-tray-status`: the original status;
- `x-tray-location`: the original `Location`.

The request goes to `https://www.sliccy.ai/<path>`, so the join and controller URLs the hub mints stay on `www.sliccy.ai`, and followers use them there directly. `Cookie` is dropped on the way in and `Set-Cookie` on the way out, so the page's requests and its leader socket carry no ambient credentials. Every answer but the WebSocket's 101 is `no-store` and carries `frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN` (six's own CSP is kept beside it, and so is its `DENY`). Every such answer also sends `Referrer-Policy: no-referrer`, whatever six sends. The page swaps the `www.sliccy.ai` host in the controller and WebSocket URLs for its own. Every other tray route stays on `www.sliccy.ai` only.

**Publishing branches without a secret:** `/api/publish/*` on every host lets slicc-bios's branch builds and pull requests publish with their GitHub Actions OIDC token instead of a Cloudflare token, so a branch never holds a secret that could overwrite `seven/`.
- **The token:** an RS256 JWT, checked against GitHub's keys (`https://token.actions.githubusercontent.com/.well-known/jwks`, cached for 10 minutes). It has to have:
  - `iss` `https://token.actions.githubusercontent.com` and `aud` `https://sliccy.ai`;
  - a valid `exp`, `nbf` and `iat`, with a minute's leeway;
  - `repository` `ai-ecoverse/slicc-bios`, owned by `ai-ecoverse`;
  - a `ref` of `refs/heads/<branch>`, or a pull request's (below).
- **Pull requests:** slicc-shared-web's pipeline publishes a pull request's preview from its `deploy` job, whose token has a `ref` of `refs/pull/<number>/merge`. Such a token is accepted only with:
  - `event_name` `pull_request` and `environment` `staging`;
  - a `ref` matching `^refs/pull/\d+/merge$` exactly (`refs/pull/<number>/head` is refused);
  - a non-empty `head_ref`, the pull request's branch, which then stands for `<branch>` everywhere below. A pull request and a push of its branch write the same preview, and the manifest names the branch either way.

  A pull request from a fork gets no token there. A pull request token never writes `seven/` or `vault/main/`.
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
- **Caching:** as for seven, HTML documents (`index.html`, `popup.html`, `button.html`) and `/config.json` are `no-store` and every other file is `no-cache`, each with its ETag.
- **`GET /embedders.json`** answers `{ "embedders": [...] }`. It's the same list as `frame-ancestors`, from the same code, and the vault checks `event.origin` against it.
  - **Caching:** `cache-control: no-store`.
  - **Cookies:** none set.
- **Publishing:** slicc-vault publishes through the same `/api/publish/*` route (on any host but a vault host), with an OIDC token whose `repository` is `ai-ecoverse/slicc-vault`.
  - `main` publishes to `vault/main/` only from a push to `main` whose token's `environment` is `production`, i.e. from a job in slicc-vault's `production` environment. A pull request token with `head_ref` `main` is refused.
  - A pull request publishes its `head_ref`'s preview, with the token checks of slicc-bios's pull requests.
  - Every other branch publishes to `vault/branches/<label>/`. The label is the branch name lower-cased, with runs of other characters turned into `-`, cut to 57 characters so `vault-<label>` fits a DNS label. slicc-bios's reserved names don't apply here, so `vault-seven` is fine. A vault branch named `preview` can't publish, since `vault-preview` is the shared preview vault.
- **Reserved names:** slicc-bios branches named `vault` or `vault-*` can't publish, so they can never take a vault host.

**Installers:** `https://get.sliccy.ai/<tool>` is a short installer URL, so a tool installs with `curl -fsSL https://get.sliccy.ai/<tool> | sh`, and on Windows with `irm https://get.sliccy.ai/<tool>.ps1 | iex` in PowerShell. The table is in [`src/get.js`](src/get.js).

| `<tool>` | Answer |
|---|---|
| `slicc` | `302` to slicc-cli's latest `install.sh` |
| `jerk` | `302` to slicc-jerk's latest `install.sh` |
| `mcpcat` | `302` to mcpcat's latest `install.sh` |
| `open` | `302` to slicc-open's latest `install.sh` (the `scopen` command) |
| `slicc-capture` | `302` to slicc-capture's latest `install.sh` (the `sccapture` command) |
| `man` | `302` to slicc-man's latest `install.sh` (the `scman` command) |
| `slicc-audio` | `302` to slicc-audio's latest `install.sh` (`say`, `hear`, `afplay`, `chime`) |
| `jsh` | `302` to slicc-jsh's latest `install.sh` (the host `jsh` command) |
| `serve` | `302` to slicc-serve's latest `install.sh` (the `scserve` command) |
| `playwright-cli`, `curlwright` | a three-line `sh` script, fixed here, that pipes slicc-cdp's latest `install.sh` to `sh -s -- --only <tool>` and passes on the caller's arguments (a release URL can't carry them) |

- **Windows:** `/<tool>.ps1`, for every `<tool>` above, is a short PowerShell script, fixed here, that downloads the tool repo's latest release asset `install.ps1` and runs it. The Worker asks GitHub nothing; the script does.
  - For slicc-cdp's tools it passes `-Only <tool>`, the PowerShell form of the sh wrapper's `--only <tool>`, so a repo's `install.ps1` takes an `-Only` parameter. The caller's arguments are passed on too, with `& ([scriptblock]::Create((irm https://get.sliccy.ai/<tool>.ps1))) <options>`.
  - If the release has no `install.ps1` (a 404), it stops with `<tool> is not available for Windows yet; see https://github.com/ai-ecoverse/<repo>/releases`, a terminating error (so `powershell -Command` exits 1), and runs nothing. Other download errors stop it too.
  - It runs inside a script block, so it leaves no variables in the caller's session, and it turns on TLS 1.2 for Windows PowerShell 5.1.
- `/` lists the sh and PowerShell one-liners for each tool, and everything else, an unknown `/<x>.ps1` included, is a 404.
- Every answer is `text/plain`, with `cache-control: max-age=300`, `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, no cookies and no CORS headers.
- Only GET and HEAD are answered.
- A slicc-bios branch named `get` can't publish.

**Previews:** `*.sliccy.now` and the serve hub's API `/api/serve/*` are described in [Previews on sliccy.now](#previews-on-sliccynow-the-serve-hub).

**Adobe Support:** the Support API (`/api/support/*` on seven and branch hosts, `/7/api/support/*` on www) is described in [Adobe Support](#adobe-support).

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
  - **Handshakes** are answered at the edge and never stored: Meta's `hub.challenge` (checked against `verifyToken`, or the secret if there's none, since Meta's verify token is a different value from its app secret), Microsoft Graph's `validationToken`, Slack's `url_verification`, and the [MCP Events](https://github.com/modelcontextprotocol/ext-events) `verification` envelope. A challenge is echoed only if it's at most 1 KiB of printable ASCII, with `nosniff` and a sandboxing CSP that also carries `frame-ancestors 'none'`.
    - **MCP Events:** before an MCP server delivers events to a hook it POSTs `{"type":"verification","challenge":"<nonce>"}`, signed with Standard Webhooks and the subscription's `delivery.secret`. A hook whose secret is that `delivery.secret` checks the signature (401 if it doesn't verify) and answers `{"challenge":"<nonce>"}`; the `X-MCP-Subscription-Id` it carries isn't needed, since a hook has one secret. A hook without a secret answers such a request 403 and stores nothing, because an echo it can't check the signature of would prove no one's intent; an MCP subscription needs a hook created with its `delivery.secret`. `gap` and `terminated` envelopes are stored like events, and every delivery's `X-MCP-Subscription-Id` (not a secret) is kept in `headers`, so a handler can recognize MCP control envelopes and route them per subscription.
    - **No well-known document:** `/.well-known/mcp-webhook-receiver.json` isn't served. It would waive the challenge for every hook on `ntfy.sliccy.ai` at once, secretless ones included, letting anyone who learns a hook URL point a server's deliveries at it.
  - **The message:** `title` is the event (`X-GitHub-Event`, `X-Gitlab-Event`, or the body's `type`), `tags` names the provider, `message` is the body, and `headers` (an allowlist that drops any name with `secret`, `token`, `password`, `auth`, `cookie`, `api-key` or `credential` in it, so never `Authorization` or `X-Gitlab-Token`), `verified` and `hook` are added. They reach a handler through `$NTFY_RAW`.
- **Large bodies:** a body over 48 KiB, one that isn't UTF-8, or one whose JSON line would pass 60 KiB (ntfy's client reads lines of up to 64 KiB) becomes an `attachment`. Its URL, `https://ntfy.sliccy.ai/file/<id>.<ext>`, is a capability, as in ntfy: an unguessable id, served without a token, as `Content-Disposition: attachment` with `nosniff` and a sandboxing CSP that also carries `frame-ancestors 'none'`, until the message expires.
- **Limits:** messages are kept 7 days, at most 1,000 per home, with at most 100 MiB of attachments; the oldest go first. A webhook or message body is at most 25 MiB. A home holds at most 256 tokens, 64 hooks and 64 open streams, 8 of them per token, and takes at most 300 messages and webhook deliveries a minute (429 with `retry-after: 60` past that), counted only once a token or a hook id has been checked, so knowing a `homeId` isn't enough to use up its budget. A backlog is read from storage page by page as the subscriber reads it, and a subscriber that falls 1 MiB behind live messages (or 16 MiB across the home) is dropped; ntfy clients reconnect with `since`.
- **CORS:** every answer has `access-control-allow-origin: *`, and preflights allow the headers they ask for, so seven's page and the ntfy web app can call it. No cookies are read or set, and every answer sends `referrer-policy: no-referrer`. `?auth=` is ntfy's and works, but it puts the token in URLs and logs; prefer the header, or give such tokens an `expires`.
- A slicc-bios branch named `ntfy` can't publish.

**mcpcat's client document:** `https://mcpcat.sliccy.ai/oauth/client.json` is [mcpcat](https://github.com/ai-ecoverse/mcpcat)'s OAuth Client ID Metadata Document (mcpcat's spec §11.2). An authorization server fetches it to learn the client, so mcpcat needs no dynamic registration. The document is in [`src/mcpcat.js`](src/mcpcat.js), so it changes only through a reviewed PR here.
- **What it says:** a public native client (`token_endpoint_auth_method: none`), signing in with the code flow and refresh tokens, with the loopback redirects `http://127.0.0.1/callback` and `http://localhost/callback`. The authorization server lets the port vary (RFC 8252 §7.3).
- **How it's served:** `application/json`, `cache-control: public, max-age=3600`, `access-control-allow-origin: *`, and no cookies. Every answer, the 404 included, sends `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`. Every other path on `mcpcat.sliccy.ai` is a 404, and a slicc-bios branch named `mcpcat` can't publish.

**SLICC's client document:** `/oauth/client.json` is SLICC's OAuth Client ID Metadata Document, generated per origin in [`src/client.js`](src/client.js), so every seven has an identity of its own with an authorization server.
- **What it says:** a public web client (`token_endpoint_auth_method: none`, `application_type: web`), signing in with the code flow and refresh tokens. `client_id` is the document's own `https` URL, and `redirect_uris` is that origin's `/oauth/mcp-callback` alone.
- **Which origins:** `https://seven.sliccy.ai`, `https://www.sliccy.ai` (the agent runs from `/opt/agent/` under the service worker's scope `/`, so its redirect is `/oauth/mcp-callback`, which that service worker answers), `https://www.sliccy.ai/7` (`/7/oauth/client.json`, redirecting to `/7/oauth/mcp-callback`), and each published slicc-bios branch, whose `branches/<label>.json` manifest exists. It wins over R2, so a file a branch publishes at that path is never served; publishing it is still allowed, as it's harmless. An unpublished label, a service host and every other www path answer as they did.
- **How it's served:** as mcpcat's, with `frame-ancestors 'none'` and `X-Frame-Options: DENY`. Methods other than GET and HEAD get 405.

`www.sliccy.ai/*` and `sliccy.ai/*` have more specific routes to `slicc-tray-hub` (SLICC v6), and `*.` doesn't match the bare domain. Seven's paths on www (`/7`, `/7/*`, `/os/*` and `/oauth/client.json`) and the Sliccy DMG download have routes of their own here, more specific still (see below). A proxied wildcard record `AAAA *.sliccy.ai 100::` makes every other subdomain resolve.

The worker only reads. slicc-bios's `edge/publish.mjs` writes `main` to `seven/` and every other branch to `branches/<label>/`, each with a manifest next to it (`seven.json`, `branches/<label>.json`) that records the owning branch. Every answer this worker makes for `seven` and the branch previews, whatever its status or type (404s, 405s, 304s, 412s, publish errors, scripts), sends `Content-Security-Policy: frame-ancestors 'self'` and `X-Frame-Options: SAMEORIGIN`, so no other site can frame seven. The tray routes add `frame-ancestors 'self'` as a policy of their own next to six's `Content-Security-Policy`, and `X-Frame-Options: SAMEORIGIN` unless six sent `DENY`; fonts, `ntfy` and `echo` send `frame-ancestors 'none'` and `X-Frame-Options: DENY`, vault hosts send their own `frame-ancestors` instead, and SLICC's client document sends `'none'`. Every answer this worker makes carries a framing policy, except six's own answers passed through on www and on `*.sliccy.now`, a live preview's answers (the origin's own headers stand), and WebSocket upgrades. The router never serves a manifest, because every key it builds has a `/` after the label.

The bucket's lifecycle rule `branch-releases` expires everything under `branches/` 30 days after it was uploaded. Every push to a branch uploads all of its files again, so active branches stay up, and nobody has to clean up after deleted ones. `seven/` never expires.

## Stable Sliccy Mac download

`https://www.sliccy.ai/download/sliccy.dmg` is the version-independent download URL for the native [Sliccy Mac app](https://github.com/ai-ecoverse/sliccy-app/releases/latest). The 7.0.0 DMG requires Apple silicon and macOS 27 or newer. This is a separate release line from Sliccstart; the legacy `/download/slicc.dmg` and other platform downloads remain with V6.

- **Routing:** `www.sliccy.ai/download/sliccy.dmg*` takes precedence over tray-hub's `www.sliccy.ai/*`. The trailing wildcard catches query strings, as with `/7*`; the handler matches only the exact pathname and ignores query parameters. Lookalike paths still proxy unchanged to V6. Other hosts do not gain a download route. Installing this Cloudflare route requires the normal production rollout; uploading a PR preview version does not install routes.
- **Discovery:** [`src/download.js`](src/download.js) fetches the public GitHub latest-release API for `ai-ecoverse/sliccy-app`, accepting only a stable published `vMAJOR.MINOR.PATCH` release and exactly one uploaded, nonempty `Sliccy-MAJOR.MINOR.PATCH.dmg`. Both the release page and asset URL must exactly match this repository, tag and filename. The endpoint returns **302** to that validated versioned asset for GET and HEAD, with an empty body; it never proxies the DMG bytes. It does not invent a `/latest/download/Sliccy.dmg` asset or accept a redirect target from the request.
- **Bounds and caching:** discovery includes response reading within five seconds and at most 256 KiB of JSON. Metadata redirects are refused, and request cookies and authorization are never forwarded. Successful GitHub metadata may be cached at Cloudflare's edge for five minutes; within each worker isolate, one discovery is shared by concurrent requests and its success or failure is kept for one minute. Each request waits at most five seconds for it, and a shared discovery older than that is replaced by a fresh one, so a cancelled request cannot stall later ones. A newly published release can therefore take up to six minutes to appear here. Client redirects are `no-store`.
- **Failures:** missing/invalid assets, API limits, network errors and timeouts answer **503**, `Retry-After: 60` and `Cache-Control: no-store`; an expired successful lookup is not served on failure. GET includes the stable GitHub release landing in its message; HEAD has no body. Every answer includes that landing as a `Link: rel="alternate"`. Other methods answer **405** with `Allow: GET, HEAD` without discovery. All responses have the existing unframed policy and `Referrer-Policy: no-referrer`.
- **Release information and updates:** use [the latest release landing](https://github.com/ai-ecoverse/sliccy-app/releases/latest) for release notes and installation requirements. No extra info route is needed. Sparkle's existing stable [appcast.xml](https://github.com/ai-ecoverse/sliccy-app/releases/latest/download/appcast.xml) is unchanged.

## Seven on www.sliccy.ai

Seven shares `www.sliccy.ai` with SLICC 6 while six's users upgrade in place (ai-ecoverse/slicc-bios#648). The BIOS is `/7/` and its UI `/os/`; outside those and the client document, only the Sliccy DMG download described above is handled here. Other paths stay six's.

- **Routes:** `www.sliccy.ai/7*`, `www.sliccy.ai/os/*` and `www.sliccy.ai/oauth/client.json` in `wrangler.json`, more specific than tray-hub's `www.sliccy.ai/*`. The `*` after `7` is what catches `/7?<query>`, which a bare `www.sliccy.ai/7` route doesn't match. A www request that reaches this worker on another path (`/70`, say) goes to six through `V6`, unchanged.
- **`/7`** answers 301 to `/7/`, keeping the query.
- **`/7/<path>`** is R2's `seven/<path>`, exactly as `seven.sliccy.ai` serves it: `index.html` for directories, the ETag with 304 and 412, `no-store` on HTML documents, and `frame-ancestors 'self'` with `X-Frame-Options` on every answer, as are `/7`'s 301 and `/os/`'s 302 and 404. `/7/sw.js` also gets `Service-Worker-Allowed: /`, so the BIOS registers its service worker at scope `/` and the UI is `/os/`. After the upgrade, seven's service worker answers `/` too.
- **The tray hub under `/7`:** `POST /7/tray`, `/7/controller/<token>` (WebSocket included), `/7/join/<token>`, `POST /7/api/tray/<trayId>/supersede` and the guest-seat routes are the tray routes above without the `/7`: cookies dropped both ways, a 3xx answered as 200 with `x-tray-status` and `x-tray-location`, and the same frame headers. Seven could reach the hub on www directly, but then it would send www's cookies and couldn't read the hub's redirects.
- **`/os/*`** is answered from OPFS by seven's service worker. A navigation that reaches the network instead (`Sec-Fetch-Mode: navigate` or `Sec-Fetch-Dest: document`: a first visit, a cleared site, a hard reload) gets a 302 to `/7/`, so it goes through the BIOS; anything else there is a 404. Without this route, tray-hub's single-page fallback would answer `/os/` with six's `index.html`.
- **Nothing is written on www:** `/7/` answers only GET and HEAD outside the tray routes, the serve hub's `/7/api/serve/*` (see [Previews on sliccy.now](#previews-on-sliccynow-the-serve-hub)) and the Support API's `/7/api/support/*` (see [Adobe Support](#adobe-support)), so `/7/api/publish/*` is a 404 (405 for writes).
- **The vault:** production seven runs on www too, so the production vault lets it embed (see the vault above). In a browser that hasn't upgraded yet, six's `/preview/` service worker serves agent-written HTML unsandboxed on www, and that HTML could frame the production vault. The vault's storage there is partitioned under www, though, and stays empty until seven runs in that browser, and the upgrade unregisters six's `/preview/` before seven stores anything (ai-ecoverse/slicc#4051).
- **Fonts** on www stay tray-hub's own `/fonts/*`, same-origin for seven there.
- **Later:** when `www.sliccy.ai/` serves the BIOS, `/7/` keeps working, because bookmarks and the service worker's script URL `/7/sw.js` must not move.

## Service hosts

A `*.sliccy.ai` label is either a seven deployment (`seven`, or a published slicc-bios branch preview), one of these service hosts, or unpublished:

| Label | What it is |
|---|---|
| `www`, and the bare `sliccy.ai` | SLICC v6 and the tray hub (`slicc-tray-hub`); only seven's `/7`, `/os/` and `/oauth/client.json` paths on www reach this worker |
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

## Previews on sliccy.now (the serve hub)

`serve` in seven and slicc-serve's `scserve` publish a directory or a local server at a public `https://<label>.sliccy.now/` URL. This worker is their hub ([#167](https://github.com/ai-ecoverse/sliccy-ai/issues/167)): it takes the `*.sliccy.now/*` route over from SLICC 6's `slicc-preview` worker, relays every visitor's full HTTP request to the publisher's socket, and serves `--ttl` snapshots from R2. Six's own previews keep working on six's hub: every label in six's formats goes on to `slicc-preview` unchanged. There are no limits on who publishes or how much (no sign-in, no quotas); the bounds below protect the hub and the visitor, not a budget. The code is in [`src/serve.js`](src/serve.js) (the API's and `*.sliccy.now`'s edge), [`src/host.js`](src/host.js) (the Durable Object) and [`src/relay.js`](src/relay.js) (headers, frames and the bridge's injection).

### Publishers

A **publisher** is one `ServeHost` Durable Object (SQLite storage), named by a `hostId` of 20 lowercase hex digits. Seven's page and each machine running `scserve` keep their own host; neither needs a tray.

- **Creating one:** `POST /api/serve/host` (no body, no credentials) answers 201 `{ hostId, secret }`. The secret is 64 hex digits and is shown only here; the host keeps its SHA-256.
- **Credentials:** every other call names the host in its path and carries `Authorization: Bearer <secret>`. A missing or wrong secret is 401 (`UNAUTHORIZED`, with `WWW-Authenticate: Bearer`); a host nobody created is 404 (`HOST_NOT_FOUND`) and a deleted one 410 (`HOST_GONE`), so a client that gets either creates a new host and tries again once.
- **Where:** the API is answered on `seven.sliccy.ai` and every branch host (`/api/serve/…`), and on `www.sliccy.ai/7/api/serve/…`, so seven's page reaches it on its own origin without CORS, wherever it runs. It's one hub: a host made through one origin works through all of them. `scserve` uses `https://seven.sliccy.ai` (overridable for tests and staging). No cookies are read or set, and there are no CORS headers.
- **Deleting one:** `DELETE /api/serve/host/<hostId>` stops every preview, deletes its snapshots, closes its sockets and answers 200 `{ "deleted": true }`; the host answers 410 from then on. A host is deleted the same way once 90 days pass with no API call and no publisher socket open, and none of its snapshots unexpired.
- **Answers** are JSON: `{ … }` on success, `{ error, code }` otherwise, with `cache-control: no-store`, `Referrer-Policy: no-referrer` and seven's frame headers.

### Previews

| call | does |
| --- | --- |
| `POST /api/serve/host/<hostId>/previews` `{ entry?, tag?, bridge?, maxTabs?, quiet?, ttlMs? }` | mints a preview: 201 with the preview's record (below) |
| `GET /api/serve/host/<hostId>/previews` | `{ previews: [record, …] }`, live ones and snapshots, uploading or ready |
| `DELETE /api/serve/host/<hostId>/previews/<previewToken>` | stops it: 200 `{ "stopped": true }`, or 404 `PREVIEW_NOT_FOUND` |
| `PUT /api/serve/host/<hostId>/previews/<previewToken>/files/<path>` | uploads one file of a snapshot |
| `POST /api/serve/host/<hostId>/previews/<previewToken>/finalize` | publishes the snapshot: 200 with its record |

- **The mint's fields:**
  - `entry`: the URL path the preview opens at, starting with `/` (default `/`), at most 2,048 characters, without `\` or control characters. The URL is `https://<label>.sliccy.now<entry>`; a live preview's origin answers every path, so `entry` only says where to start.
  - `tag`: an opaque string of at most 256 characters the publisher picks (`scserve` uses its served root, `/srv/serve/<16 hex>`); the hub only lists it back, so a publisher that restarts can tell its leftovers apart.
  - `bridge` (default `false`), `maxTabs` (1 to 100, default 20) and `quiet` (default `false`): see [the bridge](#the-bridge-on-sliccynow).
  - `ttlMs`: makes it a snapshot that lasts that long after it's finalized, a positive whole number of milliseconds, at most 30 days. A snapshot can't be bridged (400).
- **The record:** `{ previewToken, url, entry, tag, mode, state, bridge, maxTabs, quiet, createdAt, expiresAt, files, bytes }`. `mode` is `live` or `snapshot`; `state` is `ready`, or `uploading` for a snapshot not finalized yet; `expiresAt` is `null` for a live preview and for a snapshot before it's finalized; `files` and `bytes` are a snapshot's (0 for a live preview).
- **Stopping** a live preview sends `preview.revoked` to the publisher's socket and closes its visitor tabs' bridges; stopping a snapshot deletes its files. Either way its URL answers 404 at once.
- **A live preview** lives as long as its host: it is served while the publisher's socket is open, and answers 502 while it isn't. Publishers stop the ones they no longer serve.

### Labels

A new preview's label is `<hostId>-<secret>`: the host's 20 hex digits, `-`, and 32 random lowercase hex digits, 53 characters in all. The label is the `previewToken` and the capability: anyone who has the URL can visit, and nobody can guess one. Six's labels always contain `--` (`<32 hex>--<secret>` and `<32 hex>--<hash8>-<secret>`), so the two formats never overlap, and six can't mint a label this hub answers.

### `*.sliccy.now`

The route `*.sliccy.now/*` (zone `sliccy.now`) runs this worker. For `https://<label>.sliccy.now/…`:

- **A label that matches `^[0-9a-f]{20}-[0-9a-f]{32}$`** is this hub's: the preview, served from its publisher's socket (live) or from R2 (a snapshot). A token of that shape nobody minted, or one stopped or expired, is 404.
- **Every other label** (six's formats, six's MCP hosts, anything else) goes to six's `slicc-preview` worker over the service binding `V6_PREVIEW`, byte for byte: the request as it came (method, URL, headers, body, a WebSocket upgrade) and six's answer as it went, with nothing added or removed, not even `x-sliccy-ai-version`. So six's existing previews, uploads, bridges and errors don't change.
- **Answers the hub makes itself** on `*.sliccy.now` (errors, snapshot files, the bridge's bootstrap) carry `Content-Security-Policy: frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `x-sliccy-ai-version`; errors are `text/plain` and `no-store`. A live preview's answers are the origin's own (below), plus `x-sliccy-ai-version`.

### Full HTTP over the publisher's socket

The publisher holds one WebSocket to the hub, `GET /api/serve/host/<hostId>/ws`, on any origin the API answers on. Browsers can't set headers on a WebSocket, so the secret goes either in `Authorization: Bearer <secret>` or as the subprotocol `bearer.<secret>` next to `slicc-serve.v1` (`new WebSocket(url, ['slicc-serve.v1', 'bearer.' + secret])`); the hub answers with `slicc-serve.v1`. A refusal is the API's JSON error instead of the 101. A host has one socket: a new one replaces the old, which is closed with 4000 (`replaced`). Deleting the host closes it with 4001 (`host deleted`). On a new socket the hub first sends `hello { hostId }`; stopping a live preview through the API sends `preview.revoked { previewToken }`.

**Frames.** Every message is a JSON text frame with a `type`, except body bytes and the keepalive.
- **Body bytes** are binary frames: the stream's `id` as a 4-byte big-endian unsigned integer, then 1 to 65,536 bytes of body.
- **Keepalive:** the publisher sends the text frame `ping` every 30 s, and the hub answers `pong` without waking the Durable Object. A socket the hub hasn't heard from for 90 s counts as gone.
- **Sizes:** a JSON frame is at most 1 MiB, and a header list at most 64 KiB and 256 entries. A larger frame, a binary frame shorter than 5 bytes, or one that isn't JSON where JSON is due closes the socket with 1009 or 1008. A message of an unknown `type` is ignored, so either side can add some later; a body frame or message for a stream that's gone (finished or cancelled) is ignored too.

**A visitor's request** to a live preview opens a stream; the hub numbers them per socket.

| direction | message |
| --- | --- |
| hub → publisher | `http.request { id, previewToken, method, url, path, headers, body }` |
| hub → publisher | the request body's binary frames, then `http.request.end { id }` (only when `body` is `true`) |
| publisher → hub | `http.response { id, status, headers, body }` |
| publisher → hub | the response body's binary frames, then `http.response.end { id }` (only when `body` is `true`) |
| either way | `http.ack { id, bytes }`: the receiver has passed on `bytes` more of the stream's body |
| either way | `http.cancel { id, reason }`: the stream is over; nothing more is sent for it either way |

- **`url`** is the visitor's full URL (`https://<label>.sliccy.now/a/b?x=1`) and **`path`** its path and query exactly as they came, still percent-encoded; the publisher sends `path` to its origin. **`headers`** is a list of `[name, value]` pairs with lowercase names, in the visitor's order, repeats kept; `body` says whether a request body follows. The request is the visitor's, every method, with the headers below. `Range`, conditional requests and `Cookie` reach the origin as the visitor sent them, so the origin answers 206, 304 and 416 itself.
- **`status`** is 200 to 599 (no 1xx); `headers` the same shape, so several `Set-Cookie` lines survive. `body` is `false` for `HEAD`, 204 and 304, and the hub ignores any body frames then.
- **Flow control:** a sender has at most 1 MiB of a stream's body unacknowledged at a time, and the receiver acknowledges bytes once it has passed them on (the hub, as the visitor reads the response; the publisher, as its origin reads the request body), so neither side buffers more than that per stream, however large or long a body is.
- **Cancelling:** the hub sends `http.cancel` when the visitor goes away or a bound below is hit, and the publisher when its origin fails. A cancel before `http.response` is the visitor's 502 (504 for the timeouts, 413 for a request body over the limit, with the reason as its text); after, the visitor's body ends in an error.
- **Bounds:**
  - a request body is at most 100 MiB (`Content-Length` larger is 413 before anything is sent; a body that runs past it is cancelled);
  - a response body has no length limit, as long as it keeps moving: a live stream (server-sent events, a long download) runs as long as the visitor reads it;
  - `http.response` must come within 30 s of the request (else 504, `the publisher didn't answer within 30 s`), and each later response frame within 120 s of the one before (else the visitor's body ends in an error);
  - a request body the publisher doesn't acknowledge for 60 s is cancelled;
  - a host has at most 256 streams open at once; another visitor request gets 503 with `retry-after: 1`.
- **When there's no socket**, a live preview answers 502 (`the publisher of this preview is offline`). When the socket closes, every open stream is cancelled as above.
- **WebSockets** from visitors aren't relayed yet (apart from the bridge): an upgrade to a live preview answers 501. The frame format leaves room for them.

**Headers.** The hub passes on everything an ordinary reverse proxy would, and nothing of its own.
- **To the publisher:** the visitor's headers without:
  - the hop-by-hop ones (`connection` and the names it lists, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`);
  - `host` (it's in `url`);
  - Cloudflare's and any proxy's (`cf-*`, `cdn-loop`, `forwarded`, `x-forwarded-*`, `x-real-ip`, `true-client-ip`), so the visitor's address never reaches a publisher;
  - `x-sliccy-*`.

  For a bridged preview, `accept-encoding` is replaced by `identity`, so the hub can inject the bootstrap into the page. The publisher sets `Host` for its origin (`127.0.0.1:<port>`, which dev servers checking `Host` accept) and may add `X-Forwarded-Host` and `X-Forwarded-Proto: https`; it rewrites a `Location` on its origin (`http://127.0.0.1:<port>/x`, `http://localhost:<port>/x`) to the path alone, so redirects stay on the preview.
- **To the visitor:** the origin's headers without the hop-by-hop ones, `alt-svc` and `x-sliccy-*`. A `Content-Length` is kept and must match the body (otherwise the body ends in an error); a `Content-Encoding` is passed on with the bytes as they are. The origin's own `Cache-Control`, CSP and framing headers stand; the hub adds none, and caches nothing.
- **Cookies:** `sliccy.now` isn't on the Public Suffix List, so a cookie set with `Domain=sliccy.now` would reach every preview. The hub drops the `Domain` attribute from every `Set-Cookie` an origin sends, so each one is host-only and stays with its own preview. (A page's script can still write such a cookie through `document.cookie`; only the Public Suffix List would stop that, so a preview shouldn't trust a cookie it didn't set.) The visitor's `Cookie` header goes to the preview it was sent to and nowhere else; the hub's API never reads cookies.

### Snapshots (`--ttl`)

A snapshot is minted with `ttlMs`, then filled and finalized by its publisher, who can go offline after that.
- **Uploading:** `PUT …/previews/<previewToken>/files/<path>`, with the host's bearer, a `Content-Length` (411 without) and the file's `Content-Type` (default `application/octet-stream`), answers 200 `{ path, size }`. `<path>` is the file's path under the snapshot's root, each segment percent-encoded; decoded, no segment may be empty, `.` or `..`, or hold `\` or NUL (400). The same path again replaces the file, so a failed upload can simply be retried.
- **Limits,** checked before the body is stored: 25 MiB per file (413 `FILE_TOO_LARGE`), 1,000 files (413 `TOO_MANY_FILES`) and 50 MiB in all (413 `SNAPSHOT_TOO_LARGE`), the limits of six. Uploading to a finalized snapshot is 409 `SNAPSHOT_FINALIZED`.
- **Finalizing:** `POST …/finalize` needs the entry's file, else 400 `ENTRY_MISSING`: the `entry`'s path without its query or fragment, percent-decoded as upload paths are, with `index.html` after a final `/` (so `/a%20b.html?x=1` needs `a b.html`, and `/docs/` needs `docs/index.html`). From then on the snapshot is served for `ttlMs`, then deleted. One that isn't finalized within an hour of its mint is deleted.
- **Storage:** R2, the bucket `sliccy-now-basic-storage` (binding `SERVE_STORAGE`) under `serve/<hostId>/`, a prefix six doesn't use; the host's Durable Object keeps the index and deletes the files with an alarm when the snapshot expires or is stopped.
- **Serving:** `GET` and `HEAD` (others 405, `Allow: GET, HEAD`). A path, percent-decoded, is the file of that name; one ending in `/` is its `index.html`; a path without its final `/` whose `index.html` exists is 301 to the path with it (query kept). The query is ignored otherwise. Each file has its type, `ETag` (`If-None-Match` gets 304), `Accept-Ranges: bytes` with one range answered as 206 (and 416 outside the file), `cache-control: no-cache`, and the hub's headers above. Anything else is 404.

### The bridge on sliccy.now

A bridged live preview (`bridge: true`) makes each visitor's tab drivable by the publisher, as six's `serve --bridge` does, with the same bootstrap and visitor protocol.
- **The bootstrap** is `@ai-ecoverse/cherry`'s published `preview-bridge.js` (a pinned devDependency, bundled into this worker), served at `/__slicc/preview-bridge.js` with `cache-control: public, max-age=86400`. The hub inserts `<script src="/__slicc/preview-bridge.js" data-slicc-token="<previewToken>" data-slicc-ws="wss://<label>.sliccy.now/__slicc/bridge"></script>` right after `<head>` (else `<body>`, else at the end) of every 200 `text/html` answer without a `Content-Encoding`, drops its `Content-Length`, and adds `wss://<label>.sliccy.now` to the `connect-src` of the origin's CSP (or adds `connect-src 'self' wss://<label>.sliccy.now` if it has none).
- **The tab's socket** is `/__slicc/bridge` (WebSocket). At most `maxTabs` tabs at once per preview (another is 429 `BRIDGE_CAP`). The hub answers the tab's `ping` with `pong`, sends it `{ t: "welcome", connId }`, passes `cdp.req` to it and its `cdp.res` and `emit` frames on. A tab's frame is at most 1 MiB. `POST /__slicc/emit` (the bootstrap's beacon when its socket is down) takes one `{ t: "emit", name, detail }` of at most 16 KiB and answers 204.
- **On the publisher's socket:**
  - hub → publisher: `bridge.connected { previewToken, connId, origin, userAgent, connectedAt, replay? }`, `bridge.disconnected { previewToken, connId, reason? }`, `bridge.emit { previewToken, connId, name, detail, at }` (`connId` is `null` for a beacon), and `bridge.cdp.response { connId, id, result?, error? }`;
  - publisher → hub: `bridge.cdp.request { connId, id, method, params?, sessionId? }` and `bridge.close { connId }`; a request for a tab that's gone is answered `{ code: -32000, message: "Preview bridge connection is gone" }`;
  - emits: at most 16 KiB each and 20 per tab every 10 s; more are dropped. They go only to the publisher, no webhook.
- **Reconnecting:** visitor tabs stay with the hub while the publisher's socket is down. A new socket gets, after `hello { hostId }`, `preview.state { previewToken, quiet, announced }` for each bridged preview and `bridge.connected { …, replay: true }` for each tab still there. The publisher latches the first-visit announcement with `preview.state.update { previewToken, announced }`, which the hub keeps.
- `/__slicc/*` paths of a preview that isn't bridged go to its origin like any other path.

### Moving over

1. **This worker** gets the `ServeHost` class and its migration, the `SERVE_STORAGE` and `V6_PREVIEW` bindings, the API, and the `*.sliccy.now` handler with six's labels forwarded, while `slicc-preview` still has the route. The API works on `*.sliccy.ai` from then on, and integration tests cover the hub with a fake publisher.
2. **The route:** the `*.sliccy.now/*` route is reassigned from `slicc-preview` to `sliccy-ai` in one step (the route keeps its id, so rolling back is reassigning it again), and `wrangler.json` lists it from then on. Wrangler refuses to deploy a route another worker holds, so the reassignment comes before the release that lists it. `SLICCY_AI_DEPLOY_TOKEN` needs Zone Read and Workers Routes Write on `sliccy.now` for that. Right after, six's existing previews and a new one are checked on production. Six's own `wrangler-preview.jsonc` no longer names the route, so six's `slicc-preview` deploys don't touch it; its script still uploads, which is all the forwarding needs.
3. **The clients** switch: slicc-serve's `scserve` and seven's `serve`, and slicc-bios's page relay, each in their repository. Six's tray API stays as it is, for six.

### Rolling back the route

The route is `*.sliccy.now/*`, id `52e942a4b9924600b9c482245b55fa91`, zone `46d6506442b8be4e4840520ed22961d3`. It has belonged to `sliccy-ai` since release v1.15.0.

- **Traffic:** reassign the route to `slicc-preview` in Cloudflare; it keeps its id. A rollback of this worker's version doesn't move it, and the version before the route, v1.14.0 (`d955c1bb-1d53-4c98-8061-6c6370a95b64`), already forwards six's labels to `slicc-preview`.
- **Releases:** `wrangler.json` lists the route, and wrangler refuses to deploy a route another worker holds, so every release fails at the route step until a pull request removes the `*.sliccy.now/*` line.
- **Going forward again:** reassign the route to `sliccy-ai` and restore the line, in that order.

## Adobe Support

Seven embeds Adobe Support: the Support panel on slicc-spectrum's `support` port ([slicc-spectrum#1008](https://github.com/ai-ecoverse/slicc-spectrum/pull/1008)). The page reaches Opspile's portal integration API (`/integrations/portal/v1`, adobe/helix-opspile's `docs/PORTAL-INTEGRATION.md`) through this worker, which adds the service credentials. The code is in [`src/support.js`](src/support.js).

- **Signing in isn't here:** seven already signs in with Adobe on its own (slicc-bios's `src/seed/adobe.js`). It uses an implicit grant with the IMS client `experience-catalyst-prod` on IMS prod. Its scopes, `openid,AdobeID,additional_info.ownerOrg,read_organizations,…`, come from the Adobe LLM proxy's public `/v1/config`. IMS redirects to SLICC 6's registered relay `https://www.sliccy.ai/auth/callback`, which sends the token on to `https://<label>.sliccy.ai/auth/callback`. The page then gets it over a `BroadcastChannel`, after checking a nonce. The Support port sends that token here, and this worker neither mints, stores nor refreshes it.
- **Where:**
  - `/api/support/*` on `seven.sliccy.ai` and every published branch host (one whose `branches/<label>.json` exists);
  - `/7/api/support/*` on `www.sliccy.ai`, where production seven also runs (see [Seven on www.sliccy.ai](#seven-on-wwwsliccyai)). It's the same fixed map with the `seven` profile, and a create's `Location` points under `/7/api/support/`.

  www's own `/api/support/*` stays SLICC 6's, passed on to `slicc-tray-hub` unchanged. Vault hosts, service hosts and unpublished labels don't have the API, and answer those paths as before.
- **Two profiles:** `seven` for `seven.sliccy.ai` and `www.sliccy.ai/7/`, and `branches` for every branch preview. Each has its own Opspile portal and Access service token, so branch code, which nobody has reviewed, can't reach production Support data with the production service token. `branches` goes to Opspile's staging portal with a service token of its own, and must never hold the production one.
- **One IMS client for both:** both profiles get production IMS tokens from `experience-catalyst-prod`, since branches sign in like seven. The staging Opspile host registration therefore has to accept prod IMS tokens for that client (identity environment `prod`, client ID `experience-catalyst-prod`), not stg1 ones. Its customers and members should be test enrollments.
- **Same origin only:** every call needs `Sec-Fetch-Site: same-origin`, and an `Origin`, if sent, must be the host's own (`https://www.sliccy.ai` on www); anything else is 403 `forbidden`. There are no CORS headers, and no cookies are read or set.
- **Answers:** JSON, with `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and seven's frame headers. Errors have Opspile's v1 shape, `{"error":{"code":"…"}}`. The worker's own codes are:
  - `invalid_input` (400);
  - `invalid_assertion` (401, no bearer token or a malformed one);
  - `forbidden` (403);
  - `not_found` (404);
  - `method_not_allowed` (405, with `Allow`);
  - `unavailable` (503, also when the profile isn't configured).
- **Nothing logged:** the module doesn't log. Tokens and message text never go into a log or a URL.

### The Support API

`/api/support/*` is a fixed map of Opspile's v1 operations. The page sends `Authorization: Bearer <IMS access token>`, the one seven signed in with.

| call | goes to `<portal>/integrations/portal/v1` |
|---|---|
| `GET /api/support/threads?limit=&cursor=` | `GET /threads` (list) |
| `POST /api/support/threads` `{ title, body, topic? }`, with `Idempotency-Key` | `POST /threads` (create) |
| `GET /api/support/threads/<root>?limit=&cursor=` | `GET /threads/<root>` (detail) |
| `POST /api/support/threads/<root>/replies` `{ body }`, with `Idempotency-Key` | `POST /threads/<root>/replies` (reply) |
| `PUT /api/support/threads/<root>/read` `{ through }` | `PUT /threads/<root>/read` (read) |
| `GET /api/support/changes?after=` | `GET /changes` (changes) |

- **What's checked:** any other path is 404 and any other method 405. Then, before anything is sent:
  - `<root>` is 1 to 128 of `A-Z a-z 0-9 . _ : -`;
  - only the listed query parameters, once each: `limit` from 1 to 100, and `cursor` and `after` up to 2,048 printable ASCII characters;
  - a body is `application/json`, at most 16 KiB, an object with only the listed string fields (`topic` is optional), and what's sent on is rebuilt from those fields;
  - `Idempotency-Key` is 1 to 128 of `A-Z a-z 0-9 . _ : -`, and both POSTs need one;
  - the bearer token is up to 8 KiB of base64url characters, `.`, `+`, `/`, `=` and `~`.

  A failed check is 400 `invalid_input`, or 401 `invalid_assertion` for the token. Opspile checks the content itself (lengths, topics).
- **What's sent:** only `Accept: application/json`, `Authorization: Bearer <the user's IMS token>` as issued, the profile's `CF-Access-Client-Id` and `CF-Access-Client-Secret`, and for writes `Content-Type: application/json` and the `Idempotency-Key`. No tenant, org, subject or email: Opspile verifies the IMS token itself and takes the organization from the IMS profile (its host-passed identity mode, with one host registration per profile). The request carries no cookies, follows no redirects and gives up after 15 s.
- **What comes back:**
  - a 2xx JSON answer, with its status. A create's `Location` becomes `/api/support/threads/<id>`, and any other `Location` is dropped;
  - a v1 error, with its status, as `{"error":{"code"}}` and nothing else of its body;
  - `rate_limited` for a 429 without one;
  - 503 `unavailable` for anything else: an Access refusal or redirect, an answer that isn't JSON, a timeout.

  `Retry-After` passes through on every answer. No other upstream header reaches the page.
- **Enrollment:** Opspile has no status operation yet. `GET /api/support/threads?limit=1` is 200 when the signed-in profile is enrolled and 403 `not_enrolled` when it isn't, and 401 `invalid_assertion` means signing in again (the token expired, was revoked, or isn't from a client Opspile accepts).

### Configuration

| name | kind | what |
|---|---|---|
| `SUPPORT_PORTAL_<PROFILE>` | secret | the portal Worker's origin (`https://…`, no path) |
| `SUPPORT_ACCESS_ID_<PROFILE>`, `SUPPORT_ACCESS_SECRET_<PROFILE>` | secrets | the Cloudflare Access service token Opspile registered for the profile |

`<PROFILE>` is `SEVEN` or `BRANCHES`. Without its portal and service token, a profile's API answers 503 `unavailable` and calls nothing. Portal origins are secrets too: they go to Opspile's operator out of band, not into this repository. The `seven` profile's are set.

### Setting it up

Support works once these manual steps are done:
1. **The IMS client:** the owners of `experience-catalyst-prod` confirm that Support may rely on it and on its `additional_info.ownerOrg` scope. Opspile takes the customer from the signed-in profile's `ownerOrg`.
2. **Opspile:** two host registrations with IMS identity, both for IMS prod and the client `experience-catalyst-prod`: one on the production portal for `seven`, one on the staging portal for `branches`. Each has its own Access service token, and the customers and members are enrolled as PORTAL-INTEGRATION.md describes.
3. **Secrets:** someone with the deploy token sets each profile's secrets above with `wrangler secret put <NAME>`, after the release that ships this. That command deploys the current version with them.
4. **slicc-bios:** its `SupportPort`, and its service worker passing `/api/support/*` to the network.

**On www:** `www.sliccy.ai` is one origin for SLICC 6 and seven's `/7/`. A token seven holds there is visible to SLICC 6's pages on www, through script or its service worker. That includes the IMS token the Support API sends, which is the same token seven's existing Adobe sign-in already holds on www. `/7/api/support/*` adds no new exposure, and same-origin is the only check it can make: a SLICC 6 page holding the token could call it too.

## Develop

```sh
npm install
npm test
npm run lint
```

`npm test` runs the router in workerd through [Miniflare](https://github.com/cloudflare/workers-sdk/tree/main/packages/miniflare) against a local R2 bucket, using `wrangler.json` for the compatibility date and bindings. The serve hub's tests (`serve.test.mjs`) run the `ServeHost` Durable Object with a fake publisher ([`publisher.mjs`](test/integration/publisher.mjs)) that speaks the socket protocol, flow control included, and a stand-in `slicc-preview` behind `V6_PREVIEW`; `SERVE_LIMITS` (a JSON object, unset in production) shortens the hub's timeouts and bounds for them. The ntfy tests run the `NtfyHome` Durable Object and a stand-in `slicc-tray-hub` that exports a `SessionTrayDurableObject`, reached through the same cross-script binding as in production. The Adobe Support tests (`support.test.mjs`) answer for the Opspile portal with Miniflare's `outboundService` ([`opspile.mjs`](test/integration/opspile.mjs)), with made-up secrets.

`deploy.test.mjs` runs [`scripts/deploy.mjs`](scripts/deploy.mjs) against a stand-in wrangler and a fixture git repository with release tags, so the pull request deploy's choice of the stable version is tested without Cloudflare.

## CI, releases and deploys

CI is one caller workflow, [`ci.yml`](.github/workflows/ci.yml), that runs [slicc-shared-web's `pipeline.yml`](https://github.com/ai-ecoverse/slicc-shared-web#pipeline) at the same v2 tag as the `@ai-ecoverse/slicc-shared-web` devDependency, with `secrets: inherit`, on pull requests, in the merge queue and on `main`:
- **Everywhere:** `npm run lint`.
- **Pull requests and the merge queue:** `npm test` (`test/integration/*.test.mjs`), split across the pipeline's shards. `ci / integration` and `ci / review` are the checks to require.
- **Pull requests:** the branch's post-deploy tests (the pipeline's `deploy` input, in the `staging` environment, see below), then a Claude and a Codex review.
- **`main`:** semantic-release, in the `production` environment. It tags `vX.Y.Z` and writes a GitHub release from the conventional commits; nothing goes to npm (`release.config.mjs` has no npm plugin). `fix:` and `feat:` release; `chore:`, `ci:`, `docs:` and `test:` don't, so a Renovate `chore(deps)` merge deploys nothing until the next release.

[`scripts/deploy.mjs`](scripts/deploy.mjs) does both deploys:
- **A release (`after-release`):** `wrangler deploy`, tagged with the release, then the post-deploy tests against the version it just deployed. A re-run of the release job deploys the version that release already uploaded, so each tag names one version. A push to `main` that releases nothing deploys nothing.
- **A pull request (`deploy`):**
  1. wait while another branch's version is in the deployment (up to 10 minutes);
  2. `wrangler versions upload`;
  3. add that version to the live deployment at 0% of the traffic, next to the stable version read just before;
  4. wait, up to 90 seconds, until `seven`, `vault`, `ntfy`, `mcpcat` and `get.sliccy.ai` each answer from it three times in a row, since the edge picks up a new deployment a few seconds after wrangler returns (a release waits the same way);
  5. run the post-deploy tests against it, even if the wait gave up;
  6. put the version at 100% back alone, even if the tests fail.

  Production traffic never reaches the branch's version. The pipeline's deploy job can't share a lock or a concurrency group with the release, so the script keeps one rule instead: the version at 100% is the one at 100% in the newest deployment a branch job didn't write (a release, or a rollback by hand). Every deployment a branch job writes has a message starting `post-deploy tests for `, and:
  - the stable version is decided once, before the job writes anything, and kept by version id through every later switch, put-back and cleanup, so the job's own writes pushing that deployment out of the history don't change it; only a release or rollback by hand that lands during the job replaces it. It's read from that newest other deployment, not from whatever is live. `wrangler deployments list` only returns the last 10, so when every one of those is a branch job's, the stable version is the one tagged with the newest `v*` git tag of this repository, never an older one, deployed by its version id (found in `wrangler versions list`, or among the versions in the deployment history), since wrangler's `--version-tag` doesn't find it; if no deployable version has that tag, the job fails without switching anything;
  - if the version at 100% isn't that tagged one either, as after a rollback by hand that has since left the history, the job fails without switching anything. A failed deploy also fails the pull request's review, so a release can't fix it: deploy the live version by hand with a message that doesn't start with `post-deploy tests for ` (`wrangler versions deploy <version>@100% -y --message "hold <version>"`), or roll back again, and pull request deploys pass again;
  - after each switch, and after a release's post-deploy tests, if the latest deployment is a branch job's with another version at 100%, that version is put back, keeping any 0% versions, and a `::warning::` names both deployments; for a release, a rollback by hand that lands any time after the release's own deployment is what's put back, not the release;
  - a version left at 0% by a cancelled run of the same pull request doesn't hold up the next one, and one left by another pull request is replaced, with a warning, after 10 minutes in all;
  - a pull request from a fork gets no token, so it skips the deploy with a notice; one from this repository without the token fails.
  - a pull request that adds a Durable Object migration can't be uploaded as a version (`wrangler versions upload` refuses a pending migration), so it skips the deploy with a notice, and its tests and reviews run as usual; the release applies the migration with `wrangler deploy` and runs the post-deploy tests then. Any other upload error still fails the job.

The post-deploy tests in [`test/integration/live/`](test/integration/live/) (`npm run test:live`) send `Cloudflare-Workers-Version-Overrides: sliccy-ai="<version>"` on every request to `*.sliccy.ai`, so they reach the version under test, and they wait until `x-sliccy-ai-version` names it. They check:
- serving `seven`;
- `cache-control: no-store` on `seven.sliccy.ai/` and `vault.sliccy.ai/`, and `no-cache` on `bios.js`;
- 404 for an unknown host;
- 304/412 for conditional requests and 405 for writes;
- that `www.sliccy.ai` and `sliccy.ai` still reach `slicc-tray-hub`;
- that the publish route refuses no token, refuses this repository's own real OIDC token (`not from ai-ecoverse/slicc-bios`, so GitHub's keys and the signature check are exercised), and refuses a tampered one (both deploying jobs have `id-token: write`);
- that a follower attaches to a tray through `seven.sliccy.ai` (`role: follower`, waiting for a leader);
- that a tray created through `seven.sliccy.ai` gets `www.sliccy.ai` capability URLs and its leader WebSocket connects through `seven.sliccy.ai`;
- on `*.sliccy.now`, once the route reaches this worker (a branch version skips these until then; after a release they must pass): that a label in six's format still gets six's own answer (`Preview not found`, without `x-sliccy-ai-version`), that a real six preview, minted through a tray this test leads via `seven.sliccy.ai`, is served by six's leader protocol byte for byte, and that an unknown hub label is the hub's 404; after a release only, that a hub preview relays a request with its query and a `Set-Cookie` made host-only to a publisher on the socket, and that a snapshot is served;
- that the serve hub's API answers on `seven.sliccy.ai`, and after a release only, that a publisher creates a host, holds its socket (with the secret as a subprotocol), mints, uploads, finalizes, lists and stops previews, and deletes the host;
- that `ntfy.sliccy.ai` answers its health probe and refuses a topic without a token;
- after a release only, that a tray created through `seven.sliccy.ai` claims an ntfy home with its controller token (and a forged token is refused), and a signed GitHub webhook over 48 KiB reaches a subscriber as a verified message with an attachment. A branch version at 0% can't run this one: each Durable Object runs the version the deployment split assigns it, whatever the override header says, so every home still runs the stable version;
- that Chromium boots <https://seven.sliccy.ai/> into `bash` in the terminal, cross-origin isolated;
- after a release only, that `www.sliccy.ai/7/` serves the BIOS with `Service-Worker-Allowed` on `sw.js`, `/7` (with its query) and an `/os/` navigation go to `/7/`, `/status` is still six's, and Chromium boots `www.sliccy.ai/7/` into `bash` with the UI at `/os/`. A branch version can't run these: `wrangler versions upload` doesn't change routes, so www's paths reach the stable version until a release deploys.

Without `SLICCY_AI_VERSION` they run against whatever is live.

Both need the `SLICCY_AI_DEPLOY_TOKEN` secret, an account token with:
- Workers Scripts Write on the account;
- Workers Routes Write and Zone Read on `sliccy.ai` and on `sliccy.now`.

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

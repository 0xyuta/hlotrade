# HLO — app hosting on Cloudflare (Plan 8)

Date: 2026-10-30. Status: agreed with the owner in chat (domains "Separate", Vercel code "Remove all", deploys "wrangler from the Mac", then "ok write the spec").

This replaces Vercel as the app's host. It changes the app's server code (`app/middleware.ts`, `app/api/register.ts`, `app/vercel.json`), where the published files are served from, and ops' store options. Trading, rewards rules, contracts and the calculator do not change.

Wording rule: the 0.1 HLO per minute goes to the **weekly vault**. Never say jackpot, lottery or prize.

## 1. Why

- Vercel's Hobby plan is non-commercial, and its Blob store was suspended on 2026-10-29 at the Hobby limit. Files already moved to Cloudflare R2 (commit 10412d1).
- the owner bought **hlotrade.xyz** on Cloudflare. Hosting the app there too puts the app, the files and the domain in one account, with no Vercel dependency.
- `hlo.trade` was not bought (premium price). Every mention becomes `hlotrade.xyz`.

## 2. Decisions

| Topic | Decision |
|---|---|
| Host | One **Cloudflare Worker with static assets** per network. Not Pages: Workers is Cloudflare's recommended path for new projects and supports the same static hosting |
| Domains | Mainnet app `hlotrade.xyz` (`www.hlotrade.xyz` redirects to it). Testnet app `testnet.hlotrade.xyz` |
| Files | Mainnet: new bucket `hlo-mainnet` on `files.hlotrade.xyz`. Testnet: the existing bucket `hlo-testnet` on `files-testnet.hlotrade.xyz` (replaces the rate-limited `r2.dev` URL). Separate buckets, separate API tokens: a testnet key cannot touch mainnet files |
| Registration | `/api/register` writes through the Worker's **R2 binding**. The app holds no R2 keys |
| Vercel | **Removed** from the app and ops: `@vercel/blob`, `@vercel/functions`, `vercel.json`, the Blob registry, `PUBLISH=blob`, the Blob proxy (`/rewards-blob/`, `REWARDS_BLOB_ORIGIN`). R2 (or a local directory on anvil) is the only store |
| Deploys | `wrangler deploy` from the owner's Mac, through npm scripts. The owner signs in once with `npx wrangler login`; no Cloudflare token is stored in the repo or in an env file. Mainnet deploys only on the owner's say |
| Free tier | Pages go through the Worker (needed for the country block); hashed `/assets/*` files are served without it and are free. Workers' free tier is 100,000 Worker requests a day |

## 3. The Worker (`app/worker/`)

`app/worker/index.ts` is the only server code. It replaces `app/middleware.ts` and `app/api/register.ts`.

**Routing** (`wrangler.jsonc`, `assets`):
- `directory: "./dist"`, `binding: "ASSETS"`, `not_found_handling: "none"`. The Worker does the SPA fallback itself: when `ASSETS` answers 404 to a GET or HEAD, it serves `/` (the index) instead, so `/pair` and any app route load. Why: the platform's own fallback would also serve `index.html` for a missing `/assets/*` file, and `/assets/*` never runs the Worker, so a visitor from a blocked country could load the whole app there. With `"none"` a missing `/assets/*` file is a plain 404.
- `run_worker_first: ["/*", "!/assets/*"]`: every request except the hashed build files runs the Worker first.

**Per request, in order:**
1. **Country block.** `isBlocked(request.cf?.country, request.cf?.regionCode)` from `src/geo/blocked.ts`, unchanged rules: blocked countries, blocked regions, a country with blocked regions but no region is blocked (fail closed), no country passes (local dev), `T1` (Tor) and `XX` pass. A blocked request gets the existing 451 page, `cache-control: no-store`. This applies to every Worker route, `/api/register` included.
2. **`POST /api/register`** (§4). Any other method on `/api/register` is 405. Any other `/api/*` path is 404.
3. **Everything else:** `env.ASSETS.fetch(request)`; a 404 for GET/HEAD is answered with `env.ASSETS.fetch` of `/` (the index, 200).

**Headers.** The Worker adds the security headers now in `vercel.json` to every response it returns (pages, the 451 page, API answers):
- `Content-Security-Policy: frame-ancestors 'none'` (the `<meta>` CSP in `index.html` stays as it is);
- `X-Frame-Options: DENY`;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=(), clipboard-read=()`;
- `Cross-Origin-Opener-Policy: same-origin-allow-popups`;
- `Strict-Transport-Security: max-age=31536000`.

`/assets/*` (served without the Worker) gets `Cache-Control: public, max-age=31536000, immutable` and the same security headers from a `public/_headers` file, which Vite copies into `dist/`. The implementation checks with `wrangler dev` that `_headers` applies to those files. If it does not, `/assets/*` keeps Cloudflare's default caching and the plan says so.

**Bindings and vars** (per environment in `wrangler.jsonc`):
- `REGISTRY`: the R2 bucket (`hlo-testnet` or `hlo-mainnet`).
- `HLO_NETWORK`: `testnet` or `mainnet` (a plain var, as now).
- Routes: custom domains `testnet.hlotrade.xyz` (testnet), `hlotrade.xyz` and `www.hlotrade.xyz` (mainnet). The www host answers with a 301 to `https://hlotrade.xyz` plus the path and query.

**What leaves:** the rewards proxy. Files come straight from the files domain with CORS (§5).

## 4. Registration

The rules are unchanged (`src/register/rules.ts`): a body `{user}` of at most 1 KiB; the network from `HLO_NETWORK`, never from the request; the record `registry/<chainId>/<user>.json` = `{user, registeredAt}` written once; Hyperliquid's `maxBuilderFee` must be at least the builder fee before writing.

The store is `RegistryStore` (`exists`, `createOnce`) with one implementation, `bindingStore(bucket: R2Bucket)`:
- `exists(key)`: `bucket.head(key) !== null`; a throw is `false`.
- `createOnce(key, body)`: `bucket.put(key, body, { onlyIf: new Headers({ "if-none-match": "*" }), httpMetadata: { contentType: "application/json" } })`. A returned object is success. `null` (the precondition failed: someone wrote it first) or a throw falls back to `exists(key)`, as now.

The answers are unchanged: 200 `{registered: true}` (new or repeat), 400 bad body, 403 below the builder fee, 502 Hyperliquid or store failure, 503 when `HLO_NETWORK` or the network's builder is missing. A repeat costs one `head` and no Hyperliquid call.

`registeredAt` is the Worker's clock (`Date.now()`), as it was the Vercel server's. The poster and verifier already treat it as given.

`src/register/r2store.ts` (aws4fetch) and the app's `aws4fetch` dependency are removed. Ops keeps aws4fetch: the poster and verifier still use R2's S3 API with their own keys.

## 5. Files

- **Custom domains.** `files.hlotrade.xyz` → bucket `hlo-mainnet`; `files-testnet.hlotrade.xyz` → bucket `hlo-testnet`. The `r2.dev` public URL of `hlo-testnet` is turned off after the switch.
- **CORS** per bucket: `GET` and `HEAD` from its own app origin only (`https://hlotrade.xyz`; `https://testnet.hlotrade.xyz`), plus `http://localhost:5173` on the testnet bucket for development.
- **Caching** is unchanged. The poster sets `cache-control: public, max-age=60` on `latest.json` and nothing on checkpoint files. Cloudflare's CDN does not cache `.json` by default.
- **The app's rewards URL** moves from the `VITE_REWARDS_BASE` env var into each network's config file as `rewardsBase` (e.g. `"https://files-testnet.hlotrade.xyz/998/"`).
  - It is required when `deployment` is set and must be an https URL ending in `/`.
  - It goes into the CSP `connect-src`, as now.
  - `VITE_REWARDS_BASE` is no longer read; a build with it set fails, so a stale env cannot silently win.
  - `dev.json` keeps working with no rewards base (read-only dev).
- **The registry prefix** stays `registry/<chainId>/` in the same bucket as the network's files.

## 6. Ops

- `PUBLISH` accepts `r2` or `local:<dir>`. `blob` is refused with a message that says to use `r2`.
- The registry source is `REGISTRY_DIR` (anvil, required there; refused on 999) or R2. The Blob registry is removed.
- `BLOB_READ_WRITE_TOKEN` is no longer read; its env lines are deleted from the testnet env files during the switch.
- `@vercel/blob` leaves `ops/package.json`.
- The verifier's and keeper's `REWARDS_URL` on testnet becomes `https://files-testnet.hlotrade.xyz/998/`.
- `docs/OPS.md`: the store section, §2 env, the published-files section and the testnet setup say R2 only, with the new URLs.

## 7. Builds and deploys

`app/package.json` scripts:
- `build` (mainnet config) and `build:testnet` (testnet config) stay. Both also run the chunk check, as now.
- `deploy:testnet`: `vite build --mode testnet && wrangler deploy --env testnet`.
- `deploy:mainnet`: `vite build && wrangler deploy --env mainnet`. A mainnet build still fails with `withdrawEnabled` or `solanaEnabled` on unless their override env vars are set (unchanged).
- `dev` stays Vite only. `dev:worker` (`vite build --mode testnet && wrangler dev --env testnet`) runs the Worker and the built app locally.

`wrangler` is a pinned dev dependency of `app`, not a global install. `compatibility_date` is set at implementation time and pinned.

The mainnet environment is configured and type-checked, but deploying it is a separate step on the owner's say (`mainnet.json` is `{}` today, which builds "not deployed yet").

## 8. Rollout (testnet)

The controller runs this with the owner. It touches his Cloudflare account and the public testnet URL.

1. The owner runs `npm exec -w app -- wrangler login` once (browser sign-in). Wrangler keeps the login in his user config, not in the repo.
2. Create the `hlo-mainnet` bucket. Attach `files-testnet.hlotrade.xyz` to `hlo-testnet` and `files.hlotrade.xyz` to `hlo-mainnet`. Set both CORS rules.
3. `npm run deploy:testnet -w app`. Check testnet.hlotrade.xyz:
   - the app loads and trades;
   - Rewards reads `files-testnet.hlotrade.xyz`;
   - Enable trading registers: the record appears in `hlo-testnet`, and a repeat is a 200;
   - `/pair` loads;
   - the response headers match §3;
   - the CSP has no Vercel host.
4. Switch the ops env (`REWARDS_URL`, remove the `BLOB_READ_WRITE_TOKEN` lines) and restart the verifier and keeper. The poster's R2 keys are unchanged.
5. Turn off `hlo-testnet`'s `r2.dev` URL.
6. The owner checks the new site. Then, on his say, the Vercel project `hlo-testnet` is deleted (he confirms the deletion; it cannot be undone).

## 9. Testing

- **Worker unit tests** (`app/test/worker.test.ts`, Vitest, with a fake `ASSETS` and a fake `R2Bucket`):
  - blocked country, blocked region, region missing for CA/UA, no country, `T1`;
  - the security headers on a page, on the 451 page and on an API answer;
  - `/pair` and unknown paths get the index from the Worker (a 404 from `ASSETS`, then `/`); a 404 for another method stays 404;
  - `www` redirect;
  - 405 and 404 under `/api/`.
- **Registration tests** move from `register-api.test.ts` / `register-r2.test.ts` onto the Worker:
  - create;
  - repeat (one `head`, no Hyperliquid call);
  - a lost race (`put` returns `null`, the record is there) is a 200;
  - a store failure is a 502;
  - below the fee is a 403 and writes nothing;
  - a missing network or builder is a 503.
- **Config tests:** `rewardsBase` required with `deployment`, must be https and end in `/`; `VITE_REWARDS_BASE` set fails the build; CSP `connect-src` takes the files host from the config.
- **Ops tests:** `PUBLISH=blob` refused; the registry source without Blob.
- The **chunk check** runs on every build, unchanged. `app/worker/` is server code and is never imported by `src/`.
- **APP.md testnet rows** (new): H1 the Worker serves the app and `/pair`; H2 registration through the binding; H3 headers; H4 country block, checked by reading `request.cf` in a local `wrangler dev --remote` run (a real blocked-country visit is not possible from here; the rules are covered by unit tests).

## 10. Out of scope

- The mainnet deploy itself (contracts on 999, `mainnet.json`, Safe): a later step on the owner's say.
- A rate limit on `/api/register`.
- Moving the ops processes off the owner's Mac.

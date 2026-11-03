# CLAUDE.md — HLO

HLO is a Hyperliquid perps trading app that charges a 0.1% builder fee and returns fees to users through the HLO token. Mining lives in HyperEVM contracts. The design is in `docs/superpowers/specs/2026-10-27-hlo-design.md` and, for minute settlement (Plan 5), `docs/superpowers/specs/2026-10-29-hlo-minute-settlement-design.md` and, for the vault pops (Plan 9), `docs/superpowers/specs/2026-10-30-hlo-vault-pop-design.md` and, for fee counting and the rewards files at 100,000 wallets (Plan 11), `docs/superpowers/specs/2026-10-31-hlo-scale-design.md`.

- Wording rule: it is **the vault**, and it **pops** (1 in `popOdds(chainId)` each minute: 1,250 on 999, 60 on 998, 1 on anvil; spec `docs/superpowers/specs/2026-10-30-hlo-vault-pop-design.md`). Never say "jackpot", "lottery", "prize", "motherlode" or "win".

## Contracts (`contracts/`, Foundry, Solidity 0.8.28)

| Contract | Job |
|---|---|
| HloToken | ERC-20, 5M cap, minters = Mining + Buyback, pair locked until the pool opens |
| Checkpoints | poster-signed (EIP-712) cumulative checkpoints, one per minute; anyone settles (`settle`); capped at 1.1 HLO/min since launch + refining; `VAULT_PERIOD` (the deploy still requires it; nothing reads it since Plan 9). Roles: the pauser (`pause()` only; the verifier's key), the guardian (a Safe on 999: `setPaused`, `setPoster`, `setPauser`, `setGuardian`, and while paused `cancelAfter`/`cancelAll`/`writeOff`), poster history (`wasPoster`). A cancelled minute reads as not settled and can't be settled again; `latestValidMinute` is the newest settled minute that is not cancelled (`latestMinute` stays the highest ever settled) |
| Mining | claims against settled checkpoints; `settleAndClaim` in one tx; claims stop while paused; claims paid from a global allowance: CLAIM_CAP 5,000 HLO, refilled 330 HLO/hour; a bigger claim is paid in part. Merkle claims of cumulative entitlement; pays 90%, records 10% refining; only the user claims (`claim`) or signs an EIP-712 Claim that anyone submits (`claimFor`); claims bounded by the largest settled checkpoint's totalEntitled claimed against (maxEntitledBound) plus `Checkpoints.writtenOff()` |
| Staking | stake HLO, earn the stakers' 10% of bought HLO; rewards drip in at (elapsed ÷ 1 day) of the undripped balance per update — a tail, not a 1-day schedule (no just-in-time capture), nothing drips while nobody is staked; rewards paid only from released rewardBalance (principal never used) |
| Buyback | pool opens 7 days + 1 h after Checkpoints' deploy (10,000 HLO + collected USDC, pool tokens locked forever); buy() every 10 min (skips don't use the slot), 1/144 slice (grow-only), 2% TWAP guard, takes 10 bps (SAFETY_BPS) under the v2 output; 90% burn / 10% stake |
| Splitter | fee USDC: 10% admin, 90% Buyback |
| Profiles | usernames (3–16, a-z 0-9 _) + avatar ids |

```bash
cd contracts
forge build
forge test                      # all suites incl. invariants
forge test --match-contract InvariantsTest -vv
USDC=… V2_FACTORY=… SWAP_FEE_BPS=30 VAULT_PERIOD=604800 POSTER=… GUARDIAN=… PAUSER=… ADMIN=… \
  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast   # writes deployments/<chainid>.json
```

On HyperEVM, the deployer must have big blocks enabled (Buyback's constructor creates the pair, > 2M gas).

Gotchas:
- `Deploy.s.sol` gives Buyback `Checkpoints.launchTime() + 1 hour` (a broadcast reads a simulated, earlier launch time). Post-deploy check: `Buyback.launchTime() − Checkpoints.launchTime()` is between 0 and 1 h.
- `contracts/src/` changes only through a plan; Plan 5 replaced FeeFeed with Checkpoints and changed Mining; Plan 6 added Mining's claim-rate limit; Plan 7 added the pauser, cancelled checkpoints and the write-off (Checkpoints, one line of Mining, Deploy's `PAUSER`). The other contracts are unchanged since Plan 1. Plan 9 changed no contract.
- In tests, advance blocks with `vm.roll(vm.getBlockNumber() + n)`.
- The Merkle leaf is `keccak256(bytes.concat(keccak256(abi.encode(user, entitlement))))` (OpenZeppelin StandardMerkleTree, `["address","uint256"]`).
- A leaked `POSTER_KEY` can take at most CLAIM_CAP at once plus CLAIM_PER_HOUR per hour until the pause (the verifier pauses within minutes, about 5 for a settled checkpoint with no published file). After a bad root is settled: the guardian cancels it while paused, writes off the amount, sets a new poster, and only then unpauses; no redeploy (`docs/OPS.md` §12, `docs/superpowers/specs/2026-10-30-hlo-recovery-design.md`). On 999 the deploy refuses a `GUARDIAN` without code (the Safe) and a `PAUSER` that is zero or equals `GUARDIAN` or `POSTER`.
- For string reverts use `vm.expectRevert(abi.encodeWithSignature("Error(string)", "…"))`; after editing mocks run `forge test --force`.

## Calculator (`calc/`, TypeScript, no I/O beyond what the caller passes in)

| File | Job |
|---|---|
| `src/units.ts` | constants (DAY, MINUTE, HLO, MAX_SUPPLY, POOL_RESERVE, TRADER_PER_MINUTE, VAULT_PER_MINUTE), `parseFeeUnits`, `dayOf`, `yyyymmdd` |
| `src/apifills.ts` | `ApiFill` (`userFillsByTime`), `countedFee` (the counting rule), `minuteOf`, `feesByMinute` |
| `src/checkpoint.ts` | `applyCheckpoint` / `newCalcState(launchTime, odds)`: per-minute emission, supply room, refining, vault points and pops (one `seeds` entry per minute); `serializeState` (version 2) |
| `src/pop.ts` | `Seed`, `popOdds(chainId)` (999 → 1250, 998 → 60, 31337 → 1), `popsAt(hash, minute, odds)`, `popMinimum(chainId)` (the 1 point a wallet needs to share in a pop: 999 from launch, 998 from minute 2600, off on anvil) |
| `src/table.ts` | the fee table CSV: `FeeRow`, `tableCsv`, `parseTableCsv` |
| `src/merkle.ts` | `buildTree` (adds the sentinel leaf; the proofs are computed when `tree.proofs` is first read, and there is no dump), `verifyProof` |
| `src/fills.ts` | `decodeLz4`, `parseFills` (Hyperliquid's daily builder CSV, columns by header name), `isCorePerp`; used by the verifier's daily check |

```bash
npm test                # root: calc + ops unit tests (run `forge build` first, see Ops)
npm test -w calc
```

Gotchas:
- Every token or fee amount is a `bigint`. Fees are in **1e-8 USDC** (Hyperliquid's `builder_fee` precision). `launchTime` comes from the chain, never from a local clock.
- A minute's fees are its counted API fills; checkpoints are never revised; the pop odds come from `popOdds(chainId)` and each minute's seed block from the chain (`ops/src/seed.ts`); the vault keeps 10% of every pop. A pop pays only wallets with at least 1 point since the last pop, and every point resets. The minimum is part of the replay: changing it after launch makes a fresh verifier disagree, so a change needs a `fromMinute`, as on 998.
- Every tree has the sentinel leaf `(0x0…0, 0)`, so an empty checkpoint still has a root. It gets no proof file.

## Ops (`ops/`, four processes)

| File | Job |
|---|---|
| `src/main.ts` | entry: `poster`, `verifier`, `forwarder`, `keeper` or `recovery`, `--once` for one pass; loads `ops/.env` |
| `src/config.ts` | env parsing and defaults (the reference is `docs/OPS.md` §2): `TRADE_FEED`, `HL_FILLS_PER_MINUTE`, `OMISSION_FULL_MAX` among them |
| `src/context.ts` | per-process state dir, clients, `checkpointConstants` (launchTime), `chainNow` |
| `src/seed.ts` | `seedBlocks`: each minute's seed block (the first block at or after its end) by binary search on block timestamps between the last seed block and `refBlock`; `SeedRangeError` |
| `src/poster.ts` | signs and publishes one checkpoint per minute; sends no tx; write-ahead `pending.json`. Reads only the registered wallets the trade feed saw trade (a short gap adds those of the last 24 hours, a long gap every wallet); then writes `users/<xx>.json` on a round (`docs/OPS.md` §2 "Scale", §10) |
| `src/verifier.ts` | replays published checkpoints (signature by the poster or a former one, registry, API fees with one cached read per wallet and the first fee shortfall failing the minute at once, root), cross-checks `Settled` events (cancelled minutes skipped), pauses `Checkpoints` with PAUSER_KEY on every chain, announces guardian and pauser actions; hourly omission check from its own trade feed in slices (an `ok` tick skips it when the next minute is due); hourly builder total check (alert only); daily builder-file check on 999 |
| `src/recovery.ts` | `npm run recovery -w ops`: the read-only recovery report (the minute to keep, the write-off, the Safe transactions in order); `NEW_POSTER=0x…` adds `setPoster` |
| `src/forwarder.ts` | builder fees: claim → perps → spot → HyperEVM → `Splitter.deposit` |
| `src/keeper.ts` | `KEEPER_KEY`: `Buyback.openPool()` once due, then `buy()` every interval when it would spend at least `MIN_BUY_USD` (default 0, 10 on mainnet), plus settles the newest multiple of 15 (1 on anvil) from its archive file if nobody has for `SETTLE_AFTER_MINUTES` (default 60); sleeps until the next one is due (`docs/OPS.md` §11) |
| `src/registry.ts`, `r2.ts` | the wallet registry (R2, or `REGISTRY_DIR`): the Worker's time-sorted index `registry-log/<chainId>/…` is listed from 10 minutes before the newest registration, a full read each hour and on the verifier's re-check, records kept in memory and in `registry-cache.json` |
| `src/ingest.ts` | per-wallet `userFillsByTime` cursors → fee rows; `ingest.json` version 2 (`coveredThrough`, `recent` 24-hour wallets, saves at most every 10 s) |
| `src/tradefeed.ts` | `TradeFeed`: Hyperliquid's public `trades` WebSocket, one per process: who traded, whether we were watching (`uncovered`), `deliveredPast`, late trades; nothing on disk, a restart is a gap |
| `src/pacer.ts` | `Pacer`, `pacedFills`: spaces a process's fill reads at `HL_FILLS_PER_MINUTE` (default 50) |
| `src/fillcache.ts` | the verifier's per-wallet fill cache: several minutes of one wallet cost one call; a cached shortfall is read again fresh before it counts |
| `src/limit.ts` | `forEachLimit`: at most N at a time, the first failure after the running ones finish |
| `src/scale-check.ts` | `npm run scale-check -w ops -- 2000` (no number means 100,000): one checkpoint at full size, times, sizes and memory for `docs/OPS.md` §2 "Scale"; not part of `npm test` |
| `src/snapshot.ts`, `sign.ts`, `checkpoint-files.ts` | chain logs between two `refBlock`s (Mining `Claimed`, HloToken burns as a running total; no past-block state reads); EIP-712 `Checkpoint` signing; the `checkpoints/<m>.json`, `latest.json` (no tree, no wallets) and `users/<xx>.json` formats, and the rounds (`userFileEvery`, `ROUND` = 15) |
| `src/hl.ts` | Hyperliquid API client and signing (pinned to the Python SDK's vectors); `userFillsByTime`, `perpCoins` (the feed's coins), `builderRewardsUnits` (the verifier's builder total) |
| `src/publish.ts` | writes the published files (local dir or Cloudflare R2, gzipped with `content-encoding: gzip` for `users/<xx>.json`) for the app |
| `src/store.ts`, `deployments.ts`, `abi.ts`, `alerts.ts`, `chain.ts`, `fills-source.ts` | local state, deployments file, ABIs, alert channels, viem clients, the daily builder-file fetch (verifier, chain 999) |
| `src/e2e.ts` | anvil end-to-end |

```bash
npm run poster|verifier|forwarder|keeper -w ops [-- --once]
npm run recovery -w ops                 # read-only; run with the verifier's env, see docs/OPS.md §12
npm run scale-check -w ops -- 2000      # one checkpoint at full size (no number: 100,000 wallets); not part of npm test
cd contracts && forge build && cd ..   # before ops tests: abi.test.ts compares src/abi.ts with contracts/out
npm run e2e -w ops                      # spawns anvil on port 8546 and a fake Hyperliquid; runs the real poster, keeper and verifier with --once; kills anvil
```

The runbook (keys, env, alerts, timeline, published files, testnet checklist) is `docs/OPS.md`. Read it before changing ops.

Gotchas:
- The verifier never reads the poster's state. Each process has its own state dir: `STATE_DIR/<process>/<chainId>-<checkpoints>-<deployBlock>-<launchTime>/`. A redeploy or an anvil restart starts clean on its own. A fresh verifier dir is safe (it replays from launch); the poster's is not once checkpoints exist (it would re-sign them).
- The poster's and verifier's saved states are version 2 (pops, `seedFrom`); a version-1 file is refused. `ingest.json` is version 2 and the change is one-way: the old code refuses it, so going back means deleting that file only, never the poster's state dir (that re-signs, `docs/OPS.md` §3; `docs/OPS.md` §2 "Rolling out the scale change").
- "Now" is the latest block's timestamp, never the wall clock.
- Published checkpoints are never revised. A mismatch the verifier finds is stored in `verifier-state.json` and the verifier stays stopped at that minute until a human clears it (`"mismatch": null`, or a new state dir); the pause (the verifier's pauser key, or the guardian) stops `settle` and claims. Fixing a wrong poster needs `setPoster` plus the recovery runbook (`docs/OPS.md` §12), no redeploy, not a restart.
- The registry: the app's Worker writes R2 `registry-log/<chainId>/<registeredAt, 10 digits>-<user>.json` (the index, empty) first and then `registry/<chainId>/<user>.json` `{user, registeredAt}` once through its binding (the app holds no R2 keys; a failed index write answers 502 and writes no record). The poster and verifier list the index from 10 minutes before the newest registration, read the whole prefix on their first list, each hour and when the verifier is about to report "not registered", and keep every record in memory and in `registry-cache.json` in their state dir (a record deleted from R2 lives on there: delete the file in both state dirs, or a poster and a fresh verifier disagree and pause). `REGISTRY_DIR` on anvil, required; refused on 999. A checkpoint includes exactly the records with `registeredAt` at or before its minute's end. The `R2Registry` timer is a wall-clock throttle, one of the named exceptions to "now is chain time" (with the feed's coverage, the pacer's timers and `ingest.json`'s 10 s save throttle; `docs/OPS.md` §2 "Scale").
- The Hyperliquid API base is `HL_API` (the e2e points it at a fake server), not `HL_API_URL`; the trade feed's WebSocket URL is made from it. The poster reads only the wallets the trade feed saw trade: about 50 distinct traders a minute stay on time (`HL_FILLS_PER_MINUTE`, 50 reads a minute against Hyperliquid's 1,200 weight per IP), more run late and nothing is lost; the poster and verifier on one IP (the testnet Mac) need 25 each. No pool of IP addresses (Hyperliquid's Terms §3.1.8). `TRADE_FEED` is off on anvil and refused off on 999; `--once` runs without the feed and reads every wallet; a feed gap of over 5 minutes in a run of gap minutes (a restart down for more than about 3 minutes, too) reads every wallet, up to 2 × N ÷ 50 minutes late (about 66 hours at 100,000 wallets). Details and the known limits: `docs/OPS.md` §2 "Scale".
- The trade feed's silence rule: on 999 a live socket with no readable trade for 30 s (`maxSilenceMs`, `feedMaxSilenceMs` in `config.ts`) is dropped and reconnected though pongs keep coming, and its live period ends at the last trade, not the last pong; an unreadable trade does not count; 30 to 45 s to notice; off on 998 (quiet minutes), never off on 999 (spec 2026-10-31 §4).
- R2 writes are 2 a minute plus up to 256 `users/<xx>.json` files on a round (every minute under 2,000 wallets, every 5th under 20,000, every 15th above; every 15th at any size in a quiet minute, no fee rows, no pop, the same root); the cost table is in `docs/OPS.md` §2 "Store operations".
- The keeper reads `latest.json` and the round's archive file from `REWARDS_URL` (testnet: `https://files-testnet.hlotrade.xyz/998/`; or an explicit `PUBLISH=local:<dir>`); without either it cannot settle and alerts hourly. Run the poster and verifier on the same RPC; `settle` needs `refBlock < block.number`, so a keeper pass in the poster's own head block fails with `BadRefBlock` (the e2e mines a block between them).
- There is no dry run: `--once` acts for real (gas, a published checkpoint, the forwarder's USDC moves, the verifier's pause), and a `--once` poster reads every registered wallet.
- The builder account must stay in Hyperliquid **standard** account mode, not unified (`spotSend` is refused in unified mode).
- The e2e needs `anvil` and `forge` (it also searches `~/.foundry/bin`). It uses only anvil's published dev keys and a temp state root. It refuses to start if something already listens on port 8546. Its tampered-checkpoint step comes first, then the leaked-key recovery step (report, cancel, write-off, new poster #4, unpause, honest Settle & claim), which must stay last.
- The verifier holds `PAUSER_KEY` (pause only) and refuses to start with `GUARDIAN_KEY` set, with a `PAUSER_KEY` that is not `Checkpoints.pauser()`, or on chain 999 without `PAUSER_KEY`; no process holds the guardian's key. Its `checkpoints:` alerts end with ` (block N)`. `docs/OPS.md` §12 is the recovery runbook and §13 the Safe setup.
- Never print or commit a key. Keys come only from env vars.

## App (`app/`, React 18 + Vite + TypeScript)

The design is spec §6; operations are in `docs/APP.md`. Trading goes straight from the browser to Hyperliquid (`@nktkas/hyperliquid` 0.33.3, pinned); there is no backend in the trading path. The only server code is `app/worker/` (a Cloudflare Worker: country block from `request.cf`, `/api/register` through the R2 binding, security headers, the `www` redirect).

```bash
npm run dev -w app          # http://localhost:5173 (dev.json: Hyperliquid testnet, read-only)
npm test -w app && npm run typecheck -w app
npm run build -w app        # mainnet.json; `npm run build:testnet -w app` for testnet.json
npm run dev:worker -w app   # builds testnet and runs the Worker with the built app (wrangler dev)
npm exec -w app -- wrangler login   # once per machine; the login stays in the owner's user config, no token in the repo
npm run deploy:testnet -w app       # build + wrangler deploy --env testnet (testnet.hlotrade.xyz); always via the scripts or with --env
HLO_ALLOW_MAINNET_WITHDRAW=1 npm run deploy:mainnet -w app   # only on the owner's say (hlotrade.xyz); withdrawals are on in mainnet.json since 2026-11-02
```

Gotchas:
- User-signed Hyperliquid actions go through `hl/injected.ts` (Fix A). Do not pass a viem wallet client to nktkas for them: viem 2.57.12 rejects the `HyperliquidTransaction:` primary types.
- Every order carries `builder: {b: lowercase, f: 100}` (`hl/trade.ts`).
- Each device has its own agent: the computer's is `hlo` (179 days), the paired phone's is `hlo phone` (approved by the main wallet at pairing, 30 days). Agents are matched by address. The phone's key reaches the phone only as the pairing code (`hlo pairing code <network> <hex>`, scanned in-page or typed), never in a URL; `/pair#…` fragments are dropped unread. "Cut off paired phone" approves a throwaway `hlo phone` (valid 1 day). A re-pair or cut-off whose answer is lost may already have cut the old phone off: re-pair or cut off again. Never put the computer's key in a QR.
- A user-signed transfer is signed once; if Hyperliquid's answer is not confirmed (network error, timeout, 408, 5xx, or a 2xx body that cannot be read) the same signed body is re-posted (`routes/unconfirmed.ts`, memory only), never re-signed. One transfer at a time (a page-wide lock).
- Rewards: "now" comes from the HyperEVM block timestamp, never the wall clock. `latest.json` carries only the checkpoint, `table`, `vault` and `pops`; a wallet's numbers and proof come from its `users/<xx>.json` (fetched with `cache: "no-cache"`, so a repeat poll is a 304; `latest.json` is `no-store`). Both files are checked against the poster and the chain, and a proof that does not verify against the file's signed root makes that wallet's figures zero. Which file claims, and when it is "Rewards are updating…", is `docs/APP.md` §1 ("Which file claims"); only "settled through" uses `latestValidMinute`. The Vault card's odds come from `rewards/odds.ts` (`POP_ODDS`, pinned to calc's `popOdds` by `test/odds.test.ts`); `checkLatest` refuses a `latest.json` whose `vault.odds` differs.
- Country block fails closed for CA and UA without a region header; no country, Tor (`T1`) and `XX` pass.
- `withdrawEnabled` (required in every filled network config) gates the Withdraw routes: when false the modal only says "Withdrawals open after testing." Keep it false in `mainnet.json` until W1 in `docs/APP.md` passes on testnet: a mainnet build with it true fails unless `HLO_ALLOW_MAINNET_WITHDRAW=1` is set. Deposits are unaffected.
- `solanaEnabled` (required in every filled config) gates the Solana route; `solanaRpc` is required with it and goes into the CSP. A mainnet build with it true fails unless `HLO_ALLOW_MAINNET_SOLANA=1`. `withdrawEnabled` also gates Solana withdrawals. The open switches (`SOLANA_WITHDRAW_HOOK_LAYOUT`, `SOLANA_SIGN_PREFERENCE`, `SOLANA_PRIORITY_MICROLAMPORTS` in `routes/solana/constants.ts`, `SOLANA_DEPOSIT_SOL_ESTIMATE` in `routes/fees.ts`) change only with their checklist row (SOL1–SOL6 in `docs/APP.md`).
- Solana deposits: record under the signature (and event account) before the broadcast (the signAndSend fallback: by the event account before the prompt, removed on a typed "not sent"); send once; never re-sign or re-send; an unconfirmed one settles from the chain and Iris ("expired" only on an event account read as absent). Dismissing a record stops its poll but the deposit can still arrive; Solana rows offer no Dismiss while a transfer is in flight, nor an unconfirmed deposit in its first hour. A final "not sent" row (failed, or over an hour old) is not polled and gives way to a new transfer. The poll reads the Solana RPC only while `solanaEnabled` (the CSP). Solana code is lazy (`SolanaFlow`, `routes/solana/poll`): never import `routes/solana/*`, `wallet/solana.ts`, `@solana/*` or `@wallet-standard/*` statically from the entry, `App` or `TransferModal`.
- Chunk check: every `vite build` runs `app/chunkCheck.ts` and fails if the entry, the App, the phone's `/pair` page or the transfer modal reaches a module that must stay lazy (trading, rewards, referrals, tokenomics, pair modal, chart, jsQR, Solana). `/pair` is an allow-list (`NOT_FOR_PAIR`): a new `src/` module is the App's unless added there. Lazy parts load through `useRetryableLazy` inside an `ErrorBoundary scope="screen" onRetry`, so a failed chunk shows Try again in place. A bundle-size change is a fact to read in the build output, not a reason to loosen a rule.
- Node >=22.12 (`engines`, root and app; `@nktkas/hyperliquid` needs it, `app/test/engines.test.ts` checks). Deploys run `vite build` on the owner's Mac, so Node is whatever runs there.
- Chart: the TradingView logo is off. Keep the "Charts by TradingView" link and the footer notice.
- Pure rules live in `hl/`, `routes/` and `rewards/`, and each has a test in `app/test/`. Keep components thin.
- Config: one JSON per network in `app/src/config/`. `{}` builds "not deployed yet", and a bad file fails the build. The CSP `connect-src` is generated from the config, so add hosts there, never by loosening the CSP. The rewards URL is the config's `rewardsBase` (https, ends in `/`, required with a deployment); `VITE_REWARDS_BASE` is refused.
- Hosting (Plan 8, spec `docs/superpowers/specs/2026-10-30-hlo-cloudflare-hosting-design.md`): one Worker with static assets per network, deployed with wrangler from the Mac (`app/wrangler.jsonc`; `/assets/*` skips the Worker and gets its headers from `public/_headers`). Testnet `testnet.hlotrade.xyz` with files on `files-testnet.hlotrade.xyz` (bucket `hlo-testnet`); mainnet `hlotrade.xyz` (`www` redirects) with files on `files.hlotrade.xyz` (bucket `hlo-mainnet`). Vercel and Blob are gone from the app and ops. Setup and the H1–H4 checks are in `docs/APP.md` §4 and §6.
- Never print, log or commit an agent key. They live only in the user's `localStorage`; the phone's key is shown only in the computer's pair modal (pairing code QR and typed groups, a minute at a time). The computer stores only the phone agent's address and expiry.
- Referrals (Plan 10, spec `docs/superpowers/specs/2026-10-30-hlo-referrals-tokenomics-design.md`): HLO uses Hyperliquid's referral program, no contract. `referralCode` (optional, `[A-Za-z0-9]{1,20}`, a bad one fails the build) in a network config is the default code; a `?ref=CODE` link is kept in `localStorage` `hlo.ref.<network>` and wins. The Enable text names the code only after a `referral` read shows no referrer; Enable trading sends exactly the code the text showed (`enable(shownCode)`), never another, and nothing when no text showed (status unknown or loading, read pending or failed, the re-sign); the new agent sends `setReferrer` once (a failure is only logged, never with a key). Referral USDC is Hyperliquid's: paid to the account that owns the code (the `referralCode` owner for default sign-ups), claimed with `claimRewards`, never through the Splitter or the buyback. `setReferrer`, `registerReferrer` and `claimRewards` are L1 actions signed by the agent; `REFERRAL_SIGNER` in `hl/referralActions.ts` is the one switch to the main wallet (only on RF1's answer). Rules in `hl/referral.ts`; the tab is `ui/referrals/` (lazy). A paired phone can read it but not act (`GatedAction` `"referral"`).
- Bots (`ui/bots/`, lazy; the public link `/bots`; on a phone under More): how to mine with your own bot, texts in `rewards/bots.ts`, the sample `public/bots/hlo-bot.mjs` (served at `/bots/hlo-bot.mjs`), pinned to the configs by `test/bots.test.ts`: when `mainnet.json` gets a builder, put it in the script's `BUILDERS`. HLO holds no key and runs no bot. The sample only buys, up to `MAX_USD`, and sends nothing without `LIVE=1`. Do not add a button or sample that trades only to create volume (Hyperliquid's Terms §3.1.4).
- Tokenomics (Plan 10): the tab is `ui/tokenomics/` (lazy); its texts are `rewards/tokenomics.ts` and its numbers `rewards/constants.ts`, pinned to `@hlo/calc` and the contract sources by `test/tokenomics.test.ts`. Never type a protocol number into JSX. Tabs on a wide screen: Trade, Rewards, Explore, Bots, Tokenomics, Referrals; the Trade | Mine switch sits beside the wallet.
- Explore (`ui/explore/`, lazy; on a phone under More): rules in `rewards/explore.ts`, tables in `rewards/useMinuteTables.ts`. Each minute is Pending, Counted or On chain; each of the wallet's trades through HLO shows its points and is Pending, Counted or Not counted, from Hyperliquid's fills against the published `checkpoints/<m>.json` tables. For reading only: the poster's signature covers the root, not the table, so nothing here decides a claim. `countedFeeUnits` is pinned to calc's `countedFee` by `test/explore.test.ts`; a table that could not be read says "Could not check", never "Not counted".
- Mine mode (`ui/mine/`, lazy; `ui/mode.ts`): the Trade | Mine switch in the top bar, kept in `localStorage` `hlo:mode`; in Mine the tabs and the phone's bottom bar are gone. One screen: this minute's clock, the wallet's HLO with Claim, the vault, a leverage choice (1× by default, up to the market's maximum, isolated) and one button that opens a real position (`planMine`: one market order, its value the amount times the leverage, the amount at most the balance) and then becomes Close position. Rules in `rewards/mine.ts`; claims through `rewards/useClaim.ts`, shared with the Rewards screen. The clock's seconds tick between polls from a chain-time base, for display only. Nothing closes or repeats a trade by itself: no button that opens and closes in one press, no auto-repeat (Hyperliquid's Terms §3.1.4).
- Phone layout (`useNarrow`, 860px and under): a bottom bar (Markets, Trade, Positions, Rewards, More; `BottomNav`), opening on `trade/MarketList`. `TradeScreen` keeps the order form and positions mounted on every view and hides them in CSS (`data-view`), so an order in flight survives a switch; the chart loads the first time Trade opens. A table with class `cards` becomes one card per row (each cell has `data-label`). Dialogs come up from the bottom edge at 520px and under.
- Top bar: no `backdrop-filter`, `filter` or `transform` on `.topbar`, they trap the transfer dialogs' `position: fixed` inside the bar and cut them off; the bottom bar's z-index stays under it (`test/topbar.test.tsx`).
- First-visit intro (`ui/intro/`, lazy; rules and alt texts in `rewards/intro.ts`): four image cards (mining, vault, claim, start), once per browser (`localStorage` `hlo:intro`), mainnet only. The images carry mainnet's numbers, so a changed protocol number means a new image. No fee card (the owner's rule).
- Coin icons come from Hyperliquid (`COIN_ICONS_ORIGIN` in `config/csp.ts`, in the CSP's `img-src`); `CoinIcon` shows the coin's letter when one does not load.
- Wording: the vault pops (never "jackpot", "lottery", "prize", "motherlode" or "win"), and never name another project as HLO's model.

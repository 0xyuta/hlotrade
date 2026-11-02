# HLO operations runbook

This file is for the people who run the four off-chain processes (poster, verifier, forwarder, keeper) and for the app, which reads the published checkpoint files. It describes what the code in `calc/` and `ops/` does today. The design is in `docs/superpowers/specs/2026-10-29-hlo-minute-settlement-design.md` (§5 is the off-chain part).

Wording rule: it is **the vault**, and it **pops**. The 0.1 HLO per minute that does not go to traders goes into the vault, and so does an empty minute's 1 HLO. Never say jackpot, lottery, prize, motherlode or win.

How it works in one paragraph. Every minute the poster signs a **checkpoint** (cumulative entitlements for every wallet, as a Merkle root) and publishes it. The poster sends no transaction. Anyone can put a published checkpoint on chain with `Checkpoints.settle`; a user's `Mining.settleAndClaim` does that and claims in one transaction, so a claim works within about a minute of the trade. The keeper settles the newest checkpoint if nobody has for an hour. The verifier replays every checkpoint from the published data and the Hyperliquid API, and pauses `Checkpoints` (with a pause-only key, on every chain) if anything differs. If a bad checkpoint was settled before the pause, the guardian cancels it (section 12).

- Each minute's randomness is the hash of its seed block, the first HyperEVM block at or after the minute's end. The poster and the verifier each find it on their own RPC by binary search on block timestamps (`ops/src/seed.ts`): about 8 block reads per minute (one at the checkpoint's `refBlock`, about 6 or 7 for the binary search; the seed block's hash comes from the same cache), by number, never `latest`.

## 1. Processes and keys

Four long-running Node processes. Each has its own key, its own host or container, and its own state volume.

| Process | Command | Key env var | What it does |
|---|---|---|---|
| poster | `npm run poster -w ops` | `POSTER_KEY` | Once a minute: lists the wallet registry, reads the fills of the registered wallets that traded from the Hyperliquid API (it follows Hyperliquid's public trade feed; every wallet when the feed was not watching, see "Scale"), builds the minute's checkpoint with `calc/`, signs it (EIP-712) and publishes `checkpoints/<minute>.json` and `latest.json`, then the wallets' `users/<xx>.json` on a round (section 10). **Sends no transaction** |
| verifier | `npm run verifier -w ops` | `PAUSER_KEY` (every chain) | Replays every published checkpoint (signature, registry, fees against the API with one cached read per wallet, root, total), cross-checks the `Settled` events, alerts, announces every guardian and pauser action, and pauses `Checkpoints` with the pauser key. Hourly omission check from its own trade feed, in slices; hourly check of Hyperliquid's builder total (alert only); on chain 999 a daily check against Hyperliquid's builder file |
| forwarder | `npm run forwarder -w ops` | `BUILDER_KEY` | Moves the builder fees from HyperCore to the Splitter on HyperEVM, once an hour |
| keeper | `npm run keeper -w ops` | `KEEPER_KEY` | Calls `Buyback.openPool()` once it is due, then `Buyback.buy()` every 10 minutes while there is a slice to spend, and settles the newest published round (the newest multiple of 15, from its archive file) when nobody has for `SETTLE_AFTER_MINUTES`. See section 11 |

Rules:

- The **pauser** can only pause (`Checkpoints.pause()`); it cannot unpause or change anything else. The verifier holds its key on every chain, mainnet included, so a bad checkpoint is paused within minutes without a human. A leaked pauser key can stop settling and claiming and nothing else; the guardian replaces it with `setPauser`.
- The **guardian** is a Safe multisig (2 of 3 owners) on mainnet and an ordinary key on testnet. It unpauses, sets the poster, the pauser and the guardian, cancels checkpoints and records a write-off. **No process holds the guardian's key.** If the verifier's env has `GUARDIAN_KEY` it refuses to start: `GUARDIAN_KEY is set for the verifier: it holds the pauser key (PAUSER_KEY), never the guardian's`. Section 13 sets up the Safe; section 12 is the recovery.
- On mainnet no process holds two roles' keys. The poster host has `POSTER_KEY` only. The verifier host has `PAUSER_KEY` only. The forwarder host has `BUILDER_KEY` only. The pauser, the poster and the guardian are three different addresses (the deploy script checks this on 999).
- `BUILDER_KEY` must be the key of the `BUILDER` address, or the forwarder will not start.
- The poster does not start while `POSTER_KEY` is not `Checkpoints.poster()` (the process exits with that message), and it checks again before it signs every checkpoint (the guardian can rotate the poster with `setPoster`). A checkpoint signed by another key can never be settled, so a rotated-out poster stops signing: it reports `poster error: POSTER_KEY is not Checkpoints.poster() ...` and backs off.
- The verifier's `PAUSER_KEY` is used only for `pause()`, simulated first. It needs a little HYPE for gas on every chain. The verifier does not start if `PAUSER_KEY` is not the key of `Checkpoints.pauser()` (`PAUSER_KEY is not Checkpoints.pauser() (key 0x…, on chain 0x…)`, addresses only), and on chain 999 it does not start without `PAUSER_KEY`. Off chain 999, without `PAUSER_KEY` the verifier only alerts (and a human pauses with the pauser key or from the Safe).
- `KEEPER_KEY` holds only a little HYPE for gas and has no role. Anyone may call `openPool()`, `buy()` and `settle()`; the keeper only makes sure someone does.
- Run the poster and the verifier against the **same RPC provider**. Each checkpoint names a `refBlock`, and a verifier whose RPC is behind the poster's cannot read it yet.
- Keys come only from the environment (or `ops/.env`, which git ignores). The code never prints a key. A bad key value is rejected without echoing it.

## 2. Env reference

All processes read the same variables. Set only the keys the process needs. `ops/src/main.ts` loads `ops/.env` first if it exists, and variables already in the environment win.

| Variable | Default | Meaning |
|---|---|---|
| `CHAIN_ID` | required | 999 HyperEVM mainnet, 998 HyperEVM testnet, 31337 anvil. Anything else is refused. The RPC must be on the same chain or the process stops |
| `RPC_URL` | required | One URL, or several separated by commas (tried in order, 3 retries each) |
| `BUILDER` | required | The builder account (a HyperCore address). The daily check on chain 999 reads its fill files |
| `DEPLOYMENTS` | `contracts/deployments/<CHAIN_ID>.json` | The file `Deploy.s.sol` wrote (addresses and `deployBlock`) |
| `STATE_DIR` | `ops/state/<CHAIN_ID>` | Root of the local state. See section 3 |
| `HL_API` | `https://api.hyperliquid.xyz` on 999, `https://api.hyperliquid-testnet.xyz` otherwise | The Hyperliquid API: `userFillsByTime` for the poster and verifier, `meta` for the trade feed, `referral` (the builder total) for the verifier, and the forwarder's calls. The trade feed's WebSocket URL is made from it (`https` becomes `wss`, plus `/ws`). The e2e points it at a fake server |
| `REGISTRY_DIR` | unset | The wallet registry as a directory of `<address>.json` files. **Required on anvil (31337), refused on 999.** Elsewhere the registry is read from Cloudflare R2 (the `R2_*` vars) |
| `PUBLISH` | `local:<STATE_DIR>/public` | Where the poster writes its files: `local:<dir>` or `r2` (Cloudflare R2, the choice for testnet and mainnet). Anything else is refused; `blob` (Vercel Blob) was removed and names `r2` in its error |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | all four, or none; required if `PUBLISH=r2` | Cloudflare R2 through its S3 API: the account id, an R2 API token's access key pair (Object Read & Write on this bucket only) and the bucket name. When set, the poster and the verifier also read the wallet registry from this bucket. A partial set is refused, naming only the missing vars. The verifier needs them for the registry alone (it reads the published files from `REWARDS_URL`) |
| `PUBLISH_PREFIX` | `<CHAIN_ID>/` | Prefix put in front of every published path in the R2 bucket. A `/` is added if it does not end with one. Empty means the default, so mainnet publishes under `999/...` and testnet under `998/...`. Two posters running at once need their own bucket or prefix: writing the same paths, they overwrite each other's checkpoints (give a second live testnet deployment a new prefix, for example `998-v2/`). A redeploy that replaces a stopped one may keep the prefix: until the new poster overwrites a path, the old deployment's file is ignored (its `contract` differs: the verifier treats it as not yet published, the keeper does not settle it, the app ignores it). The registry is not under this prefix (it lives at `registry/<CHAIN_ID>/`). The old name `BLOB_PREFIX` is refused with a message that says to rename it |
| `REWARDS_URL` | unset | http(s) base of the published files (the same value as `rewardsBase` in the app's network config; testnet `https://files-testnet.hlotrade.xyz/998/`, mainnet `https://files.hlotrade.xyz/999/`). The keeper and the verifier read `latest.json` and `checkpoints/<minute>.json` from here. If unset, an explicit `PUBLISH=local:<dir>` is read instead; with neither, the keeper cannot settle (it alerts, once an hour) and the verifier cannot start |
| `SETTLE_AFTER_MINUTES` | `60` | The keeper settles the newest published round (a multiple of 15, every minute on anvil) once this many minutes have passed since the end of the last settled minute |
| `CHECKPOINT_GRACE_SECONDS` | `10` | The poster lists the registry and reads the fills for a minute only this many seconds after the minute ended (Hyperliquid indexing, registry writes) |
| `TRADE_FEED` | `on` on 998 and 999, `off` on anvil | `on` or `off`. `on`: the poster and the verifier each follow Hyperliquid's public trade feed (one WebSocket each), so the poster reads only the registered wallets that traded and the verifier's omission check reads only the wallets it saw. `off`: every registered wallet is read every minute, as before the scale work (the anvil e2e does, its fake Hyperliquid has no socket). **Refused `off` on 999.** `--once` always runs without the feed and reads every wallet |
| `HL_FILLS_PER_MINUTE` | `50` | Fill reads a minute that this process may make (its pacer). A read weighs 20 or more against Hyperliquid's 1,200 a minute for the IP, so 50 leaves room for the other requests. The poster and the verifier each have their own pacer: **on one IP set it to `25` for each** (see "Scale") |
| `OMISSION_FULL_MAX` | `2000` | The verifier's hourly omission check reads every registered wallet when its own feed has a gap in that hour, up to this many wallets. Above it that hour rests on the daily check (chain 999) and the verifier alerts. On a shared IP (`HL_FILLS_PER_MINUTE=25`) the pass cannot read as many as 2,000 an hour: see "Scale" |
| `FILE_DELAY_HOURS` | `2` | **Daily check only (chain 999):** a day's builder file is compared only once chain time is this many hours past the day's end. |
| `FILLS_URL` | `https://stats-data.hyperliquid.xyz/{Mainnet or Testnet}/builder_fills/{builder}/{yyyymmdd}.csv.lz4` | **Daily check only (chain 999):** template for the builder file. `{builder}` is the lowercase address, `{yyyymmdd}` the UTC date |
| `POLL_SECONDS` | `60` | Keeper and forwarder poll interval, and their first back-off step after an error (doubles, caps at 30 min). Must be above 0. The poster and verifier check every 5 seconds (and back off up to 5 minutes after an error) |
| `LOG_CHUNK` | `1000` | Blocks per `getLogs` request (public RPCs cap the range). Set it to the RPC's `eth_getLogs` block-range cap if that is lower: `50` if the cap is 50 (section 8, item 9) |
| `POSTER_KEY` | unset | Poster process |
| `PAUSER_KEY` | unset | Verifier's pause, on every chain; **required on chain 999** (the verifier exits at start without it). Must be the key of `Checkpoints.pauser()` (set at the deploy, or later with `setPauser`): the verifier reads `pauser()` at start and exits if the key's address differs |
| `GUARDIAN_KEY` | unset | **Refused by the verifier** (it exits at start). No process uses it; guardian transactions go through the Safe, or on testnet through `cast` by hand |
| `NEW_POSTER` | unset | **Recovery report only** (`npm run recovery -w ops`): the address of the replacement poster, so the report lists `setPoster(0x…)`. Optional |
| `BUILDER_KEY` | unset | Forwarder |
| `KEEPER_KEY` | unset | Keeper. Uses `MIN_HYPE` as its low-gas threshold |
| `RESERVE_USD` | `110` | USDC the forwarder always leaves in the perps account (Hyperliquid's builder minimum is 100) |
| `MIN_MOVE_USD` | `10` | Smallest amount worth moving between balances |
| `MIN_CLAIM_USD` | `1` | Smallest unclaimed reward worth claiming. At least 1: Hyperliquid refuses `claimRewards` below 1 USDC ("Must have at least 1 of a reward token to claim", testnet 2026-10-29), and the config refuses less |
| `MIN_HYPE` | `0.05` | HYPE the builder needs on HyperEVM for the two forwarder transactions |
| `ALERT_WEBHOOK_URL` | unset | A Slack or Discord style webhook (posts `{text, content}`) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Telegram alerts. Both needed |

The variables of the old daily system (`ROLES`, `EMPTY_AFTER_HOURS`, `LATE_HOURS`, `ALLOW_REPOST`, `VERIFIER_KEY`, `FILLS_DIR`) are gone; the config ignores them if they are still set.

With no alert channel set, alerts only go to stderr. Set at least one channel before any real run.

Secrets and alert hygiene:

- On mainnet prefer the host's secret store (Railway variables or similar) over an `ops/.env` file, and give each process only its own variables. If you do use a `.env`, keep one per process and never commit it (git ignores `.env`).
- Alerts can leak. An error message from the RPC client may contain the full `RPC_URL`, and a keyed RPC URL then goes to the webhook or Telegram chat. Use an RPC URL without a key in it, or send alerts only to a private channel.
- The Telegram token is part of a URL. The code logs only the channel's name, never the URL.

### The wallet registry

Only registered wallets earn, from their registration time. The app's registration function (`/api/register` in the app's Cloudflare Worker) checks `maxBuilderFee(user, builder) >= 100` with Hyperliquid and then writes two objects to the network's R2 bucket through the Worker's binding, in this order: the **index entry** `registry-log/<CHAIN_ID>/<registeredAt, 10 digits>-<lowercase user>.json` (empty body), then the **record** `registry/<CHAIN_ID>/<lowercase user>.json` `{user, registeredAt}`, written once with `If-None-Match: *` and never overwritten (so `registeredAt` is stable; it is the Worker's clock in unix seconds). A failed index write answers 502 and writes no record; a repeat registration returns at the `exists` check and writes nothing. The record is the only truth; the index only says where to look, so a stale or duplicate entry is harmless (a record not there yet is ignored for that pass). The Worker holds no R2 keys; it is bound to the same bucket the poster publishes to. A checkpoint includes exactly the records with `registeredAt` at or before the end of its minute, and a fill counts only if it is at or after `max(launchTime, registeredAt)`.

How the poster and the verifier read it (`ops/src/registry.ts`, `REGISTRY_DIR` on anvil lists the directory as before):

- Each process keeps every record in memory and in `registry-cache.json` in its own state dir (records never change, so a restart at 100,000 wallets does not read them all again). A corrupt or wrong-version cache file is ignored with a warning (`registry: ignoring registry-cache.json`) and the first list reads everything; one that cannot be written is a warning (`registry: could not save registry-cache.json`), not a failed list.
- The first list after a start, one each hour, and the verifier's re-check before it reports "not registered" read the whole `registry/<CHAIN_ID>/` prefix (the safety net, and how wallets from before the index are found). Every other list reads the index from 10 minutes before the newest `registeredAt` it has seen (never later than 10 minutes before the clock, so one record dated in the future cannot move the window past every real key), and reads only the records it does not know, 16 at a time, each tried 3 times. That is one list call a minute at any size. A pass that fails part-way keeps and saves what it read; the hourly timer and the window move only when a pass completes.
- A full read after the first one that finds a wallet from before the index window logs `registry: found late by a full read: 0x… registeredAt T; its fees from before this read may be lost`. That wallet's early fills may be missing from the tables (checkpoints are never revised); the verifier's checks will show it.
- **A record deleted from R2 lives on in `registry-cache.json`.** The cache is never checked against deletions. If you delete a record on purpose, delete `registry-cache.json` in the poster's and the verifier's state dirs (stop the process, remove the file, start it), or a poster that still counts the wallet and a fresh verifier that does not will disagree and the verifier will pause `Checkpoints`.
- **The `R2Registry` hourly timer and the index window's clamp use the wall clock.** That is a throttle, a named exception to "now is chain time" (the others are listed under "Scale"). The record is the truth, but these decide when the registry lists a wallet, and that decides from which checkpoint its fees count (a wallet found late is the case above).

### Scale

The target is 100,000 registered wallets on one poster server and one verifier server (design: `docs/superpowers/specs/2026-10-31-hlo-scale-design.md`). Hyperliquid allows 1,200 weight a minute per IP and a `userFillsByTime` read weighs 20 or more, so one IP makes about 50 fill reads a minute. The poster used to read every registered wallet every minute, which capped it at about 50 wallets. It now reads only the wallets that traded.

| Distinct registered wallets trading | What happens |
|---|---|
| up to about 50 a minute, sustained | checkpoints stay on time |
| more than that | rewards run late by about (distinct wallets active in that period) ÷ 50 minutes, then catch up; nothing is lost. 3,000 distinct traders in an hour means rewards about an hour late |
| far beyond that | our own Hyperliquid node (below), a later decision with a monthly cost |

**The trade feed** (`ops/src/tradefeed.ts`). The poster and the verifier each hold one WebSocket to Hyperliquid's public `trades` feed (one subscription per core perp, about 179 on mainnet; Hyperliquid allows 10 connections and 1,000 subscriptions per IP, so the testnet Mac, which runs other bots, must stay under 10 in all). Every trade names both wallets, so the feed says who traded. It keeps who traded in the last hour, nothing on disk: a restart is a gap. A connection counts as watching only while it is live (every subscription acknowledged) and has delivered something in the last 20 s; a pong comes every 15 s. This coverage is measured on the wall clock with a 5 s margin. A `trades` message it cannot read is a gap too (`trade feed: unreadable trade …` in the log). **On mainnet a live socket that delivers pongs but no readable trade for 30 s is dropped and reconnected** (`trade feed: no trades for N s on a live socket, reconnecting`; checked on the 15 s ping tick, so 30 to 45 s). Pongs alone do not show that Hyperliquid still sends the trades, and a checkpoint is never revised. Its live period ends at the last trade, so those seconds are a gap. Off on testnet, which has quiet minutes.

**Wall-clock exceptions.** "Now" for every decision is the latest HyperEVM block's timestamp. The named exceptions, all health measures or throttles on real requests, are: the feed's coverage (above, with its 5 s margin), the pacer's timers, `ingest.json`'s save throttle (at most one save every 10 s while a pass runs) and the `R2Registry` hourly timer and index-window clamp ("The wallet registry"). A fill's minute, a registration time and a checkpoint's contents never use the wall clock.

**How a minute picks its wallets** (spec §5). The minute's *gap* is how much of the time since the last covered minute the feed was not watching. A *run* is a stretch of consecutive minutes that each have a gap; one fully watched minute ends it.

| Path | When | Wallets the poster reads |
|---|---|---|
| Covered | no gap | the registered wallets the feed saw trade since the last covered minute. The poster first waits until the feed has delivered through the minute's end |
| Short gap | a gap, with at most 5 minutes unwatched in the run (a restart of about 3 minutes or less, a dropped connection) | those wallets, plus every wallet that traded or registered in the last 24 hours |
| Long gap | more than 5 minutes unwatched in the run (this alerts); or `TRADE_FEED=off` or `--once`, or nothing covered yet (a fresh or migrated state), which read every wallet **without an alert** | every registered wallet |

**A long gap reads every registered wallet.** At 50 reads a minute a pass over N wallets takes N ÷ 50 minutes (about 33 hours at 100,000 wallets), and no checkpoint is published until it ends; the poster then publishes the waiting minutes in a burst. The newest finished minute is fixed when a pass starts, so a long gap can cost two full passes: up to 2 × N ÷ 50 minutes, about 66 hours at 100,000 wallets. A long gap is measured over a run of consecutive gap minutes, and it looks ahead when the poster is behind. The run starts at `coveredThrough` (up to about 70 s before the poster stopped) and ends at the new feed's first live moment plus its margin, so a poster that was down for more than about 3 minutes (3.5 to 4.5 in practice) reads every wallet on its first minute, and a restart of about 3 minutes or less stays on the short path. Nothing is lost, rewards are late, and the poster says so once an hour (section 5, Poster). The pass keeps its cursors in `ingest.json`, so a restart continues it. While the registry is large keep restarts to about 3 minutes; the own node (below) is the way out of the cost.

**The pacer** (`ops/src/pacer.ts`). Every fill read of a process goes through a pacer at `HL_FILLS_PER_MINUTE` (default 50, which leaves room for the other requests). A response of more than 20 fills adds its extra weight (1 per 20 fills) to the wait. Idle time earns no burst. The 429 retry (after 2, 4 and 8 s) stays as the safety net. The poster and the verifier each have a pacer, so **on one IP (the testnet Mac) they can together reach 100 reads a minute against a limit of about 60: set `HL_FILLS_PER_MINUTE=25` for each when they share an IP.**

**No pool of IP addresses.** Hyperliquid's Terms (§3.1.8) forbid bypassing rate limits, and spreading reads over addresses to get more than one IP's allowance is that. HLO follows Hyperliquid's terms. The poster and the verifier stay on separate servers because they check each other, each inside its own IP's limit.

**The verifier's omission pass.** Hourly the verifier reads the wallets its own feed saw in that hour plus the wallets in that hour's tables, 10 wallets a tick, through the pacer, and only while it is caught up (after a verified minute it runs only if the next minute is not yet due). With a gap in its feed it reads every registered wallet, up to `OMISSION_FULL_MAX`; above that the hour rests on the daily check. Capacity (computed from the pacer and the 10-wallet slice every 5 s, not measured on a live verifier; for `HL_FILLS_PER_MINUTE` 50, about half that at 25): about 2,000 wallets an hour when the verifier is idle, about 1,100 when the row checks take 25 reads a minute, little or none at 40 and above (at 50 there is none). At 25 reads a minute the idle ceiling is below the default `OMISSION_FULL_MAX` of 2,000, so on a shared IP an hour with a feed gap and 1,000 to 2,000 registered wallets may not finish: lower `OMISSION_FULL_MAX` (then that hour rests on the daily check and says so) or accept the skipped-hour alert. An hour that is not finished when a later hour completes is dropped: the verifier alerts what it had found and how far it got (`omission check skipped minutes A..B (read x of y wallets of the first hour)`, section 5). The hourly builder total check costs one read.

**Measured at full size** (`npm run scale-check -w ops -- 2000`; no number means 100,000; one checkpoint built in memory, no I/O; Apple M4, Node 26.7, default heap limit 4.4 GB; 2026-10-31):

| | 2,000 wallets | 100,000 wallets |
|---|---|---|
| minute 0, every wallet trades: `applyCheckpoint` | 0.00 s | 0.08 s |
| `buildTree` | 0.10 s | 4.96 s |
| steady minute, 50 traders and a refining share over every wallet: state copy + `applyCheckpoint` + `buildTree` | 0.11 s | 5.5 s (0.33 + 0.06 + 5.11) |
| user files: build, JSON, gzip all 256 | 0.02 s | 2.5 s (0.16 + 0.26 + 2.08) |
| calc state (`poster-state.json` and the verifier's hold it) | 0.45 MB | 21.9 MB |
| user files | 256 files, largest 18 KB raw, 6.5 KB gzipped; 0.9 MB gzipped in all | 256 files, largest 638 KB raw, 228 KB gzipped; 52.5 MB gzipped in all |
| `latest.json` | 0.6 KB and the minute's table | 0.6 KB and the minute's table |
| memory | heap 40 MB in use, 194 MB resident | heap 720 MB in use, peak resident 1.0 GB |

- `applyCheckpoint` + `buildTree` take about 5.2 s at 100,000 wallets, far under 40 s. The poster and the verifier **both** do this every minute (the verifier replays the tree to check the root), so it is a limit on each of them separately.
- The time is linear in the wallet count, about 50 µs a wallet for the tree: 25,000 wallets 1.2 s, 50,000 2.5 s, 100,000 5.0 s, 200,000 10.3 s, 400,000 21.5 s (24.7 s with the state copy and `applyCheckpoint` of a steady minute). The time alone stays under 30 s up to about 400,000 wallets (linear extrapolation puts 30 s at about 480,000), but **the trade feed's rules bind first**. The checkpoint is computed on the event loop, which also serves the feed's socket, so a block of over about 20 s in a minute makes a gap every minute (`HEARD_MS`), and one of 15 to 30 s can already miss a pong and reconnect, depending on when it falls between pings. Measured with the real feed: a 6 s block is safe, a 17 s block just before a ping reconnects, a 22 s block loses 17.4 s, a 31 s block reconnects. At about 62 µs a wallet for the whole blocking stretch, the clean ceiling is about 240,000 wallets. The 100,000 target (5.5 s) is well inside it. Memory comes next: 400,000 wallets used 3.1 GB of heap and 3.5 GB resident.
- At 100,000 wallets the checkpoint ran with the heap limit at 640 MB and ran out of memory at 384 MB (`--max-old-space-size`). Node's default heap limit follows the host's RAM (4.4 GB on this 24 GB Mac, much less on a small server), so give each of the poster and the verifier 4 GB of RAM at that size, or set `NODE_OPTIONS=--max-old-space-size=2048`; the checkpoint alone needs about 0.64 GB of heap. That is the checkpoint alone: the registry (100,000 records), the trade feed's table and the verifier's fill cache come on top.
- The state is rewritten every minute (22 MB; the poster writes it twice, `pending.json` and `poster-state.json`). A test write of a 16 MB file of the same shape took milliseconds on an SSD, and both servers need one.
- A user-file round at 100,000 wallets is about 2.5 s of CPU and 52 MB to upload in 256 PUTs, 8 at a time; the upload time was not measured (SC4).

**The own node (later, not now).** A non-validating Hyperliquid node has no per-wallet reads at all: it streams every fill to local files. It needs 16 vCPUs, 128 GB of RAM, a 500 GB SSD and Ubuntu 24.04, so it does not run on the Mac, and it has a monthly cost. Whether its fill lines carry `builderFee` is unconfirmed. `FillSource` (`ops/src/ingest.ts`) is the seam where it would replace the feed and the pacer without touching the checkpoint rules. Decided with the owner when real volume asks for it.

#### Known limits at scale

- A **long gap reads every wallet** and rewards are late by N ÷ 50 minutes per pass (see above).
- **A real halt of the exchange looks like a dead feed on 999** (the silence rule): after about 7 minutes it reaches the long branch though nobody traded, so at 100,000 wallets rewards can be 33 to 66 hours late after it. Nothing is lost.
- **Above 2,000 wallets, a dead poster plus someone settling an off-round minute** leaves wallets on "Rewards are updating…" until a poster runs again. The user files are written on rounds (every 5th minute under 20,000 wallets, every 15th above), anyone can settle any published minute, and with the poster gone no file has a proof for that minute. The keeper settles only multiples of 15, which always have files, so it does not cause this.
- **What one feed reconnect costs at scale.** One dropped socket (a gap of 20 to 45 s) makes that minute read every wallet that traded or registered in the last 24 hours, D ÷ 50 minutes (D is that wallet count), and the minutes after it catch up. With 10,000 daily actives that is about 200 minutes for the read and about 5 hours to converge. On launch day every registered wallet counts as registered in the last 24 hours. A feed that drops every minute adds up to the long gap and reads every registered wallet. **Do:** count the reconnects (`grep -c "trade feed:" logs/poster.log` counts every feed line; `grep -c "trade feed: connection lost"` counts the drops alone). If they are frequent at scale, shorten the 24-hour window or cap the list (`DAY_MS` in `ops/src/poster.ts`); APP.md SC2b records the testnet count that decides it.
- **Registration as a cost.** Each registered wallet costs one read per long-gap pass for ever, and one per short gap for its first 24 hours. So add before mainnet: a Cloudflare rate limit on `/api/register`, and watch the wallet count in the poster's `read X of Y wallets` log line.
- **A very late trade by a wallet that was idle for over 24 hours, during a short feed gap, is not counted.** The short path reads the wallets that traded or registered in the last 24 hours; a wallet outside that whose trade the feed missed is not read. Checkpoints are never revised. The verifier's omission check, its builder total check and the daily check (chain 999) report it.
- **A verifier that is always more than 2 minutes behind runs neither the omission check nor the builder total check**, and says so only when it catches up (`verifier: omission check skipped minutes …`; the builder total check says nothing).
- Above 2,000 wallets a wallet's numbers (its user file) lag the checkpoint: up to 5 minutes from 2,000 to 20,000 wallets, up to 15 above. While the vault has popped since the file, the Vault card shows a dash for the wallet's points and share (`docs/APP.md` §1).

#### Rolling out the scale change

- **Testnet:** restart the poster and the verifier on the new code, deploy the app (`npm run deploy:testnet -w app`; an app already open needs a reload; until the first user files land a wallet briefly reads zero), then **restart the poster and the verifier once more**. A wallet that registers between the first restart and the app deploy has no index entry (the old Worker does not write one); the second restart does a full registry read and finds it at once instead of at the next hourly read. Mainnet starts with these formats, so it has no gap.
- **On one IP (the testnet Mac)** set `HL_FILLS_PER_MINUTE=25` in the poster's env and in the verifier's before that restart (section 2, "Scale"). Without it the two pacers together can reach 100 reads a minute against a limit of about 60.
- **`ingest.json` version 2 is one-way.** The new poster reads a version 1 file (its cursors are kept, so no wallet is read again from its registration; nothing is covered yet, so the first minute reads every registered wallet once, from its cursor) and writes version 2. The old code refuses a version 2 file (`ingest.json is not a valid ingest file (version); delete it to refetch`), so going back to an older release means deleting `ingest.json` first (only that file, never the poster's state dir: that would re-sign, section 3); the old poster then reads every wallet from its registration again.
- The poster's and the verifier's other saved states keep their versions (`poster-state.json` and `verifier-state.json` stay version 2; the verifier's new `builderCheck` field reads as a fresh check when missing).
- `latest.json` loses `tree` and `users` and `users/<xx>.json` appears (section 10); the keeper reads the archive file of the round it settles.

### Store operations (why R2)

The poster writes **two files per minute** (`checkpoints/<minute>.json` and `latest.json`), and on a round also up to **256 `users/<xx>.json` files** (section 10). The round is every minute under 2,000 wallets, every 5th minute from 2,000 to 20,000 and every 15th above; while the poster is behind, and in a quiet minute (no fee rows, no pop, the same root as the last files), it is every 15th. So idle wallets cost almost nothing, and the table below is the worst case, a trade in nearly every minute. The poster and the verifier each list the registry about once a minute (the index, one list call: about 43,000 a month each) and read it whole each hour (at 100,000 wallets about 100 list pages an hour, about 72,000 a month each). The Worker writes 2 objects per registration. The first store, Vercel Blob, counted these as "advanced operations"; its Hobby plan includes 2,000 a month and **suspends the store** when they run out (the testnet store was suspended on 2026-10-29 after half a day), so R2 is the only store now. Cloudflare R2's free tier includes 1,000,000 writes and lists (class A) and 10,000,000 reads (class B) a month with free egress. Class A beyond that costs $4.50 a million. At the user files' write rate (a 30-day month, 43,200 minutes; the 256 files are the most, fewer exist under 256 wallets):

Worst case, with a trade in nearly every minute (with nobody trading, every size is the last row, or less):

| Wallets with an entry | Writes a minute | Writes a month | Cost at $4.50 a million | With the free million taken off |
|---|---|---|---|---|
| under 2,000 (worst case just under) | 2 + 256 = 258 | 11.1 million | about $50 | about $45 |
| 2,000 to 20,000 | 2 + 256 ÷ 5 = 53 | 2.3 million | about $10 | about $6 |
| 20,000 and more | 2 + 256 ÷ 15 = 19 | 0.82 million | about $3.7 | nothing |

Add the registry lists: about 86,000 a month at small sizes, about 230,000 for the two processes at 100,000 wallets. Reads (class B, $0.36 a million beyond the free 10 million) follow the open browsers: each reads `latest.json` and its user file every 30 s while its tab is visible (a 304 also counts as a read), about 170,000 reads a month for a tab left open all month, unless a cache in front of the bucket serves them (SC4).

R2 setup (one bucket per network; the app side is in `docs/APP.md` §4):

| | Testnet | Mainnet |
|---|---|---|
| Bucket | `hlo-testnet` | `hlo-mainnet` |
| Custom domain (Settings → Custom Domains) | `files-testnet.hlotrade.xyz` | `files.hlotrade.xyz` |
| CORS (Settings → CORS policy): `GET`, `HEAD` from | `https://testnet.hlotrade.xyz`, `http://localhost:5173` | `https://hlotrade.xyz` |
| `REWARDS_URL` and the app's `rewardsBase` | `https://files-testnet.hlotrade.xyz/998/` | `https://files.hlotrade.xyz/999/` |

- Use the custom domain, not the `r2.dev` URL: `r2.dev` is rate-limited and not for production. The first testnet files were served from an `r2.dev` address (2026-10-30); turn that URL off (Settings → Public access) once `REWARDS_URL` and the app point at the custom domain.
- R2 → Manage API tokens: create a token with **Object Read & Write** on this bucket only, one per network, so a testnet key cannot touch mainnet files. Its access key pair goes into the poster's and the verifier's env (`R2_*`). The app needs no key: the Worker writes the registry through its binding.
- `REWARDS_URL` is the bucket's custom domain plus the prefix, `https://<files host>/<chainId>/`.

## 3. Running

> **Safety.** There is no dry run. Every command below acts for real, and `--once` is not a test mode.
> - The poster signs and publishes a checkpoint. Published checkpoints are never revised.
> - The keeper spends gas on `settle`, `openPool` and `buy`.
> - The forwarder moves real USDC from the builder's Hyperliquid account to the Splitter.
> - A verifier that holds `PAUSER_KEY` pauses `Checkpoints` (claims stop) on any mismatch.
>
> Watch the first mainnet run of each process (logs and the chain) before leaving it alone.

From the repo root, after `npm install`:

```bash
npm run poster    -w ops              # loop forever
npm run poster    -w ops -- --once    # one checkpoint (or "waiting"), prints the result
npm run verifier  -w ops
npm run forwarder -w ops
npm run keeper    -w ops
npm run recovery  -w ops              # read-only report for a recovery (section 12); run with the verifier's env
```

`--once` runs one pass: the poster publishes at most one checkpoint (`published`, `republished` or `waiting`); the verifier checks at most one checkpoint (`ok`, `waiting` or `mismatch`); the keeper makes one decision and one settle check; the forwarder takes up to 8 steps. A `--once` poster or verifier runs without the trade feed (a single pass cannot wait for it to go live), so the poster reads every registered wallet: at 100,000 wallets that is a pass of N ÷ 50 minutes.

Hosting: four long-running Node processes (Node >= 22.12), for example four Railway services. Give each its own persistent volume for `STATE_DIR`. Do not share a volume between the poster and the verifier: the verifier never reads the poster's state, and that independence is the point.

Loop behaviour:

- The poster and the verifier check every 5 seconds while they wait, and go straight on to the next minute when there is one (so after an outage they catch up minute by minute). The keeper and the forwarder poll every `POLL_SECONDS`; the forwarder runs once an hour.
- After an error the sleep doubles (up to 5 minutes for the poster and verifier, 30 minutes for the others) and resets after a clean pass.
- Alerts are deduped per text: each distinct alert text is sent at most once an hour, however many times the condition is seen. While a condition lasts, its alert repeats once an hour.
- The poster's log line `checkpoint M: N users, total T, K fee rows, read X of Y wallets, refBlock B` says how many wallets it fetched (X) of those registered by the minute (Y). A minute published in a burst, after a long pass or a catch-up, says `read 0`. When it wrote the wallets' files, `user files of checkpoint M: F files, W wallets` follows.
- "Now" for every decision (has a minute ended, is a file overdue) is the latest HyperEVM block's timestamp, not the wall clock (the named exceptions are under section 2, "Scale").

State layout. Each process keeps its state under `STATE_DIR/<process>/<chainId>-<checkpoints address>-<deployBlock>-<launchTime>/`. A redeploy or an anvil restart changes that name, so it starts clean on its own. Nothing to delete by hand. The directory holds:

- poster: `poster-state.json` (calculator state, chain tracker, the last 10 vault pops, `seedFrom`: the block the next seed search starts at; version 2), `ingest.json` (per-wallet fill cursors ahead of `coveredThrough`, the wallets that traded in the last 24 hours, and fee rows; **version 2, one-way**: the old code refuses it, see "Scale", "Rolling out the scale change"), `registry-cache.json` (the wallet records read from R2; see "The wallet registry"), `pending.json` (the write-ahead file: the signed checkpoint, written before publishing and removed after; a crash republishes exactly the same bytes);
- verifier: `verifier-state.json` (calculator state, tracker, event cursor, the stored mismatch, verified roots, API sums, omission and daily cursors, the builder total check's `{lastD, countedTotal}`, `seedFrom`; version 2), `registry-cache.json`;
- `STATE_DIR/public/` (outside the per-process dirs): the default `PUBLISH` target, written only by the poster.

A fresh state dir is safe for the **verifier** (it replays from launch against the published files). For the **poster** it is not, once checkpoints exist: the poster would re-sign minute 0 and onward, with new `refBlock`s. Keep the poster's volume (section 5, "After a mismatch").

What each process refuses to do:

- Poster: sign while `POSTER_KEY` is not `Checkpoints.poster()`; sign a checkpoint before its minute has ended plus `CHECKPOINT_GRACE_SECONDS`; start on a state dir that belongs to another deployment; start from a version-1 `poster-state.json` (written before the vault pops; a redeploy starts clean anyway) or from an `ingest.json` that is neither version 1 nor 2 (`ingest.json is not a valid ingest file (…); delete it to refetch`). It does not check the emission cap itself: the calculator follows the contract's schedule, and `settle` reverts with `OverSchedule` if a checkpoint ever exceeded it.
- Verifier: send anything but `pause()`, and that only with `PAUSER_KEY`; start while `GUARDIAN_KEY` is set; start from a version-1 `verifier-state.json` (a fresh verifier dir is safe: it replays from launch). A checkpoint whose `refBlock` is before the end of its minute (no seed block up to it) is a mismatch.
- Keeper: settle a checkpoint file (`checkpoints/<round>.json`) that names another chain or contract.
- Forwarder: re-issue a step that has not visibly landed.

## 4. Timeline

Minute `m` is the 60 seconds from `launchTime + 60m` to `launchTime + 60(m+1)`; "launch" is `Checkpoints.launchTime()`, the deploy time.

| When (chain time) | What happens |
|---|---|
| minute `m` | Traders trade. Hyperliquid's API shows their fills within seconds |
| end of `m` + 10 s (`CHECKPOINT_GRACE_SECONDS`) | The poster lists the registry, reads the fills of the registered wallets that traded (the trade feed says who; section 2, "Scale"), builds checkpoint `m`, signs and publishes it: `checkpoints/m.json`, then `latest.json`, then the wallets' `users/<xx>.json` on a round (section 10) |
| right after | A user can press Settle & claim: `Mining.settleAndClaim` settles checkpoint `m` (anyone may, once the minute is over) and pays 90% of the user's new entitlement; 10% goes to refining |
| within a minute or two | The verifier replays checkpoint `m`. `Settled` events are cross-checked against the roots it verified itself |
| end of `m` + 5 min (`OVERDUE_SECONDS`) | Still no `checkpoints/m.json`: the verifier alerts `poster: checkpoint m missing` |
| last settled minute + `SETTLE_AFTER_MINUTES` | If nobody has settled since, the keeper settles the newest published round (a multiple of 15) |
| every hour of verified minutes (60 minutes from launch) | The verifier's omission check (alert only, in slices), and its check of Hyperliquid's builder total (alert only) |
| every UTC day, chain 999 only | `FILE_DELAY_HOURS` after the day's end, the daily check compares the verifier's counted fees with Hyperliquid's builder file |
| every minute, after its fees are counted | The vault pops if `uint256(keccak256(abi.encodePacked(hash(B(m)), m))) % ODDS == 0`, `B(m)` the minute's seed block. `ODDS` (`popOdds` in calc): 1,250 on 999 (about once every 21 hours), 60 on 998 (about hourly), 1 on anvil. 90% goes to holders of points by points, 10% stays; points restart from 0 |

The poster never waits on the keeper or on a user. If the poster stops, nothing is lost: it publishes the missed minutes one after the other when it is back, as long as the Hyperliquid API still has the fills (a long outage can lose fills; spec §8). A stop of more than about 3 minutes also means the poster reads every registered wallet on its first minute (section 2, "Scale").

## 5. Alerts and what to do

Alert texts start with the process name (`verifier:`, `poster:`, `keeper:`, `forwarder:`); the channel adds an `HLO:` prefix.

### Verifier

| Alert | Meaning | Do |
|---|---|---|
| `poster: checkpoint M missing` | No `checkpoints/M.json` 5 minutes after minute M ended (sent by the verifier) | Look at the poster: is it running, is `POSTER_KEY` still `Checkpoints.poster()`, is the bucket (R2) or its disk writable, is the Hyperliquid API answering? The poster publishes the missed minutes by itself when it recovers. After a stop of more than about 3 minutes it first reads every registered wallet: N ÷ 50 to 2 × N ÷ 50 minutes (about 33 to 66 hours at 100,000 wallets) with no new checkpoint, so this alert repeats meanwhile; nothing is lost, and it is the price of not missing a wallet's fees (section 2, "Scale"). If the file exists but the verifier's `REWARDS_URL` does not show it, look at the store and its cache |
| `verifier: checkpoint M mismatch: <why>` | The verifier found a difference. The reasons: the file is for another minute, chain or contract; **`signed by 0x…, never a poster of this contract`** (the current poster and every former poster, from the `PosterSet` events, are accepted; the file's content is replayed either way); `refBlock` out of order, before the deployment, or ahead of the chain for 5 minutes; a row for a wallet that is not registered, registered after the minute, listed twice, or with a zero fee; **fee of a wallet above the API's sum** (the first such row fails the minute at once; the verifier reads a cached shortfall again fresh before it counts); **`seed: …`** (the checkpoint's `refBlock` is before the end of its minute, so there is no seed block up to it); **root or `totalEntitled` differs from the replay** (this can also come from the verifier's own RPC: see "A root that differs" below); `Settled(M)` carries a different root than the one verified or the published file; a settled checkpoint with no published file for 5 minutes (`Settled(M) with root R has no published checkpoint (absent since chain time T)`); a checkpoint M still absent 5 minutes after a later one was settled (`checkpoint M withheld while N settled`). Cancelled minutes are skipped by the `Settled` and withheld checks | Read the reason. The verifier has paused `Checkpoints` already if it holds `PAUSER_KEY` (next alert), on every chain. Decide whether the poster or the verifier is wrong (section "After a mismatch"). If a bad checkpoint was settled, go to section 12 |
| `verifier: paused Checkpoints because of the checkpoint M mismatch` | The pauser key sent `pause()`. `settle` and all claims revert until the guardian calls `setPaused(false)` | Section "After a mismatch" |
| `verifier: could not pause Checkpoints: ...` | The pause transaction failed (no gas? not the pauser any more? the RPC?) | Pause by hand now: `pause()` with the pauser key, or from the Safe (section 12, step 1) |
| `verifier: checkpoint M mismatch is still unresolved (a human decides): ...` | Repeats once an hour. The verifier has stopped at M | Section "After a mismatch" |
| `verifier: nothing has been settled for a day (N verified checkpoints are waiting for a Settled event)` | Roots are verified but no `Settled` event has been read for a day. Nobody, including the keeper, has settled | Check the keeper (`KEEPER_KEY` gas, `REWARDS_URL`); check whether `Checkpoints` is paused |
| `verifier: omission check skipped minutes A..B` or `... (read x of y wallets of the first hour)` | Hours of verified minutes went by without the hourly check finishing: the verifier was replaying (it runs the check only when the next minute is not yet due), or an hour's slices were not done when a later hour completed (capacity: section 2, "Scale"). When a pass had started, the alert says how far it got, and the `wallet 0x… fees … differ` alerts for what it had found come first | Information; the daily check on mainnet still covers those hours. If it repeats while the verifier is caught up, the hour's wallet list is longer than the pass can read in an hour (capacity: section 2, "Scale"). One IP cannot read faster, so the daily check on mainnet is the cover until the own node |
| `verifier: the omission check for minutes A..B has waited over 2 minutes for the trade feed to deliver that hour; it goes on waiting` | The verifier's feed shows no gap for the hour but has not yet delivered through its end (a trade could still be on its way, or a newly listed coin is not found yet). It waits; a dead feed shows a gap, which ends the wait | If it repeats, look at the verifier's `trade feed:` log lines (connection lost, meta read failed) |
| `verifier: the trade feed was not watching for part of minutes A..B and there are N wallets: that hour rests on the daily check` | The verifier's own feed has a gap in that hour and N is above `OMISSION_FULL_MAX`, so the hour reads only the wallets its feed saw and the hour's table wallets, and a wallet that traded in the gap may be missed | Information on mainnet (the daily check covers it). Raise `OMISSION_FULL_MAX` only if the omission pass can read that many wallets in an hour (section 2, "Scale") |
| `verifier: omission check for minutes A..B failed: ...` | The Hyperliquid API did not answer; retried after 10 minutes, from the wallet that failed (wallets already read are not read again) | Read the message |
| `verifier: wallet 0x… fees in minutes A..B differ from the published tables` | Hourly omission check, **alert only**: the API shows counted fees for a registered wallet that the verified tables do not (a wallet left out, or a fill the API reported late) | Compare by hand. Checkpoints are never revised; a missed fee cannot be added. Decide with the team whether it is the poster (omission) or the API (late fill) |
| `verifier: builder fees not in the tables grew by X USDC: a wallet was missed, or a wallet that is not registered pays our builder fee` | **Alert only**, hourly. The check compares Hyperliquid's cumulative builder total (`referral` → `builderRewards`) with the fees the verified tables count through the newest verified minute. The difference grew since the last check by more than 5 USDC plus 5% of the fees counted since then. (The first value is only recorded; the check is skipped while the verifier is more than 2 minutes behind, because Hyperliquid's total runs about 2 minutes ahead of the tables.) A fill does not name its builder, so fees from a wallet that is not registered but paid our builder fee count in the total and not in the tables | Find the wallet: compare the registry with the wallets that approved the builder fee (on mainnet the daily check names wallets). A registered wallet that was left out shows in the omission check as well. Checkpoints are never revised |
| `verifier: the tables count X USDC more than Hyperliquid's builder total: a registered wallet may be paying 0.1% to another builder` | **Alert only.** The difference fell by more than the same tolerance: the tables count fees that did not reach our builder (a fill that paid another builder exactly 0.1% counts in our rule) | Information unless it grows; compare with the daily check on mainnet |
| `verifier: the builder total has not been readable for a day: that check is off until it is` | `referral` for the builder answered no readable `builderRewards` for a day (retried every 10 minutes; once a day alert) | Check the builder address (`BUILDER`) and `HL_API`; the check resumes by itself |
| `verifier: checkpoint M: fee of 0x… is below the API (table X, API Y); alert only, a fill indexed after the grace` | **Alert only.** A row of the verified table is lower than the API's counted sum for that wallet and minute: a fill the API indexed after the poster's grace. (A row **above** the API's sum is a mismatch: the poster credited fees the API does not show.) Verification continues | Compare by hand, as for the omission alert. Checkpoints are never revised |
| `verifier: daily check day D: <wallet>: builder file X, API Y (1e-8 USDC)` | Chain 999 only: Hyperliquid's builder file for UTC day D differs from the verifier's API sums | The usual causes are a fill that paid another builder exactly 0.1% (it counts in our rule), a fill the API returned late, or a poster outage. Fix by hand (spec §8). Alert only |
| `verifier: daily check for day D failed: ...` | The builder file was not available or unreadable; retried after 10 minutes | Check `FILLS_URL`, `BUILDER` and the host's IP (HTTP 403 can mean "no file" or "blocked") |
| `verifier error: ...` | An RPC or API error. Not a finding | Read the message. Errors back off up to 5 minutes |
| `checkpoints: paused (block N)` / `checkpoints: unpaused (block N)` | A `PausedSet` event: someone paused or unpaused. After a mismatch the pause is the verifier's own; an unpause is the guardian's | Check it was yours. A pause or unpause you did not expect: treat the pauser (pause) or the Safe (unpause) as compromised |
| `checkpoints: cancelled minutes A..B (block N)` | The guardian cancelled the settled checkpoints A to B (inclusive). They can no longer be claimed against or settled | Expected in a recovery (section 12). Otherwise treat the Safe as compromised |
| `checkpoints: wrote off X HLO (total Y HLO) (block N)` | The guardian recorded a write-off; Mining's bound is now higher by X | As above. Compare X with the recovery report's write-off |
| `checkpoints: poster set to 0x… (block N)` / `checkpoints: pauser set to 0x… (block N)` / `checkpoints: guardian set to 0x… (block N)` | The guardian changed a role (a later `PosterSet`, `PauserSet` or `GuardianSet`; the constructor's first one is not announced). `pauser set to 0x000…0` means the pauser was removed | Confirm it was yours (a recovery sets the poster). If not, the Safe or its owners' keys may be compromised: stop the poster, and replace the owner keys |

Each `checkpoints:` alert ends with the block of its event, so two pauses (or unpauses) within an hour are two alerts, not one. While the verifier holds a stored mismatch it reads no events, so these alerts arrive once the mismatch is cleared and it runs again. A verifier started on a new `STATE_DIR` reads every event from the deploy block and announces the old ones again; the block number tells you when each happened.

**PATIENCE_SECONDS (300 s).** The verifier gives these a chance to resolve before it calls a mismatch, measured in chain time: a checkpoint's file that is absent while a later minute has been settled ("withheld"); a `Settled` event whose file is absent; a `refBlock` ahead of the verifier's RPC head. The first two mean the poster is withholding or deleted a file; the third usually means the two RPCs are not in sync.

**`refBlock ... is ahead of the chain`.** Compare the verifier's RPC head with another RPC (`cast block-number --rpc-url ...` against both) before blaming the poster. If the verifier's RPC is the one behind, move the verifier to the poster's provider. **The verifier has already paused `Checkpoints`** (it holds `PAUSER_KEY`), so once you have confirmed the RPC lag and that nothing bad was settled, the guardian must call `setPaused(false)` (on mainnet, from the Safe). Then clear the stored mismatch: stop the verifier, open its `verifier-state.json` (section 3), set `"mismatch": null`, and start it again. It replays that minute again, because a failed minute never advances the state. (Or start it with a new `STATE_DIR`: it replays from launch, which is slower but needs no edit.)

**A root that differs, or a `seed:` reason.** Rule out the verifier's own RPC before blaming the poster. The vault's pop for a minute depends on the hash of its seed block B(m), the first block at or after the minute's end, so an RPC that returns a different block hash or timestamp for B(m) (a lagging, forked or misbehaving provider) gives a different replay and a `root ... differs` mismatch with an honest poster. Check: find B(m) for the minute (the lowest block with a timestamp at or after `launchTime + 60(m+1)`), then read that block's hash and timestamp, and the block before it, on the verifier's RPC and on at least one other provider (`cast block <n> --rpc-url ...`, compare `hash` and `timestamp`). If they differ, move the verifier to a good provider, clear the stored mismatch and unpause as for the `refBlock` case above. A `seed:` reason means the file's `refBlock` is before the end of its minute; that is the poster's file, not an RPC problem (compare the file's `refBlock` with the minute's end).

**After a mismatch (a real one).** Published checkpoints are never revised: a checkpoint that was signed and published stays what it is, and the poster has no way to replace it.
1. `Checkpoints` stays paused (`settle` and claims revert) until the guardian calls `setPaused(false)`. On mainnet the guardian is the Safe: submit `setPaused(true)` (or `false`) through the Safe's own interface; for raw calldata use `cast calldata "setPaused(bool)" true`. Contract addresses are in `contracts/deployments/<chainid>.json`.
2. Compare the published table (`checkpoints/M.json`, its `table` field) with the API (`userFillsByTime` for the wallets in it) and with the registry. Decide whether the poster, the verifier or the data is wrong. If the verifier is wrong, fix it, clear its stored mismatch (above), and unpause.
3. If the poster is wrong, its output cannot be repaired, but a settled bad checkpoint can be **cancelled**. If nothing bad was settled (the mismatch is in a published file that nobody settled, as in the e2e's tampered file), see "A mismatch in an unsettled file only" in section 12: the published file must be put right before the mismatch is cleared. If the bad checkpoint was **settled**, follow section 12 (cancel it, write off what was claimed, rotate the poster, restart, unpause). Unpausing without cancelling lets the bad leaves keep claiming at up to 330 HLO per hour. A poster that restarts from empty state under the same contract re-signs minutes that already exist, so keep its state volume.
4. The verifier does not forget a mismatch by itself: it stays stopped at that minute and reports it every hour until a human clears it (a mismatch at a minute that is now cancelled is cleared the same way).

### Poster

| Alert | Do |
|---|---|
| `poster error: POSTER_KEY is not Checkpoints.poster() (key A, on chain B)` | Fix the key, or the guardian's `setPoster`. The poster keeps retrying with a back-off, and signs nothing meanwhile |
| `poster: the trade feed has not been watching for over 5 minutes: reading every wallet, rewards may run late` | A long gap (section 2, "Scale"): more than 5 minutes of the run were not watched (the feed was down, or the poster was down for more than about 3 minutes). A fresh or migrated state (nothing covered yet), `TRADE_FEED=off` and `--once` also read every wallet but send no alert. The poster reads every registered wallet: N ÷ 50 minutes per pass (up to two passes after an outage); checkpoints are late, not wrong. At most once an hour. **Do:** look at the poster's log for `trade feed: connection lost (…)`, `trade feed: no pong, reconnecting`, `trade feed: no trades for N s on a live socket, reconnecting`, `trade feed: not live, reconnecting`, `trade feed: meta read failed: …` and `trade feed: <Hyperliquid's refusal>`: is the IP over 10 WebSocket connections, is Hyperliquid reachable? Then wait: the pass continues from its saved cursors after a restart, and the poster publishes in a burst when it ends |
| log line, not an alert: `trade feed: no trades for N s on a live socket, reconnecting` (poster and verifier, mainnet only) | The socket was up and answering pings but delivered no readable trade for 30 s or more (mainnet trades about 136 a second), so Hyperliquid has probably dropped the `trades` subscriptions silently. The feed drops the socket and connects again; the stretch since the last trade is a gap, and the run of gap minutes reads wider (the long-gap alert above if it adds up to over 5 minutes). One line now and then is a dropped subscription, repaired. **Do:** count them (`grep -c "trade feed: no trades" logs/poster.log`); a line every minute or so means the feed is not delivering at all: check Hyperliquid's status, the IP's WebSocket connections (10 at most) and subscriptions (1,000 at most), then wait for the long-gap pass. Never switch the rule off on mainnet |
| `poster: waiting for the trade feed to deliver minute M for over 2 minutes: no checkpoint is published until it does` | The feed is connected but has not delivered through the end of minute M (a trade may still be on its way, or a newly listed coin has not been found yet). It ends by itself: a feed that stays quiet shows a gap, and the poster then reads wider. **Do:** if it repeats, look at the feed lines above and at Hyperliquid's status |
| `poster: trades arrived after their minute was read (a very late feed): the verifier's checks will show any fee this missed` | Trades timed in a minute reached the poster after it had made that minute's list: the feed is slow. The poster reads those wallets too, so usually no fee is missed; the alert means the feed is slow, not that a fee was lost. At most once an hour. **Do:** if it repeats, look at the poster's network and CPU. The verifier's omission and builder total checks show a fee that was in fact missed |
| `poster: writing the user files failed, a later checkpoint tries again: <error>` | `users/<xx>.json` could not be built, or a write failed (R2 down, a token without write rights). Checkpoints are not held up, the next checkpoint in step tries again, and one file's failure does not stop the others. Meanwhile wallets see older numbers, and from a user file older than a settled minute, "Rewards are updating…". **Do:** read the error (the first one is in the text; the log line `user files of checkpoint M: x of y files failed` has the count) and fix the store. The next checkpoint writes all the files again |
| `poster error: ...` (anything else) | Read the message (RPC down, Hyperliquid API errors or rate limits, a store write failed, the registry unreadable). Errors back off up to 5 minutes and the same text is sent at most once an hour. A `pending.json` file means a checkpoint was signed and not fully published: the next pass republishes the same bytes |
| the poster exits at start with `the saved poster state is for another deployment ...` or `... is not a valid poster state file ...` | The state dir does not belong to this contract or was damaged. No alert is sent (it never gets that far); watch the process. A human must look before it is deleted (see "After a mismatch", step 3) |

**Alert noise at scale.** Two alerts can repeat without a lost fee, both at most hourly. (1) Above `OMISSION_FULL_MAX` (2,000) wallets, every verifier restart leaves a gap in its feed, so that hour's omission pass alerts `… that hour rests on the daily check`; there is no daily check on 998, so on testnet nothing else covers that hour (on 999 the daily check does). (2) `poster: trades arrived after their minute was read` fires on many short-gap minutes that have a trade in their last seconds: a short gap does not wait for the feed to deliver, the poster reads those wallets anyway, and the alert means the feed was a little late, not that a fee was lost. If either repeats, the omission and builder total checks (section 5, Verifier) show a fee that was really missed.

### Forwarder

| Alert | Do |
|---|---|
| `<address> needs HYPE for gas (has N)` | N is in wei (1 HYPE = 10^18). Send HYPE to the builder address on HyperEVM. Needs `MIN_HYPE` (0.05) |
| `<step> did not take effect within 120s` | The step was sent but its effect was not visible in two minutes. The run stops and does not re-send. Look at the builder account on Hyperliquid. The next hourly run plans again from the balances |
| `forwarder error: ...` | Read the message. Hyperliquid refusals say why (for example an unsupported account mode) |

### Keeper

| Alert | Do |
|---|---|
| `keeper: <address> needs HYPE for gas (has N)` | N is in wei. Send HYPE to the keeper address on HyperEVM |
| `keeper: cannot read latest.json: ...` | The keeper has no place to read the published files (`REWARDS_URL` unset and no `PUBLISH=local:<dir>`), or the read failed, or the file is unparseable. It cannot settle; it alerts once an hour. Set `REWARDS_URL` |
| `keeper: checkpoints/R.json is for chain X contract C, not ...: not settling` | `REWARDS_URL` points at another deployment's files (R is the round the keeper wanted to settle) |
| `keeper: checkpoints/R.json is not published: not settling minute R yet` / `keeper: cannot read checkpoints/R.json: ...` / `keeper: checkpoints/R.json holds minute X, not R: not settling` | The keeper settles the newest multiple of 15 from its archive file, and that file is missing, unreadable or for another minute. Retried on the next pass. Check the store and `REWARDS_URL` |
| `keeper: settle(R) failed: <error>` | The settle of round R was refused (for example `BadSignature`, `BadRefBlock`, `IsPaused`, `OverSchedule`). `BadRefBlock` clears on the next pass (the poster's `refBlock` is still the head block); if it persists, check that the keeper's RPC is not behind the poster's. A `NotNewer` is not an error: someone else settled first. Retried on the next pass |
| `keeper: cannot read the Checkpoints state: ...` | RPC trouble |
| `keeper error: ...` | Read the message. A revert other than "someone else already did it" is an error; a TWAP skip is not |

## 6. What an outage or a bad input does

- **The Hyperliquid API is down or rate limiting.** The poster cannot read fills, so it publishes nothing for those minutes (a `poster error`) and catches up when the API is back. Fills in the API's history are not lost. An outage longer than the API's history (or a fill the API returns late) can miss a fee in a minute that is already checkpointed; see "Alerts" for the omission check and the spec's known limits.
- **The registry is unreadable.** Same: the poster publishes nothing, because a checkpoint must contain exactly the records registered by its minute.
- **The trade feed is down or Hyperliquid's WebSocket refuses us.** Checkpoints continue. A gap of up to 5 minutes unwatched in the run (a restart of about 3 minutes or less, a dropped connection) also reads every wallet that traded or registered in the last 24 hours; a longer one reads every registered wallet (N ÷ 50 minutes a pass, section 2, "Scale") and alerts. Nothing is lost.
- **R2 refuses the user files.** Checkpoints and `latest.json` continue; the poster alerts `poster: writing the user files failed …` and tries again with every checkpoint in step. Wallets keep their last files (the app says "Rewards are updating…" once the chain's settled minute is newer than a file whose minute is not itself settled).
- **Nobody settles.** Nothing is lost. Claims need a settled checkpoint, and a user's Settle & claim does that; the keeper settles after `SETTLE_AFTER_MINUTES` regardless.
- **The poster's key is lost or leaked.** The verifier pauses (`pause()`, pauser key) by itself, and the Safe recovers (section 12): cancel the bad checkpoints, write off what was claimed against them, `setPoster` to a new key, restart, unpause. The contract caps the total paid HLO at the cumulative emission schedule plus refining, not the HLO of recent minutes, so a bad checkpoint can assign all unclaimed HLO to one wallet; the claim-rate limit (spec §4) bounds how fast it can leave: at most `CLAIM_CAP` (5,000 HLO) at once plus `CLAIM_PER_HOUR` (330 HLO) per hour until the pause. Mitigations: a separate poster key, the verifier and its pauser, the rate limit, public data. A **lost** key (no leak) needs only `setPoster`; nothing was settled that was not honest.

## 7. Forwarder

The forwarder is a small state machine. It reads the builder's balances and takes one step at a time, downstream first, so money never queues behind a stuck stage. After each step it waits up to 120 s (40 polls of 3 s) for the effect to show before it plans again.

| Order | Condition | Step |
|---|---|---|
| 1 | HyperEVM USDC at the builder address > 0 and HYPE ≥ `MIN_HYPE` | `approve` if needed, then `Splitter.deposit(amount)` |
| 1 | same, but HYPE < `MIN_HYPE` | alert (low gas), stop |
| 2 | Core spot USDC (total minus hold) ≥ `MIN_MOVE_USD` | Core `spotSend` of all of it to `0x2000...0000`. **Assumed, not yet confirmed (section 8, item 4):** that this arrives as USDC at the builder's own HyperEVM address. A send to an address that is not yet a Core user may cost an activation fee (1 USDC in the `ops/src/hl.ts` comment; who pays is unconfirmed). Until item 4 is answered, treat this step as unproven |
| 3 | perps withdrawable ≥ `RESERVE_USD + MIN_MOVE_USD` | Re-read perps withdrawable right before the transfer, then `usdClassTransfer` of (that fresh value minus `RESERVE_USD`) to spot. If the fresh value is not above `RESERVE_USD`, skip the transfer and end the run |
| 4 | unclaimed rewards (`info {type:"referral"}.unclaimedRewards`) ≥ `MIN_CLAIM_USD` | `claimRewards` |
| 5 | none of the above | idle |

A run takes up to 8 steps, so one run can carry a claim all the way to the Splitter.

**Run exactly one forwarder instance, with no deploy overlap.** Two instances that read the same perps balance can both send (withdrawable minus `RESERVE_USD`), which leaves the account below Hyperliquid's 100 USDC builder minimum, and builder-coded orders are refused until someone tops it up. The re-read before the transfer narrows that window but does not close it. On Railway or similar, turn off zero-downtime (overlapping) deploys for the forwarder service, or stop the old instance before the new one starts.

The builder must stay in Hyperliquid **standard** account mode, not unified. In unified mode `spotSend` is refused, and the spot balance can include perps margin, so the forwarder could try to move the 100 USDC reserve.

Fund the builder's reserve into its **perps** account. A `spotSend` to the builder lands in spot, and the forwarder sends any spot USDC of `MIN_MOVE_USD` or more on to HyperEVM and the Splitter. So after funding by `spotSend`, stop the forwarder, move the money to perps with the builder key (`usdClassTransfer`, `toPerp: true`), and then start the forwarder again. Testnet, 2026-10-28: 98 USDC sent to spot was moved this way before the forwarder's next pass.

The forwarder only uses the builder's own account. Its destinations are the Splitter (`approve` and `deposit` on HyperEVM) and `0x2000...0000` (the Core send). The Core signing code in `ops/src/hl.ts` is pinned to the Hyperliquid Python SDK's vectors by `ops/test/hl.test.ts`, except `usdClassTransfer` and `claimRewards`, whose test pins are computed by us (no SDK vector exists). The first testnet run must show they are accepted (section 8).


## 8. Testnet rehearsal checklist

**Do not start the forwarder on mainnet until items 2 to 5 are answered on testnet.** Item 4 asks whether the Core send to `0x2000...0000` works at all. Until it is answered, a mainnet run could send real USDC somewhere with no known way back.

Write the answer next to each item. "Open" means not checked yet. Checked on 2026-10-27 means a read-only request made while writing this file.

1. **Do Hyperliquid testnet builder-fill files exist** (`stats-data.hyperliquid.xyz/Testnet/builder_fills/...`)?
   Answer: **no** (2026-10-29), and no longer needed: minute settlement reads each registered wallet's fills from the API (`userFillsByTime`), not from the daily files. The builder files are used only by the verifier's daily check on chain 999 (mainnet files exist: for 10-28 they answered 200 with header `time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee`). A 403 for a missing file looks the same as a 403 for blocked access (on 2026-10-27 a builder with no fills got HTTP 403 under both `/Testnet/` and `/Mainnet/`), so the daily check's "not available" is not proof of either.
2. **Do builder fees show up in `info {type:"referral"}.unclaimedRewards`?** If not, name the right field and fix `referralUnclaimed` in `ops/src/hl.ts`.
   Answer: **yes** (testnet, 2026-10-29). `unclaimedRewards` was 15.988952, equal to the sum of the fills' `builderFee`, and the forwarder claimed it, sent it to HyperEVM and deposited it into the Splitter.
3. **Does `claimRewards` credit the perps or the spot balance?** The forwarder handles both (steps 2 and 3).
   Answer: open.
4. **Does a Core spot USDC send to `0x2000...0000` arrive as HyperEVM USDC at the same address, and does it need HYPE on Core? Who pays the possible activation fee?** (the forwarder's HyperEVM leg itself is covered in the anvil e2e, with a fake HyperCore) Testnet 2026-10-29: yes. The deployer (no HYPE on Core) sent 5 USDC from Core spot to `0x2000…0000`; 5.000000 USDC reached its own HyperEVM address within about 6 s, and Core charged about 0.0032 USDC. No activation fee (the address was already a Core user).
   Answer: open.
5. **Are `usdClassTransfer` and `claimRewards` accepted by the exchange?**
   Answer: open.
6. **Is the HyperEVM testnet USDC address equal to `Splitter.usdc()`?** The deploy takes it from `USDC`. `Deploy.s.sol` checks that it has code and 6 decimals.
   Answer (2026-10-28): yes. Circle's HyperEVM testnet USDC is `0x2B3370eE501B4a559b57D449569354196457D8Ab` (`symbol()` = `USDC`, `decimals()` = 6 on the testnet RPC), and the testnet deploy's `Splitter.usdc()` returns it. The address `spotMeta` lists (`0x0b80…c206`) is Circle's CoreDepositWallet, not the token.
7. **Does each of the poster, verifier, keeper and forwarder run one full day without an alert?** (After the checkpoint change, also: does a user's Settle & claim work within a minute of a trade, and does the keeper settle after an hour of nobody settling, with `SETTLE_AFTER_MINUTES` lowered for the test?)
   Answer: open.
8. **After the testnet deploy:** `Buyback.launchTime() − Checkpoints.launchTime()` is between 0 and 1 hour (see section 9).
   Answer (2026-10-28): 3516 s. The first deploy's `launchTime` 1793172780 (07:33:00 UTC), Buyback 1793176296, deploy block 68091490 (`contracts/deployments/998.json`).
9. **What are the `eth_getLogs` block-range cap and the request rate limit of the official HyperEVM RPC** (`rpc.hyperliquid.xyz/evm`, and the testnet one)? Hyperliquid's docs list a small block-range cap (50 blocks) and a per-IP rate limit. HyperEVM makes about 86,400 blocks a day, so at 50 blocks per request each of the poster and the verifier needs about 3,500 `getLogs` calls a day for claims and burns, and a fresh state dir catches up from the deploy block. With the default `LOG_CHUNK` of 1000, every call would fail. If the cap is 50, set `LOG_CHUNK=50`. On mainnet, use a provider RPC (with a larger range cap and a rate limit you pay for) rather than the official one, and keep the official one as the second URL in `RPC_URL` (mind the alert-leak note in section 2 for keyed URLs).
   Answer for the testnet RPC (2026-10-28): ranges of 50, 100, 200 and 500 blocks answered; 1000 blocks answered `-32005 rate limited` every time. A burst of a few dozen requests from one IP also got `rate limited` for about a minute, and four processes on one IP hit it in normal polling. The testnet run therefore gives each process two URLs, the official RPC and `https://hyperliquid-testnet.drpc.org` (free plan: 100-block log ranges answer, 500 does not), with `LOG_CHUNK=100`. The poster and the verifier use the same first URL (the same provider, section 1), whatever order the other processes use. Answer for mainnet (2026-11-02): the Alchemy free plan allows only 10 blocks per `getLogs`, which fails. `rpc.hyperliquid.xyz/evm` and `hyperliquid-rpc.publicnode.com` answer up to 500 (1000 is refused), so the poster and the verifier use those two with `LOG_CHUNK=500`.
10. **How many registered wallets can one IP serve?** Superseded by the scale work (section 2, "Scale"): the poster reads only the wallets that traded, so one IP keeps up with about 50 distinct traders a minute whatever the registry holds. The testnet rows SC1 to SC4 (`docs/APP.md` §6, "Scale") check that on the real network, including 429s with the poster and the verifier on one IP (`HL_FILLS_PER_MINUTE=25` each).
   Answer: open.

## 9. Deploy

> **Irreversible. On mainnet this spends real gas.** The contracts are immutable and the deploy fixes `launchTime` for ever. Run it on mainnet only after every item in section 8 is answered and every mainnet value below is confirmed.

`contracts/script/Deploy.s.sol` needs `USDC`, `V2_FACTORY`, `SWAP_FEE_BPS`, `POSTER`, `GUARDIAN` and `ADMIN`, takes `PAUSER` (the address of the verifier's `PAUSER_KEY`; optional off mainnet, where it may be left unset for no pauser), and takes `VAULT_PERIOD` in seconds (default 7 days; chain 999 requires exactly 7 days; testnet uses 3600; the script still requires it, but nothing reads it since Plan 9: the vault pops by odds, not by period) and the optional `CLAIM_CAP` and `CLAIM_PER_HOUR` (Mining's claim-rate limit, wei; defaults `5000e18` and `330e18`; chain 999 requires exactly these). The script calls `vm.startBroadcast()` with no key, so forge needs a signer flag: prefer `--account <keystore name>` (a keystore made with `cast wallet import`) or `--ledger`. Do not put a raw key on the command line with `--private-key`: it stays in shell history.

```bash
cd contracts
USDC=... V2_FACTORY=... SWAP_FEE_BPS=... VAULT_PERIOD=... POSTER=... GUARDIAN=... PAUSER=... ADMIN=... \
  forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --account <keystore name>
```

Roles. `POSTER`, `PAUSER` and `GUARDIAN` are three different addresses. On chain 999 the script refuses a `GUARDIAN` without code (`GUARDIAN_NOT_A_SAFE`: it must be the Safe of section 13, deployed first) and a `PAUSER` that is zero or equal to `GUARDIAN` or `POSTER` (`PAUSER`). On testnet the guardian is an ordinary key. Post-deploy check (they must be the addresses you meant):

```bash
cast call $CHECKPOINTS "poster()(address)"   --rpc-url $RPC
cast call $CHECKPOINTS "pauser()(address)"   --rpc-url $RPC
cast call $CHECKPOINTS "guardian()(address)" --rpc-url $RPC
```

It writes `contracts/deployments/<chainid>.json` with the addresses and `deployBlock` (not the roles: read those from the chain as above). Check that file is the one `DEPLOYMENTS` points at. `$CHECKPOINTS`, `$BUYBACK` and `$MINING` below are the `checkpoints`, `buyback` and `mining` entries of that file.

Buyback's launch time. A broadcast reads `Checkpoints.launchTime()` from forge's simulation, which can be earlier than the block Checkpoints really lands in. So the script gives Buyback `Checkpoints.launchTime() + 1 hour` (`LAUNCH_MARGIN`). That keeps the pool opening at least 7 days after the real launch. Pool opening: `openPool()` can be called once, by anyone, from 7 days + 1 hour after Checkpoints' deploy. Post-deploy check:

```bash
cast call $CHECKPOINTS "launchTime()(uint256)" --rpc-url $RPC
cast call $BUYBACK "launchTime()(uint256)" --rpc-url $RPC
```

The difference (Buyback minus Checkpoints) must be between 0 and 3600 seconds.

Mining's limits. Post-deploy check (they are immutable; `claimAvailable()` starts equal to the cap):

```bash
cast call $MINING "CLAIM_CAP()(uint256)" --rpc-url $RPC          # 5000000000000000000000 on 999
cast call $MINING "CLAIM_PER_HOUR()(uint256)" --rpc-url $RPC     # 330000000000000000000 on 999
cast call $MINING "claimAvailable()(uint256)" --rpc-url $RPC
```

The anvil-only `script/DevDeploy.s.sol` (`runDev()`) deploys the same contracts with a mock USDC and a mock V2 factory. It refuses any chain except 31337.

Mainnet values to confirm before deploy:

- **HyperEVM USDC** `0xb88339CB7199b77E23DB6E890353E22632Ba630f`. Checked on 2026-10-27: on the mainnet RPC the address answers `symbol()` = `USDC` and `decimals()` = 6. Still verify on the explorer that it is Circle's native USDC. Do not use the address `spotMeta` lists for USDC (`0x6b9e...5390a24`): a `symbol()` call to it reverts on the mainnet RPC.
- **HyperSwap V2 factory and its swap fee** (`V2_FACTORY`, `SWAP_FEE_BPS`). HyperSwap's docs list the V2 factory as `0x724412C00059bf7d6ee7d4a1d0D5cd4de3ea1C48` on mainnet and `0xA028411927E2015A363014881a4404C636218fb1` on testnet. A fork test on 2026-10-28 created a fresh pair from each factory and searched for the smallest fee a `swap` accepts: 30 bps on both, so `SWAP_FEE_BPS=30`. The testnet deploy used it (`Buyback.swapFeeBps()` = 30). Re-run the fork test against mainnet right before the mainnet deploy. `SWAP_FEE_BPS` must match the live pair.

  **BLOCKER (testnet 2026-10-29): Buyback cannot open its pool on a HyperSwap V2 pair.** The pair is not a standard Uniswap V2 pair: `price0CumulativeLast()` and `price1CumulativeLast()` revert (they do not exist), and `getReserves()` returns `(reserve0, reserve1, 300, 300)`, not `(…, blockTimestampLast)`. `Buyback._observe` (`src/Buyback.sol:178-179`) reads both for the TWAP guard, so `openPool()` reverts after the pair mint (traced on an anvil fork of testnet, fast-timer deployment). The same factory serves the real-timer testnet deployment, and HyperSwap's mainnet V2 is presumably the same fork: check before any mainnet deploy. Resolved 2026-10-29 without a contract change: **use Uniswap V2, not HyperSwap.** Uniswap lists an official V2 factory on HyperEVM, `0x89e5DB8B5aA49aA85AC63f691524311AEB649eba` (developers.uniswap.org, v2 deployments). On mainnet (chain 999) its pairs are standard (`price0CumulativeLast`, 3-value `getReserves`), and the fee probe finds 30 bps, so `SWAP_FEE_BPS=30` stays. A mainnet fork test deployed the real contracts with that factory and real USDC, opened the pool and ran buys (some skipped by the 2% guard, as designed): 90% of the HLO bought was burned and 10% went to Staking. **Mainnet: `V2_FACTORY=0x89e5DB8B5aA49aA85AC63f691524311AEB649eba`.** It is not on testnet, so testnet uses a byte-for-byte copy of the mainnet factory's runtime code, deployed by the deployer at `0x9fd89419c3B85F25E3BE315D41eD9dEd6a22048F` (`feeToSetter` 0, so no protocol fee can be switched on). The fast-timer testnet set on it opened its pool on 2026-10-29.
- **Big blocks.** Buyback's constructor creates the pair, which costs more than the 2M gas of a small block, so the deployer needs big blocks (30M gas, about one per minute) turned on first. `useBigBlocks(account, true, net)` in `ops/src/hl.ts` sends the Hyperliquid `evmUserModify` action; there is no command for it, so call it from a short script, or use Hyperliquid's own interface. The deployer must already be a HyperCore user. Turn it off again afterwards.
- **Builder account:** at least 100 USDC on Hyperliquid, in standard account mode (section 7), with the 0.1% builder fee approved by users.
  Hyperliquid's site can show a standard-mode wallet at $0 while the money is in perps (seen 2026-11-02). Read the real balance from the API (`clearinghouseState`). A wallet with no positions can move between unified and standard with `userSetAbstraction` (`disabled` or `unifiedAccount`), both ways (2026-11-02, on mainnet).
- Poster, pauser (the verifier), forwarder, keeper and the Safe guardian each have their own address. The admin address is separate again. The pauser needs a little HYPE for gas.
- The Safe exists on HyperEVM, has been rehearsed (section 13), and its address is the `GUARDIAN` value.
- **npm audit (2026-10-28).** `npm audit --omit=dev` at the repo root flagged `@vercel/blob` 1.1.1 → `undici` 5.29.0 → `@fastify/busboy` 2.1.1, an ops-only dependency. `@vercel/blob` was removed with Plan 8 (R2 only), so that finding is gone; recheck the audit before mainnet. Recheck 2026-11-02: 4 moderate, all `uuid` under `@openzeppelin/merkle-tree` → `@metamask/*`. The bug needs a caller that passes `buf` to `uuid`; the tree code does not, so nothing changes.
- **Fork test (2026-11-02, on a local fork of chain 999 at block 50150934, nothing sent).** The real deploy script with real USDC and `0x89e5…4eba`: `openPool()` refused early and worked 7 days + 1 h later (370k gas). With USDC added, 12 `buy()` calls every 10 minutes: the first two skip, the rest buy, the largest 446k gas; 582.16 HLO burned and 64.68 sent to Staking, exactly 90/10. `allPairsLength` is 4, `feeTo` is zero. `feeToSetter` is not zero, so Uniswap could turn on its protocol fee; that fee is taken from liquidity, which is locked here, and swap output stays the same.


## 10. Published files for the app

The poster writes three kinds of file with `PUBLISH` (a local directory, or R2 with the same paths under `PUBLISH_PREFIX`). In the bucket every path below starts with the prefix: by default `<chainId>/`, so mainnet's newest checkpoint is `999/latest.json`. The files are served from the bucket's custom domain: mainnet `https://files.hlotrade.xyz/999/`, testnet `https://files-testnet.hlotrade.xyz/998/` (this base is `REWARDS_URL` and the app's `rewardsBase`; the older `r2.dev` address is history). The app reads under the prefix of the deployment it talks to, and each deployment has its own prefix or bucket (section 2). Storage is untrusted: nothing in a file is believed until the contract accepts it. `settle` checks the poster's signature, and a claim checks the Merkle proof against the settled root.

All numbers that can be large (`entitlement`, amounts, `refBlock`) are decimal strings. Addresses are lowercase.

| Path | Content | Cache lifetime |
|---|---|---|
| `checkpoints/{minute}.json` | One file per checkpoint, kept for ever: `{ "v": 1, "chainId", "contract", "throughMinute", "refBlock", "root", "totalEntitled", "sig", "publishedAt", "table" }`. `table` is the CSV text (`minute,user,fee`, fee in 1e-8 USDC) of the minute's fee rows, so anyone can replay every checkpoint. `sig` is the poster's EIP-712 signature over `Checkpoint(throughMinute, refBlock, root, totalEntitled)`; `publishedAt` is chain time | none set (R2's default; local files carry no cache header) |
| `latest.json` | The newest checkpoint, with the same fields as above plus `vault` and `pops` (below). **No wallet's numbers and no tree**: it stays about 1 KB plus the minute's table. Overwritten every minute, **after** the minute's archive file | 60 s |
| `users/{xx}.json` | The wallets whose address starts with the byte `xx` (lowercase hex; at most 256 files, and only files with a wallet in them exist): `{ "v": 1, "chainId", "contract", "throughMinute", "refBlock", "root", "totalEntitled", "sig", "publishedAt", "vault": { "amount", "pointsTotal" }, "users": { "<lowercase address>": { "entitlement", "fees", "mined", "fromVault", "refined", "points", "proof": ["0x…"] } } }`. Each file carries its checkpoint's signed fields, so it stands alone and the app checks it like `latest.json`. Up to about 640 KB raw (230 KB gzipped) per file at 100,000 wallets. Stored gzipped with `content-encoding: gzip` on R2 (a local directory keeps plain text). Written on a round, below | 60 s |

Fields of `latest.json` beyond the checkpoint's:

- `vault`: `{ amount, pointsTotal, odds, lastPopMinute }` (a user file has `{ amount, pointsTotal }` of its own checkpoint): the vault now, the points it would be shared by, the odds (1 in `odds` each minute, `popOdds(chainId)`), and the newest pop's minute (`-1` before the first).
- `vault.pointsTotal` is the points a share is out of: those of the wallets at the 1-point minimum (`popMinimum`), not every wallet's. A wallet under it reads no share.
- `pops`: the last 10 pops, newest first: `{ minute, block, amount, kept, recipients }`. `block` is the minute's seed block, `amount` what holders of points got (at most 90%), `kept` what stayed (10% plus rounding dust; all of it when nobody had points).
- Anyone can recheck a pop: `B(m)` is the lowest block with a timestamp at or after `launchTime + 60(m+1)`, and the minute popped exactly when `keccak256(abi.encodePacked(blockhash, uint256 m)) % odds == 0`. A wrong pop changes the checkpoint's root, so the verifier's replay catches it (mismatch, pause).

Fields of an entry in `users/{xx}.json`:

- `proof`: the wallet's Merkle proof, in OpenZeppelin `StandardMerkleTree` format (`["address","uint256"]`; the leaf is `keccak256(bytes.concat(keccak256(abi.encode(user, entitlement))))`, and every tree also has the sentinel leaf `(0x0000000000000000000000000000000000000000, 0)`, which nobody can claim). Empty for a wallet with points and nothing earned (it is not in the tree). There is no `tree` dump in any file any more; the poster computes proofs only when it writes the user files.
- `entitlement` is cumulative through the file's checkpoint and is what the leaf holds. The rest is **display only** (not in the leaf): `fees` (1e-8 USDC), `mined` (trader emission), `fromVault` (vault pops), `refined` (refining shares) are cumulative; `points` is since the last pop, in fee units (1 point = 1e8 units = $1 of builder fee = $1,000 traded). `mined + fromVault + refined = entitlement`. A wallet is in the file if it has an entitlement, points or totals.

**The rounds.** A minute with a trade changes every proof, so all the user files change together, and the poster writes them only on a round (`throughMinute` divisible by the number below), after the checkpoint's own publish, 8 files at a time:

| Wallets with an entry | Round |
|---|---|
| under 2,000 | every checkpoint |
| 2,000 to under 20,000 | every 5th minute |
| 20,000 and more | every 15th minute |
| the poster is behind (the next minute is already due) | every 15th minute |
| a quiet minute (no fee rows, no pop, the root of the last files written) | every 15th minute |

In a quiet stretch a wallet's file can name a checkpoint up to 14 minutes older than `latest.json`. It proves the same entitlement; only its vault amount, and so "Your share", lags. It can still claim: Settle & claim settles it when it is newer than the chain, and a settle by anyone past it makes the next checkpoint write.

Every multiple of 15 is a round at every wallet count, and the keeper settles only such minutes (section 11), so a wallet always has a file with a proof for the newest round the keeper settled, even if the poster never returns. Besides the rounds, a write is owed (and made at the next checkpoint in step) after a start (the first checkpoint writes even when the poster is behind), after a failed write, after a checkpoint was republished from `pending.json`, after a round skipped while behind, and **when the chain has settled a minute newer than the last one the poster wrote files for** (anyone can settle any published checkpoint; in step and off the round the poster reads `Checkpoints.latestMinute()` once a minute for this, so the next file is newer than the chain and Settle & claim works). The user files are derived data and are not in `pending.json`: a failure alerts (section 5, Poster; once an hour per text), never holds up checkpoints, and one file's failure does not stop the others. So files of two checkpoints can lie side by side; each stands alone.


Things to know:

- A file is on the store before the contract has seen it: it can be there before anyone has settled it. A settled checkpoint stays claimable unless the guardian cancels it while `Checkpoints` is paused (section 12); there is no 24-hour window. The protection is the verifier's pause, which stops `settle` and claims, and the cancel that follows. A cancelled minute reads as not settled and can never be settled again.
- **Claim with the wallet's file.** `Mining.settleAndClaim(cp, sig, entitlement, proof)` takes the checkpoint fields and signature of the wallet's user file and the proof in it (the file may be older than `latest.json`, see the rounds); it settles that checkpoint if it is newer than the chain's and pays. If someone settled the same checkpoint first it still pays. If a newer one landed first it reverts `StaleCheckpoint`; the file's own minute can still claim with `Mining.claim(throughMinute, entitlement, proof)` when it is settled at the file's root (Mining pays against any settled minute that is not cancelled, and the app checks `rootOf(file.throughMinute)` and does this itself); otherwise the wallet waits for the next round's file ("Rewards are updating…"). The entitlement is cumulative, so the newest file claims everything credited through its minute. After a recovery the newest settled minute is `Checkpoints.latestValidMinute()` (cancelled minutes read as not settled), while "is the file newer than the chain's" compares with `latestMinute()`, the highest minute ever settled, cancelled or not.
- `claimFor(user, throughMinute, entitlement, proof, deadline, v, r, s)` takes the user's EIP-712 signature (domain `{name:"HLO Mining", version:"1", chainId, verifyingContract}`, type `Claim(address user,uint256 entitlement,uint256 deadline)`); anyone can submit it. A relayer that submits `claimFor` must have users sign **short deadlines**: a signature stays usable until the entitlement it names is fully claimed (there is no nonce, and a partial claim no longer uses it up), so with a long deadline whoever holds it decides when the user's claims happen (the HLO still goes to the user) and can spend the shared allowance on them, a slice at a time.
- Every claim pays 90% and records 10% as refining, shared out in later checkpoints to holders of unclaimed entitlement. Claims draw on one hourly allowance (`Mining.claimAvailable()`; `CLAIM_CAP` 5,000 HLO, `CLAIM_PER_HOUR` 330 HLO): a claim larger than it is paid in part (`claimed[user]` grows by the gross paid out, the rest stays claimable), an empty allowance reverts `ClaimLimitReached`. `Claimed(user, throughMinute, claimedTotal, paid, refined)` reports the user's new `claimed[user]`, which is what the poster's and verifier's tracker feeds the calculator as `claimed`.
- The display fields are unverified. Show them as information, never use them for a claim. The claim uses only `entitlement` and `proof`, checked against the settled root.
- Fills are counted by the minute they happened in (`minute = floor((time − launchTime) / 60)`), and only registered wallets earn, from their registration time.

## 11. Keeper

The keeper makes sure `Buyback.openPool()` and `Buyback.buy()` get called. Both functions are open to anyone, so a second keeper (or a user pressing the app's buttons) is harmless: the loser's call is simulated first and counted as "nothing".

| Condition (chain time) | Step |
|---|---|
| pool not open, before `launchTime() + OPEN_DELAY` | wait |
| pool not open, due, Buyback holds USDC | `openPool()` |
| pool open, `slice == 0` | idle: buying starts after the next `Splitter.deposit` (the forwarder's deposit calls `refreshSlice`) |
| pool open, `slice > 0`, `now ≥ lastBuy + BUY_INTERVAL` (and one interval after its own last skipped try) | `buy()` |

**Settling.** On every pass, after the buyback step, the keeper also checks `Checkpoints`. It settles the newest **round**: the newest multiple of 15 at or before `latest.json`'s minute (every minute on anvil), with that minute's signed fields from its archive file `checkpoints/<round>.json`, by `Checkpoints.settle(cp, sig)`. It does so when that round is newer than the chain's `latestMinute()` and `SETTLE_AFTER_MINUTES` (default 60) have passed since the end of the last settled minute (since launch, if nothing is settled yet). A round and not the newest minute because the poster writes the wallets' user files on every multiple of 15 at every wallet count: a settled off-round minute could leave wallets with no proof for any settled minute, for good if the poster never came back (section 10). Users normally settle by claiming, so this only covers quiet hours; it keeps `Settled` events and the chain's checkpoint from falling far behind. It reads `latest.json` from `REWARDS_URL` (or an explicit `PUBLISH=local:<dir>`) only once the chain alone says a settle could be due, and the round's archive file only once a settle is due; a missing or unreadable archive file is alerted (section 5, Keeper) and tried again on the next pass. Without a source it cannot settle and alerts once an hour. A `NotNewer` revert (someone else settled first) is success, and the settle step never stops the buyback step. The loop sleeps until the next buy or the next settle is due, whichever is first (the smaller of the two sleeps: the buy part is at most `POLL_SECONDS` and at least 1 s; the settle part is the time until the settle is due, but at least 30 s, and 5 min when the settle time is unknown).

A buy that the 2% TWAP guard stops emits `Skipped` and returns 0. The keeper counts that as success and tries again one interval later. A buy that comes less than 30 minutes after opening is a skip, because the 30-minute TWAP needs an observation that is 30 minutes old. A later first buy executes.

Run one keeper. It needs a funded `KEEPER_KEY` and the same `CHAIN_ID`, `RPC_URL`, `BUILDER` and `DEPLOYMENTS` as the other processes (`BUILDER` is required by the shared config even though the keeper does not use it). The keeper ignores `PUBLISH=r2`, so an env shared with the poster that has it and no `R2_*` vars still starts it; `PUBLISH=local:<dir>` is read as the place to find `latest.json`. For a deployed keeper set `REWARDS_URL`.

## 12. Recovery (a bad checkpoint was settled)

Read this with the spec (`docs/superpowers/specs/2026-10-30-hlo-recovery-design.md`, §6 and §8). The cause is usually a leaked or lost `POSTER_KEY`: whoever holds it can sign a checkpoint that pays one wallet, and anyone can settle it. This section is the order of the work. Take the steps one at a time. Nothing here needs a redeploy: same contracts, same token, same pool.

What the contracts do. While `Checkpoints` is paused the guardian can **cancel** every settled checkpoint after the last good one (`cancelAfter(keep)`, or `cancelAll()` when none is good). A cancelled minute reads as not settled, so nobody can claim against it, and it can never be settled again. The guardian can then record a **write-off** (`writeOff(amount)`): the gross HLO claimed against the cancelled checkpoints. Mining's overall bound allows that much more (`maxEntitledBound + writtenOff`), so the stolen amount does not block the last honest claimers. The new poster continues from its honest state, and its next checkpoint carries everyone's honest entitlement.

How long before the pause. A bad checkpoint that is settled with no published file is called a mismatch only after the verifier's patience (`PATIENCE_SECONDS`, 300 s of chain time), so detection takes about 5 minutes after the settle. If a published file shows a different root, the verifier sees it as soon as it reads the `Settled` event. Whatever leaves before the pause is bounded by the claim limit: `CLAIM_CAP` (5,000 HLO) plus `CLAIM_PER_HOUR` (330 HLO) for each hour, which is about 5,030 HLO for 5 minutes.

### Before you start

- Contract addresses: `contracts/deployments/<chainid>.json`. In the commands below `$CHECKPOINTS` is its `checkpoints` entry and `$RPC` the same RPC the poster and verifier use.
- The Safe's owners (section 13), or on testnet the guardian key, are at hand. Never paste a key into chat or a ticket.
- Write down the time of each step. The incident note (step 7) needs it.

### The steps

1. **Pause.** The verifier pauses by itself and alerts `verifier: paused Checkpoints because of the checkpoint M mismatch`. Check, and if it did not (`could not pause`), pause by hand: `pause()` with the pauser key, or from the Safe.

   ```bash
   cast call $CHECKPOINTS "paused()(bool)" --rpc-url $RPC            # true
   # only if it is false. In a shell that has sourced the verifier's env (never type the key):
   cast send $CHECKPOINTS "pause()" --rpc-url "$RPC_URL" --private-key "$PAUSER_KEY"
   ```

2. **Stop the poster and find out what happened.** Stop the poster process (do not delete its volume: its state is the honest state). If the key leaked or was lost, make a new `POSTER_KEY` on a clean machine, keep it only in the poster host's secret store, and note the new address. Remove the old key from every place it was. If the poster key is fine and the poster itself was wrong, fix the cause first.

3. **Run the recovery report.** It is read-only: it sends nothing and needs no key. Run it with the **verifier's env** (the same `CHAIN_ID`, `RPC_URL`, `DEPLOYMENTS`, `STATE_DIR`, `REWARDS_URL`, `LOG_CHUNK`) on the verifier's host, so it reads the verifier's saved state (`verifier-state.json`), and pass the replacement poster:

   ```bash
   NEW_POSTER=0x… npm run recovery -w ops
   ```

   Leave `NEW_POSTER` out when the poster key did not change. The report prints, in this order: any `NOTE:` lines; `keep minute K, cancel minutes A..B` (K is the newest settled minute whose root equals the verifier's verified root; or `cancel every settled minute 0..B` when the verifier verified none); `write-off: X HLO`; `"honest" is each wallet's entitlement as of the verifier's last verified minute M`; one line per wallet whose `Mining.claimed` is above its honest entitlement; then the Safe transactions, numbered by what is present (the list below is the full set, in order), each as `<call> to <Checkpoints address> data <calldata>`:

   1. `cancelAfter(K)`, or `cancelAll()`
   2. `writeOff(X)` (only when X is above zero)
   3. `setPoster(0x…)` (only with `NEW_POSTER`)
   4. `setPaused(false)` (last; not yet)

   Read it before you sign anything. A `NOTE:` that says the chain's root for the verified minute differs from the verifier's means the choice of `K` is yours: stop and look. The report is safe to run again: after a cancel or a write-off it lists only what remains (`already written off`, `Minutes after K are already cancelled`). The wallets it checks are every wallet with a `Claimed` event since the deploy block (read in `LOG_CHUNK` pieces); each one's `Mining.claimed` now is compared with its honest entitlement as of the verifier's last verified minute M. So let the verifier run (and stop at its mismatch) before you run the report: an honest wallet that claimed against a checkpoint newer than M would show as excess. Check each listed wallet before you sign the write-off.

4. **In the Safe, send every printed transaction except the last (`setPaused(false)`), in order, as one batch.** The report numbers what is present: with no write-off, `setPoster` is 2.
   - Mainnet: open the Safe app, Apps, Transaction Builder. For each of those transactions: switch on **Custom data**, put the Checkpoints address in "Enter address", leave the value at 0, paste the report's calldata (`0x…`) into "Data", and "Add transaction". Then "Create batch", "Send batch", sign, and have a second owner confirm and execute. The Safe's own simulation must show no revert; if it does, stop (the pause is not on, or `K` is wrong).
   - Testnet (the guardian is an ordinary key): from the report's calls, with the guardian's keystore:

     ```bash
     cast send $CHECKPOINTS "cancelAfter(uint256)" <K> --rpc-url $RPC --account <guardian keystore name>
     cast send $CHECKPOINTS "writeOff(uint256)" <X in wei> --rpc-url $RPC --account <guardian keystore name>
     cast send $CHECKPOINTS "setPoster(address)" 0x… --rpc-url $RPC --account <guardian keystore name>
     ```

   Check each transaction landed, with `cast call`:

   ```bash
   cast call $CHECKPOINTS "isCancelled(uint256)(bool)" <A> --rpc-url $RPC     # true (A = the first cancelled minute); rootOf(A) reads 0x00…0
   cast call $CHECKPOINTS "latestValidMinute()(uint256)" --rpc-url $RPC       # K (after cancelAll(): "anyValid()(bool)" is false)
   cast call $CHECKPOINTS "writtenOff()(uint256)" --rpc-url $RPC              # X (plus any earlier write-off)
   cast call $CHECKPOINTS "poster()(address)" --rpc-url $RPC                  # the new poster
   ```

   The verifier does not announce these yet: while its mismatch is stored it stops before it reads any event. The announcements (`checkpoints: paused (block N)` for its own pause, `checkpoints: cancelled minutes A..B (block N)`, `checkpoints: wrote off X HLO (total Y HLO) (block N)`, `checkpoints: poster set to 0x… (block N)`) arrive once it runs again after step 5.

5. **Restart, in this order.**
   1. **Poster** with the new `POSTER_KEY` and the **same state dir**. It starts only if the key is `Checkpoints.poster()`. It publishes any minutes it owes and continues. After hours of recovery the new process's feed was not watching that stretch, so its first minute takes the long-gap path and reads every registered wallet (section 2, "Scale"): N ÷ 50 to 2 × N ÷ 50 minutes, about 33 to 66 hours at 100,000 wallets, with no new checkpoint meanwhile. Nothing is lost; it is the price of not missing a wallet's fees. Step 6 (honest claims) waits for the first new checkpoint. Files published with the old key stay published; a cancelled minute can never be settled.
   2. **Verifier:** stop it, open its `verifier-state.json` (section 3) and set `"mismatch": null`, start it again. It replays from where it stopped. It accepts files signed by the old poster (a former poster); the content is replayed either way.
   3. **Wait** while the running verifier catches up. Watch its log (the host's log view, or the log file) for `checkpoint M ok: ...` lines until M is the newest published minute (`latest.json`'s `throughMinute`), with no new `mismatch` alert. Do not start a second verifier on the same `STATE_DIR` to check: it races on `verifier-state.json` and can double-alert or pause. `--once` is for when the loop is stopped, and it checks only one checkpoint.

6. **Unpause.** In the Safe: `setPaused(false)` (the report's last transaction; on testnet `cast send $CHECKPOINTS "setPaused(bool)" false --rpc-url $RPC --account <guardian keystore name>`). Check `paused()` is `false`, the verifier announces `checkpoints: unpaused (block N)`, and press **Settle & claim** with a small honest wallet. The app's claimable amount comes from the settled checkpoint at `latestMinute` (a cancelled one's root reads zero, so it offers nothing there) or, with a newer published file, from Settle & claim; only "settled through" uses `latestValidMinute`. Right after the cancel, the new poster's newer checkpoint is what makes claims possible again (its first checkpoint also writes the wallets' `users/<xx>.json`, which the app claims from). The bad wallet's claim against a cancelled minute reverts `NotSettled`.

7. **Tell users and write the incident note.**
   - Users: HLO already in wallets is intact. Honest holders lose nothing: their entitlements continue, and the claim that went to the thief is extra supply, not taken from anyone's balance. Claims were stopped for the length of the pause and work again now. Say what was lost (X HLO, claimed before the pause) and that the poster key was replaced. Say "the vault" for the 0.1 HLO per minute.
   - Note: times of each step, the cause, how the key leaked, the report's output (`keep`, `cancel`, `write-off`), and the transactions' hashes.

### What is lost

- Only what was claimed against the bad checkpoints before the pause: at most `CLAIM_CAP` plus `CLAIM_PER_HOUR` per hour of the time between the settle and the pause. It stays with whoever claimed it and is written off.
- `maxEntitledBound` may stay raised by the bad checkpoint's total. The bound then protects less, but the poster is honest again and the claim limit still applies.
- Refining: a wallet that took more than its share gets no refining (the calculator shares it only over wallets whose entitlement is above their claimed amount).

### Other cases

- **A false alarm** (the verifier was wrong, nothing bad was settled). Fix the verifier, clear its stored mismatch, and unpause with `setPaused(false)`. No cancel is needed: `cancelAfter` is only for settled minutes after the last good one.
- **A mismatch in an unsettled file only** (a tampered or wrong file that nobody settled): no cancel. Clearing the mismatch alone does not help: the verifier reads the same `checkpoints/M.json` again and stops at M again, and so does a new `STATE_DIR` (it replays from launch and reaches the same file). First put the poster's correct signed file back at that path (from a backup, or the store's object versions if it keeps them; the poster keeps no copy once a file is published). Then rotate the poster key with `setPoster` if it leaked, clear the mismatch, and unpause. If there is no correct copy because the poster itself signed the wrong content, its later checkpoints build on it: stop the poster and treat it as a wrong poster ("After a mismatch", step 3) before anything else.
- **The first settled checkpoint is bad.** The report prints `cancelAll()` and the poster's state continues as above.
- **The pauser key leaked.** Someone can keep the contracts paused and nothing else. The Safe calls `setPauser(new)` (and the verifier moves to the new `PAUSER_KEY`), then `setPaused(false)`.
- **An unexpected `checkpoints:` guardian alert** (a role set, a cancel, a write-off, an unpause that was not yours). Treat the Safe, or the pauser, as compromised: pause with the pauser key if you can, tell the other owners, and replace the owner keys and the role addresses.
- **A stolen Safe** (2 of the 3 owner keys) could set its own poster and settle bad checkpoints (the claim limit still applies), cancel honest checkpoints (no HLO moves; users claim against the next one), or write off any amount. The verifier announces every such action. Replace an owner as soon as one key is lost; do not wait for two.

## 13. Safe setup (mainnet guardian)

The guardian on mainnet is a Safe, a contract wallet. At launch it has one owner and needs that one signature; add owners and raise the threshold later (Settings, Setup, Owners) with no redeploy. The steps below describe the 2-of-3 setup to move to when the product grows. On 2026-11-02 Safe{Wallet} asked for a paid plan on HyperEVM, so the launch Safe was created directly: `createProxyWithNonce` on the standard SafeProxyFactory 1.4.1 (`0x4e1DCf7AD4e460CFd30791CCC4F9c8a4f820ec67`, singleton SafeL2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`). A one-owner Safe needs no site: the owner sends `execTransaction` itself, with a pre-validated signature (the owner's address as r, zero as s, v = 1). It is the only account that can unpause, cancel checkpoints, write off, and change the poster, the pauser or the guardian. This section is for someone who has never made one. Do it before the deploy: `Deploy.s.sol` refuses a mainnet `GUARDIAN` that has no code.

1. **Pick the three owners**, each a different wallet on a different device: your browser wallet, your phone wallet, and a spare or hardware wallet. Threshold: **2**. Use fresh wallets for the Safe's owners, not wallets that hold your funds or run a process (no poster, pauser, builder or keeper key).
2. **Find an app that lists HyperEVM** (chain 999). Try Safe{Wallet} (`app.safe.global`) first, and Den if Safe's app does not list it. (Not yet checked for HyperEVM: do this first; if neither lists it, stop and ask before going on.)
3. **Create the Safe on HyperEVM.** In the app: Create account, choose HyperEVM as the network, name it, add the three owner addresses, set the threshold to 2, and confirm the creation transaction with one owner wallet (it pays gas in HYPE). Wait for it to finish.
4. **Note the Safe's address** (the app shows it). Check on the HyperEVM explorer that it is a contract. This is the `GUARDIAN` value for the deploy.
5. **Fund it with a little HYPE** (a few dollars' worth) for gas. A Safe transaction is paid by the owner that executes it, so also keep a little HYPE in each owner wallet.
6. **Learn to send raw calldata.** In the Safe app: Apps, Transaction Builder, switch on **Custom data**, enter the target address, value 0, the data (`0x…`), Add transaction, Create batch, Send batch. The first owner signs; the second confirms and executes. The recovery report (section 12) prints exactly this: target and calldata.
7. **Rehearse on mainnet, right after the deploy and before anyone is told about it** (no real users yet):
   1. Pause from the Safe: Transaction Builder, target the Checkpoints address, data from `cast calldata "pause()"`. Confirm `cast call $CHECKPOINTS "paused()(bool)"` is `true`.
   2. Unpause: `cast calldata "setPaused(bool)" false`. Confirm it is `false`.
   3. Pause once with the pauser key (`cast send $CHECKPOINTS "pause()" --rpc-url "$RPC_URL" --private-key "$PAUSER_KEY"`, in a shell that has sourced the verifier's env; never type the key), and unpause from the Safe.
   4. Check the alert channel got `checkpoints: paused (block N)` and `checkpoints: unpaused (block N)` for each. If the Transaction Builder cannot send custom data on HyperEVM, find the app's way of calling a contract with raw data now, not during an incident.
8. **Keep the owners' recovery phrases offline and apart:** written on paper (or a hardware wallet's backup), in different places, never in a cloud note, a photo or a chat. Test that each owner device can still sign. If one owner key is lost or leaked, replace that owner at once (Safe: Settings, Setup, Owners); do not wait for a second one to fail.
9. **Know what the Safe can do.** It cannot transfer anyone's HLO directly. Its powers are the ones in section 12, and a stolen Safe's worst case is listed there under "Other cases".

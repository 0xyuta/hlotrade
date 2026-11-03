# HLO — design

Date: 2026-10-27. Status: agreed with the owner section by section; awaiting his review of this file.

HLO is a trading app for Hyperliquid perps that charges a builder fee and returns most of the fees to its users through the HLO token. How mining works: trading fees mine HLO every minute, a rewards pot pops at random, claims pay a refining fee to holders who have not claimed, and the fees buy back and burn HLO.

Trading stays entirely on Hyperliquid. The contracts on HyperEVM run only the mining system.

Wording rule: the 1/625 vault is the **rewards pot**. Never call it a jackpot, lottery or prize.

## 1. Decisions

| Topic | Decision |
|---|---|
| Name | Project HLO, token HLO |
| Trading venue | Hyperliquid perps through our builder code. Users' money stays in their own Hyperliquid account |
| Builder fee | 0.1% (Hyperliquid's perps maximum; users approve 0.1%, so we can lower it without re-approval) |
| Wallets | Users bring their own EVM wallet (MetaMask, Rabby, Phantom EVM and so on). No embedded wallet |
| Markets | All Hyperliquid perps, listed live. No spot, no HIP-3 at launch |
| Orders | Market, limit, TP/SL, a leverage slider, isolated margin by default |
| Deposits and withdrawals | Inside the app. Launch routes: HyperCore, HyperEVM, Arbitrum, Solana, Ethereum. Robinhood Chain later |
| Mining | Fully on-chain contracts on HyperEVM. The only outside input is one daily data post |
| Emission | 1 HLO per minute to traders (pro rata by builder fees paid in that minute) + 0.1 HLO per minute into the rewards pot |
| Supply | 5M cap, flat rate (no halving). Burned HLO frees room, so it can be mined again |
| Empty minute | Its 1 HLO goes into the rewards pot |
| Rewards pot | Pops with a 1/625 chance per minute. The whole pot is shared pro rata by fees paid since the last pop |
| Refining | A claim pays 90% to the claimer. The 10% goes to everyone still holding unclaimed HLO, pro rata |
| Fee split | 10% admin, 90% buyback |
| Buyback | Bought HLO: 90% burned, 10% to stakers |
| Staking | Stake HLO at any time, earn buyback HLO, unstake at any time |
| Liquidity pool | Anyone can open it from 7 days + 1 hour after FeeFeed's deploy; the contract creates it with 10,000 newly minted HLO + all buyback USDC collected so far. The pool tokens are locked in the contract forever |
| Launch | App and contracts launch together, after about a week on Hyperliquid testnet |
| Upgrades | Contracts are immutable |
| Audit | None before mainnet. We say so publicly and audit later |
| World App | Not a target |
| Look | Rounded cards and monospace numbers; its own HLO identity |

## 2. Architecture

```
trader ──orders──▶ Hyperliquid ──0.1% builder fee──▶ builder account (HyperCore)
                        │                                   │ daily
             public daily builder-fill file          fee forwarder ──▶ Splitter ──10%──▶ admin
                        │ daily                                            └──90%──▶ Buyback ──▶ pool (HLO/USDC)
                     poster ──▶ FeeFeed ──▶ Mining ──▶ HLO claims              90% burn │ 10%
                                                                                   Staking ◀┘
```

Repository layout:

- `app/` — React + Vite + viem, hosted on Vercel. No server of ours in the trading path.
- `contracts/` — Foundry, Solidity, deployed to HyperEVM (chain 999; testnet 998). `lib/forge-std` is already in the repo.
- `calc/` — the public rewards calculator (TypeScript, no I/O): parses Hyperliquid's builder-fill files, builds the canonical fee table, replays the emission schedule, and builds the Merkle tree. It is shared by the poster, the verifier and anyone who wants to check a post.
- `ops/` — three processes: `poster` (commits, reveals, posts; needs the poster key), `verifier` (re-runs `calc/` on every post it can still act on, alerts, and cancels when it holds the guardian key; also watches FeeFeed events and reveals seeds the poster missed) and `forwarder` (moves the builder fees to the Splitter; needs the builder key). Each runs separately with its own state and its own key. The runbook is `docs/OPS.md`.

## 3. Mining rules (the calculator is the reference)

Units: HLO has 18 decimals. Fees are USDC; the calculator counts them in units of 1e-8 USDC, the precision of Hyperliquid's `builder_fee` column.

- **Minute:** `m = floor((t − launchTime) / 60)`, where `t` is the fill time and `launchTime` is FeeFeed's deploy time (`FeeFeed.launchTime()`, read from the chain, never from a local clock). Fills before `launchTime` don't count.
- **Day:** UTC calendar day. The first day is partial.
- **Fees:** `f(u, m)` is the builder fee user `u` paid in minute `m`, from Hyperliquid's file `https://stats-data.hyperliquid.xyz/Mainnet/builder_fills/{builder}/{YYYYMMDD}.csv.lz4`. `F(m)` is the total for that minute.
- **Trader emission:** if `F(m) > 0`, user `u` earns `1 HLO × f(u, m) / F(m)`, rounded down. Rounding dust goes to the pot. If `F(m) = 0`, the 1 HLO goes to the pot.
- **Pot:** gains 0.1 HLO every minute, plus empty minutes and dust.
- **Pop:** minute `m` pops if `uint256(keccak256(seed_d, m)) % 625 == 0`, where `seed_d` is the seed fixed on-chain for that day (section 4). On a pop, the whole pot (including that minute's 0.1) is shared pro rata by fees paid from the minute after the previous pop through `m`. If no fees were paid in that span, the pot carries over.
- **Refining:** claims made during day `d` (on-chain events) produce a refining pool `R_d`. At the close of day `d`, `R_d` is shared pro rata by each user's unclaimed balance: their total earned through day `d` minus what they had claimed by the end of day `d`.
- **Supply room:** a minute emits its 1.1 HLO only while `(total emitted − total burned) < 5,000,000 − 10,000`. Otherwise it emits only the room left, or nothing. "Total burned" is read from on-chain burn events. The 10,000 reserve is the pool mint.

The calculator outputs each user's cumulative entitlement `E(u)` through day `d`, plus the day's totals: emitted, pot left over, pops, refining shared. Every input is public: the Hyperliquid file and on-chain events.

### Calculator details

The rules above leave some cases open. These nine settle them. `calc/` and `ops/` follow them exactly (rules 1 to 8 are `calc/`; rule 9 is the poster's and verifier's).

1. **Perps only.** Only fills whose `coin` contains none of `@`, `:` or `/` count: core Hyperliquid perps. Spot (`@305`, `PURR/USDC`) and HIP-3 (`xyz:GOLD`) fills are ignored, and so are zero-fee fills.
2. **Claiming address.** A fill's `user` is mapped through Hyperliquid's `userRole`:
   - `subAccount` → `data.master`;
   - `vault` → the vault's `leader` (from `vaultDetails`);
   - `agent` → `data.user`;
   - anything else → itself.

   Sub-accounts and vaults have no key that can sign a HyperEVM claim.
3. **Which day settles a minute.** A minute settles on the last UTC day it overlaps, i.e. the day containing `launchTime + 60(m+1) − 1`. A minute that ends exactly at midnight belongs to the day before. A minute that starts before midnight and ends after it settles on the next day, using rows from both days' tables. That day's seed decides its pop.
4. **Burns and room.** The room for every minute settled on day `D` is `5,000,000 − 10,000 + (HLO burned in blocks before day D's first block)`, in HLO. Within a minute the trader part is filled first: `min(1, room left)`. The pot part is `min(0.1, room left after that)`.
5. **Refining.** `R_D` is the sum of `Claimed.refined` in day `D`'s blocks. A user's base is their entitlement credited through day `D` (before this day's refining) minus their `Mining.claimed` at the end of day `D`, never below 0. Each user's share is `floor(pool × base ÷ Σ base)`, with pool = `R_D` plus earlier carry. Leftover dust, or the whole pool when nobody holds unclaimed HLO, carries to the next day.
6. **Pop hash.** `pop(m) ⇔ uint256(keccak256(abi.encodePacked(bytes32 seed_D, uint256 m))) % 625 == 0`. The day summary counts a pop's recipients only among users who received a share above 0.
7. **Sentinel leaf.** Every tree also contains the leaf `(0x0000000000000000000000000000000000000000, 0)`, so a day with no traders still has a non-zero root and can be posted. Nobody can claim it.
8. **Canonical table and `dataHash`.** The table text is the header `minute,user,fee`, then one line `minute,user,fee` per (minute, claiming user) with a summed fee above 0:
   - sorted by minute, then by user (lowercase hex);
   - lines joined by `\n`, with no trailing newline.

   `dataHash = keccak256(utf8(text))`.
9. **Empty or late files.**
   - The poster uses day `D`'s file only once chain time is at least `(D+1)·86400 + FILE_DELAY_HOURS·3600` (default 2 h; the file appears about 1.6 h after midnight).
   - If the file is still missing (HTTP 403 or 404) at `(D+1)·86400 + EMPTY_AFTER_HOURS·3600` (default 6 h), the day's table is empty. If that was really an access failure, the day's trader emission goes to the rewards pot; it is not lost. A verifier that builds that day after the real file appears flags a data mismatch; one that already stored the empty table does not.

"Now" for these decisions is the latest HyperEVM block's timestamp, never the wall clock.

## 4. Daily cycle and trust

1. **Commit.** After Hyperliquid publishes the file for day `d`, the poster calls `FeeFeed.commit(d, dataHash)`. `dataHash` is the hash of the canonical per-user, per-minute fee table for day `d`.
2. **Seed.** `seed_d = blockhash(commitBlock + 5)`. Anyone can call `reveal(d)` from block `commitBlock + 5` until 256 blocks later. If nobody reveals in time, the commit lapses and must be repeated with the *same* `dataHash`. Lapses are emitted as events so watchers can see them.
3. **Post.** The poster runs the calculator and calls `post(d, root, totalEntitled, potLeft)`. `root` is the Merkle root of `(user, E(u))`.
4. **On-chain checks:**
   - days must be posted in order;
   - `totalEntitled` never decreases;
   - `totalEntitled ≤ emission allowed through the end of day d + refining recorded through the end of day d`.

   So a bad post can move HLO between users but can never create extra HLO.
5. **Check window.** The post becomes claimable 24 hours later. During the window the guardian can cancel it, and the poster then re-posts. Anyone can re-run `calc/` against the public file to verify.
6. **Claim.** `claim(day, E, proof)` (for the sender) or `claimFor(user, day, E, proof, deadline, v, r, s)` (with the user's EIP-712 signature): `gross = E − claimed[user]`, mint `0.9 × gross` to the user, set `claimed[user] = E`, and emit `Claimed` with the 10% refined. Only the user can claim, directly or by signing a claim message that anyone (e.g. a gas-paying helper) can submit. This keeps refining fair: nobody can force another user's balance to be claimed.

**Roles:**
- **Poster:** commits and posts.
- **Guardian:** cancels a post during its window, pauses new commits, and can replace the poster address.

Neither role can touch USDC, stakes or the pool. They do decide who receives HLO: the guardian can make itself poster, and a wrong root that becomes final can redirect unclaimed HLO and cannot be undone. Mitigations: a multisig guardian, a separate poster key, an independent verifier that re-runs `calc/` and alerts/cancels within the 24 h window, alerts on every PosterSet, and an independent reveal bot (so a poster cannot skip an unwanted seed by letting a reveal lapse).

**What users trust:** the poster and guardian to post correctly or cancel mistakes, and Hyperliquid's file. Cheating is publicly visible, and the contract caps its damage.

**Timing:** a day's HLO is claimable about 26 hours after the day ends (posted about 02:00 UTC the next day, final 24 hours later).

## 5. Contracts

| Contract | Job |
|---|---|
| `HloToken` | ERC-20, 18 decimals. Only Mining (claims) and Buyback (the one pool mint) can mint. Anyone can burn their own tokens. Enforces `supply ≤ 5M` |
| `FeeFeed` | commit / reveal / post / cancel with the daily rules above |
| `Mining` | Merkle claims with the 90/10 refining split; reads finalized roots from FeeFeed |
| `Splitter` | Receives USDC from the forwarder: 10% to the admin's claimable balance, 90% to Buyback |
| `Buyback` | Until the pool opens it only collects USDC. `openPool()` can be called once, by anyone, from 7 days + 1 hour after FeeFeed's deploy (the deploy script gives Buyback `FeeFeed.launchTime() + 1 hour`, because a broadcast reads a simulated launch time that can be earlier than the real one): mints 10,000 HLO, adds them with all collected USDC to a Uniswap-v2-style pool on HyperEVM, and keeps the pool tokens forever (no function can move them). After that, `buy()` can be called by anyone at most every 10 minutes. It spends `min(remaining, dailyBudget / 144)`, skips if the pool price is more than 2% away from its own 30-minute average, burns 90% of the HLO and sends 10% to Staking |
| `Staking` | Stake and unstake HLO at any time. Buyback HLO drips in gradually: each update releases (time since the last update ÷ 1 day) of what is still undripped, so with buys every 10 minutes about 63% of a buy's reward is out after a day. It is shared pro rata through a reward-per-share index, so staking just around a buy earns almost nothing |

The exact DEX (for example HyperSwap V2) and the HyperEVM USDC address are fixed in the implementation plan, after checking their contracts on chain.

## 6. App

**Trade screen**
- A market picker over all perps, live price and 24h change.
- A chart.
- An order form:
  - Market and Limit tabs, optional TP/SL;
  - a leverage slider capped at the market's maximum;
  - isolated margin.
- The order form and Mine screen show no fee line (the owner's decision, 2026-11-03). The 0.1% is stated when the user enables trading.
- Tabs: positions (PnL, liquidation price, close, reverse, edit TP/SL), open orders, trade history.

**Rewards screen**
- **Yours:** fees paid, unclaimed HLO, refining earned, and a Claim button. A "today so far" estimate uses the user's own fills from Hyperliquid's API and the previous day's HLO per $1 of fees.
- **The pot:** its size, time since the last pop, and pop history.
- **Staking:** stake and unstake.
- **Protocol stats:** total burned, buyback USDC spent, pool price, and a countdown to the pool opening.

**Account menu**
- **Username:** from a small on-chain registry on HyperEVM.
- **Profile picture:** chosen from built-in avatars.
- **Copy address.**
- **Enable trading:** the wallet signs `ApproveBuilderFee` (0.1%) and approves a browser agent key.
- **Pair phone:** a QR code carries the agent key to the phone camera directly. The agent can trade, never withdraw.
- **Disconnect.**

**Deposit and withdraw modals**
- One list of routes with the user's USDC balance on each, then a per-route flow with its own wallet connection and a fee breakdown.
- Routes: HyperCore (already the trading balance), HyperEVM (transfer to HyperCore), Arbitrum (Hyperliquid's bridge), Solana and Ethereum (Circle CCTP v2 into HyperCore). Withdrawals use the same routes in reverse.
- Pending transfers are kept in browser storage.

**Country blocking:** a Vercel edge check blocks the same countries Hyperliquid's own site blocks.

**Failures:**
- Hyperliquid errors are shown in plain words.
- An expired agent key prompts one re-sign.
- If HyperEVM is unreachable, trading keeps working and only the rewards screen pauses.

## 7. Testing

**Contracts:** unit, fuzz and invariant tests for:
- supply never above 5M;
- entitlement never above the schedule plus refining;
- claims pay exactly 90% and never more than posted;
- the seed always comes from a block after the commit;
- the pool opens once, only from 7 days + 1 hour after FeeFeed's deploy, and its pool tokens never move;
- `buy()` respects its interval, slice and price guard;
- the 90/10 burn/stake split, and the 10/90 admin/buyback split;
- Staking pays out exactly what came in.

**Calculator:**
- fixed sample days with hand-checked answers;
- a property check that each day's totals equal the schedule exactly;
- runs on real Hyperliquid testnet builder files.

**App:**
- unit tests for fee, liquidation-price and route-fee math;
- a full run on Hyperliquid testnet: connect, enable trading, deposit, market/limit/TP/SL, withdraw, claim, stake.

**Launch:**
1. About a week on testnet with real test trades, posts and pops.
2. Mainnet: a builder account with at least 100 USDC on Hyperliquid in standard mode, plus poster, guardian and admin wallets.
3. Deploy the contracts, deploy the app, announce. The announcement states that the contracts are unaudited.

## 8. Known limits

- The contracts trust one daily post. They cap its damage but can't check it against Hyperliquid themselves.
- Neither role can touch USDC, stakes or the pool. They do decide who receives HLO: the guardian can make itself poster, and a wrong root that becomes final can redirect unclaimed HLO and cannot be undone. Mitigations: a multisig guardian, a separate poster key, an independent verifier that re-runs `calc/` and alerts/cancels within the 24 h window, alerts on every PosterSet, and an independent reveal bot (so a poster cannot skip an unwanted seed by letting a reveal lapse).
- The pop seed is a HyperEVM block hash, which Hyperliquid's validators could in theory influence.
- A poster could let a reveal lapse to get a different seed. Lapses are public, and the data hash can't change.
- Early minutes with few traders are cheap to mine. That is expected with fixed emission.
- Running the forwarder needs our builder key, so fees reach the Splitter only if we forward them. The builder-fill file shows how much should arrive each day.

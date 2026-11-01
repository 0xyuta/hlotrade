# HLO — minute settlement and the weekly vault

> **2026-10-30:** the weekly vault is replaced. The vault now pops with a 1-in-`ODDS` chance each minute, 90% shared by points and 10% kept: `2026-10-30-hlo-vault-pop-design.md`. That spec replaces §3 rules 2, 7 and 8 and the weekly vault in §1, §5 and §6 here; the rest stands.

Date: 2026-10-29. Status: agreed with the owner in chat ("yes write the spec and build").

This replaces how rewards are settled. It supersedes these parts of `2026-10-27-hlo-design.md`:
- §3 (mining rules) and its calculator details;
- §4 (daily cycle and trust);
- the `FeeFeed` and `Mining` rows of §5;
- the Rewards screen in §6;
- the mining parts of §7 and §8.

Everything else stays: trading, deposits and withdrawals, the builder fee, HloToken, Splitter, Buyback, Staking, Profiles, the forwarder and the 90/10 refining split.

Wording rule: there is no rewards pot any more. The 0.1 HLO per minute goes to the **weekly vault**. Never say jackpot, lottery or prize.

## 1. Decisions

| Topic | Decision |
|---|---|
| Round | Every minute is a round. Everyone who traded in it earns, by builder fee paid. Nobody loses, and nothing is random |
| Emission | 1 HLO per minute to that minute's traders + 0.1 HLO per minute into the weekly vault (1.1 HLO/min, unchanged) |
| Empty minute | Its 1 HLO goes into the weekly vault |
| Weekly vault | Every 7 days from launch it opens: everything in it is shared by that week's points. A week with no points carries the vault into the next week |
| Points | 1 point per $100 of volume. Only fills that paid our 0.1% builder fee count, so points = 10 × builder fee in USD |
| Settlement | Anyone can settle at any moment. The poster signs a checkpoint every minute, and anyone submits it on-chain. The project's keeper submits one if nobody has for an hour |
| Claim | Instant: a settled checkpoint is final in the same block. "Settle & claim" is one transaction |
| Trust | One poster key signs checkpoints. The contract caps the total paid HLO at the cumulative emission schedule (1.1 HLO/min since launch) plus refining, not per checkpoint (§8). The verifier recomputes every checkpoint and pauses on a mismatch. Everything the poster uses is public, and it publishes every checkpoint's full balance list |
| Data | Hyperliquid's API (`userFillsByTime`) for registered wallets, live. Hyperliquid's daily builder file is checked against it once a day on mainnet |
| Registration | Enable trading also registers the wallet (a server checks the user approved our builder fee). Only fills after registration count |
| Refining | Unchanged split (90% to the claimer, 10% to holders of unclaimed HLO), now shared at every checkpoint instead of every day |
| Fully trustless (trading through a contract) | Considered and declined: HyperEVM cannot read Hyperliquid fills or fees, so it would need every order to go through a HyperEVM contract (gas, a delay of a few seconds, funds in contracts). Revisit if Hyperliquid adds a fee or fill precompile |

## 2. Architecture

```
trader ─orders─▶ Hyperliquid ─0.1%─▶ builder (HyperCore) ─forwarder─▶ Splitter ─▶ Buyback ─▶ burn / Staking   (unchanged)
   │ Enable trading                │ userFillsByTime (live)
   ▼                               ▼
/api/register ─▶ Blob registry ─▶ poster ─ signs checkpoint every minute ─▶ Blob (checkpoint + balances + vault)
                                                                             │
                     anyone (Settle & claim) / keeper (hourly) ─▶ Checkpoints.settle ─▶ Mining.claim ─▶ HLO
                                                                             │
                                           verifier: recompute, pause on mismatch, daily file check
```

- **No randomness.** The commit, reveal and seed steps go away.
- **No cancel window.** The guardian can pause settling and claiming, and can replace the poster key. *Changed by Plan 7 (`2026-10-30-hlo-recovery-design.md`): while paused, the guardian can also cancel settled checkpoints after the last good one, so a bad settled root can be undone.*

## 3. Mining rules (the calculator is the reference)

Units:
- HLO has 18 decimals.
- Fees are counted in units of 1e-8 USDC (`parseFeeUnits`).
- "Now" is the latest HyperEVM block's timestamp.

1. **Minute.** `m = floor((t − launchTime) / 60)`, where `launchTime = Checkpoints.launchTime()`. Minute `m` ends at `launchTime + 60(m+1)`.
2. **Week.** `w = floor(m / P)`, where `P = Checkpoints.VAULT_PERIOD() / 60` minutes. That is 10,080 on mainnet; testnet may use a shorter period.
3. **Registered wallet.** A wallet counts from `registeredAt`, the unix second its registration record was created (§5). A fill counts only if:
   - `t ≥ max(launchTime, registeredAt)`;
   - `coin` is a core perp (contains none of `@`, `:` or `/`);
   - `builderFee > 0`;
   - `|builderFee − px·sz/1000| ≤ 0.000002` USDC, computed exactly in decimal. This is our 0.1% rate; fills don't say which builder was paid.

   The fill's `user` is the registered wallet. Agents trade as their user, so no role mapping is needed.
4. **Fees.** `f(u, m)` is the sum of counted builder fees of `u` in minute `m`. `F(m) = Σ_u f(u, m)`.
5. **Trader emission.** If `F(m) > 0`, `u` earns `floor(1e18 × f(u,m) / F(m))`, and rounding dust goes to the vault. If `F(m) = 0`, the 1 HLO goes to the vault.
6. **Vault.** It gains 0.1 HLO every minute, plus empty minutes and dust.
7. **Points.** `p(u, w) = Σ f(u, m)` over the minutes of week `w`, in fee units. Shown as `10 × p / 1e8`, which is volume ÷ $100.
8. **Vault opening.** Week `w` closes at the first checkpoint whose `throughMinute ≥ P(w+1) − 1`:
   - the vault `V_w` (the carry plus everything week `w` added) is shared: `u` gets `floor(V_w × p(u,w) / Σ p)`;
   - dust carries to week `w+1`, and so does the whole vault if `Σ p = 0`.
9. **Supply room.** For the minutes of checkpoint `k`, `room = 5,000,000 − 10,000 + burned(refBlock_k) − emitted so far`, in HLO. `burned(b)` is the HLO burned up to block `b`, which equals `HloToken.totalBurned()` at `b`. Ops derive it from the token's `Transfer(from, address(0), value)` logs (a running total from the deploy block), never from a state read at a past block, so no archive node is needed. A mint is `Transfer(address(0), …)` and does not count. Within a minute the trader part is `min(1, room)` and the vault part `min(0.1, room left)`. A vault opening never exceeds what was added to the vault.
10. **Refining.**
    - `R_k` is the sum of `Mining.Claimed.refined` in blocks `(refBlock_{k−1}, refBlock_k]`.
    - At checkpoint `k`, each user's base is `E_pre(u) − claimed(u, refBlock_k)`, never below 0. `E_pre` is the entitlement through `throughMinute_k` before this refining.
    - `u` gets `floor(pool × base / Σ base)`, where the pool is `R_k` plus the carry. Dust, or the whole pool if `Σ base = 0`, carries to the next checkpoint.
11. **Entitlement.** `E_k(u)` is everything `u` earned from launch through checkpoint `k`: minutes, vault openings and refining. It never decreases.
12. **Tree.** The leaf is `keccak256(bytes.concat(keccak256(abi.encode(user, E))))` (OpenZeppelin StandardMerkleTree, `["address","uint256"]`), plus the sentinel leaf `(0x0, 0)`.

### Checkpoints

- The poster makes exactly one checkpoint per minute, in order: `k` covers `throughMinute = M_k`. A checkpoint is made only when:
  - "now" ≥ the end of minute `M_k` + 10 s;
  - every registered wallet's fills have been fetched through the end of `M_k`.
- The wallets in checkpoint `k` are exactly the registry records with `registeredAt ≤` the end of `M_k`. The poster lists the registry only after that time + 10 s. Records are written before the app lets a wallet trade and are never changed, so the poster and the verifier always see the same set.
- `refBlock_k` is a HyperEVM block chosen by the poster at that time: `refBlock_k ≥ refBlock_{k−1}`, and its timestamp ≥ the end of `M_k`. It fixes the burns and claims the checkpoint used.
- Every checkpoint is published, settled or not. Rules 9 and 10 depend on every `refBlock`, so a checker replays all of them from launch.
- A published checkpoint is never revised. A fill fetched too late (for a minute already checkpointed) is not credited; the daily check alerts it.

## 4. Contracts

| Contract | Change |
|---|---|
| `Checkpoints` (new, replaces `FeeFeed`) | Holds `launchTime` (deploy time), `VAULT_PERIOD` (immutable; the deploy script requires 7 days on chain 999), the poster, the guardian, `paused`, and every settled checkpoint by `throughMinute` |
| `Mining` | Claims against any settled checkpoint, plus `settleAndClaim`. Pause stops claims |
| `HloToken`, `Splitter`, `Buyback`, `Staking`, `Profiles` | Unchanged. Buyback gets `Checkpoints.launchTime() + 1 hour` in the deploy script, as it did with FeeFeed |

**`Checkpoints.settle(Checkpoint cp, bytes sig)`.** Anyone can call it. `Checkpoint` is `{uint256 throughMinute, uint256 refBlock, bytes32 root, uint256 totalEntitled}`, and the EIP-712 domain is `"HLO Checkpoints"`, version `"1"`. It reverts unless:
- not paused;
- the signer is `poster`;
- `cp.throughMinute > latestMinute` (any value for the first one);
- `launchTime + 60(cp.throughMinute + 1) ≤ block.timestamp`;
- `cp.refBlock < block.number` and `cp.refBlock ≥ latest.refBlock`;
- `cp.root ≠ 0`;
- `cp.totalEntitled ≥ latest.totalEntitled`;
- `cp.totalEntitled ≤ emissionAllowedThrough(cp.throughMinute) + mining.totalRefined()`, where `emissionAllowedThrough(M) = min((M+1) × 1.1e18, 5M − 10k + token.totalBurned())`.

It then stores the checkpoint with `settledAt`, sets `latestMinute`, and emits `Settled(throughMinute, refBlock, root, totalEntitled)`.

**Views:**
- `rootOf(M)`;
- `totalEntitledOf(M)`;
- `latestMinute()`;
- `getCheckpoint(M)`.

**Guardian:** `setPaused`, `setPoster`, `setGuardian` (non-zero addresses). *Plan 7 adds the pauser (`pause()` only), `setPauser`, and the guardian's `cancelAfter`, `cancelAll` and `writeOff` while paused (`2026-10-30-hlo-recovery-design.md` §3).*

**Mining:**
- `claim(M, E, proof)` and `claimFor(user, M, E, proof, deadline, v, r, s)` work as today, with the day replaced by a settled `M`.
- `settleAndClaim(Checkpoint cp, bytes sig, E, proof)`:
  - if `cp.throughMinute > latestMinute`, it settles `cp` first;
  - otherwise `cp` must equal the stored checkpoint at `cp.throughMinute`;
  - then it claims for `msg.sender` against it.
- Every claim reverts while paused.
- `maxEntitledBound`, the 90/10 split and `totalRefined` are unchanged. `Claimed` has `throughMinute` in place of the day and reports the new `claimed[user]` (see the claim-rate limit below).

**Claim-rate limit.** Mining pays every claim's gross (paid + refined) out of one global allowance: `available = min(CLAIM_CAP, bucket + (now − updatedAt) · CLAIM_PER_HOUR / 1 hour)`, with `CLAIM_CAP = 5,000 HLO` and `CLAIM_PER_HOUR = 330 HLO`, starting full. A claim takes `gross = min(entitlement − claimed[user], available)`; `available == 0` reverts `ClaimLimitReached`. `claimed[user]` grows by `gross`, so the rest stays claimable. `Claimed(user, throughMinute, claimedTotal, paid, refined)` reports the new `claimed[user]`. `claimAvailable()` is a view. Honest claims average about 1.1× emission per hour, so in steady state the bucket is nearly always full. The exception is the pool opening (launch + 7 days + 1 hour): the week-1 holders who waited to claim (about 11,000 HLO gross) will see the first 5,000 HLO go at once and the rest over about 18 to 19 hours, first come first served; claiming during week 1 avoids the queue. Any backlog (a large holder, a rush of claims) spreads over hours the same way, each claim taking what is there. A leaked poster key can take at most about 5,000 HLO at once plus 330 HLO per hour until the pause. *Plan 7 replaced "a settled root cannot be revoked; recovery is a new deploy": the guardian cancels the bad checkpoints while paused, records a write-off, rotates the poster and unpauses (`2026-10-30-hlo-recovery-design.md`, `docs/OPS.md` "Recovery").*

**Invariants (tests):**
- supply never above 5M;
- the total ever claimed (gross) never above the largest settled `totalEntitled`;
- a claim pays exactly 90%;
- checkpoints only move forward;
- only the poster's signature settles;
- paused means no settle and no claim;
- a replayed or stale checkpoint never settles.

## 5. Off-chain

**Registration (`app/api/register.ts`, a Vercel function):**
- It takes `POST {user}` and reads Hyperliquid's `maxBuilderFee(user, builder)`.
- If that is at least 100, it writes the Blob `registry/<lowercase user>.json` `{user, registeredAt}`, only if the record does not exist yet. It never overwrites, so `registeredAt` is stable.
- The app calls it after Enable trading succeeds, and on each app open for a wallet whose trading is enabled. It also accepts paired phones: the main wallet is the one registered.

**Poster (`ops`, POSTER_KEY: it only signs, never sends a transaction):**
- It lists the registry, and fetches each wallet's fills with `userFillsByTime` from its saved cursor, keeping the cursor per wallet in its state dir.
- Each minute it builds checkpoint `k` with `calc/`, signs it, and publishes it under the rewards base `<chainId>/`:
  - `checkpoints/<M>.json` (every checkpoint, kept): the checkpoint, its signature, `refBlock`, `publishedAt` and the minute's fee table (`minute,user,fee`), so anyone can replay every checkpoint;
  - `latest.json` (overwritten each minute): the newest checkpoint plus the Merkle tree dump, every user's entitlement and breakdown, this week's points, the vault and the last openings.
  Two Blob writes per minute (about 86,000 a month): check the Vercel plan's Blob operation allowance before mainnet.
- Old files stay: proofs for settled checkpoints need them.
- **Scale limit (v1):** Hyperliquid's info limit is about 1200 weight per minute per IP and `userFillsByTime` weighs at least 20, so one IP sustains roughly 50 wallet fetches a minute. Checkpoint `M` needs every registered wallet fetched through the end of minute `M`. A wallet already fetched past that point is skipped, a wallet that is fetched is read through the newest finished minute (one request covers every minute since its cursor), and a rate-limited request (HTTP 429) is retried after 2, 4 and 8 s before the pass stops. A pass cut short keeps the cursors it saved and the next pass continues with the wallets still behind, so with `N` wallets the poster never stalls: it publishes in bursts and trails real time by roughly `N/50` to `2N/50` minutes, once `N` is above about 50. Below that it keeps up minute by minute. A later version skips idle wallets by checking the builder's total fee counter first. Not in v1.

**Keeper:**
- Unchanged buybacks.
- New: if `latestMinute` on chain is more than 60 minutes behind the newest published checkpoint, it submits the newest with `Checkpoints.settle`.

**Verifier:**
- It replays every published checkpoint from launch with `calc/`, using the same registry and the Hyperliquid API.
- It replays from the published fee tables, and checks each table's rows against the API for the wallets in it.
- A mismatch is any of: a different root, a different total, a `refBlock` out of order, or a settled checkpoint that was never published.
- On a mismatch it alerts and calls `pause()` with the pauser key (`PAUSER_KEY`, every chain; Plan 7). It never holds the guardian's key (on mainnet a Safe).
- Once a day on mainnet (chain 999) it compares each user's counted fees for the UTC day with Hyperliquid's builder file, and alerts any difference.

**Forwarder:** unchanged.

**Removed:** `testnet-fills`, the day tables, `dataHash`, commit, reveal and the reveal bot.

## 6. App, Rewards screen

**Yours:**
- earned so far (`E` in the newest published checkpoint);
- claimed (chain);
- claimable now (`E − claimed`; you receive 90%);
- refining earned;
- "settled through HH:MM UTC";
- **Settle & claim**: one transaction. It uses `settleAndClaim` with the newest published checkpoint, or `claim` if the chain is already past it. Every proof is verified locally against the checkpoint's root before sending.

**Weekly vault:**
- HLO in the vault now;
- your points this week, and what they are worth if the week ended now;
- "opens in Xd Yh";
- after an opening: "the vault opened: you got X HLO", included in your claimable.

**Staking, Protocol:** unchanged.

**Removed:** the pot card, pops, days, the "today" estimate and the check-window text.

"Now" stays the HyperEVM block time. A file whose root does not match the chain is ignored, as today.

## 7. Testing and launch

- **Contracts:** unit, fuzz and invariant tests (§4).
- **Calculator:** hand-checked minute, vault-opening and refining cases; a property check that, with traders in every minute, minute payouts plus vault openings plus the vault left equal `1.1 × minutes` exactly.
- **Ops:** unit tests, plus the anvil e2e rewritten for checkpoints (register, fills from a fake Hyperliquid, poster, settle by a user and by the keeper, verifier pause).
- **App:** unit tests, then on testnet: enable trading (registers), trade, Settle & claim within a minute, the vault opening (testnet `VAULT_PERIOD` 1 hour), stake.
- **Testnet:** a fresh contract set (Uniswap V2 copy, Buyback's 10-minute open delay as in `fast-testnet.sh`, `VAULT_PERIOD` 1 hour). Mainnet only after the testnet run passes and the owner says so.

## 8. Known limits

- The contracts trust one poster key. The contract caps total paid HLO at the cumulative emission schedule plus refining, so a bad checkpoint can assign all unclaimed HLO to one wallet; the claim-rate limit (§4) bounds how fast it can leave: at most `CLAIM_CAP` (5,000 HLO) at once plus `CLAIM_PER_HOUR` (330 HLO) per hour until the pause. **Since Plan 7** the verifier pauses within minutes on every chain (the pauser role), and the guardian (a Safe on mainnet) cancels the bad checkpoints, writes off what was claimed against them, rotates the poster and unpauses; no redeploy. What is lost, and what a stolen Safe could do, is in `2026-10-30-hlo-recovery-design.md` §8. Mitigations: a separate poster key, the verifier, the pauser, the rate limit, public data.
- The guardian can make itself poster.
- Fills don't say which builder was paid. A fill that paid another builder exactly 0.1% would count. The daily builder-file check finds it, and it is fixed by hand.
- Only registered wallets earn, from their registration time.
- A fill Hyperliquid's API returns late, or a poster outage longer than the API's history, can miss a minute that is already checkpointed. Checkpoints are never revised; the daily check alerts it.
- v1 scale: about 50 registered wallets per poster IP keep up minute by minute; beyond that checkpoints trail real time by roughly `N/50` minutes (§5).
- A `transfer` of HLO to the zero address emits the same `Transfer(from, address(0), value)` log as `burn`, but lowers neither the supply nor `totalBurned`. Ops count it as burned, so someone can lose their own HLO to raise the replayed supply room above the contract's. This matters only when the supply nears the 5M cap (the 1.1 HLO per minute schedule binds first, for years), and the poster and the verifier agree on it. Revisit before emission passes about 4.5M HLO (a token that rejects transfers to the zero address, or reading `totalBurned` where a node can serve it).

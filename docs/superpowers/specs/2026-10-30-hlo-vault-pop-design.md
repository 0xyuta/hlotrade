# HLO — the vault pops (replaces the weekly vault)

Agreed with the owner on 2026-10-30. This replaces rules 2, 7 and 8 of the minute-settlement spec (`2026-10-29-hlo-minute-settlement-design.md` §3) and the weekly vault in its §1, §5 and §6. Everything else there stands: one signed checkpoint per minute, anyone settles, instant claims, refining, the claim-rate limit, Plan 7 recovery.

Wording rule: it is **the vault**, and it **pops**. Never say jackpot, lottery, prize, motherlode or win. Recipients "get" a share.

## 1. The rules in one table

| | |
|---|---|
| Vault | Gains 0.1 HLO every minute, plus the 1 HLO of any minute nobody traded, plus rounding dust (unchanged). Changed 2026-11-04 (spec `2026-11-04-hlo-quiet-minutes-design.md`): from `quietMinuteFrom(chainId)` on, a minute nobody trades mines nothing, so the vault gains only the 0.1 |
| Points | 1 point per $1,000 traded with our builder fee, i.e. 1 point per $1 of builder fee. Counted from the last pop |
| Pop | Every minute the vault pops with a 1 in `ODDS` chance. `ODDS` = 1,250 on mainnet (about once every 21 hours) |
| Minimum | Added 2026-11-01 at the owner's request: a wallet needs at least 1 point since the last pop to share in a pop, so one tiny trade in a quiet stretch cannot take the vault (`popMinimum(chainId)`: 999 from launch, 998 from minute 2600, off on anvil) |
| On a pop | 90% of the vault is shared by points among the wallets at the minimum. 10% (plus dust) stays and starts the next round. Everyone's points go back to 0, those under the minimum too |
| Nobody at the minimum | The pop pays nothing; the whole vault stays |
| Where it goes | Into the recipient's entitlement, like mined HLO ("unrefined"): the usual claim (90% paid, 10% refining) applies |
| Randomness | The hash of a HyperEVM block fixed by the minute's end time. The poster cannot choose which block it is (as long as block timestamps never decrease); the hash is set by the block's contents, so block producers could influence it; anyone can recheck it |

No contract changes. `Checkpoints.VAULT_PERIOD` stays on chain (the deploy script still requires it) but nothing reads it any more.

## 2. Rules (replacing §3 rules 2, 7 and 8)

1. **Odds.** `ODDS` depends on the chain only: 999 → 1250, 998 → 60 (about hourly, so testnet sees pops), 31337 → 1 (every minute pops: the e2e is deterministic). It is a constant in `calc/` (`popOdds(chainId)`), so the poster, the verifier and the app always agree.
2. **Seed block.** For minute `m`, `B(m)` is the lowest HyperEVM block number whose timestamp is ≥ the end of `m` (`launchTime + 60(m+1)`). Block timestamps never decrease, so `B(m)` is found by binary search; `B(m) ≤ refBlock_k` for every minute of checkpoint `k` (the spec already requires `timestamp(refBlock_k) ≥` the end of `M_k`).
3. **Pop test.** Minute `m` pops if `uint256(keccak256(abi.encodePacked(bytes32 hash(B(m)), uint256 m))) % ODDS == 0`. `m` is in the hash so that two minutes with the same seed block (a stalled chain) still draw separately.
4. **Points.** `p(u)` is `Σ f(u, m)` over the minutes after the last pop through now, in fee units (1e-8 USDC). Shown as `p / 1e8` with two decimals: 1 point = $1 of builder fee = $1,000 traded.
5. **Order inside a minute.** Trader emission, then the vault part and dust go into the vault, then that minute's fees add to the points, then the pop test. So a pop pays the minute's own traders too, and includes the minute's own 0.1.
6. **Pop payout.** `V` is the vault after step 5. `pay = floor(V × 9 / 10)`. `Σ p` and the shares count only the wallets with `p(u)` at or above the minimum. If `Σ p > 0`, each such `u` gets `floor(pay × p(u) / Σ p)` added to its entitlement (and to its `fromVault` total); the vault keeps `V − Σ shares` (the 10% plus dust). If `Σ p = 0` nothing is paid. Either way all points reset to 0.
7. **Supply room** (§3 rule 9) is unchanged. A pop never pays more than the vault holds.

## 3. Ops

- **`ops/src/seed.ts`** (new): `seedBlocks(client, launchTime, fromMinute, throughMinute, lo, hi)` returns `{minute, block, hash}` for every minute in the range, by binary search on block timestamps between `lo` (the previous checkpoint's last seed block, or the deploy block) and `hi` (this checkpoint's `refBlock`). It reads blocks by number, never `latest`. The poster and the verifier each call it with their own client.
- **Poster.** Before building checkpoint `k` it fetches the seeds of `nextMinute..M_k` and passes them to `applyCheckpoint`. It keeps the last 10 pops in its state (as it kept openings).
- **Verifier.** Fetches the seeds itself and replays. A wrong pop changes the root, so it is caught by the existing root check: mismatch, pause.
- **Files.**
  - `checkpoints/<M>.json` is unchanged.
  - `latest.json`: `vault` becomes `{amount, pointsTotal, odds, lastPopMinute}` (`lastPopMinute` is -1 before the first pop); `openings` becomes `pops`: newest first, at most 10, each `{minute, block, amount, kept, recipients}` (`kept` is what stayed in the vault). `users[u].points` keeps its name and now means points since the last pop.
- **State.** `CalcState` drops `periodMinutes` and `week` and gains `odds`; its serialized version becomes 2. `checkpointConstants` stops reading `VAULT_PERIOD`. A saved state of version 1 is refused with a clear message (a redeploy starts clean anyway).

## 4. App

The Weekly vault card becomes **Vault**:

- "0.1 HLO goes in every minute, plus any minute nobody traded. Every minute it has a 1 in 1,250 chance to pop (about once every 21 hours). When it pops, 90% is shared by points and 10% stays for the next round. 1 point per $1,000 traded."
  (The two numbers come from `latest.vault.odds`: 1 in N, and N minutes in hours.)
- In the vault; your points since the last pop; your share if it popped now (`floor(floor(V × 9/10) × p / Σp)`); the last pop: "Popped 3 h ago: 120.5 HLO to 14 traders".
- "Opens in" and the week are gone.

The app checks `latest.json` as before. The `odds` it shows must equal `popOdds(chainId)` for its network; a file that disagrees is refused like any other bad file.

## 5. Testing

- **Calc:** hand-checked pops (one recipient, several, nobody with points, a pop in a checkpoint of several minutes, two seeds equal), the 90/10 split and dust, points reset; the property check becomes: minute payouts + pop payouts + the vault left = 1.1 × minutes exactly.
- **Ops:** `seed.ts` against a fake chain (gaps, equal timestamps, a stalled chain); poster and verifier tests with pops; the e2e (odds 1 on anvil) checks a pop pays the minute's traders 90% and keeps 10%.
- **App:** unit tests for the card text and the share; a file with the wrong odds is refused.

## 6. Rollout

- **Testnet:** the rule change makes every old checkpoint unreplayable, so testnet gets a fresh contract set (as for Plan 5) and fresh ops state dirs; `testnet.json` and the four ops envs point at it. Old testnet HLO stays on the old contracts and is not shown by the app. Then check a pop on testnet (about one an hour).
- **Mainnet:** not deployed yet; it launches with these rules.
- Docs: `CLAUDE.md` (the wording rule and the tables), `docs/OPS.md` (published files), `docs/APP.md` (the card), and a note at the top of the minute-settlement spec pointing here.

## 7. Risks

- **Random payouts.** A chance-based payout funded by fees users paid may be treated as a lottery in some places. The owner chose this knowingly on 2026-10-30; the copy avoids gambling words.
- **Block hash.** A block's hash is fixed by its contents, so HyperEVM's block producers (and, impractically, whoever lands transactions in that block) could influence it. The poster cannot choose the seed block as long as block timestamps never decrease (240 mainnet blocks sampled: none did). Acceptable for this size.
- **RPC cost.** About 8 block reads per minute (one at the `refBlock`, about 6 or 7 for the binary search), per process.

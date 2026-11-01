# HLO — recovery from a bad checkpoint (Plan 7)

Date: 2026-10-30. Status: agreed with the owner in chat ("cancel checkpoints, write the spec").

This changes the trust and recovery parts of `2026-10-29-hlo-minute-settlement-design.md` (§2 "No cancel window", the guardian rows of §4, §8 "Known limits") and `docs/OPS.md` §5 and §6. Everything else stays: the minute rules, the calculator, the claim-rate limit, the weekly vault, refining.

Wording rule: the 0.1 HLO per minute goes to the **weekly vault**. Never say jackpot, lottery or prize.

## 1. Why

Today one leaked poster key can settle a bad checkpoint. The claim limit bounds what leaves (5,000 HLO at once, then 330 HLO per hour), but a settled root can never be revoked: the only recovery is a new deploy of every contract and a new token, because HloToken's minter is fixed. And on mainnet only a human with the guardian (a multisig) can pause, so the leak runs until someone wakes up.

## 2. Decisions

| Topic | Decision |
|---|---|
| Pause | A new **pauser** role can only pause. The verifier holds the pauser key on every chain, mainnet included, and pauses within minutes of a mismatch. A leaked pauser key can stop settling and claiming, nothing else |
| Guardian | A **Safe multisig** on HyperEVM mainnet, 2 of 3 owners (the owner's browser wallet, phone wallet, a spare or hardware wallet). It unpauses, sets the poster, the pauser and the guardian, cancels checkpoints and records a write-off. Testnet keeps an ordinary key as guardian |
| Recovery | **Cancel checkpoints.** While paused, the guardian cancels every settled checkpoint after the last good one. A cancelled checkpoint cannot be claimed against and cannot be settled again. The poster (with a new key) continues from its honest state; the next checkpoint carries everyone's honest entitlement. Same contracts, same token, same pool, no migration |
| What is lost | Only what was claimed against bad checkpoints before the pause, at most `CLAIM_CAP` + `CLAIM_PER_HOUR` per hour. It stays with whoever claimed it. Honest holders lose nothing: their entitlements continue, and the stolen HLO is extra supply, not taken from anyone's balance |
| Write-off | The guardian records the stolen gross amount as a **write-off**. Mining's overall bound (`totalClaimedGross ≤ maxEntitledBound`) allows that much more, so the stolen amount does not block the last honest claimers |
| Rejected | A 48-hour switch to a new Mining contract (slower, a migration, and a guardian that can install any minter); revoking single minutes (the guardian would have to name every bad minute; a missed one stays claimable) |

## 3. Contracts

`contracts/src` changes in `Checkpoints` and one line of `Mining`. HloToken, Buyback, Staking, Splitter and Profiles are unchanged.

### Checkpoints

New state: `address pauser`, `uint256 latestValidMinute`, `bool anyValid`, `uint256 writtenOff`, and a list of cancelled ranges `Range { uint64 from; uint64 to; }` (inclusive minutes).

- **Constructor** `(token, poster, guardian, pauser, vaultPeriod)`. `pauser` may be zero (no pauser). It emits `PosterSet(poster)`, `GuardianSet(guardian)` and `PauserSet(pauser)`, so the full key history is in the event log from the deploy block.
- **`pause()`**: callable by the pauser or the guardian. Sets `paused = true` only (idempotent, emits `PausedSet(true)`).
- **`setPaused(bool)`**, **`setPoster`**, **`setGuardian`**: guardian only (unchanged).
- **`setPauser(address)`**: guardian only; zero removes the pauser. Emits `PauserSet`.
- **`cancelAfter(uint256 keep)`**: guardian only, only while paused. `keep` must be a settled, not cancelled minute with `keep ≤ latestValidMinute` and `keep < latestMinute`. Cancels every minute in `(keep, latestMinute]`, sets `latestValidMinute = keep`. Emits `Cancelled(keep + 1, latestMinute)`.
- **`cancelAll()`**: guardian only, only while paused, needs `anyValid` (so a repeat while nothing is live reverts and the range list stays short). Cancels `[0, latestMinute]`, sets `anyValid = false`. Emits `Cancelled(0, latestMinute)`. (For a bad first checkpoint.)
- **`writeOff(uint256 amount)`**: guardian only, only while paused, `amount > 0`. Adds to `writtenOff`. Emits `WrittenOff(amount, writtenOff)`.
- **`settle`**:
  - `NotNewer` still compares with `latestMinute` (the highest minute ever settled), so a cancelled minute can never be settled again.
  - The `refBlock` order and `EntitlementDecreased` checks compare with `latestValidMinute` and apply only while `anyValid`.
  - A successful settle sets `latestMinute`, `latestValidMinute`, `anySettled` and `anyValid`.
- **Views.** `rootOf`, `totalEntitledOf`, `isSettled` and `getCheckpoint` return zero (false) for a cancelled minute. New views: `latestValidMinute()`, `anyValid()`, `pauser()`, `writtenOff()`, `cancelledCount()` and `cancelledAt(i)`, and `isCancelled(m)`.

A cancelled range list stays short (one entry per incident), so the views loop over it.

### Mining

One change in `_claim`: the bound becomes `newTotal > maxEntitledBound + checkpoints.writtenOff()`. Everything else is unchanged: a claim against a cancelled minute already reverts `NotSettled` (its root reads as zero), and `settleAndClaim` already handles `NotNewer`.

### Deploy

`Deploy.s.sol` takes `PAUSER` (an address, may be the zero address only off mainnet). On chain 999 `GUARDIAN` must be a contract (the Safe: `code.length > 0`) and `PAUSER` must be set and differ from `GUARDIAN` and `POSTER`. The deployments file gains `"pauser"` and `"guardian"`.

## 4. Off-chain

### Verifier

- **`PAUSER_KEY`** replaces `GUARDIAN_KEY`, on every chain including 999. On a mismatch the verifier calls `pause()` and alerts. If its env holds `GUARDIAN_KEY` it refuses to start ("the verifier holds the pauser key, never the guardian's").
- **Signatures.** A published checkpoint must be signed by the current poster or a former one (every `PosterSet` from the deploy block). The content is replayed and compared as before, so an old key signing correct content is harmless; `settle` still accepts only the current poster.
- **Cancelled minutes.** The `Settled` cross-check and the "withheld" check skip cancelled minutes. A stored mismatch at a minute that is now cancelled is still cleared by a human (runbook), never by the verifier itself.
- **New information alerts** for `PosterSet`, `GuardianSet`, `PauserSet`, `Cancelled`, `WrittenOff` and `PausedSet`, so every guardian action is announced.

### Recovery report (new, read-only)

`npm run recovery -w ops` reads the chain and the verifier's verified state and prints:
- the last good settled minute (`keep`): the newest settled minute whose root equals the verifier's verified root;
- the range to cancel;
- every wallet whose `Mining.claimed` is above its honest entitlement at the latest verified minute, and the sum: the **write-off**;
- the Safe transactions in order, as target, function and calldata: `cancelAfter(keep)` (or `cancelAll()`), `writeOff(sum)` when the sum is above zero, `setPoster(new)`, and last `setPaused(false)`.

It sends nothing.

### Poster, keeper, calculator

- **Poster:** no change. After `setPoster`, it restarts with the new `POSTER_KEY` and the same state dir, and continues from its honest state. Files it published with the old key stay published, and they cannot be settled.
- **Keeper:** no change. It settles the newest published checkpoint, which is newer than `latestMinute`.
- **Calculator:** no change. It already shares refining only over wallets whose entitlement is above their claimed amount, so a wallet that took more than its share gets no refining.

## 5. App

- `rewards/chain.ts` reads `latestValidMinute` and `anyValid`. `latestRoot` stays `rootOf(latestMinute)`, which reads zero when that minute is cancelled.
- "Settled through" uses the latest valid minute.
- A claim against the settled checkpoint applies when the file's minute equals `latestMinute` and its root matches; "Settle & claim" applies when the file is newer than `latestMinute`. The app holds only the newest file's proofs, and a file at or below a cancelled `latestMinute` can never be settled, so after a cancel users claim with Settle & claim once the poster's next file is out.
- While paused, the Rewards screen keeps its current text. There is no new screen.

## 6. Runbook (docs/OPS.md §6, replacing "never unpause")

1. **Pause.** The verifier pauses by itself. A human can also pause with the pauser key (`pause()`) or from the Safe.
2. **Stop the poster.** Find out what happened. If the poster key leaked, make a new one.
3. **Run the recovery report.**
4. **In the Safe**, as one batch:
   - `cancelAfter(keep)`;
   - `writeOff(sum)`, when the sum is above zero;
   - `setPoster(new)` when the key changed.
5. **Restart.**
   - Start the poster with the new key.
   - Stop the verifier, clear its stored mismatch (`"mismatch": null`) and start it.
   - Wait until it verifies through the present.
6. **In the Safe:** `setPaused(false)`.
7. **Tell users** what was lost and that their HLO is intact.

**Safe setup** gets its own section, written for a first-time Safe user:
- create the Safe on HyperEVM (Safe{Wallet}, or Den if Safe's app does not list HyperEVM);
- add three owners, threshold 2;
- fund it with a little HYPE;
- make one rehearsal pause and unpause on mainnet before launch;
- know how to submit raw calldata from the recovery report.

## 7. Testing

- **Foundry:**
  - pause roles;
  - `cancelAfter`, `cancelAll`, `writeOff` and every revert;
  - settle after a cancel: a cancelled minute can't be settled again, and the totals and `refBlock` are checked against the last valid minute;
  - views on cancelled minutes;
  - Mining: a claim against a cancelled minute reverts, and the write-off raises the bound;
  - invariants: no claim against a cancelled root, and paid ≤ schedule + write-off.
- **ops:**
  - the verifier's pauser key and its refusal of `GUARDIAN_KEY`;
  - signatures by former posters;
  - cancelled minutes;
  - the new alerts;
  - the recovery report against a fixture.
- **app:** latest valid minute, settled text, claim plan after a cancel.
- **e2e (anvil):** after the tampered-checkpoint step, run the recovery:
  - the report;
  - cancel, write-off, new poster, unpause;
  - the poster continues with the new key and a claim succeeds.

  This becomes the last step.
- **Testnet rehearsal:** redeploy with the normal limits (5,000 HLO, 330 HLO/hour) and the new roles. Then:
  1. Sign and settle a bad checkpoint with the poster key, simulating a leak.
  2. Watch the verifier pause.
  3. Follow the runbook.
  4. Confirm honest claims work and the bad wallet gets nothing more.

  This uses the guardian key, because testnet has no Safe.

## 8. Known limits (replacing the poster-key paragraph of the minute-settlement spec §8)

- A leaked poster key can still take up to `CLAIM_CAP` plus `CLAIM_PER_HOUR` per hour until the pause, which is now minutes on mainnet too. That HLO is lost to the protocol as extra supply, and the HloToken cap still holds.
- **What a stolen Safe could do.** With 2 of the 3 owner keys it could:
  - set its own poster and settle bad checkpoints (the claim limit still applies);
  - cancel honest checkpoints (no HLO moves; users claim against the next one);
  - write off any amount (this only loosens a bound that matters with a lying poster).
- A leaked pauser key can keep the contracts paused until the Safe replaces it. A false alarm from the verifier pauses mainnet until the Safe unpauses.
- After an incident, `maxEntitledBound` may stay raised by the bad checkpoint's total. The bound then protects less, but the poster is honest again and the claim limit still applies.

## 9. Out of scope

Moving the app off Vercel to Cloudflare (Workers, R2 binding, `hlotrade.xyz`) is Plan 8.

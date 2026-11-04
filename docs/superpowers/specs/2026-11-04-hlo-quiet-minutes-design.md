# HLO: minutes nobody trades

2026-11-04, at the owner's request. Changes rule 1 of the minute settlement (spec 2026-10-29 §3) and the vault's inflow (spec 2026-10-30 §1).

## The rule

From minute `quietMinuteFrom(chainId)` on, a minute with no counted fee mines no trader HLO: its 1 HLO is never made (it stays inside the 5,000,000 cap, unminted). The vault still gains its 0.1 HLO every minute, plus rounding dust. A minute with at least one counted fee is unchanged: 1 HLO to its traders by fee, 0.1 HLO to the vault.

Before that minute the launch rule holds: a minute nobody traded sent its 1 HLO to the vault. A fresh verifier replays those minutes that way, so every published checkpoint still verifies.

| Chain | `quietMinuteFrom` |
|---|---|
| 999 | 2220 (2026-11-04 01:01 UTC). The poster and verifier were restarted with the rule before that minute was checkpointed |
| 998 | null: testnet keeps the launch rule (its ops were stopped; the app's texts describe mainnet) |
| 31337 | 0: anvil from launch, so the e2e checks it |

## Why

With few traders the vault grew 1.1 HLO a minute, about 1,584 a day, so a pop paid far more than the trading behind it. Now it grows 144 HLO a day while nobody trades, and an average pop is about 125 HLO plus what traded minutes add.

## What changed

- `calc`: `quietMinuteFrom(chainId)` in `src/pop.ts`; `CheckpointInput.quietFrom`, required, so no caller can leave it out. `CalcState` and its serialized version 2 are unchanged.
- `ops`: the poster, the verifier and the scale check pass `quietMinuteFrom(chainId)`.
- No contract change. `Checkpoints` caps emission at 1.1 HLO a minute since launch; mining less stays under it.
- App: the Tokenomics mining line ("A minute nobody trades mines nothing: its 1 HLO is never made."), the Vault card text ("0.1 HLO goes in every minute. …") and the intro's vault image and its alt text.

Changing `quietMinuteFrom` for a chain after its minute has been checkpointed makes a fresh verifier disagree with published checkpoints; a change needs a new from-minute in the future, as here.

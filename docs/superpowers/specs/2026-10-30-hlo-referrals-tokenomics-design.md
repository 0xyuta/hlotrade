# HLO — Hyperliquid referrals and the Tokenomics page

Agreed with the owner on 2026-10-30. HLO has no referral system of its own. It uses Hyperliquid's: a user can do on hlotrade.xyz what Hyperliquid's own Referrals page offers, and a new account gets HLO's code by default. A Tokenomics page explains HLO.

Wording rules stand: "the vault" that "pops"; never jackpot, lottery, prize, motherlode, win, and never name another project as the model for HLO.

## 1. Hyperliquid's referral rules (facts the app relies on)

- An account takes one referrer, set with the `setReferrer` action (`code`, 1–20 characters); the first code set is kept. The referred account gets 4% off Hyperliquid's fees on its first $25M traded; the referrer gets 10% of the referred account's fees (after the discount) on its first $1B traded, in USDC, claimed with `claimRewards`.
- A code is created with `registerReferrer` once the account has traded $10,000.
- The `referral` info request returns `referredBy` (`{referrer, code}` or null), `cumVlm`, `unclaimedRewards`, `claimedRewards`, and `referrerState`: `needToTrade` (`data.required`), `needToCreateCode`, or `ready` (`data.code`, `nReferrals`, `referralStates[]` with each referred account's volume, rewarded fees and join time).
- UNCONFIRMED (testnet check RF1): whether `setReferrer` is accepted after an account's first trade, and whether an agent may sign `setReferrer`, `registerReferrer` and `claimRewards` for its master.

## 2. Config

`referralCode` in each network config (`app/src/config/*.json`): optional; 1–20 characters `[A-Za-z0-9]`. Absent means HLO sets no default code. Mainnet: the owner's code. Testnet: a code the owner creates on testnet (his testnet wallet is past $10,000).

## 3. Default code at Enable trading

- A `?ref=<code>` in the page URL is kept in `localStorage` (`hlo.ref.<network>`, a valid code only) and wins over `referralCode`. So a user who shares `https://hlotrade.xyz/?ref=CODE` gets their referrals through HLO, exactly as with Hyperliquid's own link.
- After Enable trading succeeds, the app reads `referral`. If `referredBy` is null and a code is chosen (ref, else `referralCode`), it sends `setReferrer` signed by the new agent (by the main wallet only if RF1 shows the agent cannot). A refusal or error is ignored (logged, never blocks trading); it is not retried automatically.
- The Enable trading dialog says, when a code will be set: "Uses referral code CODE on Hyperliquid: 4% off Hyperliquid's fees on your first $25M traded."
- The text is the consent: Enable trading sends only the code its text showed for this account, and nothing when no text was shown (the trading status unknown or still loading, the `referral` read pending or failed, the "Sign once to enable trading again" re-sign). A `?ref=` stored later (another tab) does not change the code until a new read shows it.

## 4. Referrals page (new tab "Referrals")

For a connected wallet, from `referral` (chain-independent, read when the tab opens and after each action):

- **Referred by:** the code, or, when none, a code field (prefilled with the chosen default) and "Use code" (`setReferrer`). After use it shows the code; Hyperliquid keeps the first one.
- **Your code:**
  - `needToTrade`: "Trade $X more to create a code" (required − cumVlm).
  - `needToCreateCode`: a code field and "Create code" (`registerReferrer`); Hyperliquid's refusal (taken, invalid) is shown as its message.
  - `ready`: the code, the share link `https://<this site>/?ref=CODE` with Copy, referrals count, and a table of referred accounts (address shortened, volume, fees rewarded, joined).
- **Rewards:** unclaimed and claimed USDC, and "Claim" (`claimRewards`) when unclaimed > 0. Text: "Hyperliquid pays referral rewards in USDC to your trading account."
- Without a wallet: a short explanation and Connect.
- Pure rules (parsing the `referral` answer, code validation, the remaining-volume text, the ref link, choosing the default code) live in `app/src/hl/referral.ts` with tests; the screen is lazy like Rewards.

## 5. Tokenomics page (new tab "Tokenomics")

Static text, numbers from the code's constants, plus live figures where the Rewards data already has them:

- **Supply:** 5,000,000 HLO cap. The trading pool opens 7 days and 1 hour after launch, seeded with 10,000 HLO and all the USDC the buyback collected until then; its pool tokens are locked forever. HLO that is burned can be mined again (the cap counts what exists).
- **Mining, every minute:** 1 HLO to that minute's traders, shared by the builder fees they paid; a minute nobody trades sends its 1 HLO to the vault.
- **The vault:** 0.1 HLO a minute. Each minute a 1 in N chance to pop (N from the network's odds: 1,250 on mainnet, about once every 21 hours); 90% shared by points (1 point per $1,000 traded since the last pop), 10% stays.
- **Claiming:** a claim pays 90%; 10% is refined and shared with everyone who holds unclaimed HLO (earned above claimed, partial claimers included), by their unclaimed balance. Claims draw from a shared allowance (5,000 HLO, refilling 330 HLO an hour).
- **Fees:** 0.1% builder fee on every trade: 90% to the buyback, 10% to the team. Until the trading pool opens (7 days and 1 hour after launch, `Buyback.openPool`), the buyback only collects USDC, and all of it goes into the pool with the 10,000 HLO, locked forever. After that, every 10 minutes the buyback spends a 1/144 slice of its USDC on HLO; 90% of what it buys is burned and 10% goes to stakers.
- **Live:** total burned, HLO bought back, total staked, in the vault (from the existing protocol and rewards reads; dashes when not deployed).
- A simple diagram (CSS or inline SVG): fees → buyback → (until the pool opens: into the pool; after: buys HLO) → burn / stakers; minute emission → traders / vault → pop.

## 6. Testing

- Unit tests for `hl/referral.ts` and the Tokenomics numbers (they come from the same constants the rewards code uses: `POP_ODDS`, refining 10%, claim cap).
- Component tests for both screens' states (no wallet; each referrer stage; referred / not; claimable).
- Chunk check: both screens lazy.
- Testnet checklist rows in `docs/APP.md`: RF1 (setReferrer after a first trade; agent signing), RF2 (Enable trading sets the default code on a fresh account; a `?ref=` link wins), RF3 (create a code, share link, claim), TK1 (Tokenomics page reads right on both networks).

## 7. Rollout

Testnet first: The owner creates a testnet code (on the new page), it goes into `testnet.json`; mainnet `referralCode` is his mainnet code, added with the mainnet config.

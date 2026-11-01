import { REFERRAL_CODE, type Address, type Network } from "../config/validate";
import { fmtUsd } from "../ui/format";
import { allowed, PAIRED_BLOCKED_TEXT, type SessionKind } from "../wallet/permissions";
import type { KVS } from "./agent";

/**
 * Hyperliquid's referral program as HLO uses it (spec 2026-10-30 referrals §1): one referrer per account (`setReferrer`;
 * Hyperliquid keeps the first code), 4% off Hyperliquid's fees on the first $25M traded; an account's own code
 * (`registerReferrer`, after $10,000 traded) earns 10% of the referred accounts' fees in USDC (`claimRewards`).
 * Pure rules only; the calls are in referralActions.ts.
 */

export const CODE_RULE_TEXT = "Codes are 1–20 letters and digits.";
/** Hyperliquid refuses claimRewards under 1 USDC ("Must have at least 1 of a reward token to claim"; testnet 2026-10-31). */
export const MIN_REFERRAL_CLAIM = 1;
export const CLAIM_MINIMUM_TEXT = "You can claim once you have $1 or more.";
export const REFERRAL_REWARDS_TEXT = "Hyperliquid pays referral rewards in USDC to your trading account.";
export const NO_AGENT_TEXT = "Enable trading first: your trading key signs referral actions.";
export const CHECKING_KEY_TEXT = "Checking your trading key…";
/** A `ready` code HLO's `?ref=` capture would drop (Hyperliquid may allow other characters): no share link for it. */
export const NO_LINK_TEXT = "Share links work only for codes of letters and digits. Share the code itself.";
export const REFERRAL_INTRO_TEXT =
  "HLO uses Hyperliquid's referral program. A referral code gives you 4% off Hyperliquid's fees on your first $25M traded. With your own code you get 10% of the fees of the accounts you refer, paid in USDC.";
export const USE_CODE_TEXT = "A referral code gives you 4% off Hyperliquid's fees on your first $25M traded. Hyperliquid keeps the first code an account uses.";
export const REFERRED_TEXT = "Hyperliquid keeps this code for your account: 4% off Hyperliquid's fees on your first $25M traded.";

export const validCode = (s: unknown): s is string => typeof s === "string" && REFERRAL_CODE.test(s);

/** Where a `?ref=` code is kept, per network. */
export const refStorageKey = (net: Network) => `hlo.ref.${net}`;

export function loadRef(kv: KVS, net: Network): string | null {
  const v = kv.getItem(refStorageKey(net));
  return validCode(v) ? v : null;
}

/**
 * A `?ref=CODE` in the page's query (spec §3): a valid code is kept (a later valid link replaces it); anything else
 * leaves storage as it is. The URL is not changed. Returns the code kept after the call.
 */
export function captureRef(search: string, kv: KVS, net: Network): string | null {
  const ref = new URLSearchParams(search).get("ref");
  if (validCode(ref)) kv.setItem(refStorageKey(net), ref);
  return loadRef(kv, net);
}

/** The code HLO sets by default: the kept `?ref=` code, else the network config's `referralCode`; null for none. */
/** The field's first value: the chosen code, unless it is the account's own, which Hyperliquid would not take for it. */
export const codeToOffer = (chosen: string | null, own: string | null): string => (chosen !== null && chosen.toLowerCase() !== own?.toLowerCase() ? chosen : "");

export function chooseCode(stored: string | null, configCode: string | null | undefined): string | null {
  if (validCode(stored)) return stored;
  return validCode(configCode) ? configCode : null;
}

/** The share link: this site with `?ref=CODE`, exactly what the capture reads. */
export const refLink = (origin: string, code: string) => `${origin.replace(/\/+$/, "")}/?ref=${encodeURIComponent(code)}`;

/** Under Enable trading, when a code will be set (spec §3, exact). */
export const enableReferralText = (code: string) => `Uses referral code ${code} on Hyperliquid: 4% off Hyperliquid's fees on your first $25M traded.`;

/** `needToTrade`: what is left to trade before `registerReferrer` (required − cumVlm, whole dollars, rounded up). */
export function remainingToCreateText(required: number, cumVlm: number): string {
  const rest = Math.ceil(required - cumVlm);
  if (rest > 0) return `Trade $${fmtUsd(rest, 0)} more to create a code.`;
  return "You have traded enough. Hyperliquid has not opened code creation for this account yet: check again later.";
}

/** A USDC amount from Hyperliquid; a positive amount under a cent is not shown as $0.00. */
export const usdText = (n: number) => (n > 0 && n < 0.01 ? "<$0.01" : `$${fmtUsd(n)}`);

/** Hyperliquid's join time (ms) as a UTC date. */
export const joinedText = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface ReferredRow {
  user: Address; // lowercase
  volume: number; // USD traded (cumVlm)
  rewarded: number; // USDC this account's fees have given the referrer (cumFeesRewardedToReferrer)
  joined: number; // ms (timeJoined)
}

export type ReferrerStage =
  | { stage: "needToTrade"; required: number }
  | { stage: "needToCreateCode" }
  | { stage: "ready"; code: string; count: number; referrals: ReferredRow[] }
  | { stage: "unknown" };

export interface ReferralView {
  referredBy: { referrer: Address; code: string } | null;
  cumVlm: number;
  unclaimed: number; // USDC
  claimed: number; // USDC
  referrer: ReferrerStage;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const DEC = /^\d+(\.\d+)?$/;
/** Hyperliquid's decimal string ("123.45") as a number; anything else is null. */
const dec = (x: unknown): number | null => (typeof x === "string" && DEC.test(x) ? Number(x) : null);

/** A join time (ms) that gives a real date, so `joinedText` cannot throw on it. */
const validJoined = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0 && !Number.isNaN(new Date(x).getTime());

function parseRow(x: unknown): ReferredRow[] {
  if (!isObj(x) || typeof x.user !== "string" || !ADDR.test(x.user)) return [];
  const volume = dec(x.cumVlm);
  const rewarded = dec(x.cumFeesRewardedToReferrer);
  if (volume === null || rewarded === null || !validJoined(x.timeJoined)) return [];
  return [{ user: x.user.toLowerCase() as Address, volume, rewarded, joined: x.timeJoined }];
}

function parseStage(s: unknown): ReferrerStage {
  if (!isObj(s)) return { stage: "unknown" };
  const d = isObj(s.data) ? s.data : null;
  if (s.stage === "needToCreateCode") return { stage: "needToCreateCode" };
  if (s.stage === "needToTrade") {
    const required = d ? dec(d.required) : null;
    return required === null ? { stage: "unknown" } : { stage: "needToTrade", required };
  }
  if (s.stage === "ready" && d && typeof d.code === "string") {
    const referrals = (Array.isArray(d.referralStates) ? d.referralStates.flatMap(parseRow) : []).sort((a, b) => b.joined - a.joined);
    return { stage: "ready", code: d.code, count: typeof d.nReferrals === "number" ? d.nReferrals : referrals.length, referrals };
  }
  return { stage: "unknown" };
}

/** Hyperliquid's `referral` answer. Null when the parts the app relies on cannot be read (never read as "no referrer"). */
export function parseReferral(raw: unknown): ReferralView | null {
  if (!isObj(raw)) return null;
  const cumVlm = dec(raw.cumVlm);
  const unclaimed = dec(raw.unclaimedRewards);
  const claimed = dec(raw.claimedRewards);
  if (cumVlm === null || unclaimed === null || claimed === null) return null;
  let referredBy: ReferralView["referredBy"] = null;
  if (raw.referredBy !== null) {
    const r = raw.referredBy;
    if (!isObj(r) || typeof r.code !== "string" || typeof r.referrer !== "string" || !ADDR.test(r.referrer)) return null;
    referredBy = { referrer: r.referrer.toLowerCase() as Address, code: r.code };
  }
  return { referredBy, cumVlm, unclaimed, claimed, referrer: parseStage(raw.referrerState) };
}

/**
 * Whether Use code, Create code and Claim may be pressed. A paired phone only trades. With the agent as signer
 * (referralActions.REFERRAL_SIGNER), the device needs a live trading key. `checking`: the trading status is still being
 * read, so it is not yet known whether trading is enabled ("Enable trading first" would be premature). `offerEnable`:
 * the tab offers Enable trading itself (a wallet session without a live key).
 */
export function referralGate(o: { kind: SessionKind; needsAgent: boolean; agentReady: boolean; checking?: boolean }): {
  allowed: boolean;
  blockedText?: string;
  offerEnable?: boolean;
} {
  if (!allowed(o.kind, "referral")) return { allowed: false, blockedText: o.kind === "paired" ? PAIRED_BLOCKED_TEXT : "Connect a wallet to do this." };
  if (o.needsAgent && !o.agentReady) {
    if (o.checking) return { allowed: false, blockedText: CHECKING_KEY_TEXT };
    return { allowed: false, blockedText: NO_AGENT_TEXT, offerEnable: allowed(o.kind, "enable") };
  }
  return { allowed: true };
}

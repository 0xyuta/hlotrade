import type { Hex } from "viem";
import type { Address, Network } from "../config/validate";
import { agentExchange, getHl, userExchange } from "./clients";
import type { HlUserWallet } from "./injected";
import { CODE_RULE_TEXT, NO_AGENT_TEXT, parseReferral, validCode, type ReferralView } from "./referral";

/**
 * Who signs setReferrer, registerReferrer and claimRewards. They are L1 actions, like orders, so the device's trading
 * key (the agent) signs them by default. "wallet" switches all three to the main wallet through the Fix A wallet
 * (userExchange); use it only if RF1 (docs/APP.md §6) shows Hyperliquid refuses them from an agent. A wallet may refuse
 * an L1 action's typed data (domain chain 1337): RF1 records that too. The assertion keeps TypeScript from narrowing the
 * constant, so both branches stay checked.
 */
export const REFERRAL_SIGNER = "agent" as "agent" | "wallet";

export interface ReferralSigner {
  net: Network;
  agentKey: Hex | null; // the device's agent key; never logged
  wallet(): HlUserWallet; // the Fix A wallet; called only when REFERRAL_SIGNER is "wallet"
}

function exchangeFor(s: ReferralSigner) {
  if (REFERRAL_SIGNER === "wallet") return userExchange(s.net, s.wallet());
  if (!s.agentKey) throw new Error(NO_AGENT_TEXT);
  return agentExchange(s.net, s.agentKey);
}

/** Hyperliquid's `referral` info for `user`. An answer that cannot be read throws: it never reads as "no referrer". */
export async function readReferral(net: Network, user: Address): Promise<ReferralView> {
  const raw: unknown = await getHl(net).info.referral({ user });
  const v = parseReferral(raw);
  if (!v) throw new Error("Hyperliquid's referral answer could not be read.");
  return v;
}

export async function sendSetReferrer(s: ReferralSigner, code: string): Promise<void> {
  if (!validCode(code)) throw new Error(CODE_RULE_TEXT);
  await exchangeFor(s).setReferrer({ code });
}

export async function sendRegisterReferrer(s: ReferralSigner, code: string): Promise<void> {
  if (!validCode(code)) throw new Error(CODE_RULE_TEXT);
  await exchangeFor(s).registerReferrer({ code });
}

export async function sendClaimRewards(s: ReferralSigner): Promise<void> {
  await exchangeFor(s).claimRewards();
}

/**
 * After Enable trading (spec §3): with a chosen code and no referrer yet, set it. "skipped" when there is no code or the
 * account already has a referrer (Hyperliquid keeps the first). Errors reach the caller, which only logs them.
 */
export async function applyDefaultReferrer(o: { net: Network; master: Address; code: string | null; signer: ReferralSigner }): Promise<"set" | "skipped"> {
  if (!o.code) return "skipped";
  const r = await readReferral(o.net, o.master);
  if (r.referredBy !== null) return "skipped";
  await sendSetReferrer(o.signer, o.code);
  return "set";
}

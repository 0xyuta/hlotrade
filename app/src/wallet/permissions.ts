export type SessionKind = "none" | "wallet" | "paired";
export type GatedAction = "trade" | "enable" | "pair" | "claim" | "stake" | "transfer" | "profile" | "protocol" | "referral";

/** A paired phone holds only its own agent key: it can trade, nothing else. */
export function allowed(kind: SessionKind, a: GatedAction): boolean {
  if (kind === "wallet") return true;
  if (kind === "paired") return a === "trade";
  return false;
}

export const PAIRED_BLOCKED_TEXT = "Open HLO on the device with your wallet to do this.";

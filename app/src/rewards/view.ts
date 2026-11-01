import { POP_MIN_UNITS } from "./constants";
import { CLAIM_LIMIT_TEXT, PAUSED_TEXT } from "../hl/errors";
import { fmtDuration, fmtHlo } from "../ui/format";
import { PAIRED_BLOCKED_TEXT } from "../wallet/permissions";
import type { LatestPop } from "./files";
import type { ClaimPlan } from "./model";

/** The claim button: "Settle & claim" when the contract must settle the checkpoint first, "Claim" otherwise; off with no plan, while sending, when not allowed, or with a problem to show. */
/** A read that failed on its own (the Staking and Buyback reads): the Rewards screen and the Tokenomics Live card. */
export const notAvailableText = (error: string) => `Not available right now: ${error}`;

export function claimButton(o: { plan: ClaimPlan | null; busy: boolean; allowed: boolean; problem: string | null }): { label: string; disabled: boolean } {
  return {
    label: o.busy ? "Confirm in your wallet…" : o.plan?.kind === "settleAndClaim" ? "Settle & claim" : "Claim",
    disabled: !o.plan || o.busy || !o.allowed || Boolean(o.problem),
  };
}

/**
 * Whether Claim may be pressed and, when not, why. Paused is the guardian's pause on settling and claiming (Checkpoints and Mining both revert IsPaused).
 * `limited`: something is claimable but Mining's hourly allowance is empty (a claim would revert ClaimLimitReached).
 */
export function claimGate(o: { canClaim: boolean; paired: boolean; paused: boolean; limited?: boolean }): { allowed: boolean; blockedText?: string } {
  if (!o.canClaim) return { allowed: false, blockedText: o.paired ? PAIRED_BLOCKED_TEXT : "Connect a wallet to claim." };
  if (o.paused) return { allowed: false, blockedText: PAUSED_TEXT };
  if (o.limited) return { allowed: false, blockedText: CLAIM_LIMIT_TEXT };
  return { allowed: true };
}

/** How often 1-in-odds a minute is: "about once every 21 hours" for 1,250, "about once an hour" for 60. */
export function popOftenText(odds: number): string {
  if (odds <= 1) return "every minute";
  const hours = Math.round(odds / 60);
  if (hours < 1) return `about once every ${odds} minutes`;
  return hours === 1 ? "about once an hour" : `about once every ${hours} hours`;
}

/** The Vault card's rule (spec 2026-10-30 §4), from the odds: 1 in N each minute, N minutes in hours. */
export function vaultRuleText(odds: number): string {
  return `0.1 HLO goes in every minute, plus any minute nobody traded. Every minute it has a 1 in ${odds.toLocaleString("en-US")} chance to pop (${popOftenText(odds)}). When it pops, 90% is shared by points among wallets with at least 1 point and 10% stays for the next round. 1 point per $1,000 traded.`;
}

/** Under the minimum: how much more trading reaches it, rounded up to a dollar. Null with no points or at the minimum. */
export function pointsNeededText(units: bigint): string | null {
  if (units <= 0n || units >= POP_MIN_UNITS) return null;
  const dollars = ((POP_MIN_UNITS - units) * 1000n + POP_MIN_UNITS - 1n) / POP_MIN_UNITS;
  return `You need 1 point to share in a pop: $${dollars.toLocaleString("en-US")} more in trades.`;
}

/** The newest pop, by chain time (minute m ends at launchTime + 60(m + 1)); never the wall clock. */
export function lastPopText(p: LatestPop, launchTime: number, now: number): string {
  const ago = fmtDuration(now - (launchTime + 60 * (p.minute + 1)));
  if (p.recipients === 0) return `Popped ${ago} ago. Nobody had 1 point, so it all stayed in the vault.`;
  return `Popped ${ago} ago: ${fmtHlo(BigInt(p.amount))} HLO to ${p.recipients} ${p.recipients === 1 ? "trader" : "traders"}.`;
}

/**
 * Before the pool opens, holders tend to wait; at the opening their backlog drains through Mining's hourly allowance
 * (spec §4: about 11,000 HLO gross, 5,000 at once and the rest over about 18 hours). Claiming before then avoids the queue.
 * Shown only while something is claimable and the pool is not open; `openAt` and `now` are chain time.
 */
export function poolQueueText(o: { poolOpen: boolean; openAt: number; now: number; claimable: bigint }): string | null {
  if (o.poolOpen || o.claimable === 0n) return null;
  const when = o.openAt <= o.now ? "any minute now" : `in ${fmtDuration(o.openAt - o.now)}`;
  return `Claim before trading opens (${when}). After it opens, claims are paid out at a fixed rate per hour, so the first week's backlog can take about 18 hours to clear, first come first served.`;
}

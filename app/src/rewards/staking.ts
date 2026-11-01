import { fmtHlo, fmtDuration } from "../ui/format";
import type { BuyOutcome } from "./buyback";
import { dripRemaining, type PoolPhase } from "./model";

/** An HLO amount typed by the user: up to 18 decimals, above zero; null otherwise. */
export function parseHlo(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(s.trim());
  if (!m) return null;
  const v = BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? "").padEnd(18, "0"));
  return v > 0n ? v : null;
}

/** Staking.stake pulls the HLO with transferFrom, so an allowance short of the amount needs an approve first. */
export const stakeSteps = (allowance: bigint, amount: bigint): ("approve" | "stake")[] => (allowance >= amount ? ["stake"] : ["approve", "stake"]);

/**
 * Share of a new reward paid out after one day, with a buy (and so a Staking update) every 10 minutes.
 * Staking.sol releases (elapsed ÷ 1 day) of the undripped balance on each update, so this is a tail, not a one-day
 * schedule: ≈ 63% is out after a day and the rest trails off (plan2-inputs). No APR is shown anywhere.
 */
export const DAY_ONE_SHARE = 1 - dripRemaining(86_400);
export const DRIP_TEXT = `New rewards drip in: about ${Math.round(DAY_ONE_SHARE * 100)}% of each buyback's share reaches stakers within a day, and the rest keeps trickling in after that.`;

export function phaseText(p: PoolPhase): string {
  switch (p.kind) {
    case "countdown": return `The pool opens in ${fmtDuration(p.secondsLeft)}.`;
    case "canOpen": return "The pool can open now. Anyone can open it.";
    case "waitingForFees": return "The pool opens with the first fee deposit.";
    case "waitingForDeposit": return "Buying starts after the next fee deposit.";
    case "buyDue": return "A buyback is due. Anyone can run it.";
    case "nextBuy": return `Next buyback in ${fmtDuration(p.secondsLeft)}.`;
  }
}

/** The one-line result of a mined buy(), from its receipt. */
export function buyOutcomeText(o: BuyOutcome | null): string {
  if (!o) return "Sent. Check the result in your wallet or on the explorer.";
  if (o.kind === "bought") return `Bought ${fmtHlo(o.hloOut)} HLO (90% burned, 10% to stakers).`;
  if (o.kind === "skipped") return "Skipped: price moved more than 2% from its 30-minute average.";
  return "Nothing to buy right now.";
}

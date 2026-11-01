import { parseEventLogs, type Hex, type Log } from "viem";
import type { Address } from "../config/validate";
import { miningAbi } from "../evm/abi";

/** The one viem PublicClient method used here (a fake in tests). */
export interface ReceiptClient {
  getTransactionReceipt(a: { hash: Hex }): Promise<{ logs: readonly Log[] }>;
}

/** What a mined claim did, from Mining's Claimed log: the user's new claimed[user] and the HLO paid out (the gross less the 10% refining). */
export interface ClaimResult {
  claimedTotal: bigint;
  paid: bigint;
}

/**
 * The Claimed log of this claim's receipt (Mining's own, for this user).
 * A partial claim pays less than the screen expected when the allowance moved in between, so the hold uses `claimedTotal`, not the plan.
 * Null: the receipt could not be read or has no such log (the caller falls back to the plan's expectation).
 */
export async function claimResultFromReceipt(c: ReceiptClient, hash: Hex, mining: Address, user: Address): Promise<ClaimResult | null> {
  try {
    const { logs } = await c.getTransactionReceipt({ hash });
    const mine = parseEventLogs({ abi: miningAbi, logs: logs as Log[], eventName: "Claimed" }).filter(
      (l) => l.address.toLowerCase() === mining.toLowerCase() && l.args.user.toLowerCase() === user.toLowerCase(),
    );
    const last = mine[mine.length - 1]; // claimedTotal only grows within a transaction
    return last ? { claimedTotal: last.args.claimedTotal, paid: last.args.paid } : null;
  } catch {
    return null;
  }
}

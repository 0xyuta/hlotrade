import { BaseError, ContractFunctionRevertedError, parseEventLogs, type Hex, type Log } from "viem";
import type { Address } from "../config/validate";
import { buybackAbi } from "../evm/abi";

/** The two viem PublicClient methods used here (a fake in tests). */
export interface BuyClient {
  simulateContract(a: { address: Address; abi: typeof buybackAbi; functionName: "buy" }): Promise<{ result: unknown }>;
  getTransactionReceipt(a: { hash: Hex }): Promise<{ logs: readonly Log[] }>;
}

/**
 * What a buy() would return right now, by simulating it (an eth_call: no signature, no gas; buy() does not read msg.sender).
 * A buy() that does not buy does NOT revert (it emits Skipped, or returns 0 with no event), so the wallet's own gas
 * estimate cannot warn about it: this is the check that can.
 *   bigint: the HLO it would buy (0n: a revert such as TooSoon / PoolNotOpen, or a return of 0, so nothing would be bought)
 *   null:   unknown (the RPC or the network failed): the caller must not enable "run buyback" on it.
 */
export async function simulateBuy(c: BuyClient, buyback: Address): Promise<bigint | null> {
  try {
    const { result } = await c.simulateContract({ address: buyback, abi: buybackAbi, functionName: "buy" });
    return typeof result === "bigint" ? result : null;
  } catch (e) {
    if (e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError)) return 0n;
    return null;
  }
}

export type BuyOutcome =
  | { kind: "bought"; hloOut: bigint; burned: bigint; toStakers: bigint }
  | { kind: "skipped" } // the 2% price guard (or no 30-minute average yet) held the buy back
  | { kind: "nothing" }; // neither event: no USDC to spend, or the amount rounded to 0

/** Reads what a mined buy() did from its receipt. Only Buyback's own logs count. Null: the receipt could not be read. */
export async function buyOutcome(c: BuyClient, hash: Hex, buyback: Address): Promise<BuyOutcome | null> {
  try {
    const { logs } = await c.getTransactionReceipt({ hash });
    const mine = parseEventLogs({ abi: buybackAbi, logs: logs as Log[], eventName: ["Bought", "Skipped"] }).filter(
      (l) => l.address.toLowerCase() === buyback.toLowerCase(),
    );
    const bought = mine.find((l) => l.eventName === "Bought");
    if (bought) {
      const a = bought.args as { hloOut: bigint; burned: bigint; toStakers: bigint };
      return { kind: "bought", hloOut: a.hloOut, burned: a.burned, toStakers: a.toStakers };
    }
    return mine.some((l) => l.eventName === "Skipped") ? { kind: "skipped" } : { kind: "nothing" };
  } catch {
    return null;
  }
}

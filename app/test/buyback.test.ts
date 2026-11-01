import {
  createPublicClient, custom, encodeAbiParameters, encodeErrorResult, encodeEventTopics, encodeFunctionResult, type Hex, type Log,
} from "viem";
import { describe, expect, it } from "vitest";
import { buybackAbi } from "../src/evm/abi";
import { buyOutcome, simulateBuy } from "../src/rewards/buyback";

const BB = "0x00000000000000000000000000000000000000a5";
const OTHER = "0x00000000000000000000000000000000000000b9";
const E18 = 10n ** 18n;

/** A real viem client whose transport answers eth_call the way a node would. */
const client = (call: () => Hex) =>
  createPublicClient({
    transport: custom(
      {
        request: async ({ method }: { method: string }) => {
          if (method !== "eth_call") throw new Error(`unexpected ${method}`);
          return call();
        },
      },
      { retryCount: 0 },
    ),
  });
const returns = (v: bigint) => () => encodeFunctionResult({ abi: buybackAbi, functionName: "buy", result: v });
const reverts = (errorName: "TooSoon" | "PoolNotOpen") => () => {
  throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi: buybackAbi, errorName }) });
};

describe("simulateBuy", () => {
  it("returns what buy() would return: the HLO it would buy", async () => {
    expect(await simulateBuy(client(returns(5n * E18)) as never, BB)).toBe(5n * E18);
  });
  it("a buy() that skips or has nothing to spend returns 0 (it does not revert)", async () => {
    expect(await simulateBuy(client(returns(0n)) as never, BB)).toBe(0n);
  });
  it("a revert (TooSoon, PoolNotOpen) means 0: nothing would be bought", async () => {
    expect(await simulateBuy(client(reverts("TooSoon")) as never, BB)).toBe(0n);
    expect(await simulateBuy(client(reverts("PoolNotOpen")) as never, BB)).toBe(0n);
  });
  it("an RPC or network error is unknown (null), never 0 and never a number", async () => {
    const down = client(() => {
      throw new Error("fetch failed");
    });
    expect(await simulateBuy(down as never, BB)).toBeNull();
  });
});

const log = (address: string, eventName: "Bought" | "Skipped", args: unknown[], types: { type: string }[]): Log =>
  ({
    address, blockNumber: 1n, logIndex: 0, transactionHash: "0x" + "1".repeat(64), blockHash: "0x" + "2".repeat(64), transactionIndex: 0, removed: false,
    topics: encodeEventTopics({ abi: buybackAbi, eventName } as never),
    data: encodeAbiParameters(types as never, args as never),
  }) as unknown as Log;
const bought = (address = BB) =>
  log(address, "Bought", [100n, 7n * E18, 63n * E18 / 10n, 7n * E18 / 10n], [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }]);
const skipped = (address = BB) => log(address, "Skipped", [1n, 2n], [{ type: "uint256" }, { type: "uint256" }]);
const receipt = (logs: Log[]) => ({ getTransactionReceipt: async () => ({ logs }) }) as never;
const H = ("0x" + "ab".repeat(32)) as Hex;

describe("buyOutcome", () => {
  it("Bought: the amount, burned and sent to stakers", async () => {
    expect(await buyOutcome(receipt([bought()]), H, BB)).toEqual({ kind: "bought", hloOut: 7n * E18, burned: 63n * E18 / 10n, toStakers: 7n * E18 / 10n });
  });
  it("Skipped: the price guard held the buy back", async () => {
    expect(await buyOutcome(receipt([skipped()]), H, BB)).toEqual({ kind: "skipped" });
  });
  it("neither event: nothing to buy (no USDC, or rounded to 0)", async () => {
    expect(await buyOutcome(receipt([]), H, BB)).toEqual({ kind: "nothing" });
  });
  it("events from another contract in the same transaction do not count", async () => {
    expect(await buyOutcome(receipt([bought(OTHER), skipped(OTHER)]), H, BB)).toEqual({ kind: "nothing" });
  });
  it("a receipt that cannot be read is unknown (null)", async () => {
    const c = { getTransactionReceipt: async () => { throw new Error("not found"); } } as never;
    expect(await buyOutcome(c, H, BB)).toBeNull();
  });
});

import { BaseError, ContractFunctionRevertedError, createPublicClient, custom, encodeErrorResult, type Abi } from "viem";
import { describe, expect, it } from "vitest";
import { buybackAbi, stakingAbi } from "../src/evm/abi";
import { plainError } from "../src/hl/errors";

/** A real viem error: an eth_call that reverts with a custom error, decoded against the ABI. */
async function reverts(abi: Abi, errorName: string, functionName: string, args: unknown[] = []): Promise<unknown> {
  const client = createPublicClient({
    transport: custom({
      request: async () => {
        throw Object.assign(new Error("execution reverted"), { code: 3, data: encodeErrorResult({ abi, errorName } as never) });
      },
    }, { retryCount: 0 }),
  });
  try {
    await client.simulateContract({
      address: "0x3333333333333333333333333333333333333333", abi, functionName, args,
      account: "0x1111111111111111111111111111111111111111",
    } as never);
  } catch (e) {
    return e;
  }
  throw new Error("did not revert");
}

describe("Staking and Buyback reverts in plain words", () => {
  const cases: [Abi, string, string, unknown[], RegExp][] = [
    [stakingAbi, "ZeroAmount", "stake", [0n], /amount above zero/],
    [stakingAbi, "InsufficientStake", "unstake", [1n], /not have that much HLO staked/],
    [stakingAbi, "TransferFailed", "stake", [1n], /balance and the approval/],
    [buybackAbi, "PoolAlreadyOpen", "openPool", [], /already open/],
    [buybackAbi, "TooEarly", "openPool", [], /too early to open/],
    [buybackAbi, "NothingToSeed", "openPool", [], /first fee deposit/],
    [buybackAbi, "PoolNotOpen", "buy", [], /not open yet/],
    [buybackAbi, "TooSoon", "buy", [], /less than 10 minutes/],
  ];
  for (const [abi, name, fn, args, text] of cases) {
    it(`${name} (${fn})`, async () => {
      const e = await reverts(abi, name, fn, args);
      const reverted = (e as BaseError).walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError;
      expect(reverted.data?.errorName).toBe(name);
      expect(plainError(e).text).toMatch(text);
    });
  }
});

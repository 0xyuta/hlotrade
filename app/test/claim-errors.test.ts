import { BaseError, ContractFunctionRevertedError, createPublicClient, custom, encodeErrorResult, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";
import { checkpointsAbi, miningAbi, settleAndClaimAbi } from "../src/evm/abi";
import { PAUSED_TEXT, plainError } from "../src/hl/errors";

const ARGS = [{ throughMinute: 1n, refBlock: 2n, root: `0x${"11".repeat(32)}`, totalEntitled: 3n }, "0x", 4n, []] as const;

/** A real viem error: a settleAndClaim eth_call that reverts with a custom error (Mining's or Checkpoints'), decoded against the write ABI. */
async function settleAndClaimReverts(errorName: string): Promise<unknown> {
  const data = encodeErrorResult({ abi: [...miningAbi, ...checkpointsAbi], errorName } as never);
  const client = createPublicClient({
    transport: custom({
      request: async () => {
        throw Object.assign(new Error("execution reverted"), { code: 3, data });
      },
    }),
  });
  try {
    await client.simulateContract({
      address: "0x3333333333333333333333333333333333333333", abi: settleAndClaimAbi, functionName: "settleAndClaim", args: ARGS as never,
      account: "0x1111111111111111111111111111111111111111",
    });
  } catch (e) {
    return e;
  }
  throw new Error("did not revert");
}

describe("Mining.settleAndClaim reverts in plain words (Mining's and Checkpoints' errors)", () => {
  const SETTLED_FIRST = "Someone settled a newer checkpoint first. Try again.";
  const REFUSED = "That checkpoint was refused by the contract. Try again in a minute.";
  const cases: [string, string][] = [
    ["NotNewer", SETTLED_FIRST],
    ["StaleCheckpoint", SETTLED_FIRST],
    ["MinuteNotOver", "That minute is not over yet. Try again in a few seconds."],
    ["BadRefBlock", "That checkpoint is a moment newer than the chain. Try again in a few seconds."],
    ["IsPaused", "Rewards are paused while a checkpoint is checked. Your HLO is safe."],
    ["NotSettled", "That checkpoint is not settled yet. Try again."],
    ["OverSchedule", REFUSED],
    ["BadSignature", REFUSED],
    ["BadProof", "Your proof did not match. Reload and try again."],
    ["NothingToClaim", "Nothing new to claim yet."],
    ["ClaimLimitReached", "Claims are at their hourly limit. Try again in a few minutes."],
    ["OverEntitled", "The contract refused this claim because it is above the posted limit. Try again later."],
  ];
  for (const [name, text] of cases) {
    it(name, async () => {
      const e = await settleAndClaimReverts(name);
      const reverted = (e as BaseError).walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError;
      expect(reverted.data?.errorName).toBe(name);
      expect(plainError(e).text).toBe(text);
    });
  }
  it("the paused text is one constant, shared with the screen's own paused notice", () => {
    expect(PAUSED_TEXT).toBe("Rewards are paused while a checkpoint is checked. Your HLO is safe.");
  });
  it("NotFinal (the old daily feed) is no longer mapped", () => {
    expect(plainError(new Error("reverted with NotFinal")).text).not.toMatch(/not final yet/);
  });
  it("a wallet that returns only the 4-byte selector still gets the text (BadRefBlock)", () => {
    expect(plainError(new Error(`execution reverted: ${toFunctionSelector("BadRefBlock()")}`)).text).toBe("That checkpoint is a moment newer than the chain. Try again in a few seconds.");
  });
  it("the write ABI carries no duplicate error and still has both functions Mining.claim needs", () => {
    const errs = settleAndClaimAbi.filter((x) => x.type === "error").map((x) => x.name);
    expect(new Set(errs).size).toBe(errs.length);
    for (const n of ["NotNewer", "MinuteNotOver", "BadRefBlock", "OverSchedule", "BadSignature", "IsPaused", "NotSettled", "StaleCheckpoint", "BadProof", "NothingToClaim", "ClaimLimitReached"]) expect(errs).toContain(n);
    expect(settleAndClaimAbi.some((x) => x.type === "function" && x.name === "settleAndClaim")).toBe(true);
  });
});

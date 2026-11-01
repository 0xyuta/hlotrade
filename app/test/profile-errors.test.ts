import { BaseError, ContractFunctionRevertedError, createPublicClient, custom, encodeErrorResult, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { profilesAbi } from "../src/evm/abi";
import { plainError } from "../src/hl/errors";

const PROFILES = "0x4444444444444444444444444444444444444444";
const USER = "0x1111111111111111111111111111111111111111";

/** A real viem error: an eth_call that reverts with `data`, decoded against profilesAbi by simulateContract. */
async function revertWith(errorName: "BadName" | "NameTaken" | "BadAvatar" | null, data?: Hex): Promise<unknown> {
  const body = data ?? (errorName ? encodeErrorResult({ abi: profilesAbi, errorName }) : "0x");
  const client = createPublicClient({
    transport: custom({
      request: async () => {
        throw Object.assign(new Error("execution reverted"), { code: 3, data: body });
      },
    }),
  });
  try {
    await client.simulateContract({ address: PROFILES, abi: profilesAbi, functionName: "setName", args: ["bob"], account: USER });
  } catch (e) {
    return e;
  }
  throw new Error("did not revert");
}

describe("Profiles reverts in plain words", () => {
  const cases = [
    ["NameTaken", "That name is taken. Pick another one."],
    ["BadName", "Names are 3–16 characters: a–z, 0–9 and _."],
    ["BadAvatar", "Pick one of the built-in avatars."],
  ] as const;
  for (const [name, text] of cases) {
    it(`${name}: viem decodes it against the ABI, and plainError says it in plain words`, async () => {
      const e = await revertWith(name);
      expect(e).toBeInstanceOf(BaseError);
      const reverted = (e as BaseError).walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError;
      expect(reverted.data?.errorName).toBe(name); // decoded: the ABI has the error
      expect(plainError(e).text).toBe(text);
    });
  }
  it("a wallet that hands back the raw 4-byte selector is understood too", () => {
    const sel = encodeErrorResult({ abi: profilesAbi, errorName: "NameTaken" });
    expect(plainError(new Error(`execution reverted, data: "${sel}"`)).text).toBe("That name is taken. Pick another one.");
  });
  it("a username in the message never triggers a rule", () => {
    expect(plainError(new Error('The contract function "setName" reverted. Arguments: (nametaken)')).text).not.toBe("That name is taken. Pick another one.");
  });
});

import { describe, expect, it } from "vitest";
import { assertChainId } from "../src/chain.js";

describe("assertChainId", () => {
  it("passes when the RPC reports the configured chain", async () => {
    await expect(assertChainId({ getChainId: async () => 998 }, 998)).resolves.toBeUndefined();
  });
  it("throws when the RPC is on another chain", async () => {
    await expect(assertChainId({ getChainId: async () => 999 }, 998)).rejects.toThrow(/chain 999.*CHAIN_ID is 998/);
  });
});

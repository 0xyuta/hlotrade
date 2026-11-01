import { afterEach, describe, expect, it, vi } from "vitest";
import { RPC_BATCH_SIZE, publicClient } from "../src/evm/clients";
import { viemChain } from "../src/wallet/chains";

const chain = viemChain("hyperEvm", {
  network: "testnet", hyperEvmChainId: 998, hyperEvmRpc: "https://rpc-batch.example/evm", arbitrumRpc: "https://a.example", ethereumRpc: "https://e.example",
  withdrawEnabled: true, solanaEnabled: false, solanaRpc: null, rewardsBase: null, builder: null, contracts: null, deployBlock: null, referralCode: null,
});

afterEach(() => vi.unstubAllGlobals());

describe("HyperEVM batches", () => {
  it("never sends more than 20 calls in one JSON-RPC batch (the RPC refuses a bigger one whole)", async () => {
    expect(RPC_BATCH_SIZE).toBe(20);
    const sizes: number[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { id: number }[] | { id: number };
      const calls = Array.isArray(body) ? body : [body];
      sizes.push(calls.length);
      const out = calls.map((c) => (calls.length > 20 ? { jsonrpc: "2.0", id: null, error: { code: -32010, message: "The batch request was too large" } } : { jsonrpc: "2.0", id: c.id, result: "0x1" }));
      return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]), { headers: { "content-type": "application/json" } });
    });
    const c = publicClient(chain);
    const got = await Promise.all(Array.from({ length: 25 }, () => c.request({ method: "eth_blockNumber" })));
    expect(got).toHaveLength(25);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(25);
  });
});

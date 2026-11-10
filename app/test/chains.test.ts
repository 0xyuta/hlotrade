import { toHex } from "viem";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { addChainParams, ensureChain, viemChain } from "../src/wallet/chains";
import { allowed } from "../src/wallet/permissions";

const cfg: AppConfig = {
  network: "testnet", hyperEvmChainId: 998, hyperEvmRpc: "https://rpc.hyperliquid-testnet.xyz/evm",
  arbitrumRpc: "https://arb.example", ethereumRpc: "https://eth.example", withdrawEnabled: true, solanaEnabled: false, solanaRpc: null, rewardsBase: null, builder: null, contracts: null, deployBlock: null, referralCode: null,
};

function wallet(start: number, known: number[]) {
  let chain = start;
  const calls: string[] = [];
  return {
    calls,
    async request({ method, params }: { method: string; params?: unknown }) {
      calls.push(method);
      const p = params as { chainId: string }[] | undefined;
      if (method === "eth_chainId") return toHex(chain);
      if (method === "wallet_switchEthereumChain") {
        const id = Number(p![0].chainId);
        if (!known.includes(id)) throw Object.assign(new Error("Unrecognized chain ID"), { code: 4902 });
        chain = id;
        return null;
      }
      if (method === "wallet_addEthereumChain") {
        chain = Number(p![0].chainId);
        known.push(chain);
        return null;
      }
      throw new Error(method);
    },
  };
}

describe("chains", () => {
  it("ids per network", () => {
    expect(viemChain("hyperEvm", cfg).id).toBe(998);
    expect(viemChain("arbitrum", cfg).id).toBe(421614);
    expect(viemChain("ethereum", cfg).id).toBe(11155111);
    expect(viemChain("hyperEvm", { ...cfg, network: "mainnet", hyperEvmChainId: 999 }).id).toBe(999);
    expect(viemChain("arbitrum", { ...cfg, network: "mainnet", hyperEvmChainId: 999 }).id).toBe(42161);
  });
  it("add-chain params use the config RPC and HYPE for HyperEVM", () => {
    expect(addChainParams(viemChain("hyperEvm", cfg))).toMatchObject({ chainId: "0x3e6", rpcUrls: ["https://rpc.hyperliquid-testnet.xyz/evm"], nativeCurrency: { symbol: "HYPE", decimals: 18 } });
  });
  it("ensureChain: no-op, switch, or add when the wallet does not know the chain", async () => {
    const same = wallet(998, [998]);
    await ensureChain(same, viemChain("hyperEvm", cfg));
    expect(same.calls).toEqual(["eth_chainId"]);
    const known = wallet(1, [1, 998]);
    await ensureChain(known, viemChain("hyperEvm", cfg));
    expect(known.calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "eth_chainId"]);
    const fresh = wallet(1, [1]);
    await ensureChain(fresh, viemChain("hyperEvm", cfg));
    expect(fresh.calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId"]);
  });
  it("a wrapped 4902 (MetaMask Mobile) adds the chain: the code is found anywhere, not just first (review M2)", async () => {
    for (const err of [
      Object.assign(new Error("Internal error"), { code: -32603, data: { originalError: { code: 4902 } } }),
      Object.assign(new Error("wrapper"), { code: -32603, cause: Object.assign(new Error("inner"), { code: 4902 }) }),
    ]) {
      const calls: string[] = [];
      let chain = 1;
      const w = {
        async request({ method }: { method: string }) {
          calls.push(method);
          if (method === "eth_chainId") return toHex(chain);
          if (method === "wallet_switchEthereumChain") throw err;
          chain = 998;
          return null;
        },
      };
      await ensureChain(w, viemChain("hyperEvm", cfg));
      expect(calls).toEqual(["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_chainId"]);
    }
  });
  it("a wrapped 4001 is still a refusal, not an add", async () => {
    const w = {
      request: async ({ method }: { method: string }) =>
        method === "eth_chainId" ? "0x1" : Promise.reject(Object.assign(new Error("Internal error"), { code: -32603, cause: { code: 4001, message: "User rejected" } })),
    };
    await expect(ensureChain(w, viemChain("hyperEvm", cfg))).rejects.toThrow("Internal error");
  });
  it("a refused switch is an error", async () => {
    const w = { request: async ({ method }: { method: string }) => (method === "eth_chainId" ? "0x1" : Promise.reject(Object.assign(new Error("User rejected"), { code: 4001 }))) };
    await expect(ensureChain(w, viemChain("hyperEvm", cfg))).rejects.toThrow("User rejected");
  });
});

describe("permissions: a paired phone can trade only", () => {
  it("gates", () => {
    expect(allowed("paired", "trade")).toBe(true);
    for (const a of ["enable", "pair", "claim", "stake", "transfer", "profile", "protocol", "referral", "swap"] as const) expect(allowed("paired", a)).toBe(false);
    expect(allowed("wallet", "claim")).toBe(true);
    expect(allowed("none", "trade")).toBe(false);
  });
});

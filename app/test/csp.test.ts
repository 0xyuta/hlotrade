import { describe, expect, it } from "vitest";
import { connectSources, cspFor } from "../src/config/csp";
import type { AppConfig } from "../src/config/validate";

const cfg: AppConfig = {
  network: "testnet", hyperEvmChainId: 998,
  hyperEvmRpc: "https://rpc.hyperliquid-testnet.xyz/evm",
  arbitrumRpc: "https://sepolia-rollup.arbitrum.io/rpc",
  ethereumRpc: "https://ethereum-sepolia-rpc.publicnode.com",
  withdrawEnabled: true, solanaEnabled: false, solanaRpc: null, rewardsBase: "https://files-testnet.hlotrade.xyz/998/", builder: null, contracts: null, deployBlock: null, referralCode: null,
};

describe("connect-src", () => {
  it("lists exactly self (our /api/register), Hyperliquid api + ws, the three RPCs, Iris and the rewards base", () => {
    expect(connectSources(cfg).sort()).toEqual([
      "'self'",
      "https://api.hyperliquid-testnet.xyz",
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://files-testnet.hlotrade.xyz",
      "https://iris-api-sandbox.circle.com",
      "https://rpc.hyperliquid-testnet.xyz",
      "https://sepolia-rollup.arbitrum.io",
      "wss://api.hyperliquid-testnet.xyz",
    ]);
  });
  it("mainnet uses the mainnet hosts", () => {
    const s = connectSources({ ...cfg, network: "mainnet", hyperEvmChainId: 999 });
    expect(s).toContain("https://api.hyperliquid.xyz");
    expect(s).toContain("wss://api.hyperliquid.xyz");
    expect(s).toContain("https://iris-api.circle.com");
  });
  it("the Solana RPC's origin is added only when the Solana route is on (Plan 4 C)", () => {
    const rpc = "https://api.devnet.solana.com";
    expect(connectSources({ ...cfg, solanaEnabled: true, solanaRpc: rpc })).toContain("https://api.devnet.solana.com");
    expect(connectSources({ ...cfg, solanaEnabled: false, solanaRpc: rpc })).not.toContain("https://api.devnet.solana.com");
  });
  it("the rewards origin comes from rewardsBase; no vercel host; no config is 'none'", () => {
    expect(connectSources(cfg)).toContain("https://files-testnet.hlotrade.xyz");
    expect(cspFor(cfg)).not.toMatch(/vercel/);
    expect(connectSources({ ...cfg, rewardsBase: null })).not.toContain("https://files-testnet.hlotrade.xyz");
    expect(connectSources(null)).toEqual(["'none'"]);
  });
  it("the policy allows only our scripts and Google Fonts", () => {
    const p = cspFor(cfg);
    expect(p).toContain("default-src 'none'");
    expect(p).toContain("script-src 'self'");
    expect(p).toContain("style-src 'self' https://fonts.googleapis.com");
    expect(p).toContain("font-src https://fonts.gstatic.com");
    expect(p).toContain("img-src 'self' data: https://app.hyperliquid.xyz");
  });
});

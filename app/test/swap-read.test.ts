import { describe, expect, it } from "vitest";
import type { Address } from "../src/config/validate";
import { V2_FACTORY_999, V2_ROUTER_999, swapMarket } from "../src/swap/market";
import { readSwapSnapshot, type SwapReader } from "../src/swap/read";

const HLO = "0xa4Bb42d6D7F36b6EA0C4A0890691826C9C077005" as Address;
const USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f" as Address;
const PAIR = "0x0Bc15fd6432bc63c89E2c6623fbCB9a86bA427db" as Address;
const USER = "0x00000000000000000000000000000000000000Ab" as Address;
const market = swapMarket(999, { token: HLO, pair: PAIR })!;
const low = (a: string) => a.toLowerCase();

function reader(answers: {
  reserves: readonly [bigint, bigint, number];
  token0: Address;
  token1: Address;
  pair: Address;
  hloBal?: bigint;
  usdcBal?: bigint;
  hloAllow?: bigint;
  usdcAllow?: bigint;
}): SwapReader {
  return {
    getBlock: async () => ({ timestamp: 1_700_000_000n }),
    readContract: async (a) => {
      const addr = low(a.address);
      if (a.functionName === "getReserves") {
        expect(addr).toBe(low(PAIR));
        return answers.reserves;
      }
      if (a.functionName === "token0" || a.functionName === "token1") {
        expect(addr).toBe(low(PAIR));
        return a.functionName === "token0" ? answers.token0 : answers.token1;
      }
      if (a.functionName === "getPair") {
        expect(addr).toBe(low(V2_FACTORY_999));
        expect([low(String(a.args?.[0])), low(String(a.args?.[1]))].sort()).toEqual([low(HLO), low(USDC)].sort());
        return answers.pair;
      }
      if (a.functionName === "balanceOf") {
        expect(a.args?.[0]).toBe(USER);
        if (addr === low(HLO)) return answers.hloBal;
        if (addr === low(USDC)) return answers.usdcBal;
      }
      if (a.functionName === "allowance") {
        expect(a.args?.[0]).toBe(USER);
        expect(low(String(a.args?.[1]))).toBe(low(V2_ROUTER_999));
        if (addr === low(HLO)) return answers.hloAllow;
        if (addr === low(USDC)) return answers.usdcAllow;
      }
      throw new Error(`unexpected ${a.functionName} ${a.address}`);
    },
  };
}

describe("readSwapSnapshot", () => {
  it("reads this pair's reserves and the wallet's HLO and USDC balances and allowances", async () => {
    const r = await readSwapSnapshot(reader({
      reserves: [10_000n, 7_410_157n, 0],
      token0: HLO,
      token1: USDC,
      pair: PAIR,
      hloBal: 5n,
      usdcBal: 8n,
      hloAllow: 1n,
      usdcAllow: 2n,
    }), market, USER);
    expect(r).toEqual({
      ok: true,
      snap: {
        reserve0: 10_000n,
        reserve1: 7_410_157n,
        hloIsToken0: true,
        blockTime: 1_700_000_000n,
        hloBalance: 5n,
        usdcBalance: 8n,
        hloAllowance: 1n,
        usdcAllowance: 2n,
      },
    });
  });
  it("leaves balances empty when nobody is connected, and accepts the other token order", async () => {
    const r = await readSwapSnapshot(reader({
      reserves: [4n, 10n, 1],
      token0: USDC,
      token1: HLO,
      pair: PAIR.toLowerCase() as Address,
    }), market, null);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snap.hloIsToken0).toBe(false);
    expect(r.snap.reserve0).toBe(4n);
    expect(r.snap.hloBalance).toBeNull();
    expect(r.snap.usdcAllowance).toBeNull();
  });
  it("refuses a factory pair that is not the configured pair", async () => {
    const r = await readSwapSnapshot(reader({
      reserves: [10n, 4n, 1],
      token0: HLO,
      token1: USDC,
      pair: "0x0000000000000000000000000000000000000001",
    }), market, null);
    expect(r).toEqual({ ok: false, reason: "pair" });
  });
  it("refuses a pair whose tokens are not HLO and USDC", async () => {
    const r = await readSwapSnapshot(reader({
      reserves: [10n, 4n, 1],
      token0: HLO,
      token1: "0x0000000000000000000000000000000000000002",
      pair: PAIR,
    }), market, null);
    expect(r).toEqual({ ok: false, reason: "pair" });
  });
});

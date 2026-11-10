import { describe, expect, it } from "vitest";
import { ROUTE_ADDRESSES } from "../src/routes/addresses";
import { swapCalls } from "../src/swap/execute";
import {
  amountOutMin,
  fmtAmount,
  guardedMin,
  moveText,
  parseSlippagePercent,
  parseTokenAmount,
  quoteExactIn,
  quoteMoveBps,
  swapButtonLabel,
  swapDeadline,
  swapSteps,
  SWAP_DEADLINE_SEC,
} from "../src/swap/quote";
import { reservesOf, swapMarket, tokensFor, V2_FACTORY_999, V2_ROUTER_999 } from "../src/swap/market";
import { planSwap, type SwapSnapshot } from "../src/swap/plan";

const E18 = 10n ** 18n;
const HLO = "0xa4Bb42d6D7F36b6EA0C4A0890691826C9C077005";
const PAIR = "0x0Bc15fd6432bc63c89E2c6623fbCB9a86bA427db";
const contracts = { token: HLO, pair: PAIR } as never;

describe("quoteExactIn", () => {
  it("matches the Uniswap V2 library (0.30% fee, round down)", () => {
    // getAmountOut(1000, 100000, 100000) = 987
    expect(quoteExactIn(1000n, 100_000n, 100_000n)).toBe(987n);
  });
  it("matches the other direction of that opening-reserve quote (1 HLO in)", () => {
    expect(quoteExactIn(E18, 10_000n * E18, 7_410_157n)).toBe(738n);
  });
  it("matches the router quote for the pool's opening reserves and 1 USDC in", () => {
    // Opening reserves were 10,000 HLO and 7.410157 USDC. Router getAmountsOut on 2026-11-10, while reserves were still those, returned this.
    const out = quoteExactIn(1_000_000n, 7_410_157n, 10_000n * E18);
    expect(out).toBe(1_185_894_351_681_549_422_712n);
  });
  it("is null when the input or a reserve is zero", () => {
    expect(quoteExactIn(0n, 1n, 1n)).toBeNull();
    expect(quoteExactIn(1n, 0n, 1n)).toBeNull();
    expect(quoteExactIn(1n, 1n, 0n)).toBeNull();
    expect(quoteExactIn(-1n, 1n, 1n)).toBeNull();
  });
});

describe("amountOutMin", () => {
  it("takes the slippage off the quote and rounds down", () => {
    expect(amountOutMin(10_000n, 50n)).toBe(9_950n);
    expect(amountOutMin(1n, 50n)).toBe(0n);
  });
  it("refuses a slippage outside 0.01%–5%", () => {
    expect(amountOutMin(10_000n, 0n)).toBeNull();
    expect(amountOutMin(10_000n, 501n)).toBeNull();
    expect(amountOutMin(0n, 50n)).toBeNull();
  });
});

describe("parse and format", () => {
  it("parses a token amount in that token's decimals", () => {
    expect(parseTokenAmount("1", 6)).toBe(1_000_000n);
    expect(parseTokenAmount(" 1.5 ", 6)).toBe(1_500_000n);
    expect(parseTokenAmount("0.000001", 6)).toBe(1n);
    expect(parseTokenAmount("0", 6)).toBeNull();
    expect(parseTokenAmount("1.1234567", 6)).toBeNull();
    expect(parseTokenAmount("1e6", 6)).toBeNull();
    expect(parseTokenAmount("", 18)).toBeNull();
  });
  it("parses a slippage percent into bps", () => {
    expect(parseSlippagePercent("0.5")).toBe(50n);
    expect(parseSlippagePercent("0.01")).toBe(1n);
    expect(parseSlippagePercent("5")).toBe(500n);
    expect(parseSlippagePercent("5.01")).toBeNull();
    expect(parseSlippagePercent("0")).toBeNull();
    expect(parseSlippagePercent("0.001")).toBeNull();
  });
  it("formats amounts from integers, including a tiny USDC amount", () => {
    expect(fmtAmount(7_410_157n, 6)).toBe("7.410157");
    expect(fmtAmount(1_000_000n, 6)).toBe("1");
    expect(fmtAmount(738n, 6)).toBe("0.000738");
    expect(fmtAmount(1_185_894_351_681_549_422_712n, 18)).toBe("1,185.89435168");
    expect(fmtAmount(0n, 6)).toBe("0");
  });
});

describe("quote move", () => {
  it("stays quiet under 1% and states a larger move", () => {
    const quoted = quoteExactIn(100n, 100_000n, 100_000n)!;
    const bps = quoteMoveBps(100n, 100_000n, 100_000n, quoted)!;
    expect(bps).toBeLessThan(100n);
    expect(moveText(bps)).toBeNull();
    const thin = quoteExactIn(1_000_000n, 7_410_157n, 10_000n * E18)!;
    const thinBps = quoteMoveBps(1_000_000n, 7_410_157n, 10_000n * E18, thin)!;
    expect(thinBps).toBeGreaterThan(100n);
    expect(moveText(thinBps)).toMatch(/^This amount moves the quote by \d+\.\d%\.$/);
  });
});

describe("swap steps, deadline and labels", () => {
  it("approves only when the allowance is short", () => {
    expect(swapSteps(0n, 5n)).toEqual(["approve", "swap"]);
    expect(swapSteps(4n, 5n)).toEqual(["approve", "swap"]);
    expect(swapSteps(5n, 5n)).toEqual(["swap"]);
  });
  it("deadlines from the block timestamp", () => {
    expect(SWAP_DEADLINE_SEC).toBe(1200n);
    expect(swapDeadline(1_700_000_000n)).toBe(1_700_001_200n);
  });
  it("names the button", () => {
    expect(swapButtonLabel("buy", true)).toBe("Approve and buy");
    expect(swapButtonLabel("buy", false)).toBe("Buy HLO");
    expect(swapButtonLabel("sell", true)).toBe("Approve and swap");
    expect(swapButtonLabel("sell", false)).toBe("Swap to USDC");
  });
});

describe("swapMarket", () => {
  it("is the official Uniswap V2 router for the HyperEVM factory, on mainnet only", () => {
    const m = swapMarket(999, contracts);
    expect(m).toMatchObject({
      router: V2_ROUTER_999,
      factory: V2_FACTORY_999,
      hlo: HLO,
      usdc: ROUTE_ADDRESSES.mainnet.hyperEvm.usdc,
      pair: PAIR,
    });
    expect(V2_ROUTER_999).toBe("0x1f7d7550B1b028f7571E69A784071F0205FD2EfA");
    expect(V2_FACTORY_999).toBe("0x89e5DB8B5aA49aA85AC63f691524311AEB649eba");
    expect(swapMarket(998, contracts)).toBeNull();
    expect(swapMarket(999, null)).toBeNull();
  });
  it("buy pays USDC and reads the USDC reserve as input when HLO is token0", () => {
    const m = swapMarket(999, contracts)!;
    expect(tokensFor("buy", m)).toMatchObject({ pay: m.usdc, receive: m.hlo, paySymbol: "USDC", receiveSymbol: "HLO" });
    expect(tokensFor("sell", m)).toMatchObject({ pay: m.hlo, receive: m.usdc, paySymbol: "HLO", receiveSymbol: "USDC" });
    expect(reservesOf("buy", true, 10n, 4n)).toEqual({ reserveIn: 4n, reserveOut: 10n });
    expect(reservesOf("sell", true, 10n, 4n)).toEqual({ reserveIn: 10n, reserveOut: 4n });
    expect(reservesOf("buy", false, 4n, 10n)).toEqual({ reserveIn: 4n, reserveOut: 10n });
  });
});

const snap = (over: Partial<SwapSnapshot> = {}): SwapSnapshot => ({
  reserve0: 10_000n * E18,
  reserve1: 7_410_157n,
  hloIsToken0: true,
  blockTime: 1_700_000_000n,
  hloBalance: 5n * E18,
  usdcBalance: 20_000_000n,
  hloAllowance: 0n,
  usdcAllowance: 0n,
  ...over,
});

describe("planSwap", () => {
  const market = swapMarket(999, contracts)!;
  it("buys HLO with an approval when the USDC allowance is short", () => {
    const r = planSwap({ market, side: "buy", amountIn: 1_000_000n, slippageBps: 50n, snap: snap() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.quote.quoted).toBe(1_185_894_351_681_549_422_712n);
    expect(r.quote.amountOutMin).toBe(amountOutMin(r.quote.quoted, 50n));
    expect(r.quote.amountOutMin).toBeLessThan(r.quote.quoted);
    expect(r.quote.steps).toEqual(["approve", "swap"]);
    expect(r.quote.path).toEqual([market.usdc, market.hlo]);
    expect(r.quote.deadline).toBe(1_700_001_200n);
    expect(r.quote.pay).toBe(market.usdc);
  });
  it("skips the approval when the allowance covers the amount", () => {
    const r = planSwap({ market, side: "buy", amountIn: 1_000_000n, slippageBps: 50n, snap: snap({ usdcAllowance: 1_000_000n }) });
    expect(r.ok && r.quote.steps).toEqual(["swap"]);
  });
  it("keeps the minimum the screen showed when the fresh quote is still above it", () => {
    expect(guardedMin(100n, 100n)).toBe(100n);
    expect(guardedMin(100n, 150n)).toBe(100n);
    expect(guardedMin(100n, 99n)).toBeNull();
    expect(guardedMin(0n, 10n)).toBeNull();
  });
  it("builds the approve and the router swap", () => {
    const r = planSwap({ market, side: "buy", amountIn: 1_000_000n, slippageBps: 50n, snap: snap() });
    if (!r.ok) throw new Error(r.reason);
    const [approve, swap] = swapCalls(market, r.quote, "0x00000000000000000000000000000000000000Ab");
    expect(approve).toMatchObject({ address: market.usdc, functionName: "approve", args: [market.router, 1_000_000n] });
    expect(swap).toMatchObject({
      address: market.router,
      functionName: "swapExactTokensForTokens",
      args: [1_000_000n, r.quote.amountOutMin, [market.usdc, market.hlo], "0x00000000000000000000000000000000000000Ab", 1_700_001_200n],
    });
  });
  it("refuses more than the balance, a dust output, and an empty market", () => {
    expect(planSwap({ market, side: "buy", amountIn: 21_000_000n, slippageBps: 50n, snap: snap() })).toMatchObject({ ok: false, reason: "That is more than your balance." });
    expect(planSwap({ market, side: "sell", amountIn: 1n, slippageBps: 50n, snap: snap() }).ok).toBe(false);
    expect(planSwap({ market, side: "buy", amountIn: 1_000_000n, slippageBps: 50n, snap: snap({ reserve0: 0n, reserve1: 0n }) })).toMatchObject({ ok: false, reason: "The market has no liquidity." });
  });
});

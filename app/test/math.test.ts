import { describe, expect, it } from "vitest";
import {
  BUILDER_F, BUILDER_FEE_RATE, change24h, limitFromPct, pctFromTpslPrice, tpslPriceFromPct, estimateLiq, livePnl, liqPriceIsolated, priceTickDecimals, roundPrice, roundSize, sizeFromMargin, slippagePrice, usdToUnits,
} from "../src/hl/math";

describe("roundPrice [T §3.5]", () => {
  it("keeps valid prices", () => {
    expect(roundPrice(1234.5, 0)).toBe("1234.5");
    expect(roundPrice(0.001234, 0)).toBe("0.001234");
    expect(roundPrice(0.01234, 1)).toBe("0.01234");
  });
  it("cuts to 5 significant figures", () => {
    expect(roundPrice(1234.56, 0)).toBe("1234.6");
    expect(roundPrice(0.0012345, 0)).toBe("0.001235"); // 7 decimals needed, 6 allowed
  });
  it("caps decimals at 6 − szDecimals", () => {
    expect(roundPrice(0.012345, 1, "down")).toBe("0.01234");
    expect(roundPrice(3.14159, 5)).toBe("3.1"); // BTC-like: 1 decimal
  });
  it("allows any integer", () => {
    expect(roundPrice(123456.7, 0)).toBe("123457");
    expect(roundPrice(80089.3, 5)).toBe("80089");
  });
  it("rounds in the asked direction", () => {
    expect(roundPrice(1985.0015, 4, "up")).toBe("1985.1");
    expect(roundPrice(1985.0015, 4, "down")).toBe("1985");
  });
  it("refuses a non-positive price", () => {
    expect(() => roundPrice(0, 2)).toThrow();
  });
  it("throws when rounding leaves a zero price (review M2)", () => {
    expect(() => roundPrice(4e-7, 0, "down")).toThrow();
  });
  it("rounds 5+ integer-digit prices in the asked direction", () => {
    expect(roundPrice(123456.7, 0, "down")).toBe("123456");
    expect(roundPrice(123456.2, 0, "up")).toBe("123457");
  });
  it("carries across a power of ten without leftover digits", () => {
    expect(roundPrice(9999.96, 0)).toBe("10000");
    expect(roundPrice(0.0999996, 0)).toBe("0.1");
  });
  it("small prices at szDecimals 0 keep 6 decimals", () => {
    expect(roundPrice(0.000012345, 0, "down")).toBe("0.000012");
    expect(roundPrice(0.000012345, 0, "up")).toBe("0.000013");
  });
  it("szDecimals 6 leaves no price decimals", () => {
    expect(roundPrice(1234.56, 6)).toBe("1235");
    expect(roundPrice(1.4, 6, "up")).toBe("2");
  });
});

describe("roundSize", () => {
  it("truncates to szDecimals by default and strips zeros", () => {
    expect(roundSize(0.123456, 3)).toBe("0.123");
    expect(roundSize(1.5, 0)).toBe("1");
    expect(roundSize(2.5, 2)).toBe("2.5");
  });
});

describe("constants", () => {
  it("the builder fee rate is derived from f (tenths of a basis point)", () => {
    expect(BUILDER_FEE_RATE).toBe(BUILDER_F / 100_000);
  });
});

describe("slippagePrice [T §3.4]", () => {
  it("adds 5% for buys (rounded up) and removes 5% for sells (rounded down)", () => {
    expect(slippagePrice(80000, true, 0.05, 5)).toBe("84000");
    expect(slippagePrice(80000, false, 0.05, 5)).toBe("76000");
    expect(slippagePrice(1890.49, true, 0.05, 4)).toBe("1985.1");
  });
});

describe("size from margin × leverage", () => {
  it("a size that rounds to zero stays \"0\" so the caller can say too small (review M2)", () => {
    expect(sizeFromMargin(0.5, 1, 80000, 2)).toBe("0");
  });
  it("rounds down to szDecimals", () => {
    expect(sizeFromMargin(100, 10, 50000, 5)).toBe("0.02");
    expect(sizeFromMargin(10, 3, 7, 0)).toBe("4");
  });
});

describe("liquidation price [T §5.1]", () => {
  it("matches the docs' clearinghouseState example (isolated ETH, maxLeverage 50)", () => {
    const px = liqPriceIsolated({ entry: 2985.9, size: 0.0335, isLong: true, isolatedMargin: 4.967826, maxLeverage: 50 });
    expect(px).toBeCloseTo(2866.26936529, 3);
  });
  it("estimates a fresh isolated entry for longs and shorts", () => {
    expect(estimateLiq(100, 1, true, 10, 40)).toBeCloseTo(91.139241, 5);
    expect(estimateLiq(100, 1, false, 10, 40)).toBeCloseTo(108.641975, 5);
  });
  it("a 1x long cannot be liquidated: null, not floating-point noise (review I1)", () => {
    expect(estimateLiq(2694.45, 9.32, true, 1, 17)).toBeNull(); // gave 4.5e-13 before the fix
    expect(estimateLiq(4457.59, 0.79, true, 1, 8)).toBeNull(); // gave 9.1e-13
    expect(estimateLiq(175.62, 8.24, true, 1, 4)).toBeNull(); // gave 2.8e-14
    expect(estimateLiq(100, 1, true, 1, 40)).toBeNull();
    expect(estimateLiq(2985.9, 0.0335, true, 1, 50)).toBeNull();
  });
  it("a 1x short is liquidated at about double the entry", () => {
    expect(estimateLiq(100, 1, false, 1, 40)).toBeCloseTo(197.53086, 4);
  });
  it("null when the formula gives no positive price", () => {
    expect(liqPriceIsolated({ entry: 100, size: 1, isLong: true, isolatedMargin: 150, maxLeverage: 50 })).toBeNull();
  });
});

describe("display helpers", () => {
  it("24h change and live PnL", () => {
    expect(change24h(110, 100)).toBeCloseTo(10, 10);
    expect(livePnl(-0.5, 2000, 1900)).toBeCloseTo(50, 10);
  });
  it("USD strings → 1e-8 units", () => {
    expect(usdToUnits("0.01")).toBe(1_000_000n);
    expect(usdToUnits("1.123456789")).toBe(112_345_678n);
    expect(usdToUnits("4")).toBe(400_000_000n);
    expect(() => usdToUnits("-1")).toThrow();
  });
});

describe("priceTickDecimals (chart price scale) [T §3.5]", () => {
  it("follows 6 − szDecimals and 5 significant figures", () => {
    expect(priceTickDecimals(80_000, 5)).toBe(0); // BTC: 5 integer digits
    expect(priceTickDecimals(2_300, 4)).toBe(1); // ETH: 5 sig figs leaves 1
    expect(priceTickDecimals(99.5, 2)).toBe(3); // 2 integer digits: 3 decimals
    expect(priceTickDecimals(0.077032, 0)).toBe(6); // sub-dollar, 6 − 0
    expect(priceTickDecimals(0.077032, 2)).toBe(4); // sub-dollar, capped by 6 − szDecimals
    expect(priceTickDecimals(0.0000123, 0)).toBe(6); // never past 6
  });
  it("agrees with roundPrice", () => {
    for (const [px, sz] of [[80_000.4, 5], [2_300.46, 4], [0.077032, 0], [0.0012345, 0]] as const) {
      const d = priceTickDecimals(px, sz);
      expect((roundPrice(px, sz).split(".")[1] ?? "").length).toBeLessThanOrEqual(d);
    }
  });
});

describe("TP/SL as % of margin", () => {
  it("moves the price by pct ÷ leverage, away from entry for a TP and toward it for an SL", () => {
    expect(tpslPriceFromPct({ entry: 100, pct: 50, leverage: 10, isLong: true, kind: "tp" })).toBeCloseTo(105);
    expect(tpslPriceFromPct({ entry: 100, pct: 50, leverage: 10, isLong: true, kind: "sl" })).toBeCloseTo(95);
    expect(tpslPriceFromPct({ entry: 100, pct: 50, leverage: 10, isLong: false, kind: "tp" })).toBeCloseTo(95);
    expect(tpslPriceFromPct({ entry: 100, pct: 50, leverage: 10, isLong: false, kind: "sl" })).toBeCloseTo(105);
    expect(tpslPriceFromPct({ entry: 80000, pct: 25, leverage: 1, isLong: true, kind: "tp" })).toBeCloseTo(100000);
  });
  it("gives NaN for a % that is not a positive number or a price at or below 0", () => {
    for (const pct of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(tpslPriceFromPct({ entry: 100, pct, leverage: 10, isLong: true, kind: "tp" })).toBeNaN();
    }
    expect(tpslPriceFromPct({ entry: 100, pct: 100, leverage: 1, isLong: true, kind: "sl" })).toBeNaN(); // price 0
    expect(tpslPriceFromPct({ entry: 100, pct: 150, leverage: 1, isLong: false, kind: "tp" })).toBeNaN(); // below 0
    expect(tpslPriceFromPct({ entry: 0, pct: 10, leverage: 1, isLong: true, kind: "tp" })).toBeNaN();
    expect(tpslPriceFromPct({ entry: 100, pct: 10, leverage: 0, isLong: true, kind: "tp" })).toBeNaN();
  });
  it("reads an existing trigger back as a % (positive on the right side, negative on the wrong side)", () => {
    expect(pctFromTpslPrice({ entry: 100, price: 105, leverage: 10, isLong: true, kind: "tp" })).toBeCloseTo(50);
    expect(pctFromTpslPrice({ entry: 100, price: 95, leverage: 10, isLong: true, kind: "sl" })).toBeCloseTo(50);
    expect(pctFromTpslPrice({ entry: 100, price: 95, leverage: 10, isLong: false, kind: "tp" })).toBeCloseTo(50);
    expect(pctFromTpslPrice({ entry: 100, price: 102, leverage: 10, isLong: false, kind: "sl" })).toBeCloseTo(20);
    expect(pctFromTpslPrice({ entry: 100, price: 98, leverage: 10, isLong: true, kind: "tp" })).toBeCloseTo(-20);
    expect(pctFromTpslPrice({ entry: 0, price: 98, leverage: 10, isLong: true, kind: "tp" })).toBeNaN();
  });
});

describe("limit price from a % of the current price", () => {
  it("always counts from the current price, so pressing a button again does not add up", () => {
    expect(limitFromPct(80000, 10, 5)).toBe("88000");
    expect(limitFromPct(80000, -10, 5)).toBe("72000");
    expect(limitFromPct(80000, 0, 5)).toBe("80000");
    expect(limitFromPct(3123.45, -1, 4)).toBe("3092.2"); // rounded to the market's tick
  });
  it("is empty without a price", () => {
    expect(limitFromPct(0, 10, 5)).toBe("");
    expect(limitFromPct(Number.NaN, 10, 5)).toBe("");
  });
});

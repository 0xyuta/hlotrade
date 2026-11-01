import { describe, expect, it } from "vitest";
import { impactPctText, impactWarning, parseBook, passesLimit, priceImpact, shouldWarn, type Book } from "../src/hl/impact";

const book: Book = {
  bids: [{ px: 99, sz: 1 }, { px: 98, sz: 2 }],
  asks: [{ px: 101, sz: 1 }, { px: 102, sz: 1 }, { px: 110, sz: 1 }],
};

describe("priceImpact", () => {
  it("a buy inside the first level costs the half spread", () => {
    const i = priceImpact(book, true, 0.5)!;
    expect(i.mid).toBe(100);
    expect(i.avgPx).toBe(101);
    expect(i.pct).toBeCloseTo(1);
    expect(i.costUsd).toBeCloseTo(0.5);
    expect(i.covered).toBe(true);
  });

  it("a buy walks the asks: 1 @101 + 1 @102 + 1 @110 averages 104.33", () => {
    const i = priceImpact(book, true, 3)!;
    expect(i.avgPx).toBeCloseTo(104.333, 3);
    expect(i.worstPx).toBe(110);
    expect(i.pct).toBeCloseTo(4.333, 3);
    expect(i.costUsd).toBeCloseTo(13);
  });

  it("a sell walks the bids", () => {
    const i = priceImpact(book, false, 2)!;
    expect(i.avgPx).toBe(98.5);
    expect(i.pct).toBeCloseTo(1.5);
    expect(i.worstPx).toBe(98);
  });

  it("a size bigger than the visible book is flagged and always warned", () => {
    const i = priceImpact(book, false, 5)!;
    expect(i.covered).toBe(false);
    expect(shouldWarn(i)).toBe(true);
    expect(impactPctText(i)).toBe("more than 1.67%");
    expect(impactWarning(i, "This order")).toMatch(/bigger than the visible order book/);
  });

  it("the user's WLD close (testnet 2026-10-29): 1.75% on $7.8k is warned", () => {
    const asks = [0.41499, 0.4159, 0.4168, 0.4177, 0.4186, 0.4195, 0.4204, 0.4213, 0.4222, 0.4231, 0.424, 0.4249, 0.42578].map((px) => ({ px, sz: 1450.4 }));
    const i = priceImpact({ bids: [{ px: 0.41212, sz: 900 }], asks }, true, 18855.1)!;
    expect(i.pct).toBeGreaterThan(1);
    expect(shouldWarn(i)).toBe(true);
    expect(impactWarning(i, "This order")).toMatch(/^This order moves the price about \d\.\d\d%: about \$\d+\.\d\d worse than the current price, on top of fees\.$/);
  });

  it("no warning under 1%, a tiny one reads under 0.01%", () => {
    const deep: Book = { bids: [{ px: 79999, sz: 10 }], asks: [{ px: 80001, sz: 10 }] };
    const i = priceImpact(deep, true, 0.001)!;
    expect(shouldWarn(i)).toBe(false);
    expect(impactPctText(i)).toBe("under 0.01%");
  });

  it("no book side or no size → null", () => {
    expect(priceImpact({ bids: [], asks: book.asks }, true, 1)).toBeNull();
    expect(priceImpact(book, true, 0)).toBeNull();
  });

  it("passesLimit: the fills would go past the max-slippage price", () => {
    const i = priceImpact(book, true, 3)!;
    expect(passesLimit(i, true, 105)).toBe(true);
    expect(passesLimit(i, true, 110)).toBe(false);
    const s = priceImpact(book, false, 2)!;
    expect(passesLimit(s, false, 98.5)).toBe(true);
    expect(passesLimit(s, false, 97)).toBe(false);
  });
});

describe("parseBook", () => {
  it("reads the l2Book response", () => {
    expect(parseBook({ coin: "BTC", time: 1, levels: [[{ px: "99", sz: "1", n: 1 }], [{ px: "101", sz: "2", n: 3 }]] })).toEqual({
      bids: [{ px: 99, sz: 1 }],
      asks: [{ px: 101, sz: 2 }],
    });
  });
  it("anything else is null", () => {
    expect(parseBook(null)).toBeNull();
    expect(parseBook({ levels: [[]] })).toBeNull();
    expect(parseBook({ levels: [[{ px: "x", sz: "1" }], []] })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { countedFee, feesByMinute, minuteOf, type ApiFill } from "../src/index.js";

const f = (o: Partial<ApiFill>): ApiFill => ({ time: 1_800_000_100_000, coin: "WLD", px: "0.42578", sz: "1543.7", builderFee: "0.657276", tid: 1, ...o });

describe("countedFee", () => {
  it("counts our 0.1% fee within 0.000002 USDC (a real testnet fill: 657.276586 notional, fee 0.657276)", () => {
    expect(countedFee(f({}), 1_800_000_000)).toBe(65_727_600n);
  });
  it("an exact fee counts", () => {
    expect(countedFee(f({ px: "80000", sz: "0.001", builderFee: "0.08" }), 0)).toBe(8_000_000n);
  });
  it("another builder's rate does not count (0.05%)", () => {
    expect(countedFee(f({ px: "80000", sz: "0.001", builderFee: "0.04" }), 0)).toBeNull();
  });
  it("just outside the tolerance does not count", () => {
    expect(countedFee(f({ px: "100", sz: "1", builderFee: "0.100003" }), 0)).toBeNull();
    expect(countedFee(f({ px: "100", sz: "1", builderFee: "0.100002" }), 0)).toBe(10_000_200n);
  });
  it("spot, HIP-3, no fee, zero fee and fills before the start do not count", () => {
    expect(countedFee(f({ coin: "@107" }), 0)).toBeNull();
    expect(countedFee(f({ coin: "xyz:GOLD" }), 0)).toBeNull();
    expect(countedFee(f({ builderFee: undefined }), 0)).toBeNull();
    expect(countedFee(f({ builderFee: "0" }), 0)).toBeNull();
    expect(countedFee(f({ time: 1_800_000_099_999 }), 1_800_000_100)).toBeNull();
    expect(countedFee(f({ time: 1_800_000_100_000 }), 1_800_000_100)).toBe(65_727_600n);
  });
});

describe("minutes", () => {
  it("minuteOf: minute m covers [launch+60m, launch+60(m+1))", () => {
    expect(minuteOf(1000, 1_000_000)).toBe(0);
    expect(minuteOf(1000, 1_059_999)).toBe(0);
    expect(minuteOf(1000, 1_060_000)).toBe(1);
  });
  it("feesByMinute sums a user's rows in the same minute", () => {
    const m = feesByMinute([
      { minute: 3, user: "0xaa" as never, fee: 5n },
      { minute: 3, user: "0xaa" as never, fee: 7n },
      { minute: 4, user: "0xbb" as never, fee: 1n },
    ]);
    expect(m.get(3)?.get("0xaa" as never)).toBe(12n);
    expect(m.get(4)?.get("0xbb" as never)).toBe(1n);
  });
});

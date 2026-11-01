import { describe, expect, it } from "vitest";
import { candleWindow, INTERVAL_MS, livePrice, mergeBar, parseMids, toBar, toMarkets } from "../src/hl/markets";

const ctx = (markPx: string, dayNtlVlm: string, midPx: string | null = markPx) => ({
  markPx, midPx, oraclePx: markPx, prevDayPx: "100", funding: "0.0000125", openInterest: "10", dayNtlVlm, premium: "0", impactPxs: null, dayBaseVlm: "1",
});

describe("toMarkets [T §4.1]", () => {
  const raw = [
    {
      universe: [
        { name: "BTC", szDecimals: 5, maxLeverage: 40, marginTableId: 56 },
        { name: "HPOS", szDecimals: 0, maxLeverage: 3, marginTableId: 3, onlyIsolated: true, isDelisted: true, marginMode: "strictIsolated" },
        { name: "ETH", szDecimals: 4, maxLeverage: 25, marginTableId: 55 },
        { name: "XYZ", szDecimals: 1, maxLeverage: 3, marginTableId: 3, marginMode: "noCross" },
      ],
      marginTables: [],
      collateralToken: 0,
    },
    [ctx("80000", "2000"), ctx("1", "5"), ctx("3000", "9000", null), ctx("2", "1")],
  ];
  it("keeps the universe index as the asset index, drops delisted, sorts by 24h volume", () => {
    const m = toMarkets(raw);
    expect(m.map((x) => [x.name, x.index])).toEqual([["ETH", 2], ["BTC", 0], ["XYZ", 3]]);
    expect(m[0]).toMatchObject({ szDecimals: 4, maxLeverage: 25, markPx: 3000, midPx: null, prevDayPx: 100, dayNtlVlm: 9000, onlyIsolated: false });
    expect(m[2].onlyIsolated).toBe(true);
  });
  it("returns [] for anything malformed", () => {
    expect(toMarkets(null)).toEqual([]);
    expect(toMarkets([{ universe: [{ name: "BTC" }] }, []])).toEqual([]);
  });
});

describe("prices", () => {
  it("parseMids keeps numeric entries", () => {
    expect(parseMids({ mids: { BTC: "80000.5", "@1": "0.5", BAD: "x" } })).toEqual({ BTC: 80000.5, "@1": 0.5 });
    expect(parseMids({ BTC: "1" })).toEqual({ BTC: 1 });
    expect(parseMids(null)).toEqual({});
  });
  it("livePrice prefers the mid, then the mark", () => {
    const [m] = toMarkets([{ universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }] }, [ctx("80000", "1")]]);
    expect(livePrice(m, { BTC: 80010 })).toBe(80010);
    expect(livePrice(m, {})).toBe(80000);
  });
});

describe("candles [T §4.5]", () => {
  it("toBar parses strings and numbers, time in seconds", () => {
    expect(toBar({ t: 1792998000000, T: 1793001599999, s: "BTC", i: "1h", o: "80089.0", c: "80003.0", h: "80200.0", l: "79914.0", v: "310", n: 6327 }))
      .toEqual({ time: 1792998000, open: 80089, high: 80200, low: 79914, close: 80003 });
    expect(toBar({ t: 60000, o: 1, h: 2, l: 0.5, c: 1.5 })).toEqual({ time: 60, open: 1, high: 2, low: 0.5, close: 1.5 });
    expect(toBar({ t: 1, o: "x" })).toBeNull();
  });
  it("candleWindow asks for 500 bars by default", () => {
    expect(candleWindow("1h", 1_000_000_000_000)).toEqual({ startTime: 1_000_000_000_000 - 500 * INTERVAL_MS["1h"], endTime: 1_000_000_000_000 });
  });
  it("mergeBar replaces the same bar, appends a newer one, ignores an older one", () => {
    const a = { time: 60, open: 1, high: 1, low: 1, close: 1 };
    const b = { time: 120, open: 1, high: 2, low: 1, close: 2 };
    expect(mergeBar([a], b)).toEqual([a, b]);
    expect(mergeBar([a, b], { ...b, close: 3 })).toEqual([a, { ...b, close: 3 }]);
    expect(mergeBar([a, b], a)).toEqual([a, b]);
    expect(mergeBar([], a)).toEqual([a]);
  });
});

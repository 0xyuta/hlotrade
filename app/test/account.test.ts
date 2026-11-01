import { describe, expect, it } from "vitest";
import { balances, parseAbstraction, parseFills, parseOpenOrders, parsePositions, takerRate } from "../src/hl/account";
import { BASE_TAKER_RATE } from "../src/hl/math";

// [T §4.2] docs example
const CH = {
  assetPositions: [{ type: "oneWay", position: {
    coin: "ETH", szi: "0.0335", entryPx: "2986.3", positionValue: "100.02765", liquidationPx: "2866.26936529", unrealizedPnl: "-0.0134",
    returnOnEquity: "-0.0026789", leverage: { type: "isolated", value: 20, rawUsd: "-95.059824" }, marginUsed: "4.967826", maxLeverage: 50,
  } }],
  marginSummary: { accountValue: "13109.482328" },
  withdrawable: "13104.514502",
};
const SPOT = { balances: [{ coin: "USDC", token: 0, total: "250.5", hold: "0.5", entryNtl: "0" }, { coin: "HYPE", token: 150, total: "3", hold: "0" }] };

describe("account parsers", () => {
  it("positions", () => {
    expect(parsePositions(CH)).toEqual([{
      coin: "ETH", szi: 0.0335, entryPx: 2986.3, positionValue: 100.02765, unrealizedPnl: -0.0134, returnOnEquity: -0.0026789,
      liquidationPx: 2866.26936529, leverage: { type: "isolated", value: 20 }, marginUsed: 4.967826,
    }]);
    const nullLiq = { assetPositions: [{ position: { ...CH.assetPositions[0].position, liquidationPx: null, leverage: { type: "cross", value: 3 } } }] };
    expect(parsePositions(nullLiq)[0]).toMatchObject({ liquidationPx: null, leverage: { type: "cross", value: 3 } });
    expect(parsePositions(null)).toEqual([]);
  });
  it("abstraction [R §2.4]", () => {
    for (const a of ["unifiedAccount", "portfolioMargin", "disabled", "default", "dexAbstraction"]) expect(parseAbstraction(a)).toBe(a);
    expect(parseAbstraction("other")).toBe("unknown");
    expect(parseAbstraction(null)).toBe("unknown");
  });
  it("balances: spot for unified and portfolio, perps withdrawable otherwise", () => {
    expect(balances({ abstraction: "unifiedAccount", clearinghouse: CH, spot: SPOT })).toEqual({ perps: 13104.514502, spot: 250, trade: 250, source: "spot" });
    expect(balances({ abstraction: "portfolioMargin", clearinghouse: CH, spot: SPOT }).source).toBe("spot");
    expect(balances({ abstraction: "disabled", clearinghouse: CH, spot: SPOT })).toEqual({ perps: 13104.514502, spot: 250, trade: 13104.514502, source: "perps" });
    expect(balances({ abstraction: "default", clearinghouse: CH, spot: SPOT }).source).toBe("perps");
    expect(balances({ abstraction: "unknown", clearinghouse: null, spot: null })).toEqual({ perps: 0, spot: 0, trade: 0, source: "perps" });
  });
  it("open orders, including triggers [T §4.3]", () => {
    expect(parseOpenOrders([{ coin: "BTC", side: "A", limitPx: "72000", sz: "0.001", oid: 9, timestamp: 1, origSz: "0.001", isTrigger: true, triggerPx: "80000", triggerCondition: "Price above 80000", orderType: "Take Profit Market", reduceOnly: true, isPositionTpsl: true, children: [], tif: null, cloid: null }]))
      .toEqual([{ coin: "BTC", side: "A", limitPx: 72000, sz: 0.001, oid: 9, timestamp: 1, isTrigger: true, triggerPx: 80000, orderType: "Take Profit Market", reduceOnly: true, isPositionTpsl: true }]);
  });
  it("fills: builderFee 0 when absent [T §4.4]", () => {
    const f = parseFills([
      { coin: "AVAX", px: "18.435", sz: "93.53", side: "B", time: 1681222254710, startPosition: "26.86", dir: "Open Long", closedPnl: "0.0", hash: "0x", oid: 90542681, crossed: false, fee: "0.01", feeToken: "USDC", builderFee: "0.01", tid: 118906512037719 },
      { coin: "AVAX", px: "18", sz: "1", side: "A", time: 2, dir: "Close Long", closedPnl: "1.5", oid: 1, fee: "0.002", tid: 2 },
    ]);
    expect(f.map((x) => [x.builderFee, x.closedPnl])).toEqual([[0.01, 0], [0, 1.5]]);
  });
  it("taker rate: userCrossRate, else the tier-0 base [T §4.6]", () => {
    expect(takerRate({ userCrossRate: "0.000315" })).toBe(0.000315);
    expect(takerRate(null)).toBe(BASE_TAKER_RATE);
  });
});

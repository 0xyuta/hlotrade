import { describe, expect, it } from "vitest";
import type { OpenOrder, Position } from "../src/hl/account";
import { describeCancels, fillNote, planClose, planPositionTpsl, planReverse, tpslOrdersAll, tpslOrdersFor } from "../src/hl/positions";

const ETH = { index: 1, name: "ETH", szDecimals: 4, maxLeverage: 25 };
const long: Position = { coin: "ETH", szi: 0.0335, entryPx: 2986.3, positionValue: 100, unrealizedPnl: 0, returnOnEquity: 0, liquidationPx: 2866, leverage: { type: "isolated", value: 20 }, marginUsed: 5 };
const short: Position = { ...long, szi: -0.0335 };

describe("close and reverse", () => {
  it("close a long = reduce-only IOC sell for |szi| at ref × 0.95", () => {
    const r = planClose(ETH, long, 3000, 0.05);
    expect(r).toEqual({ ok: true, plan: { grouping: "na", px: 3000, notional: 0.0335 * 3000, orders: [{ a: 1, b: false, p: "2850", s: "0.0335", r: true, t: { limit: { tif: "Ioc" } } }] } });
  });
  it("close a short buys back, rounded up", () => {
    const r = planClose(ETH, short, 3000.01, 0.05);
    expect(r.ok && r.plan.orders[0]).toMatchObject({ b: true, p: "3150.1", s: "0.0335", r: true });
  });
  it("reverse = 2 × |szi| the other way, not reduce-only", () => {
    const r = planReverse(ETH, long, 3000, 0.05);
    expect(r.ok && r.plan.orders[0]).toEqual({ a: 1, b: false, p: "2850", s: "0.067", r: false, t: { limit: { tif: "Ioc" } } });
  });
  it("no price → error", () => {
    expect(planClose(ETH, long, 0, 0.05)).toEqual({ ok: false, error: "No price yet. Wait a moment." });
  });
  it("bad inputs return errors instead of throwing (roundPrice throws on 0; roundSize gives 0 when too small)", () => {
    expect(planClose(ETH, long, NaN, 0.05)).toEqual({ ok: false, error: "No price yet. Wait a moment." });
    expect(planClose(ETH, long, 3000, 1)).toMatchObject({ ok: false });
    expect(planClose(ETH, long, 3000, NaN)).toMatchObject({ ok: false });
    expect(planClose(ETH, long, 1e-12, 0.05)).toEqual({ ok: false, error: "That price has too many digits or is too small for this market." });
    expect(planClose(ETH, { ...long, szi: 0.00001 }, 3000, 0.05)).toEqual({ ok: false, error: "Nothing to close." });
    expect(planReverse(ETH, { ...long, szi: 0.00001 }, 3000, 0.05)).toMatchObject({ ok: false });
  });
});

describe("position TP/SL [T §3.2]", () => {
  it("positionTpsl with the full size, reduce-only, closing side", () => {
    const r = planPositionTpsl(ETH, long, 3000, { tp: 3300, sl: 2900 });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.grouping).toBe("positionTpsl");
    expect(r.plan.orders).toEqual([
      { a: 1, b: false, p: "2970", s: "0.0335", r: true, t: { trigger: { isMarket: true, triggerPx: "3300", tpsl: "tp" } } },
      { a: 1, b: false, p: "2610", s: "0.0335", r: true, t: { trigger: { isMarket: true, triggerPx: "2900", tpsl: "sl" } } },
    ]);
  });
  it("checks sides against the live price and needs at least one price", () => {
    expect(planPositionTpsl(ETH, short, 3000, { tp: 3100 })).toEqual({ ok: false, error: "For a short, take profit must be below 3,000." });
    expect(planPositionTpsl(ETH, long, 3000, {})).toEqual({ ok: false, error: "Choose a take-profit or stop-loss %." });
  });
  it("one side only is fine", () => {
    const r = planPositionTpsl(ETH, short, 3000, { sl: 3100 });
    expect(r.ok && r.plan.orders).toEqual([{ a: 1, b: true, p: "3410", s: "0.0335", r: true, t: { trigger: { isMarket: true, triggerPx: "3100", tpsl: "sl" } } }]);
  });
  it("rejects a missing price and bad numbers instead of passing the side check or throwing", () => {
    expect(planPositionTpsl(ETH, long, 0, { tp: 3300 })).toEqual({ ok: false, error: "No price yet. Wait a moment." });
    expect(planPositionTpsl(ETH, long, 3000, { tp: NaN })).toEqual({ ok: false, error: "Enter a take profit % above 0." });
    expect(planPositionTpsl(ETH, long, 3000, { sl: 0 })).toEqual({ ok: false, error: "Enter a stop loss % above 0." });
    expect(planPositionTpsl(ETH, short, 3000, { tp: 1e-12 })).toMatchObject({ ok: false });
    expect(planPositionTpsl(ETH, { ...long, szi: 0.00001 }, 3000, { tp: 3300 })).toEqual({ ok: false, error: "Nothing to protect." });
  });
});

describe("tpslOrdersFor [T §4.3]", () => {
  const o = (x: Partial<OpenOrder>): OpenOrder => ({ coin: "ETH", side: "A", limitPx: 0, sz: 0.0335, oid: 1, timestamp: 0, isTrigger: true, triggerPx: 3300, orderType: "Take Profit Market", reduceOnly: true, isPositionTpsl: true, ...x });
  it("finds the reduce-only trigger orders of a coin by type", () => {
    const tp = o({ oid: 1 });
    const sl = o({ oid: 2, orderType: "Stop Market", triggerPx: 2900 });
    const other = o({ oid: 3, coin: "BTC" });
    const plain = o({ oid: 4, isTrigger: false, orderType: "Limit" });
    expect(tpslOrdersFor("ETH", [other, plain, tp, sl])).toEqual({ tp, sl });
    expect(tpslOrdersFor("ETH", [plain])).toEqual({ tp: null, sl: null });
  });
});

describe("tpslOrdersAll", () => {
  const o = (x: Partial<OpenOrder>): OpenOrder => ({ coin: "ETH", side: "A", limitPx: 0, sz: 1, oid: 1, timestamp: 0, isTrigger: true, triggerPx: 3300, orderType: "Take Profit Market", reduceOnly: true, isPositionTpsl: false, ...x });
  it("returns every reduce-only trigger of the coin, not only the first TP and SL", () => {
    const list = [o({ oid: 1 }), o({ oid: 2 }), o({ oid: 3, orderType: "Stop Market" }), o({ oid: 4, orderType: "Stop Market" }), o({ oid: 5, coin: "BTC" }), o({ oid: 6, isTrigger: false, orderType: "Limit" }), o({ oid: 7, reduceOnly: false })];
    expect(tpslOrdersAll("ETH", list).map((x) => x.oid)).toEqual([1, 2, 3, 4]);
  });
});

describe("describeCancels", () => {
  const orders: OpenOrder[] = [
    { coin: "ETH", side: "A", limitPx: 0, sz: 1, oid: 1, timestamp: 0, isTrigger: true, triggerPx: 3300, orderType: "Take Profit Market", reduceOnly: true, isPositionTpsl: true },
    { coin: "ETH", side: "A", limitPx: 0, sz: 1, oid: 2, timestamp: 0, isTrigger: true, triggerPx: 2900, orderType: "Stop Market", reduceOnly: true, isPositionTpsl: true },
  ];
  const c = [{ a: 1, o: 1 }, { a: 1, o: 2 }];
  it("all done", () => {
    expect(describeCancels(c, [{ ok: true }, { ok: true }], orders)).toEqual({ ok: true, text: "2 orders cancelled." });
    expect(describeCancels([c[0]], [{ ok: true }], orders)).toEqual({ ok: true, text: "Order cancelled." });
  });
  it("a single failure is plain words", () => {
    expect(describeCancels([c[0]], [{ ok: false, text: "Order was never placed, already canceled, or filled. asset=1" }], orders)).toEqual({ ok: false, text: "That order is no longer open." });
  });
  it("a partial batch names both sides; a total failure says nothing was cancelled", () => {
    const gone = { ok: false as const, text: "Order was never placed, already canceled, or filled." };
    expect(describeCancels(c, [{ ok: true }, gone], orders).text).toBe("Cancelled: take profit 3,300. Not cancelled: stop loss 2,900 (That order is no longer open).");
    expect(describeCancels(c, [gone, gone], orders).text).toBe("Nothing was cancelled. Not cancelled: take profit 3,300 (That order is no longer open), stop loss 2,900 (That order is no longer open).");
  });
  it("a missing status counts as not cancelled", () => {
    expect(describeCancels(c, [{ ok: true }], orders).ok).toBe(false);
  });
});

describe("fillNote", () => {
  const plan = (() => { const r = planClose(ETH, long, 3000, 0.05); if (!r.ok) throw new Error(r.error); return r.plan; })();
  const ok = { ok: true, text: "Filled 0.01 at 3000." };
  it("a smaller fill than the order is called partial", () => {
    expect(fillNote(ok, [{ kind: "filled", totalSz: "0.01", avgPx: "3000" }], plan).text).toBe("Filled 0.01 of 0.0335 at 3000. The rest did not fill at your slippage limit. Check Positions before trying again.");
  });
  it("a full fill, a resting order and a failure are left alone", () => {
    expect(fillNote(ok, [{ kind: "filled", totalSz: "0.0335", avgPx: "3000" }], plan)).toBe(ok);
    expect(fillNote(ok, [{ kind: "resting", oid: 1 }], plan)).toBe(ok);
    const bad = { ok: false, text: "x" };
    expect(fillNote(bad, [{ kind: "filled", totalSz: "0.01", avgPx: "3000" }], plan)).toBe(bad);
  });
});

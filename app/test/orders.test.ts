import { describe, expect, it } from "vitest";
import { checkTpsl, num, needsLeverageUpdate, outcomeText, planOrder, summarizeStatuses, TPSL_SLIPPAGE } from "../src/hl/orders";

const BTC = { index: 3, name: "BTC", szDecimals: 5, maxLeverage: 40 };

describe("planOrder [T §3.1–3.5]", () => {
  it("market buy = IOC at ref × 1.05 rounded up", () => {
    const r = planOrder(BTC, { kind: "market", isBuy: true, size: 0.001234567, refPx: 80000, slippage: 0.05 });
    expect(r).toEqual({
      ok: true,
      plan: { grouping: "na", px: 80000, notional: 80000 * 0.00123, orders: [{ a: 3, b: true, p: "84000", s: "0.00123", r: false, t: { limit: { tif: "Ioc" } } }] },
    });
  });
  it("market sell rounds the price down", () => {
    const r = planOrder({ ...BTC, szDecimals: 2 }, { kind: "market", isBuy: false, size: 10, refPx: 1.23456, slippage: 0.05 });
    expect(r.ok && r.plan.orders[0].p).toBe("1.1728");
  });
  it("limit = GTC at the rounded limit price; notional at the limit price", () => {
    const r = planOrder(BTC, { kind: "limit", isBuy: true, size: 0.001, refPx: 80000, limitPx: 79123.4, slippage: 0.05 });
    expect(r.ok && r.plan.orders[0]).toEqual({ a: 3, b: true, p: "79123", s: "0.001", r: false, t: { limit: { tif: "Gtc" } } });
    expect(r.ok && r.plan.notional).toBeCloseTo(79.123, 6);
  });
  it("entry with TP and SL = normalTpsl, children opposite side, reduce-only, same size, trigger ± 10%", () => {
    const r = planOrder(BTC, { kind: "market", isBuy: true, size: 0.001, refPx: 80000, slippage: 0.05, tp: 90000, sl: 75000 });
    if (!r.ok) throw new Error(r.error);
    expect(r.plan.grouping).toBe("normalTpsl");
    expect(r.plan.orders.slice(1)).toEqual([
      { a: 3, b: false, p: String(90000 * (1 - TPSL_SLIPPAGE)), s: "0.001", r: true, t: { trigger: { isMarket: true, triggerPx: "90000", tpsl: "tp" } } },
      { a: 3, b: false, p: String(75000 * (1 - TPSL_SLIPPAGE)), s: "0.001", r: true, t: { trigger: { isMarket: true, triggerPx: "75000", tpsl: "sl" } } },
    ]);
  });
  it("short TP/SL children buy back at trigger + 10%", () => {
    const r = planOrder(BTC, { kind: "market", isBuy: false, size: 0.001, refPx: 80000, slippage: 0.05, sl: 85000 });
    expect(r.ok && r.plan.orders[1]).toMatchObject({ b: true, p: "93500", r: true, t: { trigger: { tpsl: "sl", triggerPx: "85000" } } });
  });
  it("refuses bad input with plain words", () => {
    expect(planOrder(BTC, { kind: "market", isBuy: true, size: 0, refPx: 80000, slippage: 0.05 })).toEqual({ ok: false, error: "Enter a size." });
    expect(planOrder(BTC, { kind: "market", isBuy: true, size: 0.000001, refPx: 80000, slippage: 0.05 })).toEqual({ ok: false, error: "The size rounds to 0 for BTC (5 decimals)." });
    expect(planOrder(BTC, { kind: "market", isBuy: true, size: 0.0001, refPx: 80000, slippage: 0.05 })).toEqual({ ok: false, error: "Orders must be worth at least $10." });
    expect(planOrder(BTC, { kind: "limit", isBuy: true, size: 0.001, refPx: 80000, slippage: 0.05 })).toEqual({ ok: false, error: "Enter a limit price." });
    expect(planOrder(BTC, { kind: "market", isBuy: true, size: 0.001, refPx: 80000, slippage: 0.05, tp: 70000 })).toEqual({ ok: false, error: "For a long, take profit must be above 80,000." });
  });
});

describe("checkTpsl", () => {
  it("long: TP above, SL below; short mirrored", () => {
    expect(checkTpsl(true, 100, 110, 90)).toBeNull();
    expect(checkTpsl(true, 100, undefined, 101)).toBe("For a long, stop loss must be below 100.");
    expect(checkTpsl(false, 100, 90, 110)).toBeNull();
    expect(checkTpsl(false, 100, 101)).toBe("For a short, take profit must be below 100.");
  });
});

describe("needsLeverageUpdate [T §3.6]", () => {
  it("only when not already isolated at this leverage", () => {
    expect(needsLeverageUpdate(null, 5)).toBe(true);
    expect(needsLeverageUpdate({ type: "cross", value: 5 }, 5)).toBe(true);
    expect(needsLeverageUpdate({ type: "isolated", value: 10 }, 5)).toBe(true);
    expect(needsLeverageUpdate({ type: "isolated", value: 5 }, 5)).toBe(false);
  });
});

describe("statuses [T §3.8]", () => {
  it("reads every documented status and treats unknown strings as waiting", () => {
    const s = summarizeStatuses([{ filled: { totalSz: "0.02", avgPx: "1891.4", oid: 1 } }, { resting: { oid: 77738308 } }, { error: "Order must have minimum value of $10." }, "waitingForTrigger"]);
    expect(s).toEqual([
      { kind: "filled", totalSz: "0.02", avgPx: "1891.4" },
      { kind: "resting", oid: 77738308 },
      { kind: "error", text: "Order must have minimum value of $10." },
      { kind: "waiting" },
    ]);
  });
  it("outcomeText leads with the first error in plain words", () => {
    expect(outcomeText([{ kind: "filled", totalSz: "0.02", avgPx: "1891.4" }])).toEqual({ ok: true, text: "Filled 0.02 at 1891.4." });
    expect(outcomeText([{ kind: "resting", oid: 5 }, { kind: "waiting" }])).toEqual({ ok: true, text: "Order placed (resting)." });
    expect(outcomeText([{ kind: "error", text: "Order must have minimum value of $10." }])).toEqual({ ok: false, text: "Orders must be worth at least $10." });
    expect(outcomeText([])).toEqual({ ok: false, text: "No status came back. Check open orders and positions." });
  });
});

describe("planOrder never throws on odd form input (roundPrice throws on 0)", () => {
  it("rejects tp 0 for a short, NaN prices, and slippage outside 0–100%", () => {
    expect(planOrder(BTC, { kind: "market", isBuy: false, size: 0.001, refPx: 80000, slippage: 0.05, tp: 0 })).toEqual({ ok: false, error: "Enter a take profit % above 0." });
    expect(planOrder(BTC, { kind: "market", isBuy: true, size: 0.001, refPx: 80000, slippage: 0.05, sl: num("abc") })).toEqual({ ok: false, error: "Enter a stop loss % above 0." });
    expect(planOrder(BTC, { kind: "market", isBuy: false, size: 0.001, refPx: 80000, slippage: 1 })).toEqual({ ok: false, error: "Max slippage must be between 0% and 100%." });
    expect(planOrder(BTC, { kind: "limit", isBuy: true, size: 0.001, refPx: 80000, limitPx: Number.NaN, slippage: 0.05 })).toEqual({ ok: false, error: "Enter a limit price." });
  });
  it("turns a price that rounds to 0 into a message", () => {
    const r = planOrder({ ...BTC, szDecimals: 0 }, { kind: "limit", isBuy: true, size: 1e9, refPx: 80000, limitPx: 1e-9, slippage: 0.05 });
    expect(r).toEqual({ ok: false, error: "That price has too many digits or is too small for this market." });
  });
});

describe("num", () => {
  it("blank is undefined, text is NaN", () => {
    expect(num("  ")).toBeUndefined();
    expect(num("1.5")).toBe(1.5);
    expect(num("x")).toBeNaN();
  });
});

describe("outcomeText for a partly successful batch", () => {
  const plan = (() => {
    const r = planOrder(BTC, { kind: "market", isBuy: false, size: 0.001, refPx: 80000, slippage: 0.05, tp: 70000, sl: 85000 });
    if (!r.ok) throw new Error(r.error);
    return r.plan;
  })();
  it("names what is live and what is missing", () => {
    const r = outcomeText([{ kind: "filled", totalSz: "0.001", avgPx: "80000" }, { kind: "waiting" }, { kind: "error", text: "Invalid TP/SL price." }], plan, "BTC");
    expect(r).toEqual({
      ok: false,
      partial: true,
      text: "Your short of 0.001 BTC filled at 80000 and your take profit was placed, but the stop loss was rejected: The take-profit or stop-loss price is on the wrong side of the market. Your position has no stop loss: set one in Positions.",
    });
  });
  it("works without the plan too", () => {
    const r = outcomeText([{ kind: "resting", oid: 1 }, { kind: "error", text: "boom" }]);
    expect(r).toMatchObject({ ok: false, partial: true });
    expect(r.text).toBe("An order is resting, but the order 2 was rejected: boom. Check Positions and Open orders before trying again.");
  });
  it("planOrder rethrows real bugs instead of calling them price problems", () => {
    expect(() => planOrder(null as never, { kind: "market", isBuy: true, size: 1, refPx: 1, slippage: 0.05 })).toThrow();
  });
});

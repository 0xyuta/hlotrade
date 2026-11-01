import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenOrder, Position } from "../src/hl/account";
import { describeCancels, planClose, planPositionTpsl, planReverse, tpslOrdersAll } from "../src/hl/positions";
import { outcomeText } from "../src/hl/orders";
import { cancelOrders, submitPlan } from "../src/hl/trade";

// Real nktkas signing and wire building; only fetch is stubbed. Asserts what is POSTed to /exchange.
const BUILDER = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const BUILDER_WIRE = { b: BUILDER.toLowerCase(), f: 100 };
const ETH = { index: 1, name: "ETH", szDecimals: 4, maxLeverage: 25 };
const long: Position = { coin: "ETH", szi: 0.0335, entryPx: 2986.3, positionValue: 100, unrealizedPnl: 0, returnOnEquity: 0, liquidationPx: 2866, leverage: { type: "isolated", value: 20 }, marginUsed: 5 };
const KEY = generatePrivateKey();

type Body = { action: Record<string, any>; signature: unknown; nonce: number };
function stub(replies: Record<string, unknown>) {
  const posted: Body[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text()) as Body;
    posted.push(body);
    return new Response(JSON.stringify(replies[body.action.type] ?? { status: "err", response: "unexpected" }), { headers: { "content-type": "application/json" } });
  }));
  return posted;
}
const filled = (sz: string, px: string) => ({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: sz, avgPx: px, oid: 7 } }] } } });
afterEach(() => vi.unstubAllGlobals());

const planOf = (r: ReturnType<typeof planClose>) => {
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};

describe("close and reverse on the wire", () => {
  it("close: reduce-only IOC sell of the whole size at ref × 0.95, builder on the action, signed", async () => {
    const posted = stub({ order: filled("0.0335", "3000") });
    const out = await submitPlan({ net: "testnet", agentKey: KEY, builder: BUILDER, plan: planOf(planClose(ETH, long, 3000, 0.05)) });
    expect(posted).toHaveLength(1);
    expect(posted[0].action).toEqual({
      type: "order",
      grouping: "na",
      builder: BUILDER_WIRE,
      orders: [{ a: 1, b: false, p: "2850", s: "0.0335", r: true, t: { limit: { tif: "Ioc" } } }],
    });
    expect(posted[0].signature).toMatchObject({ r: expect.stringMatching(/^0x[0-9a-f]{64}$/), s: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    expect(outcomeText(out).text).toBe("Filled 0.0335 at 3000.");
  });
  it("close of a short buys at ref × 1.05", async () => {
    const posted = stub({ order: filled("0.0335", "3000") });
    await submitPlan({ net: "testnet", agentKey: KEY, builder: BUILDER, plan: planOf(planClose(ETH, { ...long, szi: -0.0335 }, 3000, 0.05)) });
    expect(posted[0].action.orders).toEqual([{ a: 1, b: true, p: "3150", s: "0.0335", r: true, t: { limit: { tif: "Ioc" } } }]);
    expect(posted[0].action.builder).toEqual(BUILDER_WIRE);
  });
  it("reverse: IOC sell of 2 × the size, not reduce-only, builder on the action", async () => {
    const posted = stub({ order: filled("0.067", "3000") });
    await submitPlan({ net: "testnet", agentKey: KEY, builder: BUILDER, plan: planOf(planReverse(ETH, long, 3000, 0.05)) });
    expect(posted[0].action).toEqual({
      type: "order",
      grouping: "na",
      builder: BUILDER_WIRE,
      orders: [{ a: 1, b: false, p: "2850", s: "0.067", r: false, t: { limit: { tif: "Ioc" } } }],
    });
  });
  it("reverse of a short: IOC buy of 2 × the size at ref × 1.05, not reduce-only, builder on the action (carry T12)", async () => {
    const posted = stub({ order: filled("0.067", "3000") });
    await submitPlan({ net: "testnet", agentKey: KEY, builder: BUILDER, plan: planOf(planReverse(ETH, { ...long, szi: -0.0335 }, 3000, 0.05)) });
    expect(posted[0].action).toEqual({
      type: "order",
      grouping: "na",
      builder: BUILDER_WIRE,
      orders: [{ a: 1, b: true, p: "3150", s: "0.067", r: false, t: { limit: { tif: "Ioc" } } }],
    });
  });
});

describe("TP/SL on a short, on the wire (carry T12)", () => {
  it("positionTpsl pair of reduce-only BUY triggers: TP below the price, SL above, limit 10% past the trigger", async () => {
    const posted = stub({ order: { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 31 } }, { resting: { oid: 32 } }] } } } });
    await submitPlan({ net: "testnet", agentKey: KEY, builder: BUILDER, plan: planOf(planPositionTpsl(ETH, { ...long, szi: -0.0335 }, 3000, { tp: 2700, sl: 3300 })) });
    expect(posted[0].action).toEqual({
      type: "order",
      grouping: "positionTpsl",
      builder: BUILDER_WIRE,
      orders: [
        { a: 1, b: true, p: "2970", s: "0.0335", r: true, t: { trigger: { isMarket: true, triggerPx: "2700", tpsl: "tp" } } },
        { a: 1, b: true, p: "3630", s: "0.0335", r: true, t: { trigger: { isMarket: true, triggerPx: "3300", tpsl: "sl" } } },
      ],
    });
  });
  it("a TP above the price of a short is refused before anything is signed", () => {
    expect(planPositionTpsl(ETH, { ...long, szi: -0.0335 }, 3000, { tp: 3300 }).ok).toBe(false);
  });
});

describe("TP/SL edit on the wire", () => {
  const trig = (oid: number, orderType: string, triggerPx: number): OpenOrder => ({ coin: "ETH", side: "A", limitPx: 0, sz: 0.0335, oid, timestamp: 0, isTrigger: true, triggerPx, orderType, reduceOnly: true, isPositionTpsl: true });
  const existing = [trig(11, "Take Profit Market", 3300), trig(12, "Take Profit Market", 3400), trig(13, "Stop Market", 2900)];
  const placed = { status: "ok", response: { type: "order", data: { statuses: [{ resting: { oid: 21 } }, { resting: { oid: 22 } }] } } };

  it("cancels every old trigger first, then posts a positionTpsl pair with the builder", async () => {
    const posted = stub({ cancel: { status: "ok", response: { type: "cancel", data: { statuses: ["success", "success", "success"] } } }, order: placed });
    const old = tpslOrdersAll("ETH", existing).map((o) => ({ a: 1, o: o.oid }));
    const out = await cancelOrders({ net: "testnet", agentKey: KEY, cancels: old });
    expect(describeCancels(old, out, existing)).toEqual({ ok: true, text: "3 orders cancelled." });
    await submitPlan({ net: "testnet", agentKey: KEY, builder: BUILDER, plan: planOf(planPositionTpsl(ETH, long, 3000, { tp: 3300, sl: 2900 })) });

    expect(posted.map((b) => b.action.type)).toEqual(["cancel", "order"]);
    expect(posted[0].action).toEqual({ type: "cancel", cancels: [{ a: 1, o: 11 }, { a: 1, o: 12 }, { a: 1, o: 13 }] });
    expect(posted[1].action).toEqual({
      type: "order",
      grouping: "positionTpsl",
      builder: BUILDER_WIRE,
      orders: [
        { a: 1, b: false, p: "2970", s: "0.0335", r: true, t: { trigger: { isMarket: true, triggerPx: "3300", tpsl: "tp" } } },
        { a: 1, b: false, p: "2610", s: "0.0335", r: true, t: { trigger: { isMarket: true, triggerPx: "2900", tpsl: "sl" } } },
      ],
    });
  });
  it("a batch where one cancel is refused still hands back every status (nktkas throws on it)", async () => {
    stub({ cancel: { status: "ok", response: { type: "cancel", data: { statuses: ["success", { error: "Order was never placed, already canceled, or filled. asset=1" }, "success"] } } } });
    const old = [{ a: 1, o: 11 }, { a: 1, o: 12 }, { a: 1, o: 13 }];
    const out = await cancelOrders({ net: "testnet", agentKey: KEY, cancels: old });
    expect(out).toEqual([{ ok: true }, { ok: false, text: "Order was never placed, already canceled, or filled. asset=1" }, { ok: true }]);
    expect(describeCancels(old, out, existing).text).toBe("Cancelled: take profit 3,300, stop loss 2,900. Not cancelled: take profit 3,400 (That order is no longer open).");
  });
  it("a top-level error on cancel still throws", async () => {
    stub({ cancel: { status: "err", response: "Something else" } });
    await expect(cancelOrders({ net: "testnet", agentKey: KEY, cancels: [{ a: 1, o: 11 }] })).rejects.toThrow(/Something else/);
  });
});

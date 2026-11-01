import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plainError } from "../src/hl/errors";
import { outcomeText, planOrder } from "../src/hl/orders";
import { builderParam, placeOrder, submitPlan } from "../src/hl/trade";

const MASTER = "0x1111111111111111111111111111111111111111";
const BUILDER = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
const BTC = { index: 3, name: "BTC", szDecimals: 5, maxLeverage: 40 };

function stub(leverage: { type: string; value: number }, orderRes?: unknown) {
  const calls: { path: string; body: Record<string, any> }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const body = JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text());
    calls.push({ path, body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { headers: { "content-type": "application/json" } });
    if (path === "/info") return json({ user: MASTER, coin: "BTC", leverage, maxTradeSzs: ["1", "1"], availableToTrade: ["1", "1"], markPx: "80000" });
    if (body.action.type === "updateLeverage") return json({ status: "ok", response: { type: "default" } });
    if (orderRes) return json(orderRes);
    return json({ status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.001", avgPx: "80010", oid: 7 } }] } } });
  }));
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

describe("placeOrder", () => {
  const plan = (() => {
    const r = planOrder(BTC, { kind: "market", isBuy: true, size: 0.001, refPx: 80000, slippage: 0.05 });
    if (!r.ok) throw new Error(r.error);
    return r.plan;
  })();
  it("builder param is lowercase with f = 100 [T §3.3]", () => {
    expect(builderParam(BUILDER)).toEqual({ b: BUILDER.toLowerCase(), f: 100 });
  });
  it("switches to isolated at the chosen leverage, then sends the order with the builder", async () => {
    const calls = stub({ type: "cross", value: 20 });
    const out = await placeOrder({ net: "testnet", agentKey: generatePrivateKey(), master: MASTER, builder: BUILDER, market: BTC, leverage: 5, plan });
    expect(calls.map((c) => (c.path === "/info" ? c.body.type : c.body.action.type))).toEqual(["activeAssetData", "updateLeverage", "order"]);
    expect(calls[0].body).toEqual({ type: "activeAssetData", user: MASTER, coin: "BTC" });
    expect(calls[1].body.action).toMatchObject({ asset: 3, isCross: false, leverage: 5 });
    expect(calls[2].body.action).toMatchObject({ grouping: "na", builder: { b: BUILDER.toLowerCase(), f: 100 }, orders: [{ a: 3, b: true, p: "84000", s: "0.001", r: false }] });
    expect(out).toEqual([{ kind: "filled", totalSz: "0.001", avgPx: "80010" }]);
  });
  it("skips updateLeverage when already isolated at that leverage", async () => {
    const calls = stub({ type: "isolated", value: 5 });
    await placeOrder({ net: "testnet", agentKey: generatePrivateKey(), master: MASTER, builder: BUILDER, market: BTC, leverage: 5, plan });
    expect(calls.map((c) => (c.path === "/info" ? c.body.type : c.body.action.type))).toEqual(["activeAssetData", "order"]);
  });
});

describe("a batch with a rejected child (nktkas throws on any per-order error)", () => {
  const withSl = (() => {
    const r = planOrder(BTC, { kind: "market", isBuy: true, size: 0.001, refPx: 80000, slippage: 0.05, sl: 75000 });
    if (!r.ok) throw new Error(r.error);
    return r.plan;
  })();
  const mixed = { status: "ok", response: { type: "order", data: { statuses: [{ filled: { totalSz: "0.001", avgPx: "80010", oid: 7 } }, { error: "Order must have minimum value of $10." }] } } };

  it("hands the statuses back, so a filled entry is not reported as a failure", async () => {
    stub({ type: "isolated", value: 5 }, mixed);
    const out = await placeOrder({ net: "testnet", agentKey: generatePrivateKey(), master: MASTER, builder: BUILDER, market: BTC, leverage: 5, plan: withSl });
    expect(out).toEqual([{ kind: "filled", totalSz: "0.001", avgPx: "80010" }, { kind: "error", text: "Order must have minimum value of $10." }]);
    const r = outcomeText(out, withSl, "BTC");
    expect(r).toMatchObject({ ok: false, partial: true });
    expect(r.text).toBe("Your long of 0.001 BTC filled at 80010, but the stop loss was rejected: Orders must be worth at least $10. Your position has no stop loss: set one in Positions.");
  });
  it("all rejected still comes back as outcomes (plain first error, not nktkas's prefix)", async () => {
    stub({ type: "isolated", value: 5 }, { status: "ok", response: { type: "order", data: { statuses: [{ error: "Insufficient margin to place order." }, { error: "Insufficient margin to place order." }] } } });
    const out = await submitPlan({ net: "testnet", agentKey: generatePrivateKey(), builder: BUILDER, plan: withSl });
    expect(outcomeText(out, withSl)).toEqual({ ok: false, text: "Not enough margin for this order." });
  });
  it("a top-level error still throws, and the unknown-agent text asks for one re-sign", async () => {
    stub({ type: "isolated", value: 5 }, { status: "err", response: "User or API Wallet 0xf56b1cdd5c0ad3a2b4eb8ad1e48d4ac5d83a6dd2 does not exist." });
    const err = await submitPlan({ net: "testnet", agentKey: generatePrivateKey(), builder: BUILDER, plan: withSl }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(plainError(err).reSign).toBe(true);
  });
});

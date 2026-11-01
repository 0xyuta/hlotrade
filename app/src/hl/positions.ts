import { fmtPx } from "../ui/format";
import type { OpenOrder, Position } from "./account";
import { plainError } from "./errors";
import { roundSize, slippagePrice } from "./math";
import { checkTpsl, type OrderOutcome, tpslChild, type MarketRef, type OrderPlan, type OrderWire, type PlanResult } from "./orders";
import type { CancelOutcome } from "./trade";

const NO_PRICE = "No price yet. Wait a moment.";
const BAD_PRICE = "That price has too many digits or is too small for this market."; // roundPrice throws when a price rounds to 0 [T §3.5]

function ioc(m: MarketRef, isBuy: boolean, size: number, refPx: number, slippage: number, reduceOnly: boolean): PlanResult {
  if (!(refPx > 0) || !Number.isFinite(refPx)) return { ok: false, error: NO_PRICE };
  if (!(slippage >= 0 && slippage < 1)) return { ok: false, error: "Max slippage must be between 0% and 100%." };
  try {
    const s = roundSize(size, m.szDecimals, "down");
    if (Number(s) === 0) return { ok: false, error: "Nothing to close." };
    const order: OrderWire = { a: m.index, b: isBuy, p: slippagePrice(refPx, isBuy, slippage, m.szDecimals), s, r: reduceOnly, t: { limit: { tif: "Ioc" } } };
    return { ok: true, plan: { orders: [order], grouping: "na", px: refPx, notional: Number(s) * refPx } };
  } catch {
    return { ok: false, error: BAD_PRICE };
  }
}

/** Reduce-only IOC on the other side for the whole position [T §3.4]. */
export const planClose = (m: MarketRef, p: Position, refPx: number, slippage: number) => ioc(m, p.szi < 0, Math.abs(p.szi), refPx, slippage, true);

/** Twice the size the other way: closes, then opens the same size in the other direction. */
export const planReverse = (m: MarketRef, p: Position, refPx: number, slippage: number) => ioc(m, p.szi < 0, 2 * Math.abs(p.szi), refPx, slippage, false);

/** TP/SL on an open position: grouping positionTpsl, size = the whole position (UNCONFIRMED [T §3.2]). */
export function planPositionTpsl(m: MarketRef, p: Position, refPx: number, t: { tp?: number; sl?: number }): PlanResult {
  if (t.tp === undefined && t.sl === undefined) return { ok: false, error: "Choose a take-profit or stop-loss %." };
  for (const [v, label] of [[t.tp, "take profit"], [t.sl, "stop loss"]] as const) {
    if (v !== undefined && !(v > 0 && Number.isFinite(v))) return { ok: false, error: `Enter a ${label} % above 0.` };
  }
  if (!(refPx > 0) || !Number.isFinite(refPx)) return { ok: false, error: NO_PRICE }; // without it the side check below would pass for any price
  const isLong = p.szi > 0;
  const bad = checkTpsl(isLong, refPx, t.tp, t.sl);
  if (bad) return { ok: false, error: bad };
  try {
    const s = roundSize(Math.abs(p.szi), m.szDecimals, "down");
    if (Number(s) === 0) return { ok: false, error: "Nothing to protect." };
    const orders: OrderWire[] = [];
    if (t.tp !== undefined) orders.push(tpslChild(m, !isLong, t.tp, s, "tp"));
    if (t.sl !== undefined) orders.push(tpslChild(m, !isLong, t.sl, s, "sl"));
    return { ok: true, plan: { orders, grouping: "positionTpsl", px: refPx, notional: Number(s) * refPx } };
  } catch {
    return { ok: false, error: BAD_PRICE };
  }
}

/** The reduce-only trigger orders of a coin: "Take Profit …" is TP; "Stop …" is SL [T §4.3]. */
export function tpslOrdersFor(coin: string, orders: OpenOrder[]): { tp: OpenOrder | null; sl: OpenOrder | null } {
  const mine = orders.filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly);
  return {
    tp: mine.find((o) => o.orderType.startsWith("Take Profit")) ?? null,
    sl: mine.find((o) => o.orderType.startsWith("Stop")) ?? null,
  };
}

/**
 * Every reduce-only trigger order of a coin: what an edit or a removal must cancel. A coin can hold several TPs and SLs
 * (each entry placed with TP/SL adds its own pair), and `tpslOrdersFor` shows only the first of each.
 */
export const tpslOrdersAll = (coin: string, orders: OpenOrder[]): OpenOrder[] => orders.filter((o) => o.coin === coin && o.isTrigger && o.reduceOnly);

/** An open order as a short phrase for messages. */
function orderLabel(oid: number, orders: OpenOrder[]): string {
  const o = orders.find((x) => x.oid === oid);
  if (!o) return `order ${oid}`;
  if (o.isTrigger && o.triggerPx !== null) {
    if (o.orderType.startsWith("Take Profit")) return `take profit ${fmtPx(o.triggerPx)}`;
    if (o.orderType.startsWith("Stop")) return `stop loss ${fmtPx(o.triggerPx)}`;
  }
  return `${o.orderType.toLowerCase()} order ${o.coin} ${fmtPx(o.limitPx)}`;
}

/** The words for a cancel batch: all done, or which were cancelled and which not (HL cancels the others even when one fails). */
export function describeCancels(cancels: { a: number; o: number }[], outcomes: CancelOutcome[], orders: OpenOrder[]): { ok: boolean; text: string } {
  const bad = cancels.flatMap((c, i) => {
    const r = outcomes[i];
    return r?.ok ? [] : [{ oid: c.o, text: plainError(r ? r.text : "No status came back.").text.replace(/\.$/, "") }];
  });
  if (bad.length === 0) return { ok: true, text: cancels.length === 1 ? "Order cancelled." : `${cancels.length} orders cancelled.` };
  if (cancels.length === 1) return { ok: false, text: `${bad[0].text}.` };
  const done = cancels.filter((c) => !bad.some((b) => b.oid === c.o)).map((c) => orderLabel(c.o, orders));
  const not = bad.map((b) => `${orderLabel(b.oid, orders)} (${b.text})`);
  return { ok: false, text: `${done.length ? `Cancelled: ${done.join(", ")}. ` : "Nothing was cancelled. "}Not cancelled: ${not.join(", ")}.` };
}

/** A fill that is smaller than the order (an IOC that matched only part): say what is left. */
export function fillNote(result: { ok: boolean; text: string; partial?: true }, outcomes: OrderOutcome[], plan: OrderPlan): { ok: boolean; text: string; partial?: true } {
  const first = outcomes[0];
  const sent = Number(plan.orders[0]?.s);
  if (!result.ok || first?.kind !== "filled" || !(sent > 0)) return result;
  const got = Number(first.totalSz);
  if (!(got < sent - 1e-9)) return result;
  return { ...result, text: `Filled ${first.totalSz} of ${plan.orders[0].s} at ${first.avgPx}. The rest did not fill at your slippage limit. Check Positions before trying again.` };
}

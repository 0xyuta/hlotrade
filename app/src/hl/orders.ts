import { plainError } from "./errors";
import type { Market } from "./markets";
import { MIN_ORDER_USD, roundPrice, roundSize, slippagePrice } from "./math";
import { fmtPx } from "../ui/format";

/** A form field as a number: blank is undefined (not set), anything else goes through Number (so "abc" is NaN and planOrder rejects it). */
export const num = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s));

export type Tif = "Gtc" | "Ioc" | "Alo";
export interface OrderWire {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: Tif } } | { trigger: { isMarket: boolean; triggerPx: string; tpsl: "tp" | "sl" } };
}
export type MarketRef = Pick<Market, "index" | "name" | "szDecimals" | "maxLeverage">;

export interface OrderInput {
  kind: "market" | "limit";
  isBuy: boolean;
  size: number; // coin units
  refPx: number; // live mid
  limitPx?: number;
  slippage: number; // market orders only
  tp?: number;
  sl?: number;
}

/** [T §3.2] TP/SL market orders fill within 10% of the trigger; the child limit price p carries that bound. */
export const TPSL_SLIPPAGE = 0.1;

export interface OrderPlan {
  orders: OrderWire[];
  grouping: "na" | "normalTpsl" | "positionTpsl";
  px: number; // expected entry: the ref price (market) or the limit price
  notional: number;
}
export type PlanResult = { ok: true; plan: OrderPlan } | { ok: false; error: string };

/** A reduce-only trigger order that closes `size` (closeIsBuy = buying back a short). */
export function tpslChild(m: MarketRef, closeIsBuy: boolean, trigger: number, size: string, kind: "tp" | "sl"): OrderWire {
  return {
    a: m.index,
    b: closeIsBuy,
    p: slippagePrice(trigger, closeIsBuy, TPSL_SLIPPAGE, m.szDecimals),
    s: size,
    r: true,
    t: { trigger: { isMarket: true, triggerPx: roundPrice(trigger, m.szDecimals), tpsl: kind } },
  };
}

export function checkTpsl(isLong: boolean, ref: number, tp?: number, sl?: number): string | null {
  const side = isLong ? "long" : "short";
  if (tp !== undefined && (isLong ? tp <= ref : tp >= ref)) return `For a ${side}, take profit must be ${isLong ? "above" : "below"} ${fmtPx(ref)}.`;
  if (sl !== undefined && (isLong ? sl >= ref : sl <= ref)) return `For a ${side}, stop loss must be ${isLong ? "below" : "above"} ${fmtPx(ref)}.`;
  return null;
}

export function planOrder(m: MarketRef, o: OrderInput): PlanResult {
  const fail = (error: string): PlanResult => ({ ok: false, error });
  if (!(o.size > 0) || !Number.isFinite(o.size)) return fail("Enter a size.");
  if (o.kind === "market" && !(o.slippage >= 0 && o.slippage < 1)) return fail("Max slippage must be between 0% and 100%.");
  for (const [v, label] of [[o.tp, "take profit"], [o.sl, "stop loss"]] as const) {
    if (v !== undefined && !(v > 0 && Number.isFinite(v))) return fail(`Enter a ${label} % above 0.`);
  }
  try {
    return plan(m, o);
  } catch (e) {
    if (e instanceof Error && /^price /.test(e.message)) return fail("That price has too many digits or is too small for this market."); // roundPrice throws when a price rounds to 0 [T §3.5]
    throw e; // a real bug must not be worded as a price problem
  }
}

function plan(m: MarketRef, o: OrderInput): PlanResult {
  const fail = (error: string): PlanResult => ({ ok: false, error });
  const s = roundSize(o.size, m.szDecimals, "down");
  if (Number(s) === 0) return fail(`The size rounds to 0 for ${m.name} (${m.szDecimals} decimals).`);
  let p: string;
  let px: number;
  if (o.kind === "limit") {
    if (!(o.limitPx && o.limitPx > 0)) return fail("Enter a limit price.");
    p = roundPrice(o.limitPx, m.szDecimals);
    px = Number(p);
  } else {
    if (!(o.refPx > 0)) return fail("No price yet. Wait a moment.");
    p = slippagePrice(o.refPx, o.isBuy, o.slippage, m.szDecimals);
    px = o.refPx;
  }
  const notional = Number(s) * px;
  // The $10 floor is checked at the worse of the mid and the order price (which side the exchange uses is UNCONFIRMED [T §3.5]).
  if (Number(s) * Math.min(px, Number(p)) < MIN_ORDER_USD) return fail("Orders must be worth at least $10.");
  const bad = checkTpsl(o.isBuy, px, o.tp, o.sl);
  if (bad) return fail(bad);
  const orders: OrderWire[] = [{ a: m.index, b: o.isBuy, p, s, r: false, t: { limit: { tif: o.kind === "market" ? "Ioc" : "Gtc" } } }];
  if (o.tp !== undefined) orders.push(tpslChild(m, !o.isBuy, o.tp, s, "tp"));
  if (o.sl !== undefined) orders.push(tpslChild(m, !o.isBuy, o.sl, s, "sl"));
  return { ok: true, plan: { orders, grouping: orders.length > 1 ? "normalTpsl" : "na", px, notional } };
}

export const needsLeverageUpdate = (current: { type: string; value: number } | null, leverage: number) =>
  !current || current.type !== "isolated" || current.value !== leverage;

export type OrderOutcome =
  | { kind: "filled"; totalSz: string; avgPx: string }
  | { kind: "resting"; oid: number }
  | { kind: "waiting" }
  | { kind: "error"; text: string };

export function summarizeStatuses(statuses: unknown): OrderOutcome[] {
  if (!Array.isArray(statuses)) return [];
  return statuses.map((x): OrderOutcome => {
    const s = x as Record<string, any>;
    if (s && typeof s === "object") {
      if (s.filled) return { kind: "filled", totalSz: String(s.filled.totalSz), avgPx: String(s.filled.avgPx) };
      if (s.resting) return { kind: "resting", oid: Number(s.resting.oid) };
      if (typeof s.error === "string") return { kind: "error", text: s.error };
    }
    return { kind: "waiting" }; // e.g. a TP/SL child "waitingForTrigger" (nktkas type, undocumented) [T §3.8]
  });
}

const isLive = (x: OrderOutcome) => x.kind !== "error";

/** What an order of the plan is called in a message: the entry, or its take profit / stop loss. */
function labelOf(plan: OrderPlan | undefined, i: number): "entry" | "take profit" | "stop loss" | null {
  const w = plan?.orders[i];
  if (!w) return null;
  if ("trigger" in w.t) return w.t.trigger.tpsl === "tp" ? "take profit" : "stop loss";
  return "entry";
}

/**
 * The words for a batch result. When some orders went through and others were rejected (nktkas throws on any per-order
 * error, so submitPlan hands the statuses back instead [T §3.8]), the text says what is live and what is missing,
 * and `partial` is set: the caller must refetch and must not invite a second click.
 * `plan` (the orders as sent) and `coin` only improve the wording.
 */
export function outcomeText(o: OrderOutcome[], plan?: OrderPlan, coin?: string): { ok: boolean; text: string; partial?: true } {
  const errors = o.flatMap((x, i) => (x.kind === "error" ? [{ i, text: plainError(x.text).text }] : []));
  if (errors.length && !o.some(isLive)) return { ok: false, text: errors[0].text };
  if (errors.length) {
    const phrase = (x: OrderOutcome, i: number): string => {
      const label = labelOf(plan, i);
      if (label === "take profit" || label === "stop loss") return `your ${label} was placed`;
      const w = plan?.orders[i];
      const noun = w ? (w.r ? (w.b ? "buy" : "sell") : w.b ? "long" : "short") : null;
      if (x.kind === "filled") return `${noun ? `your ${noun} of ${x.totalSz}${coin ? ` ${coin}` : ""}` : `an order of ${x.totalSz}`} filled at ${x.avgPx}`;
      return `${noun ? `your ${noun} order` : "an order"} is resting`;
    };
    const live = o.flatMap((x, i) => (isLive(x) ? [phrase(x, i)] : []));
    const rejected = errors.map((e) => `the ${labelOf(plan, e.i) ?? `order ${e.i + 1}`} was rejected: ${e.text.replace(/\.$/, "")}`);
    const lost = errors.flatMap((e) => { const l = labelOf(plan, e.i); return l === "take profit" || l === "stop loss" ? [l] : []; });
    const entryFilled = o.some((x, i) => x.kind === "filled" && labelOf(plan, i) === "entry");
    const advice = lost.length && entryFilled
      ? ` Your position has no ${lost.join(" or ")}: set ${lost.length > 1 ? "them" : "one"} in Positions.`
      : " Check Positions and Open orders before trying again.";
    const text = `${live.join(" and ")}, but ${rejected.join(", and ")}.${advice}`;
    return { ok: false, partial: true, text: text[0].toUpperCase() + text.slice(1) };
  }
  const first = o[0];
  if (!first) return { ok: false, text: "No status came back. Check open orders and positions." };
  if (first.kind === "filled") return { ok: true, text: `Filled ${first.totalSz} at ${first.avgPx}.` };
  return { ok: true, text: "Order placed (resting)." };
}

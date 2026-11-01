import type { Hex } from "viem";
import type { Address, Network } from "../config/validate";
import { agentExchange, infoPost } from "./clients";
import { BUILDER_F } from "./math";
import { needsLeverageUpdate, summarizeStatuses, type MarketRef, type OrderOutcome, type OrderPlan } from "./orders";

export interface Builder {
  b: Address;
  f: number;
}
/** [T §3.3] lowercase address, f in tenths of a bp: 100 = 0.1%. */
export const builderParam = (builder: Address): Builder => ({ b: builder.toLowerCase() as Address, f: BUILDER_F });

/** The per-order statuses nktkas keeps on the error it throws for `{status:"ok", response:{type:"order", data:{statuses:[…{error}…]}}}`. */
function statusesOfError(e: unknown, type: "order" | "cancel" = "order"): unknown[] | null {
  if (!e || typeof e !== "object" || (e as { name?: unknown }).name !== "ApiRequestError") return null;
  const r = (e as { response?: { response?: { type?: unknown; data?: { statuses?: unknown } } } }).response?.response;
  return r?.type === type && Array.isArray(r.data?.statuses) ? r.data.statuses : null;
}

/**
 * Sends the plan with the builder on the action. nktkas throws as soon as ANY order of the batch has an error status,
 * which would hide a filled entry behind a rejected stop loss; so the statuses are read back off that error and returned
 * as outcomes (also when all failed). Anything else (a top-level err, a network failure) still throws [T §3.8].
 */
export async function submitPlan(o: { net: Network; agentKey: Hex; builder: Address; plan: OrderPlan }): Promise<OrderOutcome[]> {
  try {
    const res = await agentExchange(o.net, o.agentKey).order({ orders: o.plan.orders, grouping: o.plan.grouping, builder: builderParam(o.builder) } as never);
    return summarizeStatuses((res as { response?: { data?: { statuses?: unknown } } }).response?.data?.statuses);
  } catch (e) {
    const statuses = statusesOfError(e);
    if (statuses) return summarizeStatuses(statuses);
    throw e;
  }
}

/** Isolated margin at `leverage` (updateLeverage only when needed [T §3.6]), then the order. */
export async function placeOrder(o: {
  net: Network; agentKey: Hex; master: Address; builder: Address; market: MarketRef; leverage: number; plan: OrderPlan;
}): Promise<OrderOutcome[]> {
  const data = await infoPost<{ leverage?: { type: string; value: number } }>(o.net, { type: "activeAssetData", user: o.master, coin: o.market.name });
  if (needsLeverageUpdate(data?.leverage ?? null, o.leverage)) {
    await agentExchange(o.net, o.agentKey).updateLeverage({ asset: o.market.index, isCross: false, leverage: o.leverage });
  }
  return submitPlan(o);
}

/** One cancel of a batch: done, or why not (HL's words; plainError turns them into plain ones). */
export type CancelOutcome = { ok: true } | { ok: false; text: string };

export function summarizeCancels(statuses: unknown, count: number): CancelOutcome[] {
  if (!Array.isArray(statuses)) return Array.from({ length: count }, () => ({ ok: false, text: "No status came back. Check Open orders." }));
  return statuses.map((x): CancelOutcome => {
    if (x === "success") return { ok: true };
    const text = x && typeof x === "object" && typeof (x as { error?: unknown }).error === "string" ? (x as { error: string }).error : "Unknown status.";
    return { ok: false, text };
  });
}

/**
 * [T §3.7] cancel by oid; works on trigger orders (no `f` flag). nktkas throws when ANY cancel of the batch has an error
 * status, even though the others went through, so the per-cancel statuses are read back off that error and returned (as
 * submitPlan does for orders). A top-level error or a network failure still throws.
 */
export async function cancelOrders(o: { net: Network; agentKey: Hex; cancels: { a: number; o: number }[] }): Promise<CancelOutcome[]> {
  try {
    const res = await agentExchange(o.net, o.agentKey).cancel({ cancels: o.cancels });
    return summarizeCancels((res as { response?: { data?: { statuses?: unknown } } }).response?.data?.statuses, o.cancels.length);
  } catch (e) {
    const statuses = statusesOfError(e, "cancel");
    if (statuses) return summarizeCancels(statuses, o.cancels.length);
    throw e;
  }
}

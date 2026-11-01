import { BASE_TAKER_RATE } from "./math";

const isObj = (x: unknown): x is Record<string, any> => typeof x === "object" && x !== null;
const n = (x: unknown, d = 0): number => {
  const v = typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
  return Number.isFinite(v) ? v : d;
};
const nOrNull = (x: unknown): number | null => (x === null || x === undefined || x === "" ? null : Number.isFinite(Number(x)) ? Number(x) : null);

export interface Position {
  coin: string;
  szi: number; // signed: negative = short
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  liquidationPx: number | null; // null possible [T §4.2 UNCONFIRMED]
  leverage: { type: "cross" | "isolated"; value: number };
  marginUsed: number;
}

export function parsePositions(ch: unknown): Position[] {
  if (!isObj(ch) || !Array.isArray(ch.assetPositions)) return [];
  return ch.assetPositions.flatMap((ap: unknown) => {
    const p = isObj(ap) ? ap.position : null;
    if (!isObj(p) || typeof p.coin !== "string" || n(p.szi) === 0) return [];
    return [{
      coin: p.coin,
      szi: n(p.szi),
      entryPx: n(p.entryPx),
      positionValue: n(p.positionValue),
      unrealizedPnl: n(p.unrealizedPnl),
      returnOnEquity: n(p.returnOnEquity),
      liquidationPx: nOrNull(p.liquidationPx),
      leverage: { type: p.leverage?.type === "isolated" ? "isolated" : "cross", value: n(p.leverage?.value, 1) },
      marginUsed: n(p.marginUsed),
    } satisfies Position];
  });
}

export type Abstraction = "unifiedAccount" | "portfolioMargin" | "disabled" | "default" | "dexAbstraction" | "unknown";
const ABSTRACTIONS = new Set(["unifiedAccount", "portfolioMargin", "disabled", "default", "dexAbstraction"]);
export const parseAbstraction = (raw: unknown): Abstraction => (typeof raw === "string" && ABSTRACTIONS.has(raw) ? (raw as Abstraction) : "unknown");

export interface Balances {
  perps: number; // clearinghouseState.withdrawable
  spot: number; // spot USDC total − hold
  trade: number; // the one the trade screen shows
  source: "perps" | "spot";
}

/** [R §2.4] unified and portfolio margin keep balances in spot; "default" is treated as standard until tested. */
export function balances(o: { abstraction: Abstraction; clearinghouse: unknown; spot: unknown }): Balances {
  const perps = isObj(o.clearinghouse) ? n(o.clearinghouse.withdrawable) : 0;
  const usdc = isObj(o.spot) && Array.isArray(o.spot.balances) ? o.spot.balances.find((b: any) => isObj(b) && b.coin === "USDC") : undefined;
  const spot = usdc ? Math.max(0, n(usdc.total) - n(usdc.hold)) : 0;
  const source = o.abstraction === "unifiedAccount" || o.abstraction === "portfolioMargin" ? "spot" : "perps";
  return { perps, spot, trade: source === "spot" ? spot : perps, source };
}

export interface OpenOrder {
  coin: string;
  side: "B" | "A";
  limitPx: number;
  sz: number;
  oid: number;
  timestamp: number;
  isTrigger: boolean;
  triggerPx: number | null;
  orderType: string;
  reduceOnly: boolean;
  isPositionTpsl: boolean;
}

/** [T §4.3] frontendOpenOrders. */
export function parseOpenOrders(raw: unknown): OpenOrder[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((o: unknown) => {
    if (!isObj(o) || typeof o.coin !== "string") return [];
    return [{
      coin: o.coin,
      side: o.side === "A" ? "A" : "B",
      limitPx: n(o.limitPx),
      sz: n(o.sz),
      oid: n(o.oid),
      timestamp: n(o.timestamp),
      isTrigger: o.isTrigger === true,
      triggerPx: o.isTrigger ? nOrNull(o.triggerPx) : null,
      orderType: typeof o.orderType === "string" ? o.orderType : "Limit",
      reduceOnly: o.reduceOnly === true,
      isPositionTpsl: o.isPositionTpsl === true,
    } satisfies OpenOrder];
  });
}

export interface Fill {
  coin: string;
  px: number;
  sz: number;
  side: "B" | "A";
  time: number;
  dir: string;
  closedPnl: number;
  fee: number; // total, includes builderFee [T §4.4]
  builderFee: number;
  oid: number;
  tid: number;
}

export function parseFills(raw: unknown): Fill[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f: unknown) => {
    if (!isObj(f) || typeof f.coin !== "string") return [];
    return [{
      coin: f.coin, px: n(f.px), sz: n(f.sz), side: f.side === "A" ? "A" : "B", time: n(f.time), dir: String(f.dir ?? ""),
      closedPnl: n(f.closedPnl), fee: n(f.fee), builderFee: n(f.builderFee), oid: n(f.oid), tid: n(f.tid),
    } satisfies Fill];
  });
}

/** [T §4.6] userCrossRate (taker, staking discount included); referral discount UNCONFIRMED, so this can only overstate. */
export const takerRate = (userFees: unknown) => (isObj(userFees) && Number(userFees.userCrossRate) > 0 ? Number(userFees.userCrossRate) : BASE_TAKER_RATE);

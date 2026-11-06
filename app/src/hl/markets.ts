/** The market the trade screen has open (browser storage). */
export const COIN_KEY = "hlo:coin";

export interface Market {
  index: number; // asset index `a` on this network [T §4.1]
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean; // onlyIsolated, or marginMode strictIsolated / noCross
  markPx: number;
  midPx: number | null;
  oraclePx: number;
  prevDayPx: number;
  dayNtlVlm: number;
  funding: number;
  openInterest: number; // unit UNCONFIRMED [T §4.1]; shown as a plain number
}

const num = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** [T §4.1] [meta, ctxs] → tradable markets (delisted dropped), busiest first. */
export function toMarkets(raw: unknown): Market[] {
  if (!Array.isArray(raw) || raw.length < 2 || !isObj(raw[0]) || !Array.isArray(raw[0].universe) || !Array.isArray(raw[1])) return [];
  const universe = raw[0].universe as unknown[];
  const ctxs = raw[1] as unknown[];
  const out: Market[] = [];
  for (let i = 0; i < universe.length; i++) {
    const u = universe[i];
    const c = ctxs[i];
    if (!isObj(u) || !isObj(c) || typeof u.name !== "string" || u.isDelisted === true) continue;
    const szDecimals = num(u.szDecimals);
    const maxLeverage = num(u.maxLeverage);
    const markPx = num(c.markPx);
    if (szDecimals === null || maxLeverage === null || markPx === null) continue;
    out.push({
      index: i,
      name: u.name,
      szDecimals,
      maxLeverage,
      onlyIsolated: u.onlyIsolated === true || u.marginMode === "strictIsolated" || u.marginMode === "noCross",
      markPx,
      midPx: num(c.midPx),
      oraclePx: num(c.oraclePx) ?? markPx,
      prevDayPx: num(c.prevDayPx) ?? markPx,
      dayNtlVlm: num(c.dayNtlVlm) ?? 0,
      funding: num(c.funding) ?? 0,
      openInterest: num(c.openInterest) ?? 0,
    });
  }
  return out.sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
}

/** allMids (WS `{mids}` or the info response itself) → numbers. */
export function parseMids(raw: unknown): Record<string, number> {
  const src = isObj(raw) && isObj(raw.mids) ? raw.mids : raw;
  const out: Record<string, number> = {};
  if (!isObj(src)) return out;
  for (const [k, v] of Object.entries(src)) {
    const n = num(v);
    if (n !== null) out[k] = n;
  }
  return out;
}

export const livePrice = (m: Market, mids: Record<string, number>) => mids[m.name] ?? m.midPx ?? m.markPx;

/** [T §4.5] the chart offers a subset of the supported intervals. */
export const CHART_INTERVALS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];
export const INTERVAL_MS: Record<ChartInterval, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000,
};

export interface Bar {
  time: number; // seconds (lightweight-charts UTCTimestamp)
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Snapshot rows are strings, WS rows may be numbers [T §1.5]. */
export function toBar(c: unknown): Bar | null {
  if (!isObj(c)) return null;
  const t = num(c.t), o = num(c.o), h = num(c.h), l = num(c.l), cl = num(c.c);
  if (t === null || o === null || h === null || l === null || cl === null) return null;
  return { time: Math.floor(t / 1000), open: o, high: h, low: l, close: cl };
}

export const candleWindow = (interval: ChartInterval, nowMs: number, bars = 500) => ({ startTime: nowMs - bars * INTERVAL_MS[interval], endTime: nowMs });

export function mergeBar(bars: Bar[], b: Bar): Bar[] {
  const last = bars[bars.length - 1];
  if (!last || b.time > last.time) return [...bars, b];
  if (b.time === last.time) return [...bars.slice(0, -1), b];
  return bars;
}

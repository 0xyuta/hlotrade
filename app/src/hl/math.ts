/** [T §3.3] 0.1% builder fee; `f` is in tenths of a basis point, so 0.1% = 100. The rate is derived so they cannot drift. */
export const BUILDER_F = 100;
export const BUILDER_FEE_RATE = BUILDER_F / 100_000;
/** [T §3.5] perps: price decimals ≤ 6 − szDecimals, 5 significant figures, integers always allowed. */
export const PERP_MAX_DECIMALS = 6;
/** [T §3.4] Python SDK default slippage for IOC "market" orders. */
export const DEFAULT_SLIPPAGE = 0.05;
/** [T §3.5] "Order must have minimum value of $10." */
export const MIN_ORDER_USD = 10;
/** [T §4.6] tier-0 perps taker rate, used before userFees is known. */
export const BASE_TAKER_RATE = 0.00045;

export type RoundDir = "up" | "down" | "nearest";

export const priceDecimals = (szDecimals: number) => Math.max(PERP_MAX_DECIMALS - szDecimals, 0);

/**
 * Rounds x to `decimals` places. toFixed(6) first removes binary noise (0.0012345 × 1e6 = 1234.4999999999998).
 * The snap moves values within 5e-7 of a tick onto it in every direction (about 1e-8 relative at these sizes), which
 * is far below anything a price or size can express.
 */
function roundTo(x: number, decimals: number, dir: RoundDir): number {
  const f = 10 ** decimals;
  const y = Number((x * f).toFixed(6));
  const r = dir === "up" ? Math.ceil(y) : dir === "down" ? Math.floor(y) : Math.round(y);
  return r / f;
}

const plain = (v: number, decimals: number) => {
  const s = v.toFixed(decimals);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
};

/**
 * Decimals a price at `px` may carry [T §3.5]: at most 6 − szDecimals, and at most 5 significant figures
 * (so none once the price has 5 integer digits). Used for the order price and for the chart's price scale.
 */
export function priceTickDecimals(px: number, szDecimals: number): number {
  const intDigits = Math.floor(Math.log10(px)) + 1; // ≤ 0 below 1
  return Math.max(0, Math.min(priceDecimals(szDecimals), 5 - intDigits));
}

/** Throws when the input is not a positive price or when rounding leaves 0 (NK `formatPrice` does the same [T §3.5]). */
export function roundPrice(px: number, szDecimals: number, dir: RoundDir = "nearest"): string {
  if (!(px > 0) || !Number.isFinite(px)) throw new Error("price must be > 0");
  // 5+ integer digits gives 0 decimals: an integer is always valid
  const decimals = priceTickDecimals(px, szDecimals);
  const out = plain(roundTo(px, decimals, dir), decimals);
  if (Number(out) <= 0) throw new Error("price rounds to 0");
  return out;
}

/** May return "0" (a size below one lot): the caller must treat that as "too small" and also check MIN_ORDER_USD on size × price. */
export function roundSize(sz: number, szDecimals: number, dir: RoundDir = "down"): string {
  if (!(sz >= 0) || !Number.isFinite(sz)) throw new Error("size must be ≥ 0");
  return plain(roundTo(sz, szDecimals, dir), szDecimals);
}

/** IOC limit price for a "market" order: buys at ref × (1 + s) rounded up, sells at ref × (1 − s) rounded down. */
export function slippagePrice(ref: number, isBuy: boolean, slippage: number, szDecimals: number): string {
  return roundPrice(ref * (isBuy ? 1 + slippage : 1 - slippage), szDecimals, isBuy ? "up" : "down");
}


export const sizeFromMargin = (marginUsd: number, leverage: number, price: number, szDecimals: number) =>
  roundSize((marginUsd * leverage) / price, szDecimals, "down");

/**
 * [T §5.1] Isolated liquidation price for a single-tier asset. Null when it is not a clearly positive price: a 1x long
 * cannot be liquidated and the algebra gives 0 plus rounding noise, so anything below entry × 1e-9 counts as none.
 * An estimate only: `entry` should be the mark price for an open position, it uses the first margin tier's
 * `maxLeverage`, and it does not model cross margin. Show `position.liquidationPx` once there is a position.
 */
export function liqPriceIsolated(o: { entry: number; size: number; isLong: boolean; isolatedMargin: number; maxLeverage: number }): number | null {
  const side = o.isLong ? 1 : -1;
  const l = 1 / (2 * o.maxLeverage);
  const available = o.isolatedMargin - o.size * o.entry * l;
  const px = o.entry - (side * available) / o.size / (1 - l * side);
  return Number.isFinite(px) && px > o.entry * 1e-9 ? px : null;
}

/** Pre-trade estimate: isolated margin = notional ÷ leverage [T §5.1]. Shown as an estimate. */
export const estimateLiq = (entry: number, size: number, isLong: boolean, leverage: number, maxLeverage: number) =>
  liqPriceIsolated({ entry, size, isLong, isolatedMargin: (entry * size) / leverage, maxLeverage });

/**
 * TP/SL chosen as a % of margin (return on margin, so leverage counts): the price moves pct ÷ leverage % from entry,
 * away from it for a take profit and toward it for a stop loss. NaN when the % is not a positive number or the price
 * would be 0 or less, so the order plan refuses it instead of silently dropping the leg.
 */
export function tpslPriceFromPct(o: { entry: number; pct: number; leverage: number; isLong: boolean; kind: "tp" | "sl" }): number {
  if (!(o.pct > 0) || !Number.isFinite(o.pct) || !(o.entry > 0) || !(o.leverage > 0)) return Number.NaN;
  const up = (o.kind === "tp") === o.isLong;
  const px = o.entry * (1 + ((up ? 1 : -1) * o.pct) / 100 / o.leverage);
  return px > 0 && Number.isFinite(px) ? px : Number.NaN;
}

/** The inverse, for showing an existing trigger as a %; negative when the trigger is on the wrong side of entry. */
export function pctFromTpslPrice(o: { entry: number; price: number; leverage: number; isLong: boolean; kind: "tp" | "sl" }): number {
  if (!(o.entry > 0) || !(o.leverage > 0) || !(o.price > 0)) return Number.NaN;
  const up = (o.kind === "tp") === o.isLong;
  return ((up ? 1 : -1) * (o.price - o.entry) * 100 * o.leverage) / o.entry;
}

/** A limit price pct % from the current price, on the market's tick. Always from `ref`, so presets never add up. "" without a price. */
export const limitFromPct = (ref: number, pct: number, szDecimals: number): string =>
  ref > 0 && Number.isFinite(ref) ? roundPrice(ref * (1 + pct / 100), szDecimals) : "";

/** [T §4.1] the docs define no 24h formula; callers pass the live mid (or markPx when there is none) against prevDayPx. */
export const change24h = (mark: number, prevDay: number) => ((mark - prevDay) / prevDay) * 100;
export const livePnl = (szi: number, entryPx: number, mid: number) => szi * (mid - entryPx);

/** Decimal USD string → 1e-8 USDC units (the reward files' unit), truncating extra decimals. */
export function usdToUnits(s: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`bad USD amount "${s}"`);
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").slice(0, 8).padEnd(8, "0"));
}

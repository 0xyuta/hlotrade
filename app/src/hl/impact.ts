/** Price impact of a market order, estimated by walking Hyperliquid's l2Book (its top 20 levels a side). */

export interface BookLevel {
  px: number;
  sz: number;
}
export interface Book {
  bids: BookLevel[]; // best (highest) first
  asks: BookLevel[]; // best (lowest) first
}

/** At or above this the order form and the position buttons warn and ask before sending. */
export const IMPACT_WARN_PCT = 1;

/** The `l2Book` info response → numbers; null when it is not a book. */
export function parseBook(raw: unknown): Book | null {
  const levels = (raw as { levels?: unknown } | null)?.levels;
  if (!Array.isArray(levels) || levels.length !== 2) return null;
  const side = (l: unknown): BookLevel[] | null => {
    if (!Array.isArray(l)) return null;
    const out = l.map((x) => ({ px: Number((x as { px?: unknown }).px), sz: Number((x as { sz?: unknown }).sz) }));
    return out.every((x) => x.px > 0 && x.sz > 0) ? out : null;
  };
  const bids = side(levels[0]);
  const asks = side(levels[1]);
  return bids && asks ? { bids, asks } : null;
}

export interface Impact {
  mid: number;
  avgPx: number; // average fill price over what the visible book holds
  worstPx: number; // the last level reached
  pct: number; // how much worse than the mid the average is, in %
  costUsd: number; // what that costs against filling all of it at the mid
  covered: boolean; // false: the visible book holds less than the size, so the real impact is larger
}

/** Walks the side a buy (asks) or a sell (bids) takes. Null without a two-sided book or a size. */
export function priceImpact(book: Book, isBuy: boolean, size: number): Impact | null {
  const bid = book.bids[0]?.px;
  const ask = book.asks[0]?.px;
  if (!(bid > 0) || !(ask > 0) || !(size > 0)) return null;
  const mid = (bid + ask) / 2;
  let left = size;
  let cost = 0;
  let worstPx = 0;
  for (const l of isBuy ? book.asks : book.bids) {
    const take = Math.min(left, l.sz);
    cost += take * l.px;
    worstPx = l.px;
    left -= take;
    if (left <= size * 1e-9) {
      left = 0;
      break;
    }
  }
  const filled = size - left;
  const avgPx = cost / filled;
  const worse = isBuy ? avgPx - mid : mid - avgPx;
  return { mid, avgPx, worstPx, pct: (worse / mid) * 100, costUsd: worse * filled, covered: left === 0 };
}

export const shouldWarn = (i: Impact) => !i.covered || i.pct >= IMPACT_WARN_PCT;

/** "0.03%", "about 1.75%" style number for the UI; "more than" when the visible book runs out. */
export function impactPctText(i: Impact): string {
  const p = Math.max(0, i.pct);
  const n = p < 0.01 ? "under 0.01%" : `${p.toFixed(2)}%`;
  return i.covered ? n : `more than ${n}`;
}

/** True when the fills would go past the order's limit (the max-slippage price), so only part of it fills. */
export const passesLimit = (i: Impact, isBuy: boolean, limitPx: number) => !i.covered || (isBuy ? i.worstPx > limitPx : i.worstPx < limitPx);

/** The warning, in words: what the order does to the price and what it costs. */
export function impactWarning(i: Impact, what: string): string {
  const cost = `$${i.costUsd.toFixed(2)}`;
  return i.covered
    ? `${what} moves the price about ${impactPctText(i)}: about ${cost} worse than the current price, on top of fees.`
    : `${what} is bigger than the visible order book: it moves the price ${impactPctText(i)} (over ${cost}, on top of fees).`;
}

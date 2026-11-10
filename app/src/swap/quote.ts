import type { SwapSide } from "./market";

/** Uniswap V2's immutable 0.30% pair fee: amountInWithFee = amountIn * 997 / 1000. */
export const SWAP_FEE_NUM = 997n;
export const SWAP_FEE_DEN = 1000n;
/** 0.50%, the slippage a swap starts on. */
export const DEFAULT_SLIPPAGE_BPS = 50n;
export const MIN_SLIPPAGE_BPS = 1n;
export const MAX_SLIPPAGE_BPS = 500n;
/** A swap is valid for 20 minutes after the block it was quoted against. */
export const SWAP_DEADLINE_SEC = 1200n;

/**
 * Uniswap V2 `getAmountOut`. Null when the input or either reserve is zero.
 * Rounds down, which is the most the pair will pay.
 */
export function quoteExactIn(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint | null {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null;
  const amountInWithFee = amountIn * SWAP_FEE_NUM;
  return (amountInWithFee * reserveOut) / (reserveIn * SWAP_FEE_DEN + amountInWithFee);
}

/** `quoted` less the slippage, rounded down. Null when the slippage is outside 0.01%–5% or the quote is empty. Zero is a real result (dust). */
export function amountOutMin(quoted: bigint, slippageBps: bigint): bigint | null {
  if (quoted <= 0n || slippageBps < MIN_SLIPPAGE_BPS || slippageBps > MAX_SLIPPAGE_BPS) return null;
  return (quoted * (10_000n - slippageBps)) / 10_000n;
}

/**
 * How far the quote sits under the fee-adjusted price with no size, in bps.
 * This is the trade's own size, read from the reserves, not a forecast.
 */
export function quoteMoveBps(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, quoted: bigint): bigint | null {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n || quoted <= 0n) return null;
  const ideal = (amountIn * SWAP_FEE_NUM * reserveOut) / (reserveIn * SWAP_FEE_DEN);
  if (ideal <= 0n || quoted >= ideal) return 0n;
  return ((ideal - quoted) * 10_000n) / ideal;
}

/** A size warning from 1% up. Under that, nothing. */
export function moveText(bps: bigint): string | null {
  if (bps < 100n) return null;
  const tenths = (bps + 5n) / 10n;
  return `This amount moves the quote by ${tenths / 10n}.${tenths % 10n}%.`;
}

/** The minimum the screen already showed. Null when the fresh quote fell through it, so the swap is not sent. */
export function guardedMin(shownMin: bigint, freshQuoted: bigint): bigint | null {
  if (shownMin <= 0n || freshQuoted < shownMin) return null;
  return shownMin;
}

/** A typed token amount in base units. Null when it is empty, zero, or has too many decimals. */
export function parseTokenAmount(text: string, decimals: number): bigint | null {
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`).exec(text.trim());
  if (!m) return null;
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0"));
  return v > 0n ? v : null;
}

/** "0.5" → 50 bps. Null outside 0.01%–5% or with more than two decimal places. */
export function parseSlippagePercent(text: string): bigint | null {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = BigInt(m[1]) * 100n + BigInt((m[2] ?? "").padEnd(2, "0"));
  if (bps < MIN_SLIPPAGE_BPS || bps > MAX_SLIPPAGE_BPS) return null;
  return bps;
}

/** Grouped whole units, up to 6 fractional digits (8 for an 18-decimal token), trailing zeros dropped. */
export function fmtAmount(amount: bigint, decimals: number): string {
  if (amount < 0n || decimals < 0) return "—";
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const frac = amount % base;
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (frac === 0n) return grouped;
  const maxShow = Math.min(decimals, decimals <= 6 ? decimals : 8);
  const digits = frac.toString().padStart(decimals, "0").slice(0, maxShow).replace(/0+$/, "");
  return digits ? `${grouped}.${digits}` : grouped;
}

export function swapDeadline(blockTime: bigint): bigint {
  return blockTime + SWAP_DEADLINE_SEC;
}

export type SwapStep = "approve" | "swap";

/** An allowance that already covers the amount skips the approve. */
export function swapSteps(allowance: bigint, amount: bigint): SwapStep[] {
  return allowance >= amount ? ["swap"] : ["approve", "swap"];
}

export function swapButtonLabel(side: SwapSide, needsApprove: boolean): string {
  if (side === "buy") return needsApprove ? "Approve and buy" : "Buy HLO";
  return needsApprove ? "Approve and swap" : "Swap to USDC";
}

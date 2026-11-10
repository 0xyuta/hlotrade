import type { Address } from "../config/validate";
import { SWAP_NO_LIQUIDITY, SWAP_SLIPPAGE, SWAP_SLIPPAGE_ZERO, SWAP_TOO_MUCH, SWAP_TOO_SMALL } from "./copy";
import { reservesOf, tokensFor, type SwapMarket, type SwapSide } from "./market";
import { amountOutMin, quoteExactIn, quoteMoveBps, swapDeadline, swapSteps, type SwapStep } from "./quote";

/** A point-in-time read of the pair and, when a wallet is connected, its balances. Reserves are for quoting only. */
export interface SwapSnapshot {
  reserve0: bigint;
  reserve1: bigint;
  hloIsToken0: boolean;
  blockTime: bigint;
  hloBalance: bigint | null;
  usdcBalance: bigint | null;
  hloAllowance: bigint | null;
  usdcAllowance: bigint | null;
}

export interface SwapQuote {
  side: SwapSide;
  amountIn: bigint;
  quoted: bigint;
  amountOutMin: bigint;
  moveBps: bigint;
  steps: SwapStep[];
  path: readonly [Address, Address];
  deadline: bigint;
  pay: Address;
  receive: Address;
}

export function planSwap(input: {
  market: SwapMarket;
  side: SwapSide;
  amountIn: bigint;
  slippageBps: bigint;
  snap: SwapSnapshot;
}): { ok: true; quote: SwapQuote } | { ok: false; reason: string } {
  const { market, side, amountIn, slippageBps, snap } = input;
  const { reserveIn, reserveOut } = reservesOf(side, snap.hloIsToken0, snap.reserve0, snap.reserve1);
  if (reserveIn === 0n || reserveOut === 0n) return { ok: false, reason: SWAP_NO_LIQUIDITY };
  const tokens = tokensFor(side, market);
  const balance = side === "buy" ? snap.usdcBalance : snap.hloBalance;
  if (balance !== null && amountIn > balance) return { ok: false, reason: SWAP_TOO_MUCH };
  const quoted = quoteExactIn(amountIn, reserveIn, reserveOut);
  if (quoted === null || quoted === 0n) return { ok: false, reason: SWAP_TOO_SMALL };
  const min = amountOutMin(quoted, slippageBps);
  if (min === null) return { ok: false, reason: slippageBps < 1n || slippageBps > 500n ? SWAP_SLIPPAGE : SWAP_SLIPPAGE_ZERO };
  if (min === 0n) return { ok: false, reason: SWAP_SLIPPAGE_ZERO };
  const allowance = (side === "buy" ? snap.usdcAllowance : snap.hloAllowance) ?? 0n;
  return {
    ok: true,
    quote: {
      side,
      amountIn,
      quoted,
      amountOutMin: min,
      moveBps: quoteMoveBps(amountIn, reserveIn, reserveOut, quoted) ?? 0n,
      steps: swapSteps(allowance, amountIn),
      path: [tokens.pay, tokens.receive],
      deadline: swapDeadline(snap.blockTime),
      pay: tokens.pay,
      receive: tokens.receive,
    },
  };
}

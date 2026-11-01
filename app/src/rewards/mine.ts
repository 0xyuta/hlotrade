import type { Position } from "../hl/account";
import { BUILDER_FEE_RATE, DEFAULT_SLIPPAGE, MIN_ORDER_USD, sizeFromMargin } from "../hl/math";
import { planOrder, type MarketRef, type PlanResult } from "../hl/orders";
import { fmtFeeUnits, fmtHlo, fmtPx, fmtUsd } from "../ui/format";
import { TRADER_PER_MINUTE } from "./constants";
import type { FeeTable, TradeRow } from "./explore";

/**
 * Mine mode's rules (docs/APP.md §1). A mine order is an ordinary real trade: one market order at the leverage the user chose
 * (isolated, 1x unless they change it) with nothing attached, which stays open until the user closes it. Nothing here closes or repeats a trade by itself (Hyperliquid's Terms §3.1.4).
 */
/** A size is rounded down, so each amount has to sit above Hyperliquid's $10 floor. */
export const MINE_AMOUNTS = [20, 100, 1000];
export const DEFAULT_AMOUNT = 100;
export const DEFAULT_LEVERAGE = 1;
const LEVERAGE_STEPS = [1, 3, 5, 10];

/** The steps this market allows, and its own maximum as the last one. */
export function leverageChoices(maxLeverage: number): number[] {
  return [...new Set([...LEVERAGE_STEPS.filter((l) => l < maxLeverage), maxLeverage])];
}

const FEE_UNITS_PER_USDC = 1e8;
const money = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const validAmount = (n: number) => Number.isFinite(n) && n > 0;

/** What is left of this minute, by chain time. Null before launch. */
export function secondsLeft(now: number, launchTime: number): number | null {
  if (now < launchTime) return null;
  return 60 - ((now - launchTime) % 60);
}

export function clockText(seconds: number | null): string {
  if (seconds === null) return "—";
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export const tableTotal = (table: FeeTable): bigint => [...table.values()].reduce((a, b) => a + b, 0n);

export function lastMinuteText(total: bigint | null): string | null {
  if (total === null) return null;
  if (total === 0n) return "Nobody traded in the last counted minute";
  return `Last counted minute: $${fmtFeeUnits(total)} in fees shared ${fmtHlo(TRADER_PER_MINUTE, 0)} HLO`;
}

/** A guide, not a promise: this minute's share depends on who else trades in it. */
export function estimateText(amountUsd: number, total: bigint | null): string | null {
  if (total === null || !validAmount(amountUsd)) return null;
  const fee = BigInt(Math.round(amountUsd * BUILDER_FEE_RATE * FEE_UNITS_PER_USDC));
  if (fee === 0n) return null;
  return `If this minute looks like the last one: about ${fmtHlo((TRADER_PER_MINUTE * fee) / (total + fee))} HLO`;
}

/** The wallet's share of one minute's HLO, as the table says. */
export function earnedAbout(table: FeeTable, user: string): bigint {
  const total = tableTotal(table);
  return total === 0n ? 0n : (TRADER_PER_MINUTE * (table.get(user.toLowerCase()) ?? 0n)) / total;
}

/** `table` is the fee table of the trade's minute, once read. */
export function lastTradeText(row: TradeRow | null, table: FeeTable | undefined, user: string): string | null {
  if (!row) return null;
  switch (row.status.kind) {
    case "pending":
      return "Your last trade is waiting to be counted";
    case "checking":
      return "Checking your last trade…";
    case "unknown":
      return "Could not check your last trade";
    case "notCounted":
      return `Your last trade was not counted. ${row.status.why}`;
    case "counted":
      return table ? `Your last trade's minute: counted, about +${fmtHlo(earnedAbout(table, user))} HLO` : "Your last trade was counted";
  }
}

/** `amountUsd` is what the user puts in: the position is worth that times the leverage. */
export function planMine(m: MarketRef, isBuy: boolean, amountUsd: number, px: number, leverage: number): PlanResult {
  if (!validAmount(amountUsd)) return { ok: false, error: "Enter an amount." };
  if (!(px > 0)) return { ok: false, error: "No price yet. Wait a moment." };
  const size = Number(sizeFromMargin(amountUsd, leverage, px, m.szDecimals));
  if (size === 0) return { ok: false, error: "Orders must be worth at least $10." };
  return planOrder(m, { kind: "market", isBuy, size, refPx: px, slippage: DEFAULT_SLIPPAGE });
}

export function amountProblem(amountUsd: number, available: number | null): string | null {
  return available !== null && amountUsd > available ? `That is more than your available $${fmtUsd(available)}.` : null;
}

/** Under the floor nothing can be sent: where to start. */
export function fundsText(available: number | null): string | null {
  return available !== null && available < MIN_ORDER_USD ? `Deposit USDC to start: an order must be worth at least $${MIN_ORDER_USD}.` : null;
}

export function startLabel(isBuy: boolean, amountUsd: number, coin: string, leverage: number): string {
  if (!validAmount(amountUsd)) return "Start mining";
  return `Start mining: ${isBuy ? "long" : "short"} ${money(amountUsd * leverage)} ${coin}${leverage === DEFAULT_LEVERAGE ? "" : ` at ${leverage}×`}`;
}

/** `liq` is the estimated liquidation price, null when there is none (a 1x long). */
export function riskText(feeUsd: number, liq: number | null, amountUsd: number): string {
  const fee = `Real position. Fee about $${fmtUsd(feeUsd)}.`;
  return liq === null ? `${fee} You can lose money.` : `${fee} Liquidation near ${fmtPx(liq)}: you could lose your ${money(amountUsd)}.`;
}

export const minePosition = (positions: readonly Position[], coin: string): Position | null => positions.find((p) => p.coin === coin) ?? null;

export function otherPositionsText(positions: readonly Position[], coin: string): string | null {
  const n = positions.filter((p) => p.coin !== coin).length;
  if (n === 0) return null;
  return n === 1 ? "You also have 1 other position. Switch to Trade to see it." : `You also have ${n} other positions. Switch to Trade to see them.`;
}

export function positionLine(p: Position, px: number | null): string {
  const side = p.szi > 0 ? "Long" : "Short";
  const value = px !== null ? ` ${money(Math.round(Math.abs(p.szi) * px))}` : "";
  return `${side}${value} ${p.coin}${p.leverage.value === DEFAULT_LEVERAGE ? "" : ` · ${p.leverage.value}×`}`;
}

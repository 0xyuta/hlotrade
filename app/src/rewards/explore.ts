import type { Fill } from "../hl/account";
import { fmtFeeUnits } from "../ui/format";
import type { LatestPop } from "./files";

/**
 * The Explore tab's rules: where each minute stands, and whether a wallet's trades reached the published fees. "Now" is chain
 * time. The fee tables are not covered by the poster's signature (it signs the root), so this is for reading only: nothing
 * here decides a claim, and the verifier checks the same tables against Hyperliquid (docs/APP.md §1).
 */
export type MinuteStatus = "pending" | "counted" | "onchain";
/** One minute's fees by lowercase wallet, in fee units (1e-8 USDC). */
export type FeeTable = Map<string, bigint>;
export type MinuteTables = Map<number, FeeTable>;

export const MINUTES_SHOWN = 30;
export const TRADES_SHOWN = 30;
/** The newest ended minute is normally still being counted, so one minute behind is on time. */
const ON_TIME_MINUTES = 1;

const minuteEnd = (launchTime: number, minute: number) => launchTime + 60 * (minute + 1);

export const lastEndedMinute = (now: number, launchTime: number): number => Math.max(-1, Math.floor((now - launchTime) / 60) - 1);

/** How many ended minutes have no published checkpoint. `published` is null while there is none. */
export const latenessMinutes = (lastEnded: number, published: number | null): number => Math.max(0, lastEnded - (published ?? -1));

export const paceText = (late: number): string => (late <= ON_TIME_MINUTES ? "On time" : `Running ${late} minutes late`);

export function minuteStatus(minute: number, published: number | null, settled: number | null): MinuteStatus {
  if (settled !== null && minute <= settled) return "onchain";
  return published !== null && minute <= published ? "counted" : "pending";
}

const TABLE_HEADER = "minute,user,fee";
const TABLE_ROW = /^(0|[1-9]\d{0,14}),(0x[0-9a-f]{40}),([1-9]\d{0,29})$/;

/** One minute's rows of a published table (calc's `tableCsv`), or null when the table is not readable. */
export function feeTable(csv: string, minute: number): FeeTable | null {
  const lines = csv.split("\n");
  if (lines[0] !== TABLE_HEADER) return null;
  const out: FeeTable = new Map();
  for (const line of lines.slice(1)) {
    const m = TABLE_ROW.exec(line);
    if (!m) return null;
    if (Number(m[1]) === minute) out.set(m[2], BigInt(m[3]));
  }
  return out;
}

export interface MinuteRow {
  minute: number;
  endsAt: number;
  status: MinuteStatus;
  /** Null while the minute's table is not known. */
  fees: bigint | null;
  wallets: number | null;
  pop: boolean;
}

export function minuteRows(o: { lastEnded: number; count: number; launchTime: number; published: number | null; settled: number | null; tables: MinuteTables; pops: ReadonlySet<number> }): MinuteRow[] {
  const rows: MinuteRow[] = [];
  for (let m = o.lastEnded; m >= 0 && rows.length < o.count; m--) {
    const table = o.tables.get(m);
    rows.push({
      minute: m,
      endsAt: minuteEnd(o.launchTime, m),
      status: minuteStatus(m, o.published, o.settled),
      fees: table ? [...table.values()].reduce((a, b) => a + b, 0n) : null,
      wallets: table ? table.size : null,
      pop: o.pops.has(m),
    });
  }
  return rows;
}

const isCorePerp = (coin: string) => !coin.includes("@") && !coin.includes(":") && !coin.includes("/");
/** calc's tolerance around 0.1% of px·sz: 0.000002 USDC, in fee units. */
const TOLERANCE_UNITS = 200;
const FEE_UNITS_PER_USDC = 1e8;
/** 0.1% of a notional of 1 USDC, in fee units. */
const EXPECTED_UNITS_PER_USDC = 100_000;

const feeUnits = (usdc: number) => BigInt(Math.round(usdc * FEE_UNITS_PER_USDC));

/**
 * calc's `countedFee` on Fill's numbers (pinned to it by test/explore.test.ts), with the launch as its start: the registration
 * is not public here, so a trade before it shows up as missing from the table. For reading only, like everything here.
 */
export function countedFeeUnits(f: Fill, launchTime: number): bigint | null {
  if (f.time < launchTime * 1000 || !isCorePerp(f.coin) || f.builderFee <= 0) return null;
  const diff = Math.abs(f.builderFee * FEE_UNITS_PER_USDC - f.px * f.sz * EXPECTED_UNITS_PER_USDC);
  return diff <= TOLERANCE_UNITS ? feeUnits(f.builderFee) : null;
}

export type TradeStatus = { kind: "pending" } | { kind: "counted" } | { kind: "checking" } | { kind: "unknown" } | { kind: "notCounted"; why: string };

export interface TradeRow {
  fill: Fill;
  minute: number;
  /** Whether the counting rule lets it count at all: only then does its minute's table matter. */
  counts: boolean;
  /** The points it earns, in fee units (1 point per $1 of fee, the model's `pointsText`); null when it did not count. */
  points: bigint | null;
  status: TradeStatus;
}

function ruleRefusal(f: Fill, launchTime: number): string {
  if (f.time < launchTime * 1000) return "Placed before rewards started.";
  if (!isCorePerp(f.coin)) return "Only Hyperliquid's main perps count, not spot or other markets.";
  return "Its builder fee is not HLO's.";
}

/**
 * The wallet's trades placed through HLO (a builder fee above 0), newest first as given, against the published fees of their
 * minute. Fills of one minute are checked together, because the table holds one sum per wallet per minute. A table that was
 * not read says "unknown", never "not counted".
 */
export function tradeRows(o: { fills: readonly Fill[]; user: string; launchTime: number; published: number | null; tables: MinuteTables; failed: ReadonlySet<number>; max: number }): TradeRow[] {
  const user = o.user.toLowerCase();
  const minuteOf = (f: Fill) => Math.floor((f.time - o.launchTime * 1000) / 60_000);
  const sums = new Map<number, bigint>();
  for (const f of o.fills) {
    const fee = countedFeeUnits(f, o.launchTime);
    if (fee !== null) sums.set(minuteOf(f), (sums.get(minuteOf(f)) ?? 0n) + fee);
  }
  const statusOf = (f: Fill, minute: number): TradeStatus => {
    if (countedFeeUnits(f, o.launchTime) === null) return { kind: "notCounted", why: ruleRefusal(f, o.launchTime) };
    if (o.published === null || minute > o.published) return { kind: "pending" };
    const table = o.tables.get(minute);
    if (!table) return o.failed.has(minute) ? { kind: "unknown" } : { kind: "checking" };
    const counted = table.get(user) ?? 0n;
    const expected = sums.get(minute) ?? 0n;
    if (counted >= expected) return { kind: "counted" };
    if (counted === 0n) return { kind: "notCounted", why: "Not in this minute's published fees. A trade counts only after Enable trading has registered the wallet." };
    return { kind: "notCounted", why: `Only $${fmtFeeUnits(counted)} of this minute's $${fmtFeeUnits(expected)} in fees was counted.` };
  };
  return o.fills
    .filter((f) => f.builderFee > 0)
    .slice(0, o.max)
    .map((fill) => {
      const fee = countedFeeUnits(fill, o.launchTime);
      const status = statusOf(fill, minuteOf(fill));
      return { fill, minute: minuteOf(fill), counts: fee !== null, points: status.kind === "notCounted" ? null : fee, status };
    });
}

/** The minutes whose table the screen needs: the published ones it shows, newest first, once each. */
export function checkedMinutes(minutes: readonly MinuteRow[], trades: readonly TradeRow[], published: number | null): number[] {
  if (published === null) return [];
  const wanted = [...minutes.map((r) => r.minute), ...trades.filter((t) => t.counts).map((t) => t.minute)];
  return [...new Set(wanted.filter((m) => m <= published))].sort((a, b) => b - a);
}

export interface PopRow {
  minute: number;
  endsAt: number;
  paid: bigint;
  kept: bigint;
  recipients: number;
  note: string | null;
}

export const popRows = (pops: readonly LatestPop[], launchTime: number): PopRow[] =>
  pops.map((p) => ({
    minute: p.minute,
    endsAt: minuteEnd(launchTime, p.minute),
    paid: BigInt(p.amount),
    kept: BigInt(p.kept),
    recipients: p.recipients,
    note: p.recipients === 0 ? "0 wallets paid means nobody had 1 point, so it all stayed in the vault." : null,
  }));

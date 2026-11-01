import { isCorePerp, type Addr } from "./fills.js";
import type { FeeRow } from "./table.js";
import { parseFeeUnits } from "./units.js";

/** A fill as Hyperliquid's info API returns it (userFillsByTime). Only the fields the calculator reads. */
export interface ApiFill {
  time: number; // ms
  coin: string;
  px: string;
  sz: string;
  builderFee?: string;
  tid: number;
}

const DEC = /^(\d+)(?:\.(\d+))?$/;
const TOLERANCE_UNITS = 200n; // 0.000002 USDC in 1e-8 units

/** "12.345" → [12345n, 3]. */
function dec(s: string): [bigint, number] {
  const m = DEC.exec(s);
  if (!m) throw new Error(`bad decimal "${s}"`);
  const frac = m[2] ?? "";
  return [BigInt(m[1] + frac), frac.length];
}

/**
 * The fill's builder fee in 1e-8 USDC when it counts (spec §3 rule 3), else null: a core perp, a fee above 0 that is our
 * 0.1% of px·sz within 0.000002 USDC (computed exactly), at or after `startSec` (max(launchTime, registeredAt)).
 */
export function countedFee(f: ApiFill, startSec: number): bigint | null {
  if (f.time < startSec * 1000 || !isCorePerp(f.coin) || f.builderFee === undefined) return null;
  const fee = parseFeeUnits(f.builderFee);
  if (fee <= 0n) return null;
  const [px, p] = dec(f.px);
  const [sz, q] = dec(f.sz);
  // expected fee in 1e-8 units = px·sz/1000·1e8 = px·sz·1e5 / 10^(p+q); compare scaled by 10^(p+q).
  const scale = 10n ** BigInt(p + q);
  const diff = fee * scale - px * sz * 100_000n;
  const abs = diff < 0n ? -diff : diff;
  return abs <= TOLERANCE_UNITS * scale ? fee : null;
}

export const minuteOf = (launchTime: number, timeMs: number): number => Math.floor((timeMs - launchTime * 1000) / 60_000);

/** Rows → minute → user → summed fee. */
export function feesByMinute(rows: readonly FeeRow[]): Map<number, Map<Addr, bigint>> {
  const out = new Map<number, Map<Addr, bigint>>();
  for (const r of rows) {
    let m = out.get(r.minute);
    if (!m) out.set(r.minute, (m = new Map()));
    m.set(r.user, (m.get(r.user) ?? 0n) + r.fee);
  }
  return out;
}

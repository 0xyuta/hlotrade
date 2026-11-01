export const DAY = 86_400;
export const MINUTE = 60;
export const HLO = 10n ** 18n;
export const TRADER_PER_MINUTE = HLO; // 1 HLO to that minute's traders
export const VAULT_PER_MINUTE = HLO / 10n; // 0.1 HLO into the vault
export const MAX_SUPPLY = 5_000_000n * HLO;
export const POOL_RESERVE = 10_000n * HLO;

const FEE_RE = /^(\d+)(?:\.(\d{1,8}))?$/;

/** Hyperliquid's builder_fee ("0.00440671") → units of 1e-8 USDC (440671n). */
export function parseFeeUnits(s: string): bigint {
  const m = FEE_RE.exec(s);
  if (!m) throw new Error(`bad builder_fee "${s}"`);
  return BigInt(m[1]) * 10n ** 8n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

export const dayOf = (t: number): number => Math.floor(t / DAY);

/** UTC day number → "YYYYMMDD" (Hyperliquid's file name). */
export function yyyymmdd(day: number): string {
  return new Date(day * DAY * 1000).toISOString().slice(0, 10).replaceAll("-", "");
}

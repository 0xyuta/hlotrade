import { formatUnits } from "viem";

const nf = (min: number, max: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });

/** A tiny negative rounds to "-0.00"; show it as "0.00". */
const noNegZero = (s: string) => (/^-0(\.0+)?$/.test(s) ? s.slice(1) : s);

export const fmtUsd = (n: number, d = 2) => (Number.isFinite(n) ? noNegZero(nf(d, d).format(n)) : "—");
/** "+$1.20" / "-$1.20": the sign goes before the dollar sign. */
export const signedUsd = (v: number) => {
  const s = fmtUsd(Math.abs(v));
  return v < 0 && s !== fmtUsd(0) ? `-$${s}` : `${v > 0 ? "+" : ""}$${s}`;
};
/** "$5.3B", "$454.6M", "$12.4K", "$950". */
export function fmtCompactUsd(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const a = Math.abs(n);
  for (const [v, u] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) if (a >= v) return `$${nf(1, 1).format(n / v)}${u}`;
  return `$${nf(0, 0).format(n)}`;
}
export function fmtPx(n: number): string {
  if (!Number.isFinite(n)) return "—";
  return noNegZero(nf(0, n >= 10_000 ? 0 : n >= 1 ? 4 : 6).format(n));
}
export function fmtPct(n: number, d = 2): string {
  if (!Number.isFinite(n)) return "—";
  const s = noNegZero(n.toFixed(d));
  return `${s.startsWith("-") ? "" : "+"}${s}%`;
}
export const fmtHlo = (wei: bigint, d = 2) => nf(d, d).format(Number(formatUnits(wei, 18)));
export const fmtUsdc = (x: bigint) => nf(2, 2).format(Number(formatUnits(x, 6)));
export const fmtFeeUnits = (x: bigint) => nf(2, 2).format(Number(formatUnits(x, 8)));
export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** UTC day number → "YYYY-MM-DD". */
export const dayLabel = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

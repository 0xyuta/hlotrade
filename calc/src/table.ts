import type { Addr } from "./fills.js";

export interface FeeRow {
  minute: number;
  user: Addr; // claiming address, lowercase
  fee: bigint; // 1e-8 USDC, > 0
}

export const TABLE_HEADER = "minute,user,fee";
const ROW_RE = /^(0|[1-9]\d*),(0x[0-9a-f]{40}),([1-9]\d*)$/;

const cmp = (a: FeeRow, b: FeeRow) => a.minute - b.minute || (a.user < b.user ? -1 : a.user > b.user ? 1 : 0);

export function tableCsv(rows: readonly FeeRow[]): string {
  return [TABLE_HEADER, ...rows.map((r) => `${r.minute},${r.user},${r.fee}`)].join("\n");
}

export function parseTableCsv(text: string): FeeRow[] {
  const lines = text.split("\n");
  if (lines[0] !== TABLE_HEADER) throw new Error("bad table header");
  const rows: FeeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const m = ROW_RE.exec(lines[i]);
    if (!m) throw new Error(`bad table line ${i + 1}`);
    const row = { minute: Number(m[1]), user: m[2] as Addr, fee: BigInt(m[3]) };
    if (rows.length > 0 && cmp(rows[rows.length - 1], row) >= 0) throw new Error(`table out of order at line ${i + 1}`);
    rows.push(row);
  }
  return rows;
}

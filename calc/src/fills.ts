import lz4 from "lz4js";
import { parseFeeUnits } from "./units.js";

export type Addr = `0x${string}`;

export interface Fill {
  time: number; // unix seconds
  user: Addr; // lowercase
  coin: string;
  fee: bigint; // 1e-8 USDC
}

const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ADDR_RE = /^0x[0-9a-f]{40}$/;

export function decodeLz4(buf: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(lz4.decompress(buf)));
}

/** Parses Hyperliquid's builder-fill CSV. Columns are found by header name. */
export function parseFills(text: string): Fill[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`missing column ${name}`);
    return i;
  };
  const iTime = col("time");
  const iUser = col("user");
  const iCoin = col("coin");
  const iFee = col("builder_fee");
  const out: Fill[] = [];
  for (let k = 1; k < lines.length; k++) {
    const f = lines[k].split(",");
    if (f.length !== header.length) throw new Error(`line ${k + 1}: ${f.length} fields, expected ${header.length}`);
    const ts = f[iTime];
    if (!TIME_RE.test(ts)) throw new Error(`line ${k + 1}: bad time "${ts}"`);
    const user = f[iUser].toLowerCase();
    if (!ADDR_RE.test(user)) throw new Error(`line ${k + 1}: bad user "${f[iUser]}"`);
    out.push({ time: Date.parse(ts) / 1000, user: user as Addr, coin: f[iCoin], fee: parseFeeUnits(f[iFee]) });
  }
  return out;
}

/** Core Hyperliquid perps only: spot ("@305", "PURR/USDC") and HIP-3 ("xyz:GOLD") don't mine. */
export function isCorePerp(coin: string): boolean {
  return !coin.includes("@") && !coin.includes(":") && !coin.includes("/");
}

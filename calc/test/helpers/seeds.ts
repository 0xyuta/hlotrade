import { pad, toHex, type Hex } from "viem";
import { popsAt, type Seed } from "../../src/index.js";

/** The first 32-byte hash 0x…01, 0x…02, … for which `want` holds. */
export function hashWhere(want: (h: Hex) => boolean): Hex {
  for (let i = 1n; ; i++) {
    const h = pad(toHex(i), { size: 32 });
    if (want(h)) return h;
  }
}

/** Seeds for minutes from..through: minute m pops exactly when `pop` includes it (with these odds); its block is `block(m)` (default 1000 + m). */
export function seedsFor(from: number, through: number, o: { odds: number; pop?: readonly number[]; block?: (m: number) => bigint }): Seed[] {
  const out: Seed[] = [];
  for (let m = from; m <= through; m++) {
    const want = o.pop?.includes(m) ?? false;
    if (o.odds === 1 && !want) throw new Error(`with odds 1 every minute pops (minute ${m})`);
    out.push({ minute: m, block: o.block?.(m) ?? 1000n + BigInt(m), hash: hashWhere((h) => popsAt(h, m, o.odds) === want) });
  }
  return out;
}

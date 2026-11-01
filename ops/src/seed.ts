import type { Seed } from "@hlo/calc";
import type { Hex } from "viem";

/** The one viem PublicClient method seedBlocks uses (ops/src/chain.ts `PublicClient` fits it; a fake in tests). */
export interface BlockSource {
  getBlock(args: { blockNumber: bigint }): Promise<{ number: bigint | null; hash: Hex | null; timestamp: bigint }>;
}

/**
 * No block in [lo, hi] is at or after a minute's end (or lo > hi). For the verifier this is a finding about the
 * checkpoint (its refBlock is before the end of its minute), not an RPC failure.
 */
export class SeedRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRangeError";
  }
}

/**
 * Spec 2026-10-30 §2 rule 2: B(m) is the lowest block whose timestamp is at or after the end of minute m
 * (launchTime + 60(m+1)). Block timestamps never decrease, so a binary search between `lo` (at or below B(fromMinute):
 * the previous checkpoint's last seed block, or the deploy block) and `hi` (the checkpoint's refBlock) finds it; each
 * minute's search starts at the previous minute's answer. Blocks are read by number only (never "latest"), each at most
 * once per call: about log2(hi − lo) reads per minute.
 */
export async function seedBlocks(client: BlockSource, launchTime: number, fromMinute: number, throughMinute: number, lo: bigint, hi: bigint): Promise<Seed[]> {
  if (fromMinute > throughMinute) return [];
  if (lo > hi) throw new SeedRangeError(`the seed search from block ${lo} to ${hi} is empty`);
  const seen = new Map<bigint, { timestamp: bigint; hash: Hex }>();
  const at = async (n: bigint) => {
    let b = seen.get(n);
    if (!b) {
      const got = await client.getBlock({ blockNumber: n });
      if (got.number !== n || got.hash === null) throw new Error(`the RPC answered block ${got.number} (hash ${got.hash}) when asked for block ${n}`);
      b = { timestamp: got.timestamp, hash: got.hash };
      seen.set(n, b);
    }
    return b;
  };
  const endOf = (m: number) => BigInt(launchTime + 60 * (m + 1));
  const top = await at(hi);
  if (top.timestamp < endOf(throughMinute)) {
    throw new SeedRangeError(`block ${hi} (time ${top.timestamp}) is before the end of minute ${throughMinute} (${endOf(throughMinute)})`);
  }
  const out: Seed[] = [];
  let from = lo;
  for (let m = fromMinute; m <= throughMinute; m++) {
    const end = endOf(m);
    let a = from;
    let b = hi; // timestamp(b) >= end holds throughout
    while (a < b) {
      const mid = a + (b - a) / 2n;
      if ((await at(mid)).timestamp >= end) b = mid;
      else a = mid + 1n;
    }
    out.push({ minute: m, block: a, hash: (await at(a)).hash });
    from = a;
  }
  return out;
}

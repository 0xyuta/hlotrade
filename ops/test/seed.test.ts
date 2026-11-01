import { pad, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { PublicClient } from "../src/chain.js";
import { seedBlocks, SeedRangeError, type BlockSource } from "../src/seed.js";

// Compile-time check (npm run typecheck -w ops): the real viem client fits BlockSource.
const real: BlockSource = null as unknown as PublicClient;
void real;

const hashOf = (n: bigint): Hex => pad(toHex(n + 1000n), { size: 32 });

/** A chain whose block n has timestamp times[n]. It refuses anything but a read by number, and records every read. */
function chain(times: number[], o: { lie?: boolean } = {}) {
  const reads: bigint[] = [];
  const client: BlockSource = {
    async getBlock(args) {
      if (typeof args?.blockNumber !== "bigint") throw new Error("read by number only");
      const n = args.blockNumber;
      reads.push(n);
      if (n < 0n || n >= BigInt(times.length)) throw new Error(`no block ${n}`);
      return { number: o.lie ? n + 1n : n, hash: hashOf(n), timestamp: BigInt(times[Number(n)]) };
    },
  };
  return { client, reads };
}

const L = 1000; // minute m ends at 1060 + 60m
//   block:      0     1     2     3     4     5     6     7     8     9    10
const TIMES = [990, 1000, 1030, 1059, 1060, 1061, 1119, 1125, 1300, 1300, 1301];

describe("seedBlocks", () => {
  it("finds the first block at or after each minute's end, with its hash", async () => {
    const { client } = chain(TIMES);
    expect(await seedBlocks(client, L, 0, 1, 0n, 10n)).toEqual([
      { minute: 0, block: 4n, hash: hashOf(4n) }, // 1059 < 1060 ≤ 1060
      { minute: 1, block: 7n, hash: hashOf(7n) }, // a gap: 1119 < 1120 ≤ 1125
    ]);
  });

  it("a stalled chain: minutes 2, 3 and 4 share block 8; of two blocks with the same timestamp the lower is taken", async () => {
    const { client } = chain(TIMES);
    // the ends are 1180, 1240 and 1300: nothing between block 7 (1125) and blocks 8 and 9 (both 1300)
    expect((await seedBlocks(client, L, 2, 4, 7n, 10n)).map((s) => [s.minute, s.block])).toEqual([[2, 8n], [3, 8n], [4, 8n]]);
  });

  it("reads only between lo and hi, by number, each block once", async () => {
    const { client, reads } = chain(TIMES);
    await seedBlocks(client, L, 1, 2, 4n, 9n);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.every((n) => n >= 4n && n <= 9n)).toBe(true);
    expect(new Set(reads).size).toBe(reads.length);
  });

  it("about log2(range) reads for a minute on a long range", async () => {
    const { client, reads } = chain(Array.from({ length: 10_000 }, (_, i) => i)); // one block a second from time 0
    expect(await seedBlocks(client, 0, 0, 0, 0n, 9_999n)).toEqual([{ minute: 0, block: 60n, hash: hashOf(60n) }]);
    expect(reads.length).toBeLessThanOrEqual(16);
  });

  it("hi before the end of the last minute, or lo above hi, is a SeedRangeError (the refBlock is too early)", async () => {
    const { client } = chain(TIMES);
    await expect(seedBlocks(client, L, 0, 5, 0n, 10n)).rejects.toBeInstanceOf(SeedRangeError); // minute 5 ends at 1360
    await expect(seedBlocks(client, L, 0, 0, 0n, 3n)).rejects.toThrow("block 3 (time 1059) is before the end of minute 0 (1060)");
    await expect(seedBlocks(client, L, 0, 0, 5n, 4n)).rejects.toBeInstanceOf(SeedRangeError);
  });

  it("an RPC that answers another block is an error, not a SeedRangeError", async () => {
    const { client } = chain(TIMES, { lie: true });
    const e = await seedBlocks(client, L, 0, 0, 0n, 10n).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(SeedRangeError);
    expect((e as Error).message).toMatch(/asked for block 10/);
  });

  it("an empty minute range reads nothing", async () => {
    const { client, reads } = chain(TIMES);
    expect(await seedBlocks(client, L, 3, 2, 0n, 10n)).toEqual([]);
    expect(reads).toEqual([]);
  });
});

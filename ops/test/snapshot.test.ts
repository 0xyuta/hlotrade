import type { Addr } from "@hlo/calc";
import { describe, expect, it } from "vitest";
import { ChainTracker, type BurnLog, type ClaimLog } from "../src/snapshot.js";

const A = "0x00000000000000000000000000000000000000a1" as Addr;
const B = "0x00000000000000000000000000000000000000b2" as Addr;

const ZERO = "0x0000000000000000000000000000000000000000" as Addr;
// to-zero transfers are burns; the mint (from zero) and the plain transfer are not
const transfers: BurnLog[] = [
  { from: A, to: ZERO, value: 10n, block: 6n },
  { from: ZERO, to: A, value: 1000n, block: 7n }, // a mint
  { from: B, to: ZERO, value: 5n, block: 9n },
  { from: ZERO, to: ZERO, value: 777n, block: 11n }, // a mint to zero is not a burn
  { from: A, to: ZERO, value: 100n, block: 13n },
  { from: B, to: ZERO, value: 1n, block: 22n },
];

function fake(logs: ClaimLog[], burns: BurnLog[] = transfers) {
  const calls: [bigint, bigint][] = [];
  const burnCalls: [bigint, bigint][] = [];
  return {
    calls,
    burnCalls,
    reader: {
      claimedLogs: async (from: bigint, to: bigint) => {
        calls.push([from, to]);
        return logs.filter((l) => l.block >= from && l.block <= to);
      },
      burnLogs: async (from: bigint, to: bigint) => {
        burnCalls.push([from, to]);
        return burns.filter((l) => l.block >= from && l.block <= to);
      },
    },
  };
}

const logs: ClaimLog[] = [
  { user: A, claimedTotal: 100n, refined: 10n, block: 5n },
  { user: B, claimedTotal: 50n, refined: 5n, block: 8n },
  { user: A, claimedTotal: 300n, refined: 20n, block: 12n },
  { user: B, claimedTotal: 70n, refined: 2n, block: 20n },
];

describe("ChainTracker", () => {
  it("accumulates claimed across snapshots; the latest claimedTotal per user wins", async () => {
    const f = fake(logs);
    const t = new ChainTracker(f.reader, 1000n);
    const s1 = await t.snapshot(0n, 10n);
    expect(s1.claimed).toEqual(new Map([[A, 100n], [B, 50n]]));
    const s2 = await t.snapshot(10n, 25n);
    expect(s2.claimed).toEqual(new Map([[A, 300n], [B, 70n]]));
  });

  it("a partial claim then the rest: claimed[user] is the second claimedTotal (the running claimed gross), not a sum", async () => {
    const two: ClaimLog[] = [
      { user: A, claimedTotal: 40n, refined: 4n, block: 3n },
      { user: A, claimedTotal: 100n, refined: 6n, block: 9n },
    ];
    const t = new ChainTracker(fake(two).reader, 1000n);
    expect((await t.snapshot(0n, 5n)).claimed).toEqual(new Map([[A, 40n]]));
    const s = await t.snapshot(5n, 10n);
    expect(s.claimed).toEqual(new Map([[A, 100n]]));
    expect(s.refined).toBe(6n);
    const one = await new ChainTracker(fake(two).reader, 1000n).snapshot(0n, 10n);
    expect(one.claimed).toEqual(new Map([[A, 100n]]));
    expect(one.refined).toBe(10n);
  });

  it("claimed[user] is the largest claimedTotal seen, so log order (same block, or a late older log) cannot lower it", async () => {
    const out: ClaimLog[] = [
      { user: A, claimedTotal: 100n, refined: 1n, block: 9n },
      { user: A, claimedTotal: 40n, refined: 1n, block: 9n }, // listed after the larger one in the same block
      { user: B, claimedTotal: 70n, refined: 1n, block: 3n },
      { user: B, claimedTotal: 20n, refined: 1n, block: 14n }, // a later block with a smaller total
    ];
    const t = new ChainTracker(fake(out).reader, 1000n);
    expect((await t.snapshot(0n, 10n)).claimed).toEqual(new Map([[A, 100n], [B, 70n]]));
    expect((await t.snapshot(10n, 20n)).claimed).toEqual(new Map([[A, 100n], [B, 70n]])); // across snapshots too
  });

  it("sums refined only over (prev, ref]", async () => {
    const f = fake(logs);
    const t = new ChainTracker(f.reader, 1000n);
    const s1 = await t.snapshot(5n, 12n); // excludes block 5, includes 8 and 12
    expect(s1.refined).toBe(25n);
    const s2 = await t.snapshot(12n, 20n);
    expect(s2.refined).toBe(2n);
  });

  it("burned is the running sum of to-zero transfers; mints are ignored; it accumulates across snapshots and never reads state at a block", async () => {
    const f = fake(logs);
    const t = new ChainTracker(f.reader, 1000n);
    expect((await t.snapshot(0n, 6n)).burned).toBe(10n);
    expect((await t.snapshot(6n, 8n)).burned).toBe(10n); // only the mint at 7
    expect((await t.snapshot(8n, 12n)).burned).toBe(15n); // + 5; the mint to zero at 11 does not count
    expect((await t.snapshot(12n, 20n)).burned).toBe(115n); // + 100
    expect((await t.snapshot(20n, 25n)).burned).toBe(116n); // + 1
    expect((await t.snapshot(25n, 25n)).burned).toBe(116n); // empty range: unchanged
  });

  it("burned of one snapshot covering everything equals the sum of the burns in range", async () => {
    const t = new ChainTracker(fake(logs).reader, 7n);
    expect((await t.snapshot(0n, 25n)).burned).toBe(116n);
    const u = new ChainTracker(fake(logs).reader, 1000n);
    expect((await u.snapshot(6n, 13n)).burned).toBe(105n); // (6, 13]: the burn at 6 is outside
  });

  it("a failed snapshot leaves burned (and claimed) as they were", async () => {
    const f = fake(logs);
    const t = new ChainTracker({ claimedLogs: f.reader.claimedLogs, burnLogs: async (a, b) => { if (a > 10n) throw new Error("rpc"); return f.reader.burnLogs(a, b); } }, 5n);
    await expect(t.snapshot(0n, 25n)).rejects.toThrow("rpc");
    const ok = new ChainTracker(f.reader, 5n);
    expect((await ok.snapshot(0n, 25n)).burned).toBe(116n);
    expect((await t.clone().snapshot(0n, 5n)).burned).toBe(0n);
  });

  it("clone carries the running burned total", async () => {
    const t = new ChainTracker(fake(logs).reader, 1000n);
    await t.snapshot(0n, 13n);
    expect((await t.clone().snapshot(13n, 25n)).burned).toBe(116n);
  });

  it("prev == ref gives refined 0 without a log query", async () => {
    const f = fake(logs);
    const t = new ChainTracker(f.reader, 1000n);
    const s = await t.snapshot(12n, 12n);
    expect(s.refined).toBe(0n);
    expect(f.calls).toEqual([]);
    expect(f.burnCalls).toEqual([]);
    expect(s.burned).toBe(0n);
  });

  it("queries in chunks of at most LOG_CHUNK", async () => {
    const f = fake(logs);
    const t = new ChainTracker(f.reader, 7n);
    const s = await t.snapshot(0n, 25n);
    expect(f.calls).toEqual([[1n, 7n], [8n, 14n], [15n, 21n], [22n, 25n]]);
    expect(f.burnCalls).toEqual(f.calls);
    expect(s.refined).toBe(37n);
  });

  it("rejects ref < prev and a bad chunk", async () => {
    const t = new ChainTracker(fake(logs).reader, 10n);
    await expect(t.snapshot(5n, 4n)).rejects.toThrow();
    expect(() => new ChainTracker(fake(logs).reader, 0n)).toThrow();
  });

  it("round-trips through JSON", async () => {
    const f = fake(logs);
    const t = new ChainTracker(f.reader, 1000n);
    await t.snapshot(0n, 10n);
    expect(JSON.parse(t.toJSON()).burned).toBe("15"); // a decimal string
    const back = ChainTracker.fromJSON(t.toJSON(), fake(logs).reader, 1000n);
    const s = await back.snapshot(10n, 25n);
    expect(s.claimed).toEqual(new Map([[A, 300n], [B, 70n]]));
    expect(s.refined).toBe(22n);
    expect(s.burned).toBe(116n);
  });

  it("fromJSON throws on a malformed file", () => {
    expect(() => ChainTracker.fromJSON("{}", fake([]).reader, 10n)).toThrow();
    expect(() => ChainTracker.fromJSON(JSON.stringify({ claimed: { nope: "1" }, burned: "0" }), fake([]).reader, 10n)).toThrow();
    // a tracker file without the running burned total is refused: guessing 0 would under-count every earlier burn
    expect(() => ChainTracker.fromJSON(JSON.stringify({ claimed: {} }), fake([]).reader, 10n)).toThrow(/burned/);
    expect(() => ChainTracker.fromJSON(JSON.stringify({ claimed: {}, burned: "-1" }), fake([]).reader, 10n)).toThrow(/burned/);
    expect(() => ChainTracker.fromJSON(JSON.stringify({ claimed: {}, burned: 5 }), fake([]).reader, 10n)).toThrow(/burned/);
  });
});

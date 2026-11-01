import type { Addr, ApiFill } from "@hlo/calc";
import { describe, expect, it } from "vitest";
import { FillCache } from "../src/fillcache.js";

const U: Addr = "0x00000000000000000000000000000000000000a1";
const V: Addr = "0x00000000000000000000000000000000000000b2";
const fill = (tid: number, time: number): ApiFill => ({ tid, time, coin: "BTC", px: "100", sz: "10", builderFee: "1" });
const ALL = [fill(1, 1000), fill(2, 1500), fill(3, 2000), fill(4, 2999), fill(5, 4000), fill(6, 5999)];

function cache(fills: ApiFill[] = ALL) {
  const calls: [string, number, number][] = [];
  const c = new FillCache(async (user, startMs, endMs) => {
    calls.push([user, startMs, endMs]);
    return fills.filter((f) => f.time >= startMs && f.time <= endMs);
  });
  return { c, calls };
}
const tids = (r: { fills: ApiFill[] }) => r.fills.map((f) => f.tid);

describe("FillCache", () => {
  it("the first get reads once, through throughMs, and returns only the asked range", async () => {
    const { c, calls } = cache();
    const r = await c.get(U, 1000, 1999, 5999);
    expect(calls).toEqual([[U, 1000, 5999]]);
    expect(r.cached).toBe(false);
    expect(tids(r)).toEqual([1, 2]);
  });

  it("a later range inside what is held reads nothing and says it was cached", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 5999);
    const r = await c.get(U, 2000, 2999, 5999);
    expect(calls).toHaveLength(1);
    expect(r.cached).toBe(true);
    expect(tids(r)).toEqual([3, 4]);
  });

  it("a range past what is held reads again, from its own start", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 5999);
    const r = await c.get(U, 6000, 6999, 8999);
    expect(calls).toEqual([[U, 1000, 5999], [U, 6000, 8999]]);
    expect(r.cached).toBe(false);
  });

  it("a range before what is held reads again", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 5999);
    const r = await c.get(U, 500, 999, 5999);
    expect(calls).toEqual([[U, 1000, 5999], [U, 500, 5999]]);
    expect(r.cached).toBe(false);
  });

  it("a throughMs below the range's end reads through the end", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 1200);
    expect(calls).toEqual([[U, 1000, 1999]]);
  });

  it("wallets are held separately", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 5999);
    const r = await c.get(V, 1000, 1999, 5999);
    expect(r.cached).toBe(false);
    expect(calls).toEqual([[U, 1000, 5999], [V, 1000, 5999]]);
  });

  it("fresh reads exactly the range, whatever is held, and leaves the held entry as it was", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 5999);
    expect(tids({ fills: await c.fresh(U, 1000, 1999) })).toEqual([1, 2]);
    expect(await c.fresh(U, 1000, 1999)).toHaveLength(2);
    expect(calls).toEqual([[U, 1000, 5999], [U, 1000, 1999], [U, 1000, 1999]]);
    const r = await c.get(U, 4000, 5999, 5999); // still held through 5999
    expect(r.cached).toBe(true);
    expect(tids(r)).toEqual([5, 6]);
    expect(calls).toHaveLength(3);
  });

  it("fresh does not create an entry", async () => {
    const { c, calls } = cache();
    await c.fresh(U, 1000, 1999);
    const r = await c.get(U, 1000, 1999, 1999);
    expect(r.cached).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("dropBefore forgets an entry held only through older fills, and a held one whose start moved is read again", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 2999); // held through 2999
    await c.get(V, 1000, 1999, 5999); // held through 5999
    c.dropBefore(3000);
    expect((await c.get(U, 1000, 1999, 2999)).cached).toBe(false); // gone
    expect(calls).toHaveLength(3);
    expect((await c.get(V, 1000, 1999, 5999)).cached).toBe(false); // kept, but its start moved to 3000
    expect(calls).toHaveLength(4);
  });

  it("dropBefore keeps the fills at or after the cut and drops the older ones", async () => {
    const { c, calls } = cache();
    await c.get(U, 1000, 1999, 5999);
    c.dropBefore(2000);
    const r = await c.get(U, 2000, 5999, 5999);
    expect(r.cached).toBe(true);
    expect(calls).toHaveLength(1);
    expect(tids(r)).toEqual([3, 4, 5, 6]);
  });

  it("a read that fails leaves nothing held", async () => {
    let fail = true;
    const c = new FillCache(async () => {
      if (fail) throw new Error("hl down");
      return ALL;
    });
    await expect(c.get(U, 1000, 1999, 5999)).rejects.toThrow("hl down");
    fail = false;
    expect((await c.get(U, 1000, 1999, 5999)).cached).toBe(false);
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Pacer, pacedFills } from "../src/pacer.js";

describe("Pacer", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  const timesOf = async (p: Pacer, n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const w = p.wait();
      await vi.runAllTimersAsync();
      await w;
      out.push(Date.now());
    }
    return out;
  };

  it("the first read goes at once, then one every 60 000 / perMinute ms", async () => {
    expect(await timesOf(new Pacer(50), 3)).toEqual([1_000_000, 1_001_200, 1_002_400]);
  });
  it("idle time earns no burst", async () => {
    const p = new Pacer(50);
    await timesOf(p, 1);
    vi.setSystemTime(2_000_000);
    expect(await timesOf(p, 2)).toEqual([2_000_000, 2_001_200]);
  });
  it("20 fills or fewer add nothing; more add their weight (1 per 20 items; a read weighs 20)", async () => {
    const p = new Pacer(50);
    await timesOf(p, 1);
    p.addItems(20);
    expect(await timesOf(p, 1)).toEqual([1_001_200]);
    p.addItems(400); // 20 extra weight = one more read's slot
    expect(await timesOf(p, 1)).toEqual([1_003_600]);
  });
  it("pacedFills waits, reads, and reports the size", async () => {
    const p = new Pacer(50);
    const add = vi.spyOn(p, "addItems");
    const read = vi.fn(async () => [{ tid: 1 }] as never);
    const paced = pacedFills(p, read);
    const r = paced("0xa" as never, 1, 2);
    await vi.runAllTimersAsync();
    expect(await r).toEqual([{ tid: 1 }]);
    expect(read).toHaveBeenCalledWith("0xa", 1, 2);
    expect(add).toHaveBeenCalledWith(1);
  });
});

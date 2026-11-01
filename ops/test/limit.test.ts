import { describe, expect, it } from "vitest";
import { forEachLimit } from "../src/limit.js";

const tick = () => new Promise<void>((r) => setTimeout(r, 1));

describe("forEachLimit", () => {
  it("runs every item, at most `limit` at a time", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await forEachLimit(Array.from({ length: 40 }, (_, i) => i), 16, async (x) => {
      peak = Math.max(peak, ++active);
      await tick();
      active--;
      done.push(x);
    });
    expect(peak).toBe(16);
    expect(done.sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it("an empty list, or fewer items than the limit, is fine", async () => {
    await forEachLimit([], 16, async () => {
      throw new Error("never");
    });
    const seen: number[] = [];
    await forEachLimit([1, 2], 16, async (x) => void seen.push(x));
    expect(seen).toEqual([1, 2]);
  });

  it("the first failure rejects only after the ones already running have finished, and starts no more", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const err = await forEachLimit([0, 1, 2, 3, 4, 5], 3, async (x) => {
      started.push(x);
      if (x === 0) throw new Error("boom");
      await tick();
      await tick();
      finished.push(x);
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe("boom");
    // 0 failed at once; 1 and 2 were running and finished before the rejection; 3.. never started
    expect(started).toEqual([0, 1, 2]);
    expect(finished).toEqual([1, 2]);
  });

  it("with several failures the first is the one reported", async () => {
    const err = await forEachLimit([1, 2, 3], 3, async (x) => {
      await new Promise((r) => setTimeout(r, 10 * x));
      throw new Error(`fail ${x}`);
    }).catch((e: Error) => e);
    expect((err as Error).message).toBe("fail 1");
  });

  it("a limit below 1 is refused rather than silently doing nothing", async () => {
    await expect(forEachLimit([1], 0, async () => {})).rejects.toThrow(RangeError);
  });
});

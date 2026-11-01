import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Addr, ApiFill } from "@hlo/calc";
import { Ingest, type FillSource } from "../src/ingest.js";
import type { Registration } from "../src/registry.js";
import { Store } from "../src/store.js";

const L = 1_800_000_000;
const u1: Addr = "0x00000000000000000000000000000000000000a1";
const u2: Addr = "0x00000000000000000000000000000000000000a2";
const u3: Addr = "0x00000000000000000000000000000000000000a3";
// px·sz = 1000 → fee 1 USDC = 100_000_000 units
const good = (tid: number, timeMs: number, fee = "1"): ApiFill => ({ tid, time: timeMs, coin: "BTC", px: "100", sz: "10", builderFee: fee });
const at = (minute: number, sec = 0) => (L + minute * 60 + sec) * 1000;

/** `launch` 0 puts the first minute at 0 ms, so small round ms values read as they are. */
function fixture(fills: Record<string, ApiFill[]>, launch = L) {
  const calls: Array<[string, number, number]> = [];
  const src: FillSource = {
    async fills(user, s, e) {
      calls.push([user, s, e]);
      return (fills[user] ?? []).filter((f) => f.time >= s && f.time <= e);
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "ing-"));
  return { calls, src, dir, ingest: (clock?: () => number) => new Ingest(new Store(dir), src, launch, clock) };
}

/** Five wallets (lowercase), each with one counted fill in minute 1 (`oneFillEach`). */
const wallets = [1, 2, 3, 4, 5].map((n) => `0x000000000000000000000000000000000000b${n}00` as Addr);
const regsOf = (users: readonly Addr[]) => users.map((user) => ({ user, registeredAt: 1 }));
const oneFillEach = () => Object.fromEntries(wallets.map((w, i) => [w, [good(i + 1, at(1))]]));
const onDisk = (dir: string) => new Store(dir).readJson<any>("ingest", null);
const spyWrites = (store: Store) => {
  const w = { n: 0 };
  const orig = store.writeJson.bind(store);
  store.writeJson = (name: string, v: unknown) => {
    w.n++;
    orig(name, v);
  };
  return w;
};

describe("Ingest", () => {
  it("drops fills before registeredAt and non-counted fills", async () => {
    const f = fixture({ [u1]: [good(1, at(0, 5)), good(2, at(2, 5)), good(3, at(3, 5), "0.5") /* wrong rate */, { ...good(4, at(3, 6)), coin: "@5" }] });
    const regs: Registration[] = [{ user: u1, registeredAt: L + 120 }];
    const ing = f.ingest();
    await ing.catchUp(regs, at(10));
    expect(ing.rows(0, 10)).toEqual([{ minute: 2, user: u1, fee: 100_000_000n }]);
    expect(f.calls[0][1]).toBe((L + 120) * 1000); // asks only from registeredAt
  });

  it("starts at max(launchTime, registeredAt) when registered before launch", async () => {
    const f = fixture({});
    await f.ingest().catchUp([{ user: u1, registeredAt: L - 500 }], at(1));
    expect(f.calls[0][1]).toBe(L * 1000);
  });

  it("advances the cursor to endMs and resumes at endMs + 1", async () => {
    const f = fixture({ [u1]: [good(1, at(1))] });
    const ing = f.ingest();
    const regs = [{ user: u1, registeredAt: 1 }];
    expect(ing.fetchedThrough(u1)).toBe(-1);
    await ing.catchUp(regs, at(5));
    expect(ing.fetchedThrough(u1)).toBe(at(5));
    await ing.catchUp(regs, at(9));
    expect(f.calls.map((c) => [c[1], c[2]])).toEqual([[L * 1000, at(5)], [at(5) + 1, at(9)]]);
    expect(ing.fetchedThrough(u1)).toBe(at(9));
  });

  it("writes the file only when a cursor or a row changed", async () => {
    const f = fixture({ [u1]: [good(1, at(1))] });
    const store = new Store(f.dir);
    let writes = 0;
    const orig = store.writeJson.bind(store);
    store.writeJson = (n: string, v: unknown) => {
      writes++;
      orig(n, v);
    };
    const ing = new Ingest(store, f.src, L);
    const regs = [{ user: u1, registeredAt: 1 }];
    await ing.catchUp(regs, at(5));
    expect(writes).toBe(1);
    await ing.catchUp(regs, at(5)); // same end: nothing to fetch, nothing changed
    await ing.catchUp([], at(9));
    expect(writes).toBe(1);
    await ing.catchUp(regs, at(9)); // the cursor moves
    expect(writes).toBe(2);
  });

  it("persists rows and cursors across a new Ingest on the same dir", async () => {
    const f = fixture({ [u1]: [good(1, at(1))] });
    await f.ingest().catchUp([{ user: u1, registeredAt: 1 }], at(5));
    const again = f.ingest();
    expect(again.fetchedThrough(u1)).toBe(at(5));
    expect(again.rows(0, 9)).toEqual([{ minute: 1, user: u1, fee: 100_000_000n }]);
  });

  it("rows(3, 3) returns only minute 3, summed per user and sorted", async () => {
    const f = fixture({
      [u2]: [good(1, at(3, 1)), good(2, at(4, 1))],
      [u1]: [good(3, at(3, 2)), good(4, at(3, 30), "2"), good(5, at(2, 59))],
    });
    // fee "2" does not match px·sz = 1000, so it is dropped; use a matching big fill instead
    const ing = f.ingest();
    await ing.catchUp([{ user: u2, registeredAt: 1 }, { user: u1, registeredAt: 1 }], at(10));
    expect(ing.rows(3, 3)).toEqual([
      { minute: 3, user: u1, fee: 100_000_000n },
      { minute: 3, user: u2, fee: 100_000_000n },
    ]);
  });

  it("sums several counted fills of one user in one minute", async () => {
    const f = fixture({ [u1]: [good(1, at(3, 1)), good(2, at(3, 2))] });
    const ing = f.ingest();
    await ing.catchUp([{ user: u1, registeredAt: 1 }], at(10));
    expect(ing.rows(3, 3)).toEqual([{ minute: 3, user: u1, fee: 200_000_000n }]);
  });

  it("prune(4) drops minutes below 4 and persists", async () => {
    const f = fixture({ [u1]: [good(1, at(3)), good(2, at(4)), good(3, at(6))] });
    const ing = f.ingest();
    await ing.catchUp([{ user: u1, registeredAt: 1 }], at(10));
    ing.prune(4);
    expect(ing.rows(0, 99).map((r) => r.minute)).toEqual([4, 6]);
    expect(f.ingest().rows(0, 99).map((r) => r.minute)).toEqual([4, 6]);
    expect(f.ingest().fetchedThrough(u1)).toBe(at(10));
  });

  it("a failing wallet keeps the earlier wallets' progress", async () => {
    const f = fixture({ [u1]: [good(1, at(1))] });
    const failing: FillSource = { fills: (u, s, e) => (u === u2 ? Promise.reject(new Error("down")) : f.src.fills(u, s, e)) };
    const ing = new Ingest(new Store(f.dir), failing, L);
    await expect(ing.catchUp([{ user: u1, registeredAt: 1 }, { user: u2, registeredAt: 1 }], at(5))).rejects.toThrow("down");
    const again = f.ingest();
    expect(again.fetchedThrough(u1)).toBe(at(5));
    expect(again.fetchedThrough(u2)).toBe(-1);
  });

  it("skips a wallet whose cursor is already at or past endMs, and fetches the others", async () => {
    const f = fixture({ [u1]: [good(1, at(1))], [u2]: [good(2, at(1))] });
    const ing = f.ingest();
    await ing.catchUp([{ user: u1, registeredAt: 1 }], at(5));
    f.calls.length = 0;
    await ing.catchUp([{ user: u1, registeredAt: 1 }, { user: u2, registeredAt: 1 }], at(5));
    expect(f.calls.map((c) => c[0])).toEqual([u2]);
    f.calls.length = 0;
    await ing.catchUp([{ user: u1, registeredAt: 1 }], at(3)); // a cursor beyond the wanted end is also skipped
    expect(f.calls).toEqual([]);
  });

  it("returns how many wallets it fetched: those skipped, and those with nothing to ask for, are not counted", async () => {
    const f = fixture({ [u1]: [good(1, at(1))], [u2]: [good(2, at(1))] });
    const ing = f.ingest();
    expect(await ing.catchUp([{ user: u1, registeredAt: 1 }], at(5))).toBe(1);
    expect(await ing.catchUp([{ user: u1, registeredAt: 1 }, { user: u2, registeredAt: 1 }], at(5))).toBe(1); // u1 is through at(5)
    expect(await ing.catchUp([{ user: u1, registeredAt: 1 }, { user: u2, registeredAt: 1 }], at(5))).toBe(0);
    expect(await ing.catchUp([], at(9))).toBe(0);
    // registered after the end of the range: nothing to ask for, so nothing fetched
    expect(await ing.catchUp([{ user: u3, registeredAt: L + 600 }], at(2))).toBe(0);
    expect(f.calls.map((c) => c[0])).toEqual([u1, u2]);
  });

  it("fetches a wallet that is behind through throughMs, not just endMs; wallets that are not behind are not fetched at all", async () => {
    const f = fixture({ [u1]: [good(1, at(1)), good(2, at(7))] });
    const ing = f.ingest();
    await ing.catchUp([{ user: u1, registeredAt: 1 }], at(2), at(9));
    expect(f.calls.map((c) => [c[1], c[2]])).toEqual([[L * 1000, at(9)]]);
    expect(ing.fetchedThrough(u1)).toBe(at(9));
    expect(ing.rows(0, 9).map((r) => r.minute)).toEqual([1, 7]);
  });

  it("a malformed fill fails the wallet atomically: a retry counts the fees exactly once", async () => {
    let bad = true;
    const src: FillSource = {
      async fills() {
        return bad ? [good(1, at(1)), { ...good(2, at(2)), px: "x" }] : [good(1, at(1)), good(2, at(2))];
      },
    };
    const dir = mkdtempSync(join(tmpdir(), "ing-"));
    const ing = new Ingest(new Store(dir), src, L);
    const regs = [{ user: u1, registeredAt: 1 }];
    await expect(ing.catchUp(regs, at(5))).rejects.toThrow();
    expect(ing.rows(0, 99)).toEqual([]);
    expect(ing.fetchedThrough(u1)).toBe(-1);
    bad = false;
    await ing.catchUp(regs, at(5));
    expect(ing.rows(0, 99)).toEqual([{ minute: 1, user: u1, fee: 100_000_000n }, { minute: 2, user: u1, fee: 100_000_000n }]);
  });

  it("refuses a malformed ingest.json with a clear error", () => {
    const dir = mkdtempSync(join(tmpdir(), "ing-"));
    const store = new Store(dir);
    const make = () => new Ingest(store, { fills: async () => [] }, L);
    store.writeJson("ingest", { v: 1, cursors: [], rows: [] });
    expect(make).toThrow(/ingest.json is not a valid ingest file/);
    store.writeJson("ingest", { v: 1, cursors: {}, rows: [[1.5, u1, "5"]] });
    expect(make).toThrow(/not a valid ingest file/);
    store.writeJson("ingest", { v: 1, cursors: {}, rows: [[1, "nope", "5"]] });
    expect(make).toThrow(/not a valid ingest file/);
    store.writeJson("ingest", { v: 1, cursors: {}, rows: [[1, u1, "-5"]] });
    expect(make).toThrow(/not a valid ingest file/);
    store.writeJson("ingest", { v: 3, coveredThrough: -1, cursors: {}, recent: {}, rows: [] });
    expect(make).toThrow(/not a valid ingest file/);
    store.writeJson("ingest", { v: 1, cursors: { [u1]: 5 }, rows: [[1, u1, "5"]] });
    expect(make().rows(0, 9)).toEqual([{ minute: 1, user: u1, fee: 5n }]);
  });
});

describe("Ingest version 2", () => {
  it("loads a version 1 file exactly: nothing is refetched, and the next save is version 2", async () => {
    const f = fixture({ [u1]: [good(1, 5000), good(2, 5001)] }, 0);
    new Store(f.dir).writeJson("ingest", { v: 1, cursors: { [u1]: 5000 }, rows: [[0, u1, "7"]] });
    const ing = f.ingest();
    expect(ing.coveredThrough).toBe(-1);
    expect(ing.fetchedThrough(u1)).toBe(5000);
    expect(ing.rows(0, 9)).toEqual([{ minute: 0, user: u1, fee: 7n }]);
    await ing.catchUp([{ user: u1, registeredAt: 1 }], 9000);
    expect(f.calls).toEqual([[u1, 5001, 9000]]); // from the cursor + 1, the fill at 5000 is not asked for again
    expect(ing.rows(0, 9)).toEqual([{ minute: 0, user: u1, fee: 100_000_007n }]);
    expect(onDisk(f.dir)).toEqual({ v: 2, coveredThrough: -1, cursors: { [u1]: 9000 }, recent: { [u1]: 5001 }, rows: [[0, u1, "100000007"]] });
  });

  it("markCovered moves coveredThrough up only, and drops the cursors it passes", () => {
    const f = fixture({}, 0);
    new Store(f.dir).writeJson("ingest", { v: 2, coveredThrough: -1, cursors: { [u1]: 8000, [u2]: 12000, [u3]: 9000 }, recent: {}, rows: [] });
    const ing = f.ingest();
    ing.markCovered(9000);
    expect(ing.coveredThrough).toBe(9000);
    expect(ing.fetchedThrough("0x00000000000000000000000000000000000000ff")).toBe(9000); // a wallet never seen
    expect(ing.fetchedThrough(u1)).toBe(9000);
    expect(ing.fetchedThrough(u2)).toBe(12000);
    expect(ing.fetchedThrough(u3)).toBe(9000);
    expect(onDisk(f.dir)).toMatchObject({ v: 2, coveredThrough: 9000, cursors: { [u2]: 12000 } });
    expect(Object.keys(onDisk(f.dir).cursors)).toEqual([u2]);
    ing.markCovered(5000); // never backwards
    expect(ing.coveredThrough).toBe(9000);
    expect(f.ingest().coveredThrough).toBe(9000);
  });

  it("asks a wallet with no cursor from coveredThrough + 1, or from its registration when that is later; a covered end asks nothing", async () => {
    const f = fixture({}, 0);
    const ing = f.ingest();
    ing.markCovered(9000);
    const regs = [{ user: u1, registeredAt: 1 }, { user: u2, registeredAt: 10 }];
    await ing.catchUp(regs, 9000);
    expect(f.calls).toEqual([]); // every wallet is already there
    await ing.catchUp(regs, 12000);
    expect(f.calls).toEqual([[u1, 9001, 12000], [u2, 10000, 12000]]);
    expect(ing.fetchedThrough(u1)).toBe(12000);
  });

  it("recentSince lists the wallets whose newest counted fill is at or after the time, across a restart, until it ages out", async () => {
    const T = at(3, 5);
    const f = fixture({
      [u1]: [good(1, T - 1000), good(2, T)],
      [u2]: [good(3, T, "0.5") /* wrong rate: not counted */, { ...good(4, T), coin: "@5" }],
    });
    const regs = regsOf([u1, u2]);
    const ing = f.ingest();
    await ing.catchUp(regs, at(10));
    expect(ing.recentSince(T)).toEqual([u1]);
    expect(ing.recentSince(T - 1000)).toEqual([u1]);
    expect(ing.recentSince(T + 1)).toEqual([]);
    expect(f.ingest().recentSince(T)).toEqual([u1]); // a restart keeps it
    ing.markCovered(T + 24 * 3600 * 1000);
    expect(ing.recentSince(0)).toEqual([u1]); // exactly 24 h old: kept
    ing.markCovered(T + 24 * 3600 * 1000 + 1);
    expect(ing.recentSince(0)).toEqual([]);
    expect(f.ingest().recentSince(0)).toEqual([]);
  });

  it("writes once at the end of a pass while the clock stands still, and at most once per 10 s otherwise", async () => {
    const fills = oneFillEach();
    let now = 1_000_000;
    const step = { by: 0 };
    const src: FillSource = {
      async fills(user, s, e) {
        now += step.by; // each read takes `by` ms on the clock
        return (fills[user] ?? []).filter((x) => x.time >= s && x.time <= e);
      },
    };
    const run = async (by: number) => {
      step.by = by;
      const store = new Store(mkdtempSync(join(tmpdir(), "ing-")));
      const writes = spyWrites(store);
      const ing = new Ingest(store, src, L, () => now);
      await ing.catchUp(regsOf(wallets), at(5));
      expect(ing.rows(0, 9)).toHaveLength(5);
      expect(store.readJson<any>("ingest", null).rows).toHaveLength(5); // the last save has everything
      return writes.n;
    };
    expect(await run(0)).toBe(1);
    expect(await run(4_000)).toBe(2); // 4, 8, 12 s: saved after the third wallet; the end saves the rest
    expect(await run(11_000)).toBe(5); // each read is 11 s after the last save
  });

  it("a read that throws mid-pass still saves the earlier wallets, and a new Ingest goes on with the later one only", async () => {
    const f = fixture(oneFillEach());
    let down = true;
    const flaky: FillSource = { fills: (u, s, e) => (u === wallets[1] && down ? Promise.reject(new Error("down")) : f.src.fills(u, s, e)) };
    const ing = new Ingest(new Store(f.dir), flaky, L, () => 5); // the clock stands still: only the end of the pass saves
    const regs = regsOf(wallets.slice(0, 2));
    await expect(ing.catchUp(regs, at(5))).rejects.toThrow("down");
    expect(onDisk(f.dir).cursors).toEqual({ [wallets[0]]: at(5) });
    expect(onDisk(f.dir).rows).toEqual([[1, wallets[0], "100000000"]]);
    down = false;
    f.calls.length = 0;
    const again = f.ingest();
    await again.catchUp(regs, at(5));
    expect(f.calls.map((c) => c[0])).toEqual([wallets[1]]);
    expect(again.rows(0, 9)).toEqual([
      { minute: 1, user: wallets[0], fee: 100_000_000n },
      { minute: 1, user: wallets[1], fee: 100_000_000n },
    ]);
  });

  it("a crash between saves loses only what was not saved: those wallets are read again and counted once", async () => {
    // The process dies in the pass (the read never answers): the final save is never reached.
    for (const [by, saved] of [[0, 0], [6_000, 2]] as const) {
      let now = 0;
      const f = fixture(oneFillEach());
      const dying: FillSource = {
        async fills(u, s, e) {
          now += by;
          if (u === wallets[3]) return new Promise<ApiFill[]>(() => {});
          return f.src.fills(u, s, e);
        },
      };
      const store = new Store(f.dir);
      const writes = spyWrites(store);
      void new Ingest(store, dying, L, () => now).catchUp(regsOf(wallets), at(5)).catch(() => {});
      await new Promise((r) => setImmediate(r));
      expect(f.calls.map((c) => c[0])).toEqual(wallets.slice(0, 3)); // the fourth read is the one that hangs
      // 0 s steps: no save at all. 6 s steps: the second wallet (12 s) saved, the third (6 s later) did not.
      expect(writes.n).toBe(by === 0 ? 0 : 1);
      expect((onDisk(f.dir)?.rows ?? []).length).toBe(saved);
      f.calls.length = 0;
      const again = f.ingest();
      await again.catchUp(regsOf(wallets), at(5));
      expect(f.calls.map((c) => c[0])).toEqual(wallets.slice(saved)); // the saved wallets are not read again
      expect(again.rows(0, 9)).toEqual(wallets.map((user) => ({ minute: 1, user, fee: 100_000_000n }))); // each fee once
    }
  });

  it("refuses a version 2 file with a bad coveredThrough or recent, and any other version", () => {
    const dir = mkdtempSync(join(tmpdir(), "ing-"));
    const store = new Store(dir);
    const make = () => new Ingest(store, { fills: async () => [] }, L);
    const ok = { v: 2, coveredThrough: 7, cursors: {}, recent: {}, rows: [] };
    for (const bad of [
      { ...ok, coveredThrough: -2 },
      { ...ok, coveredThrough: 1.5 },
      { ...ok, coveredThrough: "7" },
      { ...ok, coveredThrough: null },
      { ...ok, recent: [] },
      { ...ok, recent: null },
      { ...ok, recent: { nope: 5 } },
      { ...ok, recent: { [u1]: 1.5 } },
      { ...ok, recent: { [u1]: "5" } },
      { v: 2, coveredThrough: 7, cursors: {}, rows: [] }, // recent missing
      { v: 2, cursors: {}, recent: {}, rows: [] }, // coveredThrough missing
      { ...ok, v: 3 },
    ]) {
      store.writeJson("ingest", bad);
      expect(make).toThrow(/ingest.json is not a valid ingest file/);
    }
    store.writeJson("ingest", { ...ok, coveredThrough: -1, recent: { [u1]: 5 } });
    expect(make().recentSince(5)).toEqual([u1]);
    store.writeJson("ingest", ok);
    expect(make().coveredThrough).toBe(7);
  });
});

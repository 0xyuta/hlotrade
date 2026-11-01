import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Addr } from "@hlo/calc";
import { describe, expect, it, vi } from "vitest";
import { DirRegistry, R2Registry, parseRegistration, registryKey, registryLogKey } from "../src/registry.js";
import { Store } from "../src/store.js";

const A = "0x00000000000000000000000000000000000000AA";
const a = A.toLowerCase() as Addr;
const b: Addr = "0x00000000000000000000000000000000000000bb";

describe("parseRegistration", () => {
  it("accepts a record and lowercases the address", () => {
    expect(parseRegistration({ user: "0xAA" + "00".repeat(19), registeredAt: 1793300000 })).toEqual({ user: "0xaa" + "00".repeat(19), registeredAt: 1793300000 });
  });
  it("rejects missing, malformed and junk input", () => {
    const ok = { user: A, registeredAt: 1793300000 };
    expect(parseRegistration({ registeredAt: 1 })).toBeNull();
    expect(parseRegistration({ ...ok, user: "0x12" })).toBeNull();
    expect(parseRegistration({ ...ok, user: "0x" + "zz".repeat(20) })).toBeNull();
    expect(parseRegistration({ ...ok, user: 5 })).toBeNull();
    expect(parseRegistration({ ...ok, registeredAt: 1.5 })).toBeNull();
    expect(parseRegistration({ ...ok, registeredAt: 0 })).toBeNull();
    expect(parseRegistration({ ...ok, registeredAt: -3 })).toBeNull();
    expect(parseRegistration({ ...ok, registeredAt: "1793300000" })).toBeNull();
    expect(parseRegistration({ ...ok, registeredAt: 1793300000000 })).toBeNull(); // milliseconds as seconds
    expect(parseRegistration({ ...ok, registeredAt: 9_999_999_999 })).not.toBeNull();
    expect(parseRegistration(null)).toBeNull();
    expect(parseRegistration("x")).toBeNull();
    expect(parseRegistration([])).toBeNull();
  });
});

describe("registryKey", () => {
  it("is the literal the app uses", () => {
    expect(registryKey(998, A)).toBe("registry/998/0x00000000000000000000000000000000000000aa.json");
  });
});

describe("registryLogKey", () => {
  it("is the literal the app uses: chain, registeredAt to 10 digits, lowercase address", () => {
    expect(registryLogKey(998, 1800000000, A)).toBe("registry-log/998/1800000000-0x00000000000000000000000000000000000000aa.json");
    expect(registryLogKey(999, 1800000000, b)).toBe("registry-log/999/1800000000-0x00000000000000000000000000000000000000bb.json");
  });
  it("pads a small registeredAt to 10 digits, so keys sort by time", () => {
    expect(registryLogKey(998, 5, A)).toBe("registry-log/998/0000000005-0x00000000000000000000000000000000000000aa.json");
    expect(registryLogKey(998, 999, a) < registryLogKey(998, 1000, a)).toBe(true);
  });
});

describe("DirRegistry", () => {
  it("lists valid files and skips a broken one with a warning", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reg-"));
    writeFileSync(join(dir, "1.json"), JSON.stringify({ user: A, registeredAt: 100 }));
    writeFileSync(join(dir, "2.json"), JSON.stringify({ user: b, registeredAt: 200 }));
    writeFileSync(join(dir, "3.json"), "{not json");
    writeFileSync(join(dir, "4.json"), JSON.stringify({ user: "0x12", registeredAt: 1 }));
    writeFileSync(join(dir, "note.txt"), "ignored");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = await new DirRegistry(dir).list();
    expect(list).toEqual([{ user: a, registeredAt: 100 }, { user: b, registeredAt: 200 }]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe("R2Registry", () => {
  const T0 = 1_800_000_000; // registeredAt, unix seconds
  /** "Now" for the tests' clocks, in ms: 5,000 s after T0. The index window is clamped to the clock, so it must be realistic. */
  const NOW0 = (T0 + 5_000) * 1000;
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Addr;
  const a = addr(1); // here the wallets are addr(1), addr(2), ...: the list is ordered by address
  const tick = () => new Promise<void>((r) => setTimeout(r, 1));
  const dir = () => mkdtempSync(join(tmpdir(), "regcache-"));
  const file = (d: string) => join(d, "registry-cache.json");
  /** The wait between a failed read and its retry, skipped (and recorded when a test wants to see it). */
  const noSleep = async () => {};

  /**
   * An in-memory bucket with the two R2 calls the registry uses. `listKeys` answers like S3: keys under the prefix that
   * sort after `startAfter`, in order. Records and index entries share the one key space, as in R2.
   */
  function bucket() {
    const objects = new Map<string, string>();
    const lists: { prefix: string; startAfter?: string }[] = [];
    const reads: string[] = [];
    const failing = new Set<string>();
    const slow = new Set<string>();
    /** key → how many more reads fail before it is served */
    const flaky = new Map<string, number>();
    let active = 0;
    const counts = { peak: 0 };
    return {
      objects, lists, reads, failing, slow, flaky, counts,
      /** A wallet signs up: the index entry first, then the record, like the Worker. Either can be left out. */
      register(user: Addr, at: number, o: { record?: boolean; index?: boolean; recordAt?: number } = {}) {
        if (o.index !== false) objects.set(registryLogKey(998, at, user), "");
        if (o.record !== false) objects.set(registryKey(998, user), JSON.stringify({ user, registeredAt: o.recordAt ?? at }));
      },
      r2: {
        listKeys: async (prefix: string, startAfter?: string) => {
          lists.push({ prefix, startAfter });
          return [...objects.keys()].filter((k) => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort();
        },
        get: async (key: string) => {
          reads.push(key);
          counts.peak = Math.max(counts.peak, ++active);
          try {
            await tick();
            if (slow.has(key)) await tick(), await tick(), await tick();
            if (failing.has(key) || (flaky.get(key) ?? 0) > 0) {
              flaky.set(key, (flaky.get(key) ?? 0) - 1);
              throw new Error(`R2 GET ${key}: HTTP 500`);
            }
            return objects.get(key) ?? null;
          } finally {
            active--;
          }
        },
      },
    };
  }
  const clockAt = (ms: number) => {
    const c = { ms, now: () => c.ms };
    return c;
  };
  const prefixes = (b: ReturnType<typeof bucket>) => b.lists.map((l) => l.prefix);
  const users = (l: { user: Addr }[]) => l.map((r) => r.user);

  it("the first list() reads the whole registry/<chainId>/ prefix, each record once", async () => {
    const b = bucket();
    b.register(a, T0);
    b.register(addr(2), T0 + 100);
    b.objects.set(registryKey(998, addr(3)), JSON.stringify({ user: addr(3), registeredAt: T0 + 50 })); // from before the index existed
    const reg = new R2Registry(b.r2, 998, undefined, clockAt(NOW0).now, noSleep);
    expect(await reg.list()).toEqual([
      { user: a, registeredAt: T0 }, { user: addr(2), registeredAt: T0 + 100 }, { user: addr(3), registeredAt: T0 + 50 },
    ]);
    expect(b.lists).toEqual([{ prefix: "registry/998/", startAfter: undefined }]);
    expect(b.reads.sort()).toEqual([registryKey(998, a), registryKey(998, addr(2)), registryKey(998, addr(3))].sort());
  });

  it("the next list() lists only the index from 10 minutes before the newest registration, and reads only unknown wallets", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0);
    b.register(addr(2), T0 + 100);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    b.lists.length = 0;
    b.reads.length = 0;
    b.register(addr(3), T0 + 200);
    clock.ms += 60_000;
    expect(users(await reg.list())).toEqual([a, addr(2), addr(3)]);
    expect(b.lists).toEqual([{ prefix: "registry-log/998/", startAfter: `registry-log/998/${T0 + 100 - 600}` }]);
    expect(b.reads).toEqual([registryKey(998, addr(3))]);
    // and a pass with nothing new reads nothing
    b.reads.length = 0;
    clock.ms += 60_000;
    expect(users(await reg.list())).toEqual([a, addr(2), addr(3)]);
    expect(b.reads).toEqual([]);
    expect(prefixes(b)).toEqual(["registry-log/998/", "registry-log/998/"]);
  });

  it("an index entry whose record has not landed yet is ignored, then found on a later pass even after newer wallets moved on", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    b.register(addr(2), T0 + 250, { record: false }); // the Worker has written the index and not the record yet
    b.register(addr(3), T0 + 260); // a later registration is complete
    clock.ms += 60_000;
    expect(users(await reg.list())).toEqual([a, addr(3)]);
    expect(b.reads).toContain(registryKey(998, addr(2))); // it was tried
    b.register(addr(2), T0 + 250); // the record lands
    clock.ms += 60_000;
    expect(users(await reg.list())).toEqual([a, addr(2), addr(3)]);
  });

  it("an entry older than the newest registration but inside 10 minutes is found (clock skew); a malformed key is skipped", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0 + 1000);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    b.register(addr(2), T0 + 1000 - 600); // exactly at the start of the window
    b.register(addr(3), T0 + 1000 - 599);
    b.register(addr(4), T0 + 1000 - 601, { record: true }); // just before it: only the hourly read finds it
    for (const bad of ["abc.json", `0000000001-${addr(9)}.txt`, "1800000000-0xzz.json", `1800000000-${addr(9).toUpperCase().replace("0X", "0x")}.json`, `18000-${addr(9)}.json`]) {
      b.objects.set(`registry-log/998/${bad}`, "");
    }
    b.reads.length = 0;
    clock.ms += 60_000;
    expect(users(await reg.list())).toEqual([a, addr(2), addr(3)]);
    expect(b.reads.sort()).toEqual([registryKey(998, addr(2)), registryKey(998, addr(3))].sort());
    clock.ms += 3_600_000;
    expect(users(await reg.list())).toContain(addr(4));
  });

  it("after an hour list() reads the whole prefix again, and finds a wallet that has no index entry", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    b.register(addr(2), T0 + 5, { index: false });
    clock.ms += 3_599_999;
    expect(users(await reg.list())).toEqual([a]); // still the index
    expect(prefixes(b)).toEqual(["registry/998/", "registry-log/998/"]);
    clock.ms += 1;
    expect(users(await reg.list())).toEqual([a, addr(2)]);
    expect(prefixes(b)).toEqual(["registry/998/", "registry-log/998/", "registry/998/"]);
    clock.ms += 60_000;
    await reg.list();
    expect(prefixes(b).at(-1)).toBe("registry-log/998/"); // the hour restarts from the full read
  });

  it("a clock that jumps back makes the next list() a full one", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    clock.ms -= 5_000;
    b.register(addr(2), T0 + 5, { index: false });
    expect(users(await reg.list())).toEqual([a, addr(2)]);
  });

  it("list(true) reads the whole prefix now, whatever the timer says, and the hour restarts from it", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    b.register(addr(2), T0 + 5, { index: false });
    clock.ms += 60_000;
    expect(users(await reg.list())).toEqual([a]);
    expect(users(await reg.list(true))).toEqual([a, addr(2)]);
    expect(prefixes(b)).toEqual(["registry/998/", "registry-log/998/", "registry/998/"]);
    clock.ms += 3_000_000; // 50 minutes after the forced read, 51 after the first
    await reg.list();
    expect(prefixes(b).at(-1)).toBe("registry-log/998/");
  });

  it("a stale or duplicate index entry is harmless: one read, and the record's registeredAt is the truth", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    // two first registrations of one wallet raced: two entries, one record (the winner's time)
    b.register(addr(2), T0 + 40);
    b.objects.set(registryLogKey(998, T0 + 43, addr(2)), "");
    b.objects.set(registryLogKey(998, T0 + 38, addr(2)), "");
    b.reads.length = 0;
    clock.ms += 60_000;
    expect(await reg.list()).toEqual([{ user: a, registeredAt: T0 }, { user: addr(2), registeredAt: T0 + 40 }]);
    expect(b.reads).toEqual([registryKey(998, addr(2))]);
  });

  it("an index entry whose record never lands stays ignored (and costs one read a pass)", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    b.register(a, T0, { record: false });
    for (let i = 0; i < 3; i++) {
      clock.ms += 60_000;
      expect(await reg.list()).toEqual([]);
    }
    expect(b.reads).toEqual([registryKey(998, a), registryKey(998, a), registryKey(998, a)]);
  });

  it("a chain's records never leak into another's", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.register(a, T0);
    b.objects.set(registryLogKey(999, T0 + 1, addr(2)), "");
    b.objects.set(registryKey(999, addr(2)), JSON.stringify({ user: addr(2), registeredAt: T0 + 1 }));
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    expect(users(await reg.list())).toEqual([a]);
    clock.ms += 60_000;
    expect(users(await reg.list())).toEqual([a]);
    expect(prefixes(b)).toEqual(["registry/998/", "registry-log/998/"]);
    expect(b.reads).toEqual([registryKey(998, a)]);
  });

  it("an index entry outside the chain's prefix is not followed even if the store returns it", async () => {
    const r2 = {
      listKeys: async (prefix: string) => (prefix.startsWith("registry-log") ? [registryLogKey(999, T0, addr(2))] : []),
      get: async () => {
        throw new Error("never read");
      },
    };
    const clock = clockAt(NOW0);
    const reg = new R2Registry(r2, 998, undefined, clock.now, noSleep);
    await reg.list();
    clock.ms += 60_000;
    expect(await reg.list()).toEqual([]);
  });

  it("reads records at most 16 at a time", async () => {
    const b = bucket();
    for (let i = 1; i <= 50; i++) b.register(addr(i), T0 + i);
    const reg = new R2Registry(b.r2, 998, undefined, clockAt(NOW0).now, noSleep);
    expect((await reg.list()).length).toBe(50);
    expect(b.counts.peak).toBe(16);
    expect(b.reads.length).toBe(50);
  });

  it("returns the wallets by address whatever order the reads finish in", async () => {
    const b = bucket();
    b.register(addr(1), T0 + 3);
    b.register(addr(2), T0 + 2);
    b.register(addr(3), T0 + 1);
    b.slow.add(registryKey(998, addr(1)));
    expect(users(await new R2Registry(b.r2, 998, undefined, clockAt(NOW0).now, noSleep).list())).toEqual([addr(1), addr(2), addr(3)]);
  });

  it("an invalid record is warned once and skipped; an index pass does not read it again, a full read does (without a second warning)", async () => {
    const b = bucket();
    const bad = registryKey(998, addr(7));
    b.objects.set(bad, "{nope");
    b.objects.set(registryLogKey(998, T0, addr(7)), ""); // it has an index entry, like a record the Worker wrote
    b.objects.set("registry/998/y.json", JSON.stringify({ user: "0x12", registeredAt: 1 }));
    const clock = clockAt(NOW0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    expect(await reg.list()).toEqual([]);
    expect(b.reads.sort()).toEqual(["registry/998/y.json", bad].sort());
    b.objects.set(registryLogKey(998, T0 + 1, addr(9)), ""); // an index pass that also lists a wallet with no record yet
    clock.ms += 60_000;
    expect(await reg.list()).toEqual([]);
    expect(b.reads.length).toBe(3); // only wallet 9's (missing) record was tried: the invalid one is known
    clock.ms += 3_600_000; // a full read again
    expect(await reg.list()).toEqual([]);
    expect(b.reads.filter((k) => k === bad).length).toBe(2);
    expect(warn).toHaveBeenCalledWith(`registry: skipping invalid record ${bad}`);
    expect(warn).toHaveBeenCalledWith("registry: skipping invalid record registry/998/y.json");
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("a record that was invalid and is valid on the next full read is then listed (list(true) can heal one)", async () => {
    const b = bucket();
    const clock = clockAt(NOW0);
    b.objects.set(registryKey(998, a), "{nope");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
    expect(await reg.list()).toEqual([]);
    b.register(a, T0, { index: false }); // fixed by hand
    clock.ms += 60_000;
    expect(await reg.list()).toEqual([]); // an index pass cannot see it
    expect(users(await reg.list(true))).toEqual([a]);
    expect(users(await reg.list())).toEqual([a]);
    warn.mockRestore();
  });

  describe("when a read fails part-way", () => {
    it("a record that cannot be read fails the list, is not kept, and is read again next time", async () => {
      const b = bucket();
      b.register(a, T0);
      b.failing.add(registryKey(998, a));
      const reg = new R2Registry(b.r2, 998, undefined, clockAt(NOW0).now, noSleep);
      await expect(reg.list()).rejects.toThrow("HTTP 500");
      expect(b.reads.length).toBe(3); // the read and its two retries
      b.failing.clear();
      expect(await reg.list()).toEqual([{ user: a, registeredAt: T0 }]);
      expect(b.reads.length).toBe(4);
    });

    it("a read that fails is tried twice more, 1 s apart, before it fails the pass", async () => {
      const b = bucket();
      b.register(a, T0);
      const sleeps: number[] = [];
      const reg = new R2Registry(b.r2, 998, undefined, clockAt(NOW0).now, async (ms) => void sleeps.push(ms));
      b.flaky.set(registryKey(998, a), 2); // fails twice, then is served
      expect(users(await reg.list())).toEqual([a]);
      expect(b.reads).toEqual([registryKey(998, a), registryKey(998, a), registryKey(998, a)]);
      expect(sleeps).toEqual([1000, 1000]);
      // three failures in a row fail the pass, after the same two waits
      const c = bucket();
      c.register(a, T0);
      c.flaky.set(registryKey(998, a), 3);
      const waits: number[] = [];
      const reg2 = new R2Registry(c.r2, 998, undefined, clockAt(NOW0).now, async (ms) => void waits.push(ms));
      await expect(reg2.list()).rejects.toThrow("HTTP 500");
      expect(c.reads.length).toBe(3);
      expect(waits).toEqual([1000, 1000]);
    });

    it("a read that works the first time waits for nothing", async () => {
      const b = bucket();
      b.register(a, T0);
      const sleeps: number[] = [];
      await new R2Registry(b.r2, 998, undefined, clockAt(NOW0).now, async (ms) => void sleeps.push(ms)).list();
      expect(sleeps).toEqual([]);
    });

    it("a full read that failed is not counted as done: the next list() is a full one again", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0, { index: false }); // from before the index: only a full read can find them
      b.register(addr(2), T0 + 1, { index: false });
      b.failing.add(registryKey(998, addr(2)));
      const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
      await expect(reg.list()).rejects.toThrow("HTTP 500");
      b.failing.clear();
      clock.ms += 60_000;
      expect(users(await reg.list())).toEqual([a, addr(2)]);
      expect(prefixes(b)).toEqual(["registry/998/", "registry/998/"]);
      clock.ms += 60_000;
      await reg.list();
      expect(prefixes(b).at(-1)).toBe("registry-log/998/"); // done now
    });

    it("a failed pass does not move the index window: an entry that failed is still inside it when it is retried", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0);
      const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
      await reg.list();
      b.lists.length = 0;
      b.register(addr(2), T0 + 100); // its read fails
      b.register(addr(3), T0 + 2000); // a much newer one is read fine in the same pass
      b.failing.add(registryKey(998, addr(2)));
      clock.ms += 60_000;
      await expect(reg.list()).rejects.toThrow("HTTP 500");
      b.failing.clear();
      clock.ms += 60_000;
      expect(users(await reg.list())).toEqual([a, addr(2), addr(3)]);
      // both passes started from the window before wallet `a`, not from wallet 3's time
      expect(b.lists.map((l) => l.startAfter)).toEqual([`registry-log/998/${T0 - 600}`, `registry-log/998/${T0 - 600}`]);
      // and from then on it starts from wallet 3's
      clock.ms += 60_000;
      await reg.list();
      expect(b.lists.at(-1)?.startAfter).toBe(`registry-log/998/${T0 + 2000 - 600}`);
    });

    it("a list call that fails changes nothing and is retried", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0);
      let fail = true;
      const reg = new R2Registry(
        { listKeys: async (p, s) => (fail ? Promise.reject(new Error("R2 list: HTTP 503")) : b.r2.listKeys(p, s)), get: b.r2.get },
        998, undefined, clock.now, noSleep,
      );
      await expect(reg.list()).rejects.toThrow("HTTP 503");
      fail = false;
      expect(users(await reg.list())).toEqual([a]);
      expect(b.lists[0].prefix).toBe("registry/998/");
    });

    it("a record listed and then gone, in a full read, is an error (the registry is unreadable this minute)", async () => {
      const r2 = { listKeys: async () => [registryKey(998, a)], get: async () => null };
      await expect(new R2Registry(r2, 998, undefined, clockAt(NOW0).now, noSleep).list()).rejects.toThrow(`registry ${registryKey(998, a)}: listed but not found`);
    });
  });

  describe("registry-cache.json", () => {
    it("holds {v:1, records:[[user, registeredAt], …]}, written when a new record was found, and not otherwise", async () => {
      const d = dir();
      const store = new Store(d);
      const writeJson = vi.spyOn(store, "writeJson");
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0);
      b.register(addr(2), T0 + 100);
      const reg = new R2Registry(b.r2, 998, store, clock.now, noSleep);
      await reg.list();
      expect(JSON.parse(readFileSync(file(d), "utf8"))).toEqual({ v: 1, records: [[a, T0], [addr(2), T0 + 100]] });
      expect(writeJson).toHaveBeenCalledTimes(1);
      clock.ms += 60_000;
      await reg.list(); // nothing new
      expect(writeJson).toHaveBeenCalledTimes(1);
      b.register(addr(3), T0 + 200);
      clock.ms += 60_000;
      await reg.list();
      expect(writeJson).toHaveBeenCalledTimes(2);
      expect(JSON.parse(readFileSync(file(d), "utf8")).records).toEqual([[a, T0], [addr(2), T0 + 100], [addr(3), T0 + 200]]);
    });

    it("a pass that failed still writes what it read (every kept record is valid); the next pass saves the rest", async () => {
      const d = dir();
      const store = new Store(d);
      const writeJson = vi.spyOn(store, "writeJson");
      const b = bucket();
      b.register(a, T0);
      b.register(addr(2), T0 + 1);
      b.failing.add(registryKey(998, addr(2)));
      const clock = clockAt(NOW0);
      const reg = new R2Registry(b.r2, 998, store, clock.now, noSleep);
      await expect(reg.list()).rejects.toThrow("HTTP 500");
      expect(writeJson).toHaveBeenCalledTimes(1);
      expect(JSON.parse(readFileSync(file(d), "utf8"))).toEqual({ v: 1, records: [[a, T0]] });
      b.failing.clear();
      clock.ms += 60_000;
      await reg.list();
      expect(writeJson).toHaveBeenCalledTimes(2);
      expect(JSON.parse(readFileSync(file(d), "utf8")).records).toEqual([[a, T0], [addr(2), T0 + 1]]);
    });

    it("a pass that failed having read nothing new writes nothing", async () => {
      const d = dir();
      const store = new Store(d);
      const writeJson = vi.spyOn(store, "writeJson");
      const b = bucket();
      b.register(a, T0);
      b.failing.add(registryKey(998, a));
      await expect(new R2Registry(b.r2, 998, store, clockAt(NOW0).now, noSleep).list()).rejects.toThrow("HTTP 500");
      expect(writeJson).not.toHaveBeenCalled();
    });

    it("after a failed cold read, a restart reads only what the failed pass did not (a failure does not redo the reads)", async () => {
      const d = dir();
      const b = bucket();
      for (let i = 1; i <= 40; i++) b.register(addr(i), T0 + i, { index: false });
      b.failing.add(registryKey(998, addr(40)));
      await expect(new R2Registry(b.r2, 998, new Store(d), clockAt(NOW0).now, noSleep).list()).rejects.toThrow("HTTP 500");
      const saved = JSON.parse(readFileSync(file(d), "utf8")).records.length;
      expect(saved).toBe(39); // every record the pass read, though it failed
      b.failing.clear();
      b.reads.length = 0;
      expect((await new R2Registry(b.r2, 998, new Store(d), clockAt(NOW0 + 60_000).now, noSleep).list()).length).toBe(40);
      expect(b.reads).toEqual([registryKey(998, addr(40))]);
    });

    it("a new R2Registry on it reads no record it already knows on its first list(), and still reads the whole prefix", async () => {
      const d = dir();
      const b = bucket();
      b.register(a, T0);
      b.register(addr(2), T0 + 100);
      await new R2Registry(b.r2, 998, new Store(d), clockAt(NOW0).now, noSleep).list();
      b.register(addr(3), T0 + 200, { index: false }); // registered while the process was down
      b.reads.length = 0;
      b.lists.length = 0;
      const second = new R2Registry(b.r2, 998, new Store(d), clockAt(NOW0 + 1_000).now, noSleep);
      expect(users(await second.list())).toEqual([a, addr(2), addr(3)]);
      expect(b.lists).toEqual([{ prefix: "registry/998/", startAfter: undefined }]);
      expect(b.reads).toEqual([registryKey(998, addr(3))]);
      expect(JSON.parse(readFileSync(file(d), "utf8")).records.length).toBe(3);
    });

    it("a restart with nothing new reads nothing and does not rewrite the file", async () => {
      const d = dir();
      const b = bucket();
      b.register(a, T0);
      await new R2Registry(b.r2, 998, new Store(d), clockAt(NOW0).now, noSleep).list();
      const store = new Store(d);
      const writeJson = vi.spyOn(store, "writeJson");
      b.reads.length = 0;
      expect(users(await new R2Registry(b.r2, 998, store, clockAt(NOW0 + 1_000).now, noSleep).list())).toEqual([a]);
      expect(b.reads).toEqual([]);
      expect(writeJson).not.toHaveBeenCalled();
    });

    it("a cache with a bad entry, a wrong version, a wrong shape or broken JSON is ignored with a warning, then everything is read", async () => {
      const good = [[a, T0], [addr(2), T0 + 100]];
      const bads: [string, string][] = [
        ["a bad entry", JSON.stringify({ v: 1, records: [[a, T0], ["0x12", T0 + 1]] })],
        ["a bad time", JSON.stringify({ v: 1, records: [[a, "soon"]] })],
        ["an entry that is not a pair", JSON.stringify({ v: 1, records: [[a, T0], 5] })],
        ["a wrong version", JSON.stringify({ v: 2, records: good })],
        ["no version", JSON.stringify({ records: good })],
        ["records not a list", JSON.stringify({ v: 1, records: "x" })],
        ["not an object", "[1,2]"],
        ["null", "null"],
        ["broken JSON", "{not json"],
      ];
      for (const [what, text] of bads) {
        const d = dir();
        writeFileSync(file(d), text);
        const b = bucket();
        b.register(a, T0);
        b.register(addr(2), T0 + 100);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const reg = new R2Registry(b.r2, 998, new Store(d), clockAt(NOW0).now, noSleep);
        expect(users(await reg.list()), what).toEqual([a, addr(2)]);
        expect(warn, what).toHaveBeenCalledWith("registry: ignoring registry-cache.json");
        expect(b.lists[0].prefix, what).toBe("registry/998/");
        expect(b.reads.sort(), what).toEqual([registryKey(998, a), registryKey(998, addr(2))].sort());
        expect(JSON.parse(readFileSync(file(d), "utf8")), what).toEqual({ v: 1, records: good }); // and rewritten good
        warn.mockRestore();
      }
    });

    it("a cache that cannot be written is a warning, not a failed list", async () => {
      const store = { readJson: <T>(_n: string, f: T) => f, writeJson: () => { throw new Error("ENOSPC"); } };
      const b = bucket();
      b.register(a, T0);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      expect(users(await new R2Registry(b.r2, 998, store, clockAt(NOW0).now, noSleep).list())).toEqual([a]);
      expect(warn).toHaveBeenCalledWith("registry: could not save registry-cache.json");
      warn.mockRestore();
    });

    it("no store, no file: lists as before", async () => {
      const b = bucket();
      b.register(a, T0);
      expect(users(await new R2Registry(b.r2, 998).list())).toEqual([a]);
    });
  });

  describe("a record dated in the future does not turn the index off", () => {
    const FUTURE = 9_999_999_999;
    const nowSec = (c: { ms: number }) => Math.floor(c.ms / 1000);

    it("the window is clamped to the clock: a wallet registered now is found through the index", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0);
      b.objects.set(registryKey(998, addr(2)), JSON.stringify({ user: addr(2), registeredAt: FUTURE })); // planted, or a Worker clock fault
      const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
      expect((await reg.list()).length).toBe(2);
      b.register(addr(3), nowSec(clock));
      clock.ms += 60_000;
      expect(users(await reg.list())).toEqual([a, addr(2), addr(3)]);
      expect(b.lists.at(-1)).toEqual({ prefix: "registry-log/998/", startAfter: `registry-log/998/${nowSec(clock) - 600}` });
    });

    it("also across a restart on the cache", async () => {
      const d = dir();
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0);
      b.objects.set(registryKey(998, addr(2)), JSON.stringify({ user: addr(2), registeredAt: FUTURE }));
      await new R2Registry(b.r2, 998, new Store(d), clock.now, noSleep).list();
      const second = new R2Registry(b.r2, 998, new Store(d), clock.now, noSleep);
      expect((await second.list()).length).toBe(2); // the first pass of the new process: loaded from the cache, the whole prefix listed
      b.register(addr(3), nowSec(clock));
      clock.ms += 60_000;
      b.reads.length = 0;
      expect(users(await second.list())).toEqual([a, addr(2), addr(3)]);
      expect(b.reads).toEqual([registryKey(998, addr(3))]);
      expect(b.lists.at(-1)).toEqual({ prefix: "registry-log/998/", startAfter: `registry-log/998/${nowSec(clock) - 600}` });
    });

    it("a restart on the cache starts the index window at the newest record it holds (not at the beginning of time)", async () => {
      const d = dir();
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0 + 1000);
      await new R2Registry(b.r2, 998, new Store(d), clock.now, noSleep).list();
      const second = new R2Registry(b.r2, 998, new Store(d), clock.now, noSleep);
      await second.list();
      clock.ms += 60_000;
      await second.list();
      expect(b.lists.at(-1)).toEqual({ prefix: "registry-log/998/", startAfter: `registry-log/998/${T0 + 1000 - 600}` });
    });
  });

  describe("a wallet found late by a full read", () => {
    const late = (warn: ReturnType<typeof vi.spyOn>) => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("found late"));

    it("is warned, once, with its address and registeredAt; the first pass of a process is silent", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0 + 1000);
      b.register(addr(5), T0 + 10, { index: false }); // far outside any window, but this is the first pass: it loads everything
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
      expect((await reg.list()).length).toBe(2);
      expect(late(warn)).toEqual([]);
      b.register(addr(2), T0 + 100, { index: false }); // the newest is T0+1000: its window starts at T0+400, so this is late
      b.register(addr(3), T0 + 900, { index: false }); // inside the window: not late
      clock.ms += 3_600_000; // the hourly full read
      expect((await reg.list()).length).toBe(4);
      const lines = late(warn);
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain(addr(2));
      expect(lines[0]).toContain(String(T0 + 100));
      expect(lines[0]).toContain("lost");
      clock.ms += 3_600_000; // known now: no second warning
      await reg.list();
      expect(late(warn).length).toBe(1);
      warn.mockRestore();
    });

    it("list(true) after the first pass warns the same way", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0 + 1000);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
      await reg.list();
      b.register(addr(2), T0 + 100, { index: false });
      clock.ms += 60_000;
      await reg.list(true);
      expect(late(warn).length).toBe(1);
      warn.mockRestore();
    });

    it("the window is the one the index would use: clamped to the clock, so a planted future record does not make every old wallet late", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0);
      b.objects.set(registryKey(998, addr(2)), JSON.stringify({ user: addr(2), registeredAt: 9_999_999_999 }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
      await reg.list();
      clock.ms += 3_600_000;
      b.register(addr(3), Math.floor(clock.ms / 1000) - 300, { index: false }); // 5 minutes old at the hourly read: inside now − 10 minutes
      await reg.list();
      expect((await reg.list()).length).toBe(3);
      expect(late(warn)).toEqual([]);
      warn.mockRestore();
    });

    it("a restart on the cache is silent on its first pass, though it finds wallets registered while it was down; a later full read is not", async () => {
      const d = dir();
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0 + 1000);
      await new R2Registry(b.r2, 998, new Store(d), clock.now, noSleep).list();
      b.register(addr(2), T0 + 100, { index: false }); // registered while the process was down, long before the window
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const second = new R2Registry(b.r2, 998, new Store(d), clock.now, noSleep);
      expect((await second.list()).length).toBe(2);
      expect(late(warn)).toEqual([]);
      b.register(addr(3), T0 + 200, { index: false });
      clock.ms += 3_600_000;
      expect((await second.list()).length).toBe(3);
      expect(late(warn).length).toBe(1);
      expect(late(warn)[0]).toContain(addr(3));
      warn.mockRestore();
    });

    it("a first pass that failed and is retried is still the first: silent", async () => {
      const b = bucket();
      const clock = clockAt(NOW0);
      b.register(a, T0 + 1000);
      b.register(addr(2), T0 + 10, { index: false });
      b.failing.add(registryKey(998, a));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reg = new R2Registry(b.r2, 998, undefined, clock.now, noSleep);
      await expect(reg.list()).rejects.toThrow("HTTP 500");
      b.failing.clear();
      clock.ms += 60_000;
      await reg.list();
      expect(late(warn)).toEqual([]);
      warn.mockRestore();
    });
  });
});

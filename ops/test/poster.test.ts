import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCheckpoint, buildTree, newCalcState, parseTableCsv, popOdds, serializeState, verifyProof, type Addr, type ApiFill } from "@hlo/calc";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedsFor } from "../../calc/test/helpers/seeds.js";
import { parseCheckpointFile, parseLatestFile, parseUserFile, userFilePath } from "../src/checkpoint-files.js";
import { Ingest, type FillSource } from "../src/ingest.js";
import { LONG_GAP_MS, Poster, WAIT_SECONDS, checkPosterKey, savedTrackerJson, type PosterDeps } from "../src/poster.js";
import type { Publisher, PutOpts } from "../src/publish.js";
import type { Registration } from "../src/registry.js";
import { recoverCheckpointSigner, signCheckpoint } from "../src/sign.js";
import { ChainTracker, type ClaimLog } from "../src/snapshot.js";
import { Store } from "../src/store.js";
import { TradeFeed, type FeedSocket } from "../src/tradefeed.js";

const L = 1_800_000_000;
const CHAIN = 998;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const A: Addr = "0x00000000000000000000000000000000000000a1";
const B: Addr = "0x00000000000000000000000000000000000000b2";
const GRACE = 10;
const DEPLOY_BLOCK = 7n;
// px·sz = 1000 → fee 1 USDC = 100_000_000 units
const good = (tid: number, timeMs: number): ApiFill => ({ tid, time: timeMs, coin: "BTC", px: "100", sz: "10", builderFee: "1" });
const at = (minute: number, sec = 0) => (L + minute * 60 + sec) * 1000;
const endOf = (m: number) => L + 60 * (m + 1);
const FEE = 100_000_000n;

type FeedOpts = {
  users?: string[];
  uncovered?: number | ((fromMs: number, toMs: number) => number);
  delivered?: boolean;
  late?: number;
  /** What each call of `takeLate` returns, in turn (then nothing). */
  lateWallets?: string[][];
};
/** A trade feed that answers from `o`, read at each call (change `o` between ticks). `lateTrades` is a plain property to set. */
const fakeFeed = (o: FeedOpts = {}) => ({
  usersSince: vi.fn((_ms: number) => o.users ?? []),
  prune: vi.fn((_ms: number) => {}),
  uncovered: vi.fn((from: number, to: number) => (typeof o.uncovered === "function" ? o.uncovered(from, to) : o.uncovered ?? 0)),
  deliveredPast: vi.fn((_ms: number) => o.delivered ?? true),
  setCovered: vi.fn((_ms: number) => {}),
  takeLate: vi.fn((): string[] => o.lateWallets?.shift() ?? []),
  lateTrades: o.late ?? 0,
});

function setup(o: { time?: number; block?: bigint; regs?: Registration[]; fills?: Record<string, ApiFill[]>; dir?: string; popAt?: number[]; claimLogs?: ClaimLog[]; beforeFill?: (user: string) => void; feed?: PosterDeps["feed"] } = {}) {
  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "poster-"));
  const store = new Store(dir);
  const fills = o.fills ?? { [A]: [good(1, at(0, 5)), good(2, at(1, 5))] };
  const fillCalls: Array<[string, number, number]> = [];
  const src: FillSource = {
    async fills(user, s, e) {
      o.beforeFill?.(user); // may throw, like a rate-limited request
      fillCalls.push([user, s, e]);
      return (fills[user] ?? []).filter((f) => f.time >= s && f.time <= e);
    },
  };
  const claimedRanges: Array<[bigint, bigint]> = [];
  const tracker = new ChainTracker(
    {
      claimedLogs: async (from, to) => {
        claimedRanges.push([from, to]);
        return (o.claimLogs ?? []).filter((l) => l.block >= from && l.block <= to);
      },
      burnLogs: async () => [],
    },
    1000n,
  );
  const published = new Map<string, string>();
  const order: string[] = [];
  const puts: Array<{ path: string; body: string; opts: PutOpts | undefined }> = [];
  const failOn = { path: "" as string | null };
  const publish: Publisher = {
    async put(path, body, _contentType, opts) {
      if (failOn.path === path) {
        failOn.path = null; // fails once
        throw new Error(`publish ${path} failed`);
      }
      order.push(path);
      puts.push({ path, body, opts });
      published.set(path, body);
    },
  };
  const clock = { time: o.time ?? endOf(0) + GRACE, block: o.block ?? 100n };
  // Checkpoints.latestMinute() as the chain reports it (null: nothing settled); a test sets `settled`, or `fail` for a read that throws.
  const chain = { settled: null as number | null, fail: false, reads: 0 };
  const regs = o.regs ?? [{ user: A, registeredAt: 1 }];
  const alerts: string[] = [];
  const logs: string[] = [];
  const seedCalls: Array<[number, number, bigint, bigint]> = [];
  const seeds: PosterDeps["seeds"] = async (from, through, lo, hi) => {
    seedCalls.push([from, through, lo, hi]);
    return seedsFor(from, through, { odds: popOdds(CHAIN), pop: o.popAt ?? [], block: () => (lo + hi) / 2n });
  };
  const deps: PosterDeps = {
    now: async () => ({ ...clock }),
    registry: { list: async () => regs },
    ingest: new Ingest(store, src, L),
    tracker,
    checkSigner: async () => {},
    settledMinute: async () => {
      chain.reads++;
      if (chain.fail) throw new Error("rpc down");
      return chain.settled;
    },
    sign: (cp) => signCheckpoint(account, CHAIN, CONTRACT, cp),
    publish,
    store,
    launchTime: L,
    seeds,
    chainId: CHAIN,
    contract: CONTRACT,
    graceSeconds: GRACE,
    deployBlock: DEPLOY_BLOCK,
    feed: o.feed ?? null,
    log: (s) => void logs.push(s),
    alert: async (s) => void alerts.push(s),
  };
  return { deps, poster: new Poster(deps), account, clock, chain, published, order, puts, failOn, fillCalls, claimedRanges, store, dir, alerts, logs, regs, seedCalls };
}

const latestOf = (published: Map<string, string>) => parseLatestFile(published.get("latest.json")!);
/** A wallet's numbers as the app reads them: from the user file its address names (latest.json has no users). */
const entryOf = (published: Map<string, string>, user: Addr) => parseUserFile(published.get(userFilePath(user))!).users[user];
/** Every wallet in every user file published so far (the latest write of each file). */
const usersOf = (published: Map<string, string>) =>
  Object.assign({}, ...[...published].filter(([path]) => path.startsWith("users/")).map(([, text]) => parseUserFile(text).users)) as ReturnType<typeof parseUserFile>["users"];

describe("Poster.tick", () => {
  it("waits until the minute's end plus the grace, and publishes nothing", async () => {
    const f = setup({ time: endOf(0) + GRACE - 1 });
    expect(await f.poster.tick()).toBe("waiting");
    expect(f.published.size).toBe(0);
    expect(f.fillCalls).toEqual([]);
    f.clock.time = endOf(0) + GRACE;
    expect(await f.poster.tick()).toBe("published");
  });

  it("publishes checkpoints/0.json then latest.json then the user files, signed by the poster, with the calculator's numbers", async () => {
    const f = setup();
    expect(await f.poster.tick()).toBe("published");
    expect(f.order).toEqual(["checkpoints/0.json", "latest.json", userFilePath(A)]);
    const latest = latestOf(f.published);
    const archive = parseCheckpointFile(f.published.get("checkpoints/0.json")!);

    // the same rows through the calculator directly (the fake seed block for bounds 7..100 is 53)
    const s = newCalcState(L, popOdds(CHAIN));
    const res = applyCheckpoint(s, { minimum: { fromMinute: 0, units: 0n }, quietFrom: null,
      throughMinute: 0, refBlock: 100n, rows: [{ minute: 0, user: A, fee: FEE }], seeds: seedsFor(0, 0, { odds: 60, block: () => 53n }),
      burned: 0n, refined: 0n, claimed: new Map(),
    });
    expect(entryOf(f.published, A).entitlement).toBe(res.entitlements.get(A)!.toString());
    expect(latest).not.toHaveProperty("users");
    expect(latest).not.toHaveProperty("tree");
    expect(latest.root).toBe(buildTree(res.entitlements).root);
    expect(latest.totalEntitled).toBe(res.totalEntitled.toString());
    expect(entryOf(f.published, A).fees).toBe(FEE.toString());
    expect(latest.throughMinute).toBe(0);
    expect(latest.refBlock).toBe("100");
    expect(latest.chainId).toBe(CHAIN);
    expect(latest.contract).toBe(CONTRACT);
    expect(latest.publishedAt).toBe(endOf(0) + GRACE);
    expect(latest.vault).toEqual({ amount: res.vault.toString(), pointsTotal: res.pointsTotal.toString(), odds: 60, lastPopMinute: -1 });
    expect(latest.pops).toEqual([]);
    expect(archive.root).toBe(latest.root);
    expect(archive.sig).toBe(latest.sig);

    const signer = await recoverCheckpointSigner(CHAIN, CONTRACT, { throughMinute: 0, refBlock: 100n, root: latest.root, totalEntitled: BigInt(latest.totalEntitled) }, latest.sig);
    expect(signer).toBe(f.account.address);
  });

  it("a wallet registered after the end of the minute is not in that checkpoint, even if its fills are returned", async () => {
    const f = setup({
      regs: [{ user: A, registeredAt: 1 }, { user: B, registeredAt: endOf(0) + 1 }],
      fills: { [A]: [good(1, at(0, 5))], [B]: [good(2, at(0, 6))] },
    });
    await f.poster.tick();
    expect(Object.keys(parseUserFile(f.published.get(userFilePath(A))!).users)).toEqual([A]); // B is in no file (its first byte is A's)
    expect(f.fillCalls.map((c) => c[0])).toEqual([A]); // B's fills were never asked for
    expect(parseCheckpointFile(f.published.get("checkpoints/0.json")!).table).not.toContain(B);
  });

  it("lists a wallet registered exactly at the end of the minute (registeredAt <= end), but its fills fall after minute 0", async () => {
    const f = setup({
      time: endOf(1) + GRACE,
      regs: [{ user: A, registeredAt: 1 }, { user: B, registeredAt: endOf(0) }],
      fills: { [A]: [good(1, at(0, 5))], [B]: [good(2, at(1, 5))] },
    });
    await f.poster.tick();
    expect(f.fillCalls.map((c) => c[0]).sort()).toEqual([A, B]);
    expect(Object.keys(usersOf(f.published))).toEqual([A]); // B's fill is minute 1's
  });

  it("the first snapshot reads chain logs from the deploy block", async () => {
    const f = setup();
    await f.poster.tick();
    expect(f.claimedRanges).toEqual([[DEPLOY_BLOCK, 100n]]);
  });

  it("later snapshots start after the previous checkpoint's refBlock, and claimed entitlements flow into the checkpoint", async () => {
    const f = setup({ claimLogs: [{ user: A, claimedTotal: 5n, refined: 1n, block: 150n }] });
    await f.poster.tick();
    f.clock.time = endOf(1) + GRACE;
    f.clock.block = 200n;
    await f.poster.tick();
    expect(f.claimedRanges).toEqual([[DEPLOY_BLOCK, 100n], [101n, 200n]]);
    expect(latestOf(f.published).refBlock).toBe("200");
    expect(parseCheckpointFile(f.published.get("checkpoints/1.json")!).throughMinute).toBe(1);
  });

  it("a crash between sign and publish republishes the same bytes, then the next minute follows", async () => {
    const f = setup({ time: endOf(1) + GRACE });
    f.failOn.path = "latest.json";
    await expect(f.poster.tick()).rejects.toThrow("publish latest.json failed");
    const archive0 = f.published.get("checkpoints/0.json")!;
    expect(f.published.has("latest.json")).toBe(false);

    // the write-ahead file holds the signed bodies
    const pending = JSON.parse(readFileSync(join(f.dir, "pending.json"), "utf8"));
    expect(pending.archive).toBe(archive0);

    expect(await f.poster.tick()).toBe("republished");
    expect(f.published.get("checkpoints/0.json")).toBe(archive0);
    expect(f.published.get("latest.json")).toBe(pending.latest);
    expect(() => readFileSync(join(f.dir, "pending.json"))).toThrow(); // deleted

    expect(await f.poster.tick()).toBe("published");
    expect(latestOf(f.published).throughMinute).toBe(1);
    expect(await f.poster.tick()).toBe("waiting");
  });

  it("a restart with a pending file republishes it, then continues from its state", async () => {
    const f = setup({ time: endOf(1) + GRACE });
    f.failOn.path = "latest.json";
    await expect(f.poster.tick()).rejects.toThrow();
    const pending = JSON.parse(readFileSync(join(f.dir, "pending.json"), "utf8"));

    // a new process on the same dir: the tracker comes from the saved JSON
    const g = setup({ time: endOf(1) + GRACE, dir: f.dir });
    expect(savedTrackerJson(g.store)).toBe(pending.next.tracker);
    expect(g.poster.nextMinute).toBe(1);
    expect(await g.poster.tick()).toBe("republished");
    expect(g.published.get("checkpoints/0.json")).toBe(pending.archive);
    expect(await g.poster.tick()).toBe("published");
    expect(latestOf(g.published).throughMinute).toBe(1);
    // and a third process starts from the saved state, not from scratch
    const h = setup({ time: endOf(1) + GRACE, dir: f.dir });
    expect(h.poster.nextMinute).toBe(2);
    expect(await h.poster.tick()).toBe("waiting");
  });

  it("a restart from pending.json starts its next seed search at the saved seedFrom and keeps the saved pops", async () => {
    const f = setup({ time: endOf(1) + GRACE, popAt: [0] });
    f.failOn.path = "latest.json";
    await expect(f.poster.tick()).rejects.toThrow();
    expect(f.seedCalls).toEqual([[0, 0, DEPLOY_BLOCK, 100n]]);
    const pending = JSON.parse(readFileSync(join(f.dir, "pending.json"), "utf8"));
    expect(pending.next.seedFrom).toBe("53"); // minute 0's seed block on the fake chain: (7 + 100) / 2
    expect(pending.next.pops.map((p: { minute: number }) => p.minute)).toEqual([0]);

    // a new process on the same dir republishes, then searches minute 1's seed block from the saved block, not the deploy block
    const g = setup({ time: endOf(1) + GRACE, dir: f.dir, popAt: [] });
    expect(await g.poster.tick()).toBe("republished");
    expect(g.seedCalls).toEqual([]);
    expect(await g.poster.tick()).toBe("published");
    expect(g.seedCalls).toEqual([[1, 1, 53n, 100n]]);
    const latest = latestOf(g.published);
    expect(latest.throughMinute).toBe(1);
    expect(latest.pops.map((p) => p.minute)).toEqual([0]); // minute 0's pop is kept; minute 1 did not pop
  });

  it("a failure before the write-ahead file leaves the poster where it was", async () => {
    const f = setup();
    f.deps.sign = async () => {
      throw new Error("signer down");
    };
    const p = new Poster(f.deps);
    await expect(p.tick()).rejects.toThrow("signer down");
    expect(p.nextMinute).toBe(0);
    expect(() => readFileSync(join(f.dir, "pending.json"))).toThrow();
  });

  it("a signer that is no longer the poster stops the tick before anything is written or published", async () => {
    const f = setup();
    let rotated = true;
    f.deps.checkSigner = async () => {
      if (rotated) throw new Error("POSTER_KEY is not Checkpoints.poster()");
    };
    const p = new Poster(f.deps);
    await expect(p.tick()).rejects.toThrow("POSTER_KEY is not Checkpoints.poster()");
    expect(f.published.size).toBe(0);
    expect(() => readFileSync(join(f.dir, "pending.json"))).toThrow();
    expect(() => readFileSync(join(f.dir, "poster-state.json"))).toThrow();
    expect(p.nextMinute).toBe(0);
    rotated = false;
    expect(await p.tick()).toBe("published");
  });

  it("checkSigner is not called while waiting or when republishing", async () => {
    const f = setup({ time: endOf(0) + GRACE - 1 });
    let calls = 0;
    f.deps.checkSigner = async () => void calls++;
    const p = new Poster(f.deps);
    expect(await p.tick()).toBe("waiting");
    f.clock.time = endOf(0) + GRACE;
    f.failOn.path = "latest.json";
    await expect(p.tick()).rejects.toThrow();
    expect(calls).toBe(1);
    expect(await p.tick()).toBe("republished");
    expect(calls).toBe(1);
  });

  it("a failure after the chain snapshot leaves the tracker as it was: the retry equals a fresh poster's checkpoint", async () => {
    const a: ClaimLog = { user: A, claimedTotal: 5n, refined: 1n, block: 60n };
    const b: ClaimLog = { user: B, claimedTotal: 7n, refined: 2n, block: 90n };
    // The failed attempt sees B's claim; by the retry the logs no longer show it (so only a tracker that kept the
    // first attempt's fold would still remember B).
    const run = async (logs: ClaimLog[], failFirstSign: boolean) => {
      const f = setup({ claimLogs: logs });
      let fail = failFirstSign;
      const realSign = f.deps.sign;
      f.deps.sign = async (cp) => {
        if (fail) {
          fail = false;
          logs.splice(0, logs.length, a);
          throw new Error("signer down");
        }
        return realSign(cp);
      };
      const p = new Poster(f.deps);
      if (failFirstSign) await expect(p.tick()).rejects.toThrow("signer down");
      await p.tick();
      return f;
    };
    const control = await run([a], false);
    const retried = await run([a, b], true);
    const unsigned = (m: Map<string, string>) => {
      const l = JSON.parse(m.get("latest.json")!);
      delete l.sig; // each poster has its own key
      return l;
    };
    expect(unsigned(retried.published)).toEqual(unsigned(control.published));
    const trackerOf = (f: { dir: string }) => JSON.parse(readFileSync(join(f.dir, "poster-state.json"), "utf8")).tracker;
    expect(trackerOf(retried)).toBe(trackerOf(control));
    expect(JSON.parse(trackerOf(retried)).claimed).toEqual({ [A]: "5" });
  });

  it("catches up one minute per tick, fetching each wallet once for the whole range", async () => {
    const f = setup({
      time: endOf(4) + GRACE,
      fills: { [A]: [0, 1, 2, 3, 4].map((m) => good(m + 1, at(m, 5))) },
    });
    const through: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await f.poster.tick()).toBe("published");
      through.push(latestOf(f.published).throughMinute);
    }
    expect(through).toEqual([0, 1, 2, 3, 4]);
    expect(f.order.filter((p) => p.startsWith("checkpoints/"))).toEqual([0, 1, 2, 3, 4].map((m) => `checkpoints/${m}.json`));
    expect(f.fillCalls).toEqual([[A, L * 1000, endOf(4) * 1000 - 1]]);
    expect(await f.poster.tick()).toBe("waiting");
    // each checkpoint carries only its own minute's table
    for (let m = 0; m < 5; m++) {
      expect(parseCheckpointFile(f.published.get(`checkpoints/${m}.json`)!).table.trim().split("\n")).toHaveLength(2); // header + one row
    }
    expect(usersOf(f.published)[A].fees).toBe((5n * FEE).toString());
  });

  it("100 wallets under a rate limit (429 after 40 requests per tick): the cursors advance tick by tick, nobody is refetched, and the checkpoint is published", async () => {
    const wallets = Array.from({ length: 100 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}` as Addr);
    const regs = wallets.map((user) => ({ user, registeredAt: 1 }));
    const fills = Object.fromEntries(wallets.map((w, i) => [w, [good(i + 1, at(0, 5))]]));
    let used = 0; // requests in the current tick
    const f = setup({
      regs, fills,
      beforeFill: () => {
        if (++used > 40) throw new Error("HL /info 429: rate limited");
      },
    });
    const results: string[] = [];
    for (let i = 0; i < 6 && results[results.length - 1] !== "published"; i++) {
      used = 0;
      try {
        results.push(await f.poster.tick());
      } catch (e) {
        results.push((e as Error).message);
      }
      f.clock.time += 60; // each pass takes a minute: the newest finished minute moves on, but checkpoint 0 is the one being built
    }
    expect(results).toHaveLength(3);
    expect(results[0]).toMatch(/429/);
    expect(results[1]).toMatch(/429/);
    expect(results[2]).toBe("published");
    // every wallet was fetched exactly once (a failed request is not recorded): no restart from the first wallet
    expect(f.fillCalls.map((c) => c[0]).sort()).toEqual([...wallets].sort());
    expect(latestOf(f.published).throughMinute).toBe(0);
    expect(Object.keys(usersOf(f.published))).toHaveLength(100);
    for (const w of wallets) expect(f.deps.ingest.fetchedThrough(w)).toBeGreaterThanOrEqual(endOf(0) * 1000 - 1);
  });

  it("the fetch covers only minutes that are finished plus grace", async () => {
    const f = setup({ time: endOf(2) + GRACE - 1 }); // minutes 0 and 1 are finished
    await f.poster.tick();
    expect(f.fillCalls).toEqual([[A, L * 1000, endOf(1) * 1000 - 1]]);
  });

  it("an empty minute still publishes a checkpoint (the sentinel root), and the vault grows", async () => {
    const f = setup({ regs: [], fills: {} });
    expect(await f.poster.tick()).toBe("published");
    const latest = latestOf(f.published);
    expect([...f.published.keys()].filter((p) => p.startsWith("users/"))).toEqual([]);
    expect(BigInt(latest.vault.amount)).toBeGreaterThan(0n);
  });

  it("the seed search starts at the deploy block, then at the previous seed block, and ends at refBlock", async () => {
    const f = setup();
    await f.poster.tick();
    f.clock.time = endOf(1) + GRACE;
    f.clock.block = 200n;
    await f.poster.tick();
    expect(f.seedCalls).toEqual([[0, 0, DEPLOY_BLOCK, 100n], [1, 1, 53n, 200n]]);
    const saved = JSON.parse(readFileSync(join(f.dir, "poster-state.json"), "utf8"));
    expect(saved.v).toBe(2);
    expect(saved.seedFrom).toBe("126");
  });

  it("a pop pays the holder of points 90% of the vault, keeps 10%, resets the points and is listed newest first", async () => {
    const f = setup({ time: endOf(1) + GRACE, popAt: [1] });
    await f.poster.tick(); // minute 0: A 1 HLO, vault 0.1, no pop
    expect(latestOf(f.published).vault.lastPopMinute).toBe(-1);
    await f.poster.tick(); // minute 1: A 1 HLO, vault 0.2, pops: A gets 0.18, 0.02 stays
    const latest = latestOf(f.published);
    expect(latest.pops).toEqual([{ minute: 1, block: "76", amount: "180000000000000000", kept: "20000000000000000", recipients: 1 }]);
    expect(latest.vault).toEqual({ amount: "20000000000000000", pointsTotal: "0", odds: 60, lastPopMinute: 1 });
    expect(entryOf(f.published, A)).toMatchObject({ points: "0", fromVault: "180000000000000000", entitlement: "2180000000000000000" });
    // a restart keeps the pops and the next seed search's lower bound
    const g = setup({ time: endOf(2) + GRACE, dir: f.dir });
    expect(g.poster.nextMinute).toBe(2);
    await g.poster.tick();
    expect(g.seedCalls[0][2]).toBe(76n);
    expect(latestOf(g.published).pops[0].minute).toBe(1);
  });

  it("a seed read that fails leaves the poster where it was", async () => {
    const f = setup();
    let down = true;
    const real = f.deps.seeds;
    f.deps.seeds = async (...a) => {
      if (down) throw new Error("rpc down");
      return real(...a);
    };
    const p = new Poster(f.deps);
    await expect(p.tick()).rejects.toThrow("rpc down");
    expect(p.nextMinute).toBe(0);
    expect(() => readFileSync(join(f.dir, "pending.json"))).toThrow();
    down = false;
    expect(await p.tick()).toBe("published");
  });
});

describe("Poster.tick with the trade feed", () => {
  const hex = (i: number) => (i + 0xa00).toString(16).padStart(40, "0");
  const wallet = (i: number): Addr => `0x${hex(i)}`;
  const wallets = Array.from({ length: 1000 }, (_, i) => wallet(i));
  const registered = (ws: readonly Addr[] = wallets, registeredAt = 1): Registration[] => ws.map((user) => ({ user, registeredAt }));
  const endMsOf = (m: number) => endOf(m) * 1000 - 1;
  const called = (f: { fillCalls: Array<[string, number, number]> }) => f.fillCalls.map((c) => c[0]).sort();
  const LONG_ALERT = "poster: the trade feed has not been watching for over 5 minutes: reading every wallet, rewards may run late";
  const tableUsers = (published: Map<string, string>, m: number) =>
    parseTableCsv(parseCheckpointFile(published.get(`checkpoints/${m}.json`)!).table).map((r) => r.user).sort();

  /** Minute 0 is published (nothing is covered yet, so every wallet is read); the clock then stands at minute 1's due time. */
  async function primed(o: { regs?: Registration[]; fills?: Record<string, ApiFill[]>; fo?: FeedOpts; beforeFill?: (user: string) => void } = {}) {
    const fo: FeedOpts = o.fo ?? {};
    const feed = fakeFeed(fo);
    const f = setup({ regs: o.regs ?? registered(), fills: o.fills ?? {}, feed, beforeFill: o.beforeFill });
    expect(await f.poster.tick()).toBe("published");
    f.fillCalls.length = 0;
    f.clock.time = endOf(1) + GRACE;
    return { ...f, fo, feed };
  }

  it("without a feed (TRADE_FEED=off) every registered wallet is read each minute", async () => {
    const ws = wallets.slice(0, 5);
    const f = setup({ regs: registered(ws), fills: {}, feed: null });
    await f.poster.tick();
    expect(called(f)).toEqual([...ws].sort());
    f.fillCalls.length = 0;
    f.clock.time = endOf(1) + GRACE;
    await f.poster.tick();
    expect(called(f)).toEqual([...ws].sort());
    expect(f.fillCalls[0].slice(1)).toEqual([endMsOf(0) + 1, endMsOf(1)]);
  });

  it("with nothing covered yet (the first pass) every registered wallet is read, the feed is not consulted, and minute 0's last ms is then covered", async () => {
    const ws = wallets.slice(0, 20);
    const feed = fakeFeed({ users: [ws[0]] });
    const f = setup({ regs: registered(ws), fills: {}, feed, time: endOf(0) + GRACE });
    expect(f.deps.ingest.coveredThrough).toBe(-1);
    expect(await f.poster.tick()).toBe("published");
    expect(called(f)).toEqual([...ws].sort());
    expect(feed.uncovered).not.toHaveBeenCalled();
    expect(feed.deliveredPast).not.toHaveBeenCalled();
    expect(f.deps.ingest.coveredThrough).toBe(endMsOf(0));
  });

  it("covered: reads only the registered wallets the feed saw (any case), logs how many, and tells the feed what is covered", async () => {
    const active = [wallets[3], wallets[500], wallets[999]];
    const strangers = [wallet(5000), wallet(5001)]; // traded, never registered
    const fills = Object.fromEntries([...active, ...strangers].map((w, i) => [w, [good(i + 1, at(1, 5 + i))]]));
    const regs = registered();
    regs[3] = { user: `0x${hex(3).toUpperCase()}`, registeredAt: 1 }; // the feed reports lowercase
    const f = await primed({ regs, fills, fo: { users: [...active, ...strangers] } });
    expect(await f.poster.tick()).toBe("published");
    expect(called(f)).toEqual([...active].sort());
    expect(f.fillCalls.every((c) => c[1] === endMsOf(0) + 1 && c[2] === endMsOf(1))).toBe(true);
    expect(tableUsers(f.published, 1)).toEqual([...active].sort());
    expect(f.feed.usersSince).toHaveBeenLastCalledWith(endMsOf(0));
    expect(f.feed.uncovered).toHaveBeenLastCalledWith(endMsOf(0), endMsOf(1));
    expect(f.feed.deliveredPast).toHaveBeenLastCalledWith(endMsOf(1));
    expect(f.feed.setCovered).toHaveBeenLastCalledWith(endMsOf(1));
    expect(f.feed.prune).toHaveBeenLastCalledWith(endMsOf(1) - 3_600_000);
    expect(f.logs.some((l) => l.startsWith("checkpoint 1:") && l.includes("read 3 of 1000 wallets"))).toBe(true);
  });

  it("marks the minute's last ms covered, so a fill in the first ms of the next minute is still read", async () => {
    const w = wallets[1];
    const f = await primed({ fills: { [w]: [good(1, at(1, 0)), good(2, at(1, 5))] }, fo: { users: [w] } });
    const marked = vi.spyOn(f.deps.ingest, "markCovered");
    expect(await f.poster.tick()).toBe("published");
    expect(marked).toHaveBeenCalledWith(endMsOf(1)); // not endOf(1) * 1000: the next read starts one ms after it
    expect(f.deps.ingest.coveredThrough).toBe(endMsOf(1));
    expect(f.fillCalls[0][1]).toBe(endOf(0) * 1000); // minute 1's first ms, which minute 0's pass did not reach
    expect(usersOf(f.published)[w].fees).toBe((2n * FEE).toString());
  });

  it("covered, but the feed has not delivered past the minute: waits, reads and publishes nothing, then goes on", async () => {
    const w = wallets[1];
    const f = await primed({ fills: { [w]: [good(1, at(1, 5))] }, fo: { users: [w], delivered: false } });
    expect(await f.poster.tick()).toBe("waiting");
    expect(await f.poster.tick()).toBe("waiting");
    expect(f.feed.deliveredPast).toHaveBeenLastCalledWith(endMsOf(1));
    expect(f.fillCalls).toEqual([]);
    expect(f.published.has("checkpoints/1.json")).toBe(false);
    expect(latestOf(f.published).throughMinute).toBe(0);
    expect(f.feed.setCovered).toHaveBeenCalledTimes(1); // minute 0's only
    f.fo.delivered = true;
    expect(await f.poster.tick()).toBe("published");
    expect(called(f)).toEqual([w]);
    expect(latestOf(f.published).throughMinute).toBe(1);
  });

  it("asks the feed about the gap again on every tick: a wait ends when coverage is cut back, and the wider read follows", async () => {
    const w = wallets[3];
    const f = await primed({ fills: { [w]: [good(1, at(1, 5))] }, fo: { users: [w], delivered: false } });
    expect(await f.poster.tick()).toBe("waiting");
    f.fo.uncovered = 20_000; // a coin found by the feed's read: the minute is no longer fully watched
    expect(await f.poster.tick()).toBe("published");
    expect(called(f)).toEqual([w]);
  });

  describe("a short gap", () => {
    // F: the feed saw it. R: a counted fill in the last 24 h. N: registered 23 h ago. OLD: registered 25 h ago. IDLE: nothing.
    const [F, R, N, OLD, IDLE] = [1, 2, 3, 4, 5].map(wallet);
    const regOf = (user: Addr, ago: number): Registration => ({ user, registeredAt: endOf(1) - ago });
    const H = 3600;
    const fills = Object.fromEntries([F, R, N, OLD, IDLE].map((w, i) => [w, [good(10 + i, at(1, 5 + i))]]));
    fills[R] = [good(1, at(0, 5)), ...fills[R]];
    const regs = [regOf(F, 1_000 * H), regOf(R, 1_000 * H), regOf(N, 23 * H), regOf(OLD, 25 * H), regOf(IDLE, 1_000 * H), ...registered(wallets.slice(100, 120))];

    it("reads the feed's wallets, the wallets with a counted fill in the last 24 h and those registered in the last 24 h, and does not wait for the feed", async () => {
      const f = await primed({ regs, fills, fo: { users: [F], uncovered: 60_000, delivered: false } });
      expect(await f.poster.tick()).toBe("published");
      expect(called(f)).toEqual([F, R, N].sort());
      expect(tableUsers(f.published, 1)).toEqual([F, R, N].sort());
      expect(f.feed.deliveredPast).not.toHaveBeenCalled();
      expect(f.logs.some((l) => l.startsWith("checkpoint 1:") && l.includes("read 3 of 25 wallets"))).toBe(true);
    });

    it("a gap of exactly LONG_GAP_MS is still a short one", async () => {
      const f = await primed({ regs, fills, fo: { users: [F], uncovered: LONG_GAP_MS } });
      expect(await f.poster.tick()).toBe("published");
      expect(called(f)).toEqual([F, R, N].sort());
      expect(f.alerts).toEqual([]);
    });
  });

  describe("a long gap", () => {
    const ws = wallets.slice(0, 30);
    it("reads every registered wallet and alerts once, whatever the feed says it saw", async () => {
      const f = await primed({ regs: registered(ws), fo: { users: [ws[0]], uncovered: LONG_GAP_MS + 1, delivered: false } });
      expect(await f.poster.tick()).toBe("published");
      expect(called(f)).toEqual([...ws].sort());
      expect(f.alerts.filter((a) => a.includes("reading every wallet"))).toHaveLength(1);
      expect(f.alerts[0]).toBe(LONG_ALERT);
      expect(f.feed.deliveredPast).not.toHaveBeenCalled();
      f.clock.time = endOf(2) + GRACE; // the same text again, an hour has not passed
      expect(await f.poster.tick()).toBe("published");
      expect(f.alerts.filter((a) => a.includes("reading every wallet"))).toHaveLength(1);
    });
  });

  describe("trades heard while the wallets are read", () => {
    const [a, x, y] = [wallets[1], wallets[2], wallets[3]];
    const fills = { [a]: [good(1, at(1, 5))], [x]: [good(2, at(1, 6))], [y]: [good(3, at(1, 7))] };

    it("the minute is marked on the feed before the first read; the wallets of trades heard meanwhile are read, until none is left, and only then is it marked covered", async () => {
      const covered: number[] = [];
      let coveredAtFirstRead = -2;
      let armed = false; // not during minute 0's first pass
      let marks = () => 0;
      const f = await primed({
        fills,
        fo: { users: [a] },
        beforeFill: () => {
          if (armed && coveredAtFirstRead === -2) coveredAtFirstRead = marks();
        },
      });
      marks = () => f.feed.setCovered.mock.calls.length;
      armed = true;
      f.fo.lateWallets = [[x], [y, wallet(5000)]]; // heard during the first read, then during the second; the stranger is not registered
      f.feed.takeLate.mockImplementation((() => {
        covered.push(f.deps.ingest.coveredThrough);
        return f.fo.lateWallets?.shift() ?? [];
      }) as () => string[]);
      expect(await f.poster.tick()).toBe("published");
      expect(coveredAtFirstRead).toBe(2); // minute 0's call and minute 1's, already made
      expect(called(f)).toEqual([a, x, y].sort());
      expect(f.fillCalls.map((c) => c[0])).toEqual([a, x, y]); // in the order heard
      expect(covered).toEqual([endMsOf(0), endMsOf(0), endMsOf(0)]); // asked three times (the last empty), minute 1 not yet covered
      expect(f.deps.ingest.coveredThrough).toBe(endMsOf(1));
      expect(tableUsers(f.published, 1)).toEqual([a, x, y].sort());
      expect(f.feed.setCovered).toHaveBeenCalledTimes(2);
      expect(f.logs.some((l) => l.startsWith("checkpoint 1:") && l.includes("read 3 of 1000 wallets"))).toBe(true);
    });

    it("a late wallet that was already read costs nothing", async () => {
      const f = await primed({ fills, fo: { users: [a], lateWallets: [[a]] } });
      expect(await f.poster.tick()).toBe("published");
      expect(f.fillCalls.map((c) => c[0])).toEqual([a]);
      expect(f.logs.some((l) => l.startsWith("checkpoint 1:") && l.includes("read 1 of 1000 wallets"))).toBe(true);
    });

    it("without a feed there is nothing to ask", async () => {
      const f = setup({ regs: registered([a]), fills, time: endOf(1) + GRACE });
      expect(await f.poster.tick()).toBe("published");
      expect(await f.poster.tick()).toBe("published");
    });
  });

  describe("a run of gap minutes", () => {
    // A run is consecutive minutes that each have a gap, ended by a fully watched minute. More than 5 minutes unwatched in
    // it (counting the finished minutes ahead) reads every wallet. The short path here reads 0 or 1 wallets, the long one 40.
    const ws = wallets.slice(0, 40);
    const w = ws[3];
    const dead = (from: number, to: number) => Math.max(0, to - from);
    const minuteEndingAt = (to: number) => Math.round(((to + 1) / 1000 - L) / 60) - 1;
    const gapIn = (gaps: (m: number) => number) => (_from: number, to: number) => gaps(minuteEndingAt(to));
    const longAlerts = (alerts: string[]) => alerts.filter((a) => a === LONG_ALERT);
    type Primed = Awaited<ReturnType<typeof primed>>;
    /** Minute m, with the clock at its due time: how many different wallets it read. */
    async function minute(f: Primed, m: number) {
      f.clock.time = endOf(m) + GRACE;
      f.fillCalls.length = 0;
      expect(await f.poster.tick()).toBe("published");
      return new Set(f.fillCalls.map((c) => c[0])).size;
    }

    it("a dead feed: minutes 1 to 5 (exactly 300 s) take the short path, minute 6 reads every wallet with one alert, minute 7 again without another", async () => {
      const f = await primed({ regs: registered(ws), fo: { uncovered: dead } });
      for (let m = 1; m <= 5; m++) expect(await minute(f, m)).toBe(0);
      expect(longAlerts(f.alerts)).toEqual([]);
      expect(await minute(f, 6)).toBe(40);
      expect(longAlerts(f.alerts)).toHaveLength(1);
      expect(await minute(f, 7)).toBe(40);
      expect(longAlerts(f.alerts)).toHaveLength(1);
      expect(f.alerts).toHaveLength(1);
    });

    it("a fully watched minute ends the run: it reads only the feed's wallets, and the next single gap is short again", async () => {
      const f = await primed({ regs: registered(ws), fo: { users: [w], uncovered: dead } });
      for (let m = 1; m <= 5; m++) await minute(f, m);
      expect(await minute(f, 6)).toBe(40);
      f.fo.uncovered = 0;
      expect(await minute(f, 7)).toBe(1);
      f.fo.uncovered = gapIn((m) => (m === 8 ? 60_000 : 0));
      expect(await minute(f, 8)).toBe(1);
      expect(longAlerts(f.alerts)).toHaveLength(1);
    });

    it("single holes, each ended by a fully watched minute, never turn long", async () => {
      const f = await primed({ regs: registered(ws), fo: { uncovered: gapIn((m) => (m % 2 === 1 ? 20_000 : 0)) } });
      for (let m = 1; m <= 40; m++) expect(await minute(f, m)).toBe(0); // 20 holes: 400 s in all, never 300 s in a run
      expect(f.alerts).toEqual([]);
    });

    it("15 consecutive minutes of 20 s (300 s exactly) stay short, the 16th is long", async () => {
      const f = await primed({ regs: registered(ws), fo: { uncovered: gapIn(() => 20_000) } });
      for (let m = 1; m <= 15; m++) expect(await minute(f, m)).toBe(0);
      expect(f.alerts).toEqual([]);
      expect(await minute(f, 16)).toBe(40);
      expect(longAlerts(f.alerts)).toHaveLength(1);
    });

    it("a poster an hour behind with a feed that watched none of it reads every wallet on its first minute, then publishes the rest in a burst with no more calls", async () => {
      const f = await primed({ regs: registered(ws), fo: { uncovered: dead } });
      f.clock.time = endOf(60) + GRACE; // minutes 1 to 60 are finished
      expect(await f.poster.tick()).toBe("published");
      expect(f.fillCalls).toHaveLength(40);
      expect(f.fillCalls.every((c) => c[1] === endMsOf(0) + 1 && c[2] === endMsOf(60))).toBe(true);
      expect(f.feed.uncovered.mock.calls.length).toBeLessThanOrEqual(8); // the look-ahead stops once the run is long, not at the newest finished minute
      for (let m = 2; m <= 60; m++) {
        expect(await f.poster.tick()).toBe("published");
        expect(latestOf(f.published).throughMinute).toBe(m);
      }
      expect(f.fillCalls).toHaveLength(40);
      expect(longAlerts(f.alerts)).toHaveLength(1);
    });

    it("the look-ahead stops at a fully watched minute: a backlog of single gaps between clean minutes stays short", async () => {
      // 60 s unwatched in every odd minute: 900 s over the 30 minutes, but never more than 60 s in a run
      const f = await primed({ regs: registered(ws), fo: { users: [w], uncovered: gapIn((m) => (m % 2 === 1 ? 60_000 : 0)) } });
      f.clock.time = endOf(30) + GRACE;
      for (let m = 1; m <= 30; m++) expect(await f.poster.tick()).toBe("published");
      expect(new Set(f.fillCalls.map((c) => c[0]))).toEqual(new Set([w]));
      expect(f.alerts).toEqual([]);
    });

    it("a read that fails and is retried counts its gap once", async () => {
      let down = false;
      const f = await primed({
        regs: registered(ws),
        fo: { users: [w], uncovered: gapIn(() => 20_000) },
        beforeFill: () => {
          if (down) throw new Error("HL /info 429: rate limited");
        },
      });
      down = true;
      f.clock.time = endOf(1) + GRACE;
      for (let i = 0; i < 20; i++) await expect(f.poster.tick()).rejects.toThrow("429");
      down = false;
      expect(await minute(f, 1)).toBe(1); // still short: 20 s, not 420 s
      for (let m = 2; m <= 15; m++) expect(await minute(f, m)).toBe(1); // 15 minutes of 20 s in all
      expect(f.alerts).toEqual([]);
      expect(await minute(f, 16)).toBe(40);
    });

    it("a failure after the minute was marked covered, retried, does not end the run and does not wait for a dead feed", async () => {
      const f = await primed({ regs: registered(ws), fo: { uncovered: dead, delivered: false } });
      for (let m = 1; m <= 3; m++) await minute(f, m);
      const realSign = f.deps.sign;
      let down = true;
      f.deps.sign = async (cp) => {
        if (down) throw new Error("signer down");
        return realSign(cp);
      };
      f.clock.time = endOf(4) + GRACE;
      await expect(f.poster.tick()).rejects.toThrow("signer down");
      down = false;
      expect(await f.poster.tick()).toBe("published"); // minute 4, its wallets already read
      expect(await minute(f, 5)).toBe(0); // 300 s in the run
      expect(await minute(f, 6)).toBe(40); // 360 s: had the retry ended the run this would be 120 s
      expect(f.feed.deliveredPast).not.toHaveBeenCalled(); // a dead feed answers false for ever: a covered minute needs no answer
    });
  });

  it("a wallet registered after the minute's end is not read, even when the feed saw it", async () => {
    const [early, late] = [wallets[1], wallets[2]];
    const regs = [...registered([early]), { user: late, registeredAt: endOf(1) + 1 }];
    const fills = { [early]: [good(1, at(1, 5))], [late]: [good(2, at(1, 6))] };
    const f = await primed({ regs, fills, fo: { users: [early, late] } });
    expect(await f.poster.tick()).toBe("published");
    expect(called(f)).toEqual([early]);
    expect(tableUsers(f.published, 1)).toEqual([early]);
  });

  it("a poster behind reads each active wallet once for all the minutes it is behind", async () => {
    const [a, b] = [wallets[7], wallets[8]];
    const minutes = [1, 2, 3, 4, 5];
    const fills = { [a]: minutes.map((m) => good(m, at(m, 5))), [b]: minutes.map((m) => good(10 + m, at(m, 6))) };
    const f = await primed({ fills, fo: { users: [a, b] } });
    f.clock.time = endOf(5) + GRACE; // minutes 1 to 5 are all finished
    const through: number[] = [];
    for (let i = 0; i < 5; i++) {
      expect(await f.poster.tick()).toBe("published");
      through.push(latestOf(f.published).throughMinute);
    }
    expect(through).toEqual(minutes);
    expect(f.fillCalls).toEqual([[a, endMsOf(0) + 1, endMsOf(5)], [b, endMsOf(0) + 1, endMsOf(5)]]);
    expect(usersOf(f.published)[a].fees).toBe((5n * FEE).toString());
    expect(usersOf(f.published)[b].fees).toBe((5n * FEE).toString());
    const reads = f.logs.filter((l) => l.startsWith("checkpoint ")).map((l) => /read (\d+) of 1000 wallets/.exec(l)?.[1]);
    expect(reads.slice(1)).toEqual(["2", "0", "0", "0", "0"]); // the first minute reads them, the burst after it reads nobody
    expect(await f.poster.tick()).toBe("waiting");
  });

  it("a failure after the wallets were read does not read them again", async () => {
    const w = wallets[1];
    const f = await primed({ fills: { [w]: [good(1, at(1, 5))] }, fo: { users: [w] } });
    const realSign = f.deps.sign;
    let down = true;
    f.deps.sign = async (cp) => {
      if (down) throw new Error("signer down");
      return realSign(cp);
    };
    await expect(f.poster.tick()).rejects.toThrow("signer down");
    expect(f.fillCalls).toHaveLength(1);
    down = false;
    expect(await f.poster.tick()).toBe("published");
    expect(f.fillCalls).toHaveLength(1);
    expect(tableUsers(f.published, 1)).toEqual([w]);
  });

  describe("waiting for the feed", () => {
    const waits = (alerts: string[]) => alerts.filter((a) => a.includes("waiting for the trade feed"));
    it("alerts once when a minute has waited over 2 minutes of chain time, keeps waiting, and counts the next minute's wait afresh", async () => {
      const f = await primed({ fo: { delivered: false } });
      expect(await f.poster.tick()).toBe("waiting"); // the wait for minute 1 begins
      f.clock.time += 120;
      expect(await f.poster.tick()).toBe("waiting");
      expect(waits(f.alerts)).toEqual([]); // exactly 2 minutes is not over
      f.clock.time += 1;
      expect(await f.poster.tick()).toBe("waiting");
      expect(waits(f.alerts)).toHaveLength(1);
      expect(waits(f.alerts)[0]).toContain("minute 1");
      f.clock.time += 600;
      expect(await f.poster.tick()).toBe("waiting");
      expect(waits(f.alerts)).toHaveLength(1); // once, not on every tick
      expect(f.published.has("checkpoints/1.json")).toBe(false);

      f.fo.delivered = true;
      expect(await f.poster.tick()).toBe("published");
      f.fo.delivered = false;
      expect(await f.poster.tick()).toBe("waiting"); // minute 2 is due long ago, but its wait has only begun
      expect(waits(f.alerts)).toHaveLength(1);
      f.clock.time += 121;
      expect(await f.poster.tick()).toBe("waiting");
      expect(waits(f.alerts)).toHaveLength(2);
      expect(waits(f.alerts)[1]).toContain("minute 2");
    });

    it("a wait that ends before 2 minutes sends nothing", async () => {
      const f = await primed({ fo: { delivered: false } });
      await f.poster.tick();
      f.clock.time += 100;
      await f.poster.tick();
      f.fo.delivered = true;
      expect(await f.poster.tick()).toBe("published");
      expect(waits(f.alerts)).toEqual([]);
    });
  });

  describe("late trades", () => {
    it("alerts when the count grows, with a text that has no number: once an hour, and never again for the same count", async () => {
      const feed = fakeFeed({ late: 2 });
      const f = setup({ feed, time: endOf(5) + GRACE });
      const lateAlerts = () => f.alerts.filter((a) => a.includes("arrived after their minute was read"));
      await f.poster.tick();
      expect(lateAlerts()).toEqual(["poster: trades arrived after their minute was read (a very late feed): the verifier's checks will show any fee this missed"]);
      feed.lateTrades = 3; // the count grew, within the hour: the same text
      await f.poster.tick();
      expect(lateAlerts()).toHaveLength(1);
      f.clock.time += 2 * 3600;
      await f.poster.tick();
      expect(lateAlerts()).toHaveLength(1); // the same count, an hour on: not again
      feed.lateTrades = 4;
      await f.poster.tick();
      expect(lateAlerts()).toHaveLength(2); // grew, and the hour has passed
    });

    it("an alert channel that fails does not stop the poster", async () => {
      const f = setup({ feed: fakeFeed({ late: 1 }) });
      f.deps.alert = async () => {
        throw new Error("webhook down");
      };
      expect(await f.poster.tick()).toBe("published");
      expect(f.logs).toContain("alert failed: webhook down");
    });
  });
});

/** A WebSocket the test drives by hand. */
class Sock implements FeedSocket {
  isOpen = false;
  onopen: FeedSocket["onopen"] = null;
  onmessage: FeedSocket["onmessage"] = null;
  onclose: FeedSocket["onclose"] = null;
  onerror: FeedSocket["onerror"] = null;
  send(_s: string) {
    if (!this.isOpen) throw new Error("not open");
  }
  close() {
    this.isOpen = false;
    this.onclose?.({});
  }
  open() {
    this.isOpen = true;
    this.onopen?.({});
  }
  msg(j: unknown) {
    this.onmessage?.({ data: JSON.stringify(j) });
  }
}

describe("Poster with the real TradeFeed (fake socket, fake clock)", () => {
  const wallet = (i: number): Addr => `0x${(i + 0xa00).toString(16).padStart(40, "0")}`;
  const registered = (ws: readonly Addr[]): Registration[] => ws.map((user) => ({ user, registeredAt: 1 }));
  const tableUsers = (published: Map<string, string>, m: number) =>
    parseTableCsv(parseCheckpointFile(published.get(`checkpoints/${m}.json`)!).table).map((r) => r.user).sort();
  const feeds: TradeFeed[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at(0) - 30_000); // chain time follows this clock
  });
  afterEach(() => {
    for (const f of feeds.splice(0)) f.stop();
    vi.useRealTimers();
  });

  function world(o: { regs: Registration[]; fills: Record<string, ApiFill[]>; beforeFill?: (user: string) => void; maxSilenceMs?: number | null }) {
    const sockets: Sock[] = [];
    const feedLogs: string[] = [];
    const feed = new TradeFeed({
      url: "wss://hl.test/ws",
      coins: async () => ["BTC"],
      connect: () => {
        const s = new Sock();
        sockets.push(s);
        return s;
      },
      log: (l) => feedLogs.push(l),
      maxSilenceMs: o.maxSilenceMs,
    });
    feeds.push(feed);
    const f = setup({ regs: o.regs, fills: o.fills, feed, beforeFill: o.beforeFill });
    const faults = { seeds: false };
    const realSeeds = f.deps.seeds;
    f.deps.seeds = async (...a) => {
      if (faults.seeds) throw new Error("rpc down");
      return realSeeds(...a);
    };
    const net = { up: true };
    /** Live now: the socket opens and every coin is acknowledged. */
    async function goLive() {
      feed.start();
      await vi.advanceTimersByTimeAsync(0);
      const s = sockets[sockets.length - 1];
      s.open();
      s.msg({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "trades", coin: "BTC" } } });
      return s;
    }
    /** `secs` of life in 5 s steps: a pong whenever the clock is on a multiple of 15 s while the net is up, then a poster tick (an error is the result). */
    async function run(secs: number) {
      const out: string[] = [];
      for (let left = secs; left > 0; left -= 5) {
        await vi.advanceTimersByTimeAsync(5_000);
        const s = sockets[sockets.length - 1];
        if (net.up && s?.isOpen && Math.floor(Date.now() / 1000) % 15 === 0) s.msg({ channel: "pong" });
        f.clock.time = Math.floor(Date.now() / 1000);
        try {
          out.push(await f.poster.tick());
        } catch (e) {
          out.push(`error: ${(e as Error).message}`);
        }
      }
      return out;
    }
    const trade = (s: Sock, time: number, a: string, b: string) => s.msg({ channel: "trades", data: [{ coin: "BTC", time, users: [a, b] }] });
    return { ...f, feed, feedLogs, sockets, faults, net, goLive, run, trade };
  }

  it("a dead feed, and then one failure after the minute was marked covered, still keeps publishing", async () => {
    const w = world({ regs: registered(Array.from({ length: 10 }, (_, i) => wallet(i))), fills: {} });
    const s = await w.goLive();
    await w.run(30 + 3 * 60 + 15); // minutes 0 to 2 published on a live feed
    expect(w.poster.nextMinute).toBe(3);
    w.net.up = false;
    s.onclose = null;
    s.isOpen = false; // it dies without a word: no more messages, no close
    await w.run(3 * 60);
    const before = w.poster.nextMinute;
    w.faults.seeds = true; // fails after the wallets were read and the minute marked covered
    const failing = await w.run(60);
    w.faults.seeds = false;
    expect(failing.some((r) => r.startsWith("error: rpc down"))).toBe(true);
    await w.run(8 * 60);
    expect(w.poster.nextMinute).toBeGreaterThanOrEqual(before + 7); // the retry did not wait for a feed that is gone
  });

  it("a trade of the minute that arrives while the wallets are being read is read too, and its fee is in that minute's table", async () => {
    const [a, x] = [wallet(1), wallet(2)];
    const fills = { [a]: [good(1, at(3, 10))], [x]: [good(2, at(3, 50))] };
    let sock!: Sock;
    let armed = false;
    const w = world({
      regs: registered([a, x]),
      fills,
      beforeFill: () => {
        if (armed) {
          armed = false;
          w.trade(sock, at(3, 50), x, wallet(99)); // x's trade, heard while a is being read
        }
      },
    });
    sock = await w.goLive();
    await w.run(30 + 3 * 60 + 30); // into minute 3
    expect(w.poster.nextMinute).toBe(3);
    w.trade(sock, at(3, 10), a, wallet(98)); // a's trade is on time; x's is not (yet)
    armed = true;
    await w.run(60);
    expect(armed).toBe(false);
    expect(w.poster.nextMinute).toBe(4);
    expect(tableUsers(w.published, 3)).toEqual([a, x].sort());
    expect(w.feed.lateTrades).toBe(1);
    expect(w.alerts.filter((m) => m.includes("arrived after their minute was read"))).toHaveLength(1);
  });

  it("fills at a minute's first and last ms are counted exactly once", async () => {
    const [a, b] = [wallet(1), wallet(2)];
    const fills = {
      [a]: [good(1, at(2)), good(2, at(3) - 1)], // minute 2's first and last ms
      [b]: [good(3, at(3) - 1), good(4, at(3))], // minute 2's last ms, minute 3's first
    };
    const w = world({ regs: registered([a, b, wallet(3)]), fills });
    const s = await w.goLive();
    await w.run(30 + 2 * 60 + 5); // into minute 2
    w.trade(s, at(2), a, wallet(90));
    w.trade(s, at(3) - 1, a, wallet(90));
    w.trade(s, at(3) - 1, b, wallet(91));
    w.trade(s, at(3), b, wallet(91));
    await w.run(4 * 60);
    expect(w.poster.nextMinute).toBeGreaterThanOrEqual(4);
    const users = usersOf(w.published);
    expect(users[a].fees).toBe((2n * FEE).toString());
    expect(users[b].fees).toBe((2n * FEE).toString());
    expect(w.fillCalls.filter((c) => c[0] === wallet(3))).toHaveLength(1); // the idle one was read in the first pass only
  });

  describe("an exchange that keeps the socket and its pongs but sends no trades (the silence rule)", () => {
    /** `secs` of life in 5 s steps: every new socket is opened and acknowledged at once, a pong comes every 15 s, and the poster ticks. */
    async function silentExchange(w: ReturnType<typeof world>, secs: number) {
      const out: string[] = [];
      for (let left = secs; left > 0; left -= 5) {
        const s = w.sockets[w.sockets.length - 1];
        if (s && !s.isOpen && !opened.has(s)) {
          opened.add(s);
          s.open();
          s.msg({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "trades", coin: "BTC" } } });
        }
        out.push(...(await w.run(5)));
      }
      return out;
    }
    const opened = new WeakSet<Sock>();

    it("reconnects about once per interval, never in a faster loop, and the poster reaches its long branch and keeps publishing", async () => {
      const regs = registered(Array.from({ length: 10 }, (_, i) => wallet(i)));
      const w = world({ regs, fills: {}, maxSilenceMs: 30_000 });
      w.feed.start();
      await vi.advanceTimersByTimeAsync(0);
      await silentExchange(w, 12 * 60);
      // each socket is live for 30 to 45 s, and the next one is made a second after the drop
      const drops = w.feedLogs.filter((l) => l.includes("no trades for"));
      expect(drops.length).toBeGreaterThanOrEqual(Math.floor(12 * 60 / 47));
      expect(drops.length).toBeLessThanOrEqual(Math.ceil(12 * 60 / 31));
      expect(w.sockets.length).toBe(drops.length + 1);
      expect(w.feedLogs.every((l) => l.includes("no trades for") || l.includes("connection lost (no trades)"))).toBe(true);
      // the stretches without a trade are not watched, so the run of gap minutes passes the poster's limit
      expect(w.logs.some((l) => l.includes("the trade feed was not watching for at least") && l.includes("reading every wallet (10)"))).toBe(true);
      expect(w.alerts.some((m) => m.includes("has not been watching for over 5 minutes"))).toBe(true);
      expect(w.poster.nextMinute).toBeGreaterThanOrEqual(10); // it published all along
      // and the long branch read every wallet in the later minutes
      const lastRead = new Set(w.fillCalls.slice(-10).map((c) => c[0]));
      expect(lastRead.size).toBe(10);
    });

    it("the same exchange with the rule off keeps the socket for good and the poster reads nobody: the failure the rule is for", async () => {
      const regs = registered(Array.from({ length: 10 }, (_, i) => wallet(i)));
      const w = world({ regs, fills: {}, maxSilenceMs: null });
      w.feed.start();
      await vi.advanceTimersByTimeAsync(0);
      await silentExchange(w, 12 * 60);
      expect(w.sockets).toHaveLength(1);
      expect(w.logs.some((l) => l.includes("reading every wallet"))).toBe(false);
      expect(w.poster.nextMinute).toBeGreaterThanOrEqual(10);
      expect(w.fillCalls).toHaveLength(10); // the first pass only: no wallet is read again, and the minutes since were published empty
    });
  });
});

describe("Poster user files", () => {
  type F = ReturnType<typeof setup>;
  const userPuts = (f: F) => f.puts.filter((p) => p.path.startsWith("users/"));
  const throughOf = (p: { body: string }) => (JSON.parse(p.body) as { throughMinute: number }).throughMinute;
  /** The throughMinute of every checkpoint that wrote a user file (some or all of them), once each, oldest first. */
  const writtenAt = (f: F) => [...new Set(userPuts(f).map(throughOf))];
  const filesAt = (f: F, m: number) => userPuts(f).filter((p) => throughOf(p) === m).length;
  /** `n` wallets spread over `buckets` files (first bytes 01, 02, ...). */
  const wallets = (n: number, buckets: number) =>
    Array.from({ length: n }, (_, i) => `0x${((i % buckets) + 1).toString(16).padStart(2, "0")}${i.toString(16).padStart(38, "0")}` as Addr);
  /** One tick per minute with the clock at each minute's end plus the grace (the poster is in step). */
  const inStep = async (f: F, from: number, through: number) => {
    for (let m = from; m <= through; m++) {
      f.clock.time = endOf(m) + GRACE;
      expect(await f.poster.tick()).toBe("published");
    }
  };
  /**
   * A saved poster state that is at `minute` and already knows 2,000 wallets besides A, none of which has earned anything:
   * the round counts them (entitlements, points and totals), and no tree of 2,000 leaves has to be built each minute.
   */
  const crowded = (minute: number) => {
    const dir = mkdtempSync(join(tmpdir(), "poster-"));
    const s = newCalcState(L, popOdds(CHAIN));
    s.nextMinute = minute;
    for (const w of wallets(2_000, 16)) s.totals.set(w, { fees: 1n, mined: 0n, fromVault: 0n, refined: 0n });
    new Store(dir).writeJson("poster-state", { v: 2, state: serializeState(s), tracker: null, pops: [], seedFrom: DEPLOY_BLOCK.toString() });
    return { dir, fills: { [A]: Array.from({ length: 40 }, (_, m) => good(m + 1, at(m, 5))) } };
  };
  const restartOf = (f: F, minute: number, fills: Record<string, ApiFill[]>) => setup({ dir: f.dir, fills, time: endOf(minute) + GRACE });

  it("writes them after latest.json, every checkpoint under 2,000 wallets", async () => {
    const f = setup();
    await inStep(f, 0, 1);
    expect(f.order).toEqual(["checkpoints/0.json", "latest.json", "users/00.json", "checkpoints/1.json", "latest.json", "users/00.json"]);
    expect(writtenAt(f)).toEqual([0, 1]);
    expect(f.logs.filter((l) => l.startsWith("user files of"))).toEqual(["user files of checkpoint 0: 1 files, 1 wallets", "user files of checkpoint 1: 1 files, 1 wallets"]);
  });

  it("passes gzip and a 60 s cache to the user files, and neither to the archive", async () => {
    const f = setup();
    await f.poster.tick();
    expect(f.puts.map((p) => [p.path, p.opts])).toEqual([
      ["checkpoints/0.json", undefined],
      ["latest.json", { maxAgeSeconds: 60 }],
      ["users/00.json", { maxAgeSeconds: 60, gzip: true }],
    ]);
  });

  it("a user file is its checkpoint's: the signed fields of latest.json, the wallet's numbers and a proof that verifies", async () => {
    const f = setup({ regs: [{ user: A, registeredAt: 1 }, { user: B, registeredAt: 1 }], fills: { [A]: [good(1, at(0, 5))], [B]: [good(2, at(0, 6))] } });
    await f.poster.tick();
    const latest = latestOf(f.published);
    const file = parseUserFile(f.published.get("users/00.json")!);
    expect(file).toMatchObject({ chainId: CHAIN, contract: CONTRACT, throughMinute: 0, refBlock: latest.refBlock, root: latest.root, totalEntitled: latest.totalEntitled, sig: latest.sig, publishedAt: latest.publishedAt });
    expect(file.vault).toEqual({ amount: latest.vault.amount, pointsTotal: latest.vault.pointsTotal });
    expect(Object.keys(file.users)).toEqual([A, B]);
    for (const u of [A, B]) {
      const { proof, ...numbers } = file.users[u];
      expect(numbers).toMatchObject({ fees: FEE.toString(), points: FEE.toString() }); // one counted fill each, no pop yet
      expect(BigInt(numbers.entitlement)).toBeGreaterThan(0n);
      expect(proof.length).toBeGreaterThan(0);
      expect(verifyProof(file.root, u, BigInt(numbers.entitlement), proof)).toBe(true);
    }
    const cp = { throughMinute: 0, refBlock: BigInt(file.refBlock), root: file.root, totalEntitled: BigInt(file.totalEntitled) };
    expect(await recoverCheckpointSigner(CHAIN, CONTRACT, cp, file.sig)).toBe(f.account.address);
  });

  it("an empty checkpoint writes no user file", async () => {
    const f = setup({ regs: [], fills: {} });
    expect(await f.poster.tick()).toBe("published");
    expect(userPuts(f)).toEqual([]);
  });

  describe("above 2,000 wallets", () => {
    it("are written on every 5th minute, and at the first checkpoint after a start: minute 7 writes none, minute 10 does", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 10);
      expect(writtenAt(f)).toEqual([3, 5, 10]);
      expect(filesAt(f, 3)).toBeGreaterThan(16); // A's file and the 16 files of the others
      expect(filesAt(f, 5)).toBe(filesAt(f, 3));
      expect(filesAt(f, 10)).toBe(filesAt(f, 3));
    });

    it("a restart writes its first checkpoint whatever its number, then the round follows", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 6);
      expect(writtenAt(f)).toEqual([3, 5]);
      const g = restartOf(f, 7, fills); // 7 is no round
      await inStep(g, 7, 10);
      expect(writtenAt(g)).toEqual([7, 10]);
    });

    it("a failed write is tried again on the next checkpoint, off the round, and then the round is back", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 4);
      f.failOn.path = "users/03.json"; // the round at minute 5: that one file fails, the others are written
      await inStep(f, 5, 5);
      expect(filesAt(f, 5)).toBe(filesAt(f, 3) - 1);
      expect(f.alerts).toHaveLength(1);
      expect(f.alerts[0]).toMatch(/user files/);
      expect(f.alerts[0]).toContain("publish users/03.json failed");
      await inStep(f, 6, 10);
      expect(writtenAt(f)).toEqual([3, 5, 6, 10]);
      expect(filesAt(f, 6)).toBe(filesAt(f, 3));
      expect(f.alerts).toHaveLength(1);
    });

    it("a poster behind writes only on the minutes divisible by 15, the first in-step checkpoint writes whatever its number, then the round of 5 returns", async () => {
      const { dir, fills } = crowded(9);
      const f = setup({ dir, fills, time: endOf(19) + GRACE });
      for (let m = 9; m <= 18; m++) expect(await f.poster.tick()).toBe("published"); // behind
      // 9 is the first after the start; 10 is a round of 5 but the poster is behind; 15 is divisible by 15
      expect(writtenAt(f)).toEqual([9, 15]);
      expect(await f.poster.tick()).toBe("published"); // 19: in step, off the round, and the skips while behind are owed
      expect(writtenAt(f)).toEqual([9, 15, 19]);
      for (let m = 20; m <= 25; m++) {
        f.clock.time = endOf(m) + GRACE;
        expect(await f.poster.tick()).toBe("published");
      }
      expect(writtenAt(f)).toEqual([9, 15, 19, 20, 25]);
    });

    it("a failure in the checkpoint where the poster catches up is tried again on the next, off the round", async () => {
      const { dir, fills } = crowded(2);
      const f = setup({ dir, fills, time: endOf(5) + GRACE });
      for (let m = 2; m <= 4; m++) await f.poster.tick(); // behind: only 2 (the first) writes
      expect(writtenAt(f)).toEqual([2]);
      f.failOn.path = "users/01.json";
      await f.poster.tick(); // minute 5: in step and a round of 5
      f.clock.time = endOf(6) + GRACE;
      await f.poster.tick();
      expect(writtenAt(f)).toEqual([2, 5, 6]);
      expect(filesAt(f, 6)).toBe(filesAt(f, 2));
      expect(f.alerts).toHaveLength(1);
    });

    it("a failed write while behind waits for the next 15th minute or the first in-step checkpoint, whichever comes first", async () => {
      const { dir, fills } = crowded(2);
      const f = setup({ dir, fills, time: endOf(17) + GRACE });
      for (let m = 2; m <= 14; m++) await f.poster.tick(); // behind: only 2 (the first) writes
      f.failOn.path = "users/01.json";
      for (let m = 15; m <= 16; m++) await f.poster.tick(); // 15 fails; 16 is behind and not a 15th minute: no retry
      expect(writtenAt(f)).toEqual([2, 15]);
      expect(filesAt(f, 15)).toBe(filesAt(f, 2) - 1);
      expect(f.alerts).toHaveLength(1);
      await f.poster.tick(); // 17: in step, off the round of 5, owed
      expect(writtenAt(f)).toEqual([2, 15, 17]);
      expect(filesAt(f, 17)).toBe(filesAt(f, 2));
    });
  });

  describe("a quiet minute (no fee rows, no pop, the same root as the files): only every 15th minute writes", () => {
    const traded = (...minutes: number[]) => ({ fills: { [A]: minutes.map((m) => good(m + 1, at(m, 5))) } });

    it("nobody trading writes the first checkpoint, then only on multiples of 15, the minutes the keeper settles", async () => {
      const f = setup(traded(0));
      await inStep(f, 0, 31);
      expect(writtenAt(f)).toEqual([0, 15, 30]);
      expect(f.order.filter((p) => p === "latest.json")).toHaveLength(32); // the checkpoints themselves go on every minute
    });

    it("a trade writes at once, and quiet minutes after it stop again", async () => {
      const f = setup(traded(0, 20));
      await inStep(f, 0, 32);
      expect(writtenAt(f)).toEqual([0, 15, 20, 30]);
    });

    it("a written file names its own checkpoint and keeps the wallet's numbers while later minutes are skipped", async () => {
      const f = setup(traded(0));
      await inStep(f, 0, 7);
      const file = userPuts(f).at(-1)!;
      expect(throughOf(file)).toBe(0);
      const latest = JSON.parse(f.puts.filter((p) => p.path === "latest.json").at(-1)!.body) as { throughMinute: number; root: string };
      expect(latest.throughMinute).toBe(7);
      expect((JSON.parse(file.body) as { root: string }).root).toBe(latest.root); // same root: the skipped minutes changed nothing a proof says
    });

    it("the chain settling past the files writes on the next checkpoint, also in a quiet stretch", async () => {
      const f = setup(traded(0));
      await inStep(f, 0, 6);
      f.chain.settled = 5;
      await inStep(f, 7, 8);
      expect(writtenAt(f)).toEqual([0, 7]);
    });

    it("a failed write is tried again on the next checkpoint, quiet or not", async () => {
      const f = setup(traded(0));
      await inStep(f, 0, 14);
      f.failOn.path = "users/00.json"; // fails once
      await inStep(f, 15, 15);
      expect(f.alerts[0]).toContain("user files");
      await inStep(f, 16, 17);
      expect(writtenAt(f)).toEqual([0, 16]);
    });

    it("a pop writes at once, also one with nobody to pay, which leaves the root as it was: the vault card compares its minute with the file's", async () => {
      const f = setup({ ...traded(0), popAt: [5, 7] });
      await inStep(f, 0, 9);
      expect(writtenAt(f)).toEqual([0, 5, 7]); // 5 pays A; 7 has nobody with points
    });

    it("minutes with a changed root that a wider round skipped are not quiet: the next round writes them", async () => {
      const { dir } = crowded(3);
      const f = setup({ dir, fills: { [A]: [good(1, at(3, 5)), good(2, at(6, 5))] } });
      await inStep(f, 3, 11);
      expect(writtenAt(f)).toEqual([3, 10]); // 5 is quiet; 6 is off the 5-minute round; 7 to 9 have no rows, but the root is not the files'; 10 is a round
    });
  });

  describe("when the chain has settled past the last files written (anyone can settle any published checkpoint)", () => {
    // Above 2,000 wallets the rounds are every 5th minute, so most minutes write nothing; a settle of an off-round minute would
    // leave every wallet's file older than the chain until the next round. The poster writes then, and the file is newer than the chain.
    it("writes off the round when the chain's settled minute is newer than the last minute written, and not before", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 4); // 3 is the first after the start; 4 is off the round, and nothing is settled
      expect(writtenAt(f)).toEqual([3]);
      f.chain.settled = 3; // the chain is at the files, not past them
      await inStep(f, 5, 5); // a round
      expect(writtenAt(f)).toEqual([3, 5]);
      f.chain.settled = 5; // at the last written minute: not past
      await inStep(f, 6, 6);
      expect(writtenAt(f)).toEqual([3, 5]);
      f.chain.settled = 6; // someone settled the off-round minute 6: the files (5) are older than the chain
      await inStep(f, 7, 7);
      expect(writtenAt(f)).toEqual([3, 5, 7]);
      expect(filesAt(f, 7)).toBe(filesAt(f, 3));
      expect(f.chain.settled).toBeLessThan(7); // so the files are newer than the chain: Settle & claim works
      await inStep(f, 8, 9); // 7 is written and the chain has not moved on: back to the rounds
      expect(writtenAt(f)).toEqual([3, 5, 7]);
      await inStep(f, 10, 10);
      expect(writtenAt(f)).toEqual([3, 5, 7, 10]);
    });

    it("someone settling every minute gets a write every other minute: a file at the chain's own minute still claims, one past it makes the next file newer", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 3);
      for (let m = 4; m <= 9; m++) {
        f.chain.settled = m - 1; // the minute just before this one was settled by someone
        await inStep(f, m, m);
      }
      expect(writtenAt(f)).toEqual([3, 5, 7, 9]); // 4 and 6 and 8 find the chain at the files, 5 is a round
    });

    it("minute 0 counts as settled (anySettled): a chain at 0 is past nothing written, a chain with nothing settled is past nothing", async () => {
      const { dir, fills } = crowded(1);
      const f = setup({ dir, fills });
      await inStep(f, 1, 1);
      expect(writtenAt(f)).toEqual([1]);
      f.chain.settled = 0; // older than the files
      await inStep(f, 2, 2);
      expect(writtenAt(f)).toEqual([1]);
      f.chain.settled = null; // nothing settled
      await inStep(f, 3, 3);
      expect(writtenAt(f)).toEqual([1]);
    });

    it("a chain read that fails is logged, writes nothing and does not stop the tick; the next read that works writes", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 3);
      f.chain.settled = 4; // past the files (3)
      f.chain.fail = true;
      f.clock.time = endOf(4) + GRACE;
      expect(await f.poster.tick()).toBe("published");
      expect(writtenAt(f)).toEqual([3]);
      expect(f.logs.some((l) => l.includes("settled minute") && l.includes("rpc down"))).toBe(true);
      expect(f.alerts).toEqual([]);
      expect(f.poster.nextMinute).toBe(5);
      f.chain.fail = false;
      await inStep(f, 5, 5); // a round
      expect(writtenAt(f)).toEqual([3, 5]);
      await inStep(f, 6, 6); // the chain (4) is not past the files (5)
      expect(writtenAt(f)).toEqual([3, 5]);
      f.chain.settled = 6;
      await inStep(f, 7, 7);
      expect(writtenAt(f)).toEqual([3, 5, 7]);
    });

    it("reads the chain only when it could change what is written: not on a round, not when a write is already owed, not while behind", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 3); // the first after the start: owed
      expect(f.chain.reads).toBe(0);
      await inStep(f, 4, 4); // off the round, in step, nothing owed: one read
      expect(f.chain.reads).toBe(1);
      await inStep(f, 5, 5); // a round
      expect(f.chain.reads).toBe(1);
      await inStep(f, 6, 6);
      expect(f.chain.reads).toBe(2);
      const g = setup({ dir: crowded(9).dir, fills, time: endOf(19) + GRACE });
      g.chain.settled = 18; // far past, but the poster is behind
      for (let m = 9; m <= 18; m++) await g.poster.tick();
      expect(g.chain.reads).toBe(0);
      expect(writtenAt(g)).toEqual([9, 15]);
    });

    it("does not apply while the poster is behind; the first in-step checkpoint then writes anyway", async () => {
      const { dir, fills } = crowded(9);
      const f = setup({ dir, fills, time: endOf(19) + GRACE });
      f.chain.settled = 12;
      for (let m = 9; m <= 18; m++) expect(await f.poster.tick()).toBe("published");
      expect(writtenAt(f)).toEqual([9, 15]); // the chain being past 9 and 12 changed nothing
      expect(await f.poster.tick()).toBe("published"); // 19: in step, owed (skips while behind)
      expect(writtenAt(f)).toEqual([9, 15, 19]);
    });

    it("a restarted poster has written nothing: its first checkpoint writes whatever the chain says, then the rule follows that minute", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 5);
      const g = restartOf(f, 6, fills); // 6 is off the round of 5
      g.chain.settled = 2;
      await inStep(g, 6, 6);
      expect(writtenAt(g)).toEqual([6]);
      expect(g.chain.reads).toBe(0); // owed already: no read needed
      g.chain.settled = 6;
      await inStep(g, 7, 7);
      expect(writtenAt(g)).toEqual([6]); // at the files, not past
      g.chain.settled = 7;
      await inStep(g, 8, 8);
      expect(writtenAt(g)).toEqual([6, 8]);
    });

    it("the chain read comes after the checkpoint is published: a failure of it never touches the checkpoint's state", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 3);
      f.chain.fail = true;
      await inStep(f, 4, 4);
      expect(parseLatestFile(f.published.get("latest.json")!).throughMinute).toBe(4);
      expect(JSON.parse(readFileSync(join(f.dir, "poster-state.json"), "utf8")).v).toBe(2);
      expect(() => readFileSync(join(f.dir, "pending.json"))).toThrow();
    });
  });

  describe("a poster behind (the next minute is already due)", () => {
    it("a burst of 40 minutes writes the first checkpoint's files, those on minutes divisible by 15 and the last in-step checkpoint's", async () => {
      const f = setup({ time: endOf(39) + GRACE });
      for (let m = 0; m < 40; m++) expect(await f.poster.tick()).toBe("published");
      expect(latestOf(f.published).throughMinute).toBe(39);
      expect(writtenAt(f)).toEqual([0, 15, 30, 39]);
    });

    it("is behind exactly when the next minute's end plus the grace has passed", async () => {
      const inStepRun = setup({ time: endOf(2) + GRACE - 1 }); // minute 2 is not due: minute 1 is the last in step
      await inStepRun.poster.tick();
      await inStepRun.poster.tick();
      expect(writtenAt(inStepRun)).toEqual([0, 1]);
      const behindRun = setup({ time: endOf(2) + GRACE }); // minute 2 is due
      await behindRun.poster.tick();
      await behindRun.poster.tick();
      expect(writtenAt(behindRun)).toEqual([0]);
    });

    it("a failure at the burst's first checkpoint is tried again at the next 15th minute, not on every checkpoint", async () => {
      const f = setup({ time: endOf(39) + GRACE });
      f.failOn.path = "users/00.json"; // the first checkpoint's write
      for (let m = 0; m < 40; m++) expect(await f.poster.tick()).toBe("published");
      expect(writtenAt(f)).toEqual([15, 30, 39]);
      expect(f.alerts).toHaveLength(1);
    });

    it("a failure on a 15th minute of the burst is tried again at the next one", async () => {
      const f = setup({ time: endOf(39) + GRACE });
      for (let m = 0; m < 15; m++) await f.poster.tick();
      f.failOn.path = "users/00.json"; // minute 15
      for (let m = 15; m < 40; m++) expect(await f.poster.tick()).toBe("published");
      expect(writtenAt(f)).toEqual([0, 30, 39]);
    });
  });

  describe("no file is lost to a failure", () => {
    it("a user-file failure does not hold up the checkpoint: published, state advanced, no pending file, one alert", async () => {
      const f = setup({ time: endOf(1) + GRACE });
      f.failOn.path = "users/00.json";
      expect(await f.poster.tick()).toBe("published");
      expect(f.alerts).toHaveLength(1);
      expect(f.alerts[0]).toContain("user files");
      expect(() => readFileSync(join(f.dir, "pending.json"))).toThrow();
      expect(parseLatestFile(f.published.get("latest.json")!).throughMinute).toBe(0);
      expect(f.poster.nextMinute).toBe(1);
      expect(JSON.parse(readFileSync(join(f.dir, "poster-state.json"), "utf8")).v).toBe(2);
      expect(userPuts(f)).toEqual([]);
      expect(await f.poster.tick()).toBe("published"); // the next checkpoint writes them
      expect(writtenAt(f)).toEqual([1]);
    });

    it("a failing alert channel does not stop the checkpoint", async () => {
      const f = setup();
      f.deps.alert = async () => {
        throw new Error("webhook down");
      };
      const p = new Poster(f.deps);
      f.failOn.path = "users/00.json";
      expect(await p.tick()).toBe("published");
      expect(f.logs.some((l) => l.includes("alert failed: webhook down"))).toBe(true);
    });

    it("a restart with a pending checkpoint republishes it without user files, and the next new checkpoint writes them", async () => {
      const { dir, fills } = crowded(1);
      const f = setup({ dir, fills, time: endOf(1) + GRACE });
      f.failOn.path = "latest.json";
      await expect(f.poster.tick()).rejects.toThrow();
      const g = restartOf(f, 1, fills);
      expect(await g.poster.tick()).toBe("republished");
      expect(userPuts(g)).toEqual([]);
      g.clock.time = endOf(2) + GRACE;
      expect(await g.poster.tick()).toBe("published"); // minute 2 is no round of 5, but it is the first new checkpoint of this process
      expect(writtenAt(g)).toEqual([2]);
    });

    it("a checkpoint republished after a failed publish has no user files; the next new checkpoint writes them even off the round", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills });
      await inStep(f, 3, 4);
      f.clock.time = endOf(5) + GRACE;
      f.failOn.path = "latest.json"; // the round at minute 5
      await expect(f.poster.tick()).rejects.toThrow();
      expect(await f.poster.tick()).toBe("republished");
      expect(writtenAt(f)).toEqual([3]);
      await inStep(f, 6, 10);
      expect(writtenAt(f)).toEqual([3, 6, 10]);
    });

    it("one file that keeps failing does not stop the others: files of different checkpoints side by side, each standing alone", async () => {
      const ws = wallets(12, 12);
      const f = setup({ regs: ws.map((user) => ({ user, registeredAt: 1 })), fills: Object.fromEntries(ws.map((w, i) => [w, [0, 1, 2].map((m) => good(100 * m + i + 1, at(m, 5)))])) });
      let broken = false;
      const real = f.deps.publish;
      f.deps.publish = { put: async (path, ...rest) => (broken && path === "users/02.json" ? Promise.reject(new Error("users/02.json is refused")) : real.put(path, ...rest)) };
      await inStep(f, 0, 0);
      expect(userPuts(f)).toHaveLength(12);
      broken = true;
      await inStep(f, 1, 2); // the first bucket after 02 and the last one are both written, at 1 and at 2
      expect(f.alerts).toEqual(["poster: writing the user files failed, a later checkpoint tries again: users/02.json is refused"]);
      expect(f.logs).toContain("user files of checkpoint 1: 1 of 12 files failed");
      const through = new Map<string, number>();
      for (const [path, body] of f.published) {
        if (!path.startsWith("users/")) continue;
        const file = parseUserFile(body);
        through.set(path, file.throughMinute);
        // the file is its own checkpoint's, whatever the others hold
        const archive = parseCheckpointFile(f.published.get(`checkpoints/${file.throughMinute}.json`)!);
        expect(file.root).toBe(archive.root);
        expect(file.sig).toBe(archive.sig);
        for (const [u, e] of Object.entries(file.users)) expect(verifyProof(file.root, u as Addr, BigInt(e.entitlement), e.proof)).toBe(true);
      }
      expect(through.size).toBe(12);
      expect(through.get("users/02.json")).toBe(0);
      expect([...through].filter(([path]) => path !== "users/02.json").every(([, m]) => m === 2)).toBe(true);
      for (const w of ws) expect(f.published.has(userFilePath(w))).toBe(true);
      broken = false;
      await inStep(f, 3, 3);
      const after = [...f.published].filter(([p]) => p.startsWith("users/")).map(([, b]) => parseUserFile(b).throughMinute);
      expect(after).toEqual(Array(12).fill(3));
    });

    it("a wallet the tree cannot prove fails the user files and alerts, and the checkpoint is still published", async () => {
      const dir = mkdtempSync(join(tmpdir(), "poster-"));
      const st = newCalcState(L, popOdds(CHAIN));
      st.earned.set("0x0000000000000000000000000000000000000000" as Addr, 5n); // the sentinel's leaf is 0: the tree has no leaf for 5
      new Store(dir).writeJson("poster-state", { v: 2, state: serializeState(st), tracker: null, pops: [], seedFrom: DEPLOY_BLOCK.toString() });
      const f = setup({ dir });
      expect(await f.poster.tick()).toBe("published");
      expect(latestOf(f.published).throughMinute).toBe(0);
      expect(userPuts(f)).toEqual([]);
      expect(f.alerts).toHaveLength(1);
      expect(f.alerts[0]).toMatch(/user files/);
      expect(f.alerts[0]).toContain("no proof for 0x0000000000000000000000000000000000000000");
      f.clock.time = endOf(1) + GRACE;
      expect(await f.poster.tick()).toBe("published"); // tried again, the same text: not alerted again within the hour
      expect(userPuts(f)).toEqual([]);
      expect(f.alerts).toHaveLength(1);
    });

    it("a logger that throws after the files were written does not turn them into a failure: no alert, nothing owed", async () => {
      const { dir, fills } = crowded(3);
      const f = setup({ dir, fills, time: endOf(3) + GRACE });
      f.deps.log = (l) => {
        if (l.startsWith("user files of")) throw new Error("log full");
      };
      const p = new Poster(f.deps);
      await expect(p.tick()).rejects.toThrow("log full"); // the files of minute 3 are written, the log line after them throws
      expect(writtenAt(f)).toEqual([3]);
      expect(f.alerts).toEqual([]);
      f.clock.time = endOf(4) + GRACE;
      expect(await p.tick()).toBe("published"); // minute 4: in step, off the round, and nothing is owed
      expect(writtenAt(f)).toEqual([3]);
    });
  });
});

describe("Poster.cycle", () => {
  it("sleeps 5 s after waiting and 0 s after a checkpoint", async () => {
    const f = setup({ time: endOf(0) + GRACE });
    expect(await f.poster.cycle()).toBe(0);
    expect(await f.poster.cycle()).toBe(WAIT_SECONDS);
  });

  it("an error is logged and alerted once, never thrown, and backs off; a good tick resets", async () => {
    const f = setup();
    let down = true;
    const real = f.deps.now;
    f.deps.now = async () => {
      if (down) throw new Error("rpc down");
      return real();
    };
    const p = new Poster(f.deps);
    expect(await p.cycle()).toBe(5);
    expect(await p.cycle()).toBe(10);
    expect(await p.cycle()).toBe(20);
    expect(f.alerts).toEqual(["poster error: rpc down"]); // deduped
    down = false;
    expect(await p.cycle()).toBe(0);
    down = true;
    f.clock.time = endOf(1) + GRACE;
    expect(await p.cycle()).toBe(5);
  });

  it("an alert channel that throws does not stop the loop", async () => {
    const f = setup();
    f.deps.now = async () => {
      throw new Error("rpc down");
    };
    f.deps.alert = async () => {
      throw new Error("webhook down");
    };
    await expect(new Poster(f.deps).cycle()).resolves.toBe(5);
  });
});

describe("checkPosterKey", () => {
  const key = privateKeyToAccount(generatePrivateKey()).address;
  const other = privateKeyToAccount(generatePrivateKey()).address;
  it("passes for the on-chain poster, whatever the address case", async () => {
    await expect(checkPosterKey(key, async () => key.toLowerCase() as typeof key)).resolves.toBeUndefined();
  });
  it("throws a clear error for another key", async () => {
    await expect(checkPosterKey(key, async () => other)).rejects.toThrow("POSTER_KEY is not Checkpoints.poster()");
  });
});

describe("Poster state files", () => {
  it("refuses a state file of another deployment (launch time or odds)", () => {
    const f = setup();
    mkdirSync(f.dir, { recursive: true });
    const file = (state: string) => JSON.stringify({ v: 2, state, tracker: null, pops: [], seedFrom: "7" });
    writeFileSync(join(f.dir, "poster-state.json"), file(serializeState(newCalcState(L + 60, 60))));
    expect(() => new Poster(f.deps)).toThrow("another deployment");
    writeFileSync(join(f.dir, "poster-state.json"), file(serializeState(newCalcState(L, 1))));
    expect(() => new Poster(f.deps)).toThrow("another deployment");
  });
  it("refuses a version-1 state file (from before the vault pops)", () => {
    const f = setup();
    mkdirSync(f.dir, { recursive: true });
    writeFileSync(join(f.dir, "poster-state.json"), JSON.stringify({ v: 1, state: "{}", tracker: null, openings: [] }));
    expect(() => new Poster(f.deps)).toThrow(/from before the vault pops \(version 1\)/);
    expect(() => savedTrackerJson(f.store)).toThrow(/from before the vault pops/);
  });
  it("savedTrackerJson is null on a fresh dir", () => {
    expect(savedTrackerJson(new Store(mkdtempSync(join(tmpdir(), "poster-"))))).toBeNull();
  });
});

describe("Store.remove", () => {
  it("deletes a json file and ignores an absent one", () => {
    const s = new Store(mkdtempSync(join(tmpdir(), "store-")));
    s.writeJson("x", { a: 1 });
    s.remove("x");
    expect(s.readJson("x", "gone")).toBe("gone");
    s.remove("x");
  });
});

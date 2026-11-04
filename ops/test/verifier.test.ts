import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dayOf, popOdds, tableCsv, type Addr, type ApiFill } from "@hlo/calc";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCheckpointFile, type CheckpointFile } from "../src/checkpoint-files.js";
import { FillCache } from "../src/fillcache.js";
import { Ingest } from "../src/ingest.js";
import { Poster } from "../src/poster.js";
import type { Registration } from "../src/registry.js";
import { SeedRangeError } from "../src/seed.js";
import { signCheckpoint } from "../src/sign.js";
import { ChainTracker, type ClaimLog } from "../src/snapshot.js";
import { Store } from "../src/store.js";
import { TradeFeed, type ActiveWallets, type FeedSocket } from "../src/tradefeed.js";
import { checkVerifierKeys, makeDailyCheck, parseBuilderFile, savedVerifierTracker, Verifier, type ChainEvent, type VerifierDeps } from "../src/verifier.js";
import { seedsFor } from "../../calc/test/helpers/seeds.js";

// Many tests here run a real poster through one to three hours of minutes (a day, for the builder total): a loaded machine needs the room.
vi.setConfig({ testTimeout: 60_000 });

const L = 1_800_000_000;
const CHAIN = 998;
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const A: Addr = "0x00000000000000000000000000000000000000a1";
const B: Addr = "0x00000000000000000000000000000000000000b2";
const GRACE = 10;
const DEPLOY_BLOCK = 7n;
const FEE = 100_000_000n;
// px·sz = 1000 → builder fee 1 USDC = 100_000_000 units
const good = (tid: number, timeMs: number, fee = "1"): ApiFill => ({ tid, time: timeMs, coin: "BTC", px: "100", sz: "10", builderFee: fee });

/** The fake chain's seeds, the same for the poster and the verifier: minute m's seed block is 100 + m (at or below every refBlock here), and it pops exactly when m is in `popAt`. */
const chainSeeds = (popAt: readonly number[], calls?: [number, number, bigint, bigint][]): VerifierDeps["seeds"] =>
  async (from, through, lo, hi) => {
    calls?.push([from, through, lo, hi]);
    return seedsFor(from, through, { odds: popOdds(CHAIN), pop: popAt, block: (m) => 100n + BigInt(m) });
  };

interface Fixture {
  launch: number;
  files: Map<string, string>;
  account: ReturnType<typeof privateKeyToAccount>;
  regs: Registration[];
  fills: Record<string, ApiFill[]>;
  claimLogs: ClaimLog[];
}

/** Runs a real Poster through `minutes` checkpoints and returns what it published. */
async function posterRun(o: { launch?: number; minutes?: number; regs?: Registration[]; fills?: Record<string, ApiFill[]>; claimLogs?: ClaimLog[]; blockStep?: bigint; chainId?: number; popAt?: number[] } = {}): Promise<Fixture> {
  const launch = o.launch ?? L;
  const minutes = o.minutes ?? 4;
  const account = privateKeyToAccount(generatePrivateKey());
  const regs = o.regs ?? [{ user: A, registeredAt: 1 }];
  const at = (m: number, sec = 5) => (launch + m * 60 + sec) * 1000;
  const fills = o.fills ?? { [A]: Array.from({ length: minutes }, (_, m) => good(m + 1, at(m))) };
  const claimLogs = o.claimLogs ?? [];
  const store = new Store(mkdtempSync(join(tmpdir(), "poster-")));
  const files = new Map<string, string>();
  const clock = { time: launch + 60 * minutes + GRACE, block: 100n };
  const poster = new Poster({
    now: async () => ({ ...clock }),
    registry: { list: async () => regs },
    ingest: new Ingest(store, { fills: async (u, s, e) => (fills[u] ?? []).filter((f) => f.time >= s && f.time <= e) }, launch),
    tracker: new ChainTracker({ claimedLogs: async (a, b) => claimLogs.filter((l) => l.block >= a && l.block <= b), burnLogs: async () => [] }, 1000n),
    checkSigner: async () => {},
    settledMinute: async () => null,
    sign: (cp) => signCheckpoint(account, o.chainId ?? CHAIN, CONTRACT, cp),
    publish: { put: async (p, body) => void files.set(p, body) },
    store,
    launchTime: launch,
    seeds: chainSeeds(o.popAt ?? []),
    chainId: o.chainId ?? CHAIN,
    contract: CONTRACT,
    graceSeconds: GRACE,
    deployBlock: DEPLOY_BLOCK,
    feed: null,
    log: () => {},
    alert: async () => {},
  });
  for (let m = 0; m < minutes; m++) {
    clock.block = 100n + BigInt(m) * (o.blockStep ?? 10n); // 100, 110, 120, ...
    expect(await poster.tick()).toBe("published");
  }
  return { launch, files, account, regs, fills, claimLogs };
}

/** Replaces published file `m` with `mutate(parsed)`, re-signed by `signer` (so only the mutation is wrong). */
async function tamper(fx: Fixture, m: number, mutate: (f: CheckpointFile) => void, signer = fx.account) {
  const f = parseCheckpointFile(fx.files.get(`checkpoints/${m}.json`)!);
  mutate(f);
  f.sig = await signCheckpoint(signer, CHAIN, CONTRACT, {
    throughMinute: f.throughMinute, refBlock: BigInt(f.refBlock), root: f.root, totalEntitled: BigInt(f.totalEntitled),
  });
  fx.files.set(`checkpoints/${m}.json`, JSON.stringify(f));
}

function verifier(fx: Fixture, o: Partial<VerifierDeps> & { time?: number; block?: bigint; dir?: string; popAt?: number[] } = {}) {
  const alerts: string[] = [];
  const clock = { time: o.time ?? fx.launch + 60 * 4 + 20, block: o.block ?? 1000n };
  const store = new Store(o.dir ?? mkdtempSync(join(tmpdir(), "verifier-")));
  const pause = vi.fn(async () => {});
  const fillCalls: [string, number, number][] = [];
  const logs: string[] = [];
  const seedCalls: [number, number, bigint, bigint][] = [];
  const events: { throughMinute: number; root: `0x${string}`; block: bigint }[] = [];
  /** Events other than Settled (role changes, cancels, write-offs, pauses). */
  const extraEvents: ChainEvent[] = [];
  /** Every address that was ever the poster (Checkpoints.wasPoster). */
  const posters = new Set([fx.account.address.toLowerCase()]);
  const cancelledRanges: { from: number; to: number }[] = [];
  const reader = { claimedLogs: async (a: bigint, b: bigint) => fx.claimLogs.filter((l) => l.block >= a && l.block <= b), burnLogs: async () => [] };
  const deps: VerifierDeps = {
    now: async () => ({ ...clock }),
    read: async (p) => fx.files.get(p) ?? null,
    registry: { list: async () => fx.regs },
    fills: async (u, s, e) => {
      fillCalls.push([u, s, e]);
      return (fx.fills[u] ?? []).filter((f) => f.time >= s && f.time <= e);
    },
    tracker: new ChainTracker(reader, 1000n),
    wasPoster: async (a) => posters.has(a.toLowerCase()),
    cancelled: async () => cancelledRanges,
    events: async (from, to) =>
      [...events.map((e): ChainEvent => ({ kind: "settled", ...e })), ...extraEvents].filter((e) => e.block >= from && e.block <= to),
    pause,
    store,
    launchTime: fx.launch,
    seeds: chainSeeds(o.popAt ?? [], seedCalls),
    chainId: CHAIN,
    contract: CONTRACT,
    deployBlock: DEPLOY_BLOCK,
    fileDelayHours: 2,
    alert: async (s) => void alerts.push(s),
    log: (s) => void logs.push(s),
    dailyCheck: null,
    feed: null,
    graceSeconds: GRACE,
    omissionFullMax: 2000,
    builderRewards: null,
    ...o,
  };
  return { v: new Verifier(deps), deps, alerts, logs, clock, pause, store, fillCalls, seedCalls, events, extraEvents, posters, cancelledRanges, reader };
}

const ticks = async (v: Verifier, n: number) => {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await v.tick());
  return out;
};

describe("Verifier.tick: a clean run", () => {
  it("verifies the poster's minutes 0..3 one per tick, then waits", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(f.v.nextMinute).toBe(4);
    expect(await f.v.tick()).toBe("waiting");
    expect(f.alerts).toEqual([]);
    expect(f.pause).not.toHaveBeenCalled();
    // the clock is 4 minutes past launch: one read of the table's wallet, through the newest finished minute, serves all four
    expect(f.fillCalls).toEqual([[A, L * 1000, (L + 240) * 1000 - 1]]);
  });

  it("accepts a Settled event whose root equals the published file's", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    f.events.push({ throughMinute: 1, root: parseCheckpointFile(fx.files.get("checkpoints/1.json")!).root, block: 50n });
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(f.alerts).toEqual([]);
  });

  it("claims on chain flow into the replay (the same root as the poster's)", async () => {
    const claimLogs: ClaimLog[] = [{ user: A, claimedTotal: 5n, refined: 1n, block: 105n }];
    const fx = await posterRun({ claimLogs });
    const f = verifier(fx);
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
  });

  it("a restart continues from the saved state, tracker included", async () => {
    const fx = await posterRun({ claimLogs: [{ user: A, claimedTotal: 5n, refined: 1n, block: 105n }] });
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const first = verifier(fx, { dir });
    expect(await ticks(first.v, 2)).toEqual(["ok", "ok"]);
    const second = verifier(fx, { dir, tracker: ChainTracker.fromJSON(savedVerifierTracker(first.store)!, first.reader, 1000n) });
    expect(second.v.nextMinute).toBe(2);
    expect(await ticks(second.v, 3)).toEqual(["ok", "ok", "waiting"]);
    expect(second.seedCalls[0]).toEqual([2, 2, 101n, 120n]); // starts at minute 1's seed block, ends at minute 2's refBlock
  });

  it("refuses the saved state of another deployment", async () => {
    const fx = await posterRun({ minutes: 1 });
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    await verifier(fx, { dir }).v.tick();
    expect(() => verifier({ ...fx, launch: L + 60 }, { dir })).toThrow("another deployment");
  });
});

describe("Verifier.tick: the vault pops", () => {
  it("replays the poster's pops (the same seeds on the same chain)", async () => {
    const fx = await posterRun({ popAt: [1, 3] });
    const f = verifier(fx, { popAt: [1, 3] });
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("the seed search starts at the deploy block, then at the previous minute's seed block, and ends at the file's refBlock", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 3);
    expect(f.seedCalls).toEqual([[0, 0, DEPLOY_BLOCK, 100n], [1, 1, 100n, 110n], [2, 2, 101n, 120n]]);
  });

  it("a checkpoint that skipped a pop the chain shows is a root mismatch: alert and pause", async () => {
    const fx = await posterRun(); // the poster saw no pop
    const f = verifier(fx, { popAt: [2] }); // the chain's seed for minute 2 pops
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "mismatch"]);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts.some((a) => a.startsWith("verifier: checkpoint 2 mismatch:") && /root:/.test(a))).toBe(true);
  });

  it("a refBlock before the end of its minute (no seed block up to it) is a mismatch", async () => {
    const fx = await posterRun();
    const fine = chainSeeds([]);
    const f = verifier(fx, {
      seeds: async (from, through, lo, hi) => {
        if (from === 2) throw new SeedRangeError("block 120 (time 1800000170) is before the end of minute 2 (1800000180)");
        return fine(from, through, lo, hi);
      },
    });
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "mismatch"]);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts.some((a) => a.startsWith("verifier: checkpoint 2 mismatch: seed: block 120"))).toBe(true);
  });

  it("a failing seed read is an error, not a mismatch: no pause, the minute is retried", async () => {
    const fx = await posterRun();
    const fine = chainSeeds([]);
    let down = true;
    const calls: [number, number, bigint, bigint][] = [];
    const f = verifier(fx, {
      seeds: async (from, through, lo, hi) => {
        calls.push([from, through, lo, hi]);
        if (from === 2 && down) throw new Error("rpc down");
        return fine(from, through, lo, hi);
      },
    });
    expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
    await expect(f.v.tick()).rejects.toThrow("rpc down");
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.v.nextMinute).toBe(2);
    down = false;
    expect(await f.v.tick()).toBe("ok");
    // the failed read did not move the search start: the retry used minute 1's seed block as its lower bound again
    expect(calls.filter((c) => c[0] === 2)).toEqual([[2, 2, 101n, 120n], [2, 2, 101n, 120n]]);
    expect(calls.at(-1)).toEqual([2, 2, 101n, 120n]);
  });

  it("refuses a version-1 state file (from before the vault pops)", async () => {
    const fx = await posterRun({ minutes: 1 });
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    writeFileSync(join(dir, "verifier-state.json"), JSON.stringify({ v: 1, state: "{}", tracker: null }));
    expect(() => verifier(fx, { dir })).toThrow(/from before the vault pops \(version 1\)/);
  });
});

describe("Verifier.tick: tampered checkpoints", () => {
  /** Verifies minutes 0 and 1, then tampers with minute 2 and ticks once. */
  async function broken(mutate: (f: CheckpointFile) => void, o: { signer?: ReturnType<typeof privateKeyToAccount>; deps?: Partial<VerifierDeps>; setup?: (f: ReturnType<typeof verifier>, fx: Fixture) => void } = {}) {
    const fx = await posterRun();
    const f = verifier(fx, o.deps);
    o.setup?.(f, fx);
    expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
    await tamper(fx, 2, mutate, o.signer);
    const r = await f.v.tick();
    return { fx, f, r };
  }
  const expectMismatch = ({ f, r }: Awaited<ReturnType<typeof broken>>, what: RegExp) => {
    expect(r).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts.some((a) => a.startsWith("verifier: checkpoint 2 mismatch:") && what.test(a))).toBe(true);
    expect(f.v.nextMinute).toBe(2);
  };

  it("a changed root", async () => {
    expectMismatch(await broken((f) => void (f.root = `0x${"ab".repeat(32)}`)), /root:/);
  });

  it("a changed totalEntitled", async () => {
    expectMismatch(await broken((f) => void (f.totalEntitled = (BigInt(f.totalEntitled) + 1n).toString())), /totalEntitled/);
  });

  it("a row with an inflated fee (the API sum differs)", async () => {
    expectMismatch(await broken((f) => void (f.table = f.table.replace(`2,${A},${FEE}`, `2,${A},${FEE + 1n}`))), /fee of 0x0+a1: table 100000001, API 100000000/);
  });

  it("a row BELOW the API sum (a fill indexed after the poster's grace) is an alert, not a mismatch: no pause, verification continues", async () => {
    const fx = await posterRun();
    // a second counted fill of minute 2 that the API shows now but the poster did not see
    fx.fills[A].push(good(99, (fx.launch + 2 * 60 + 30) * 1000));
    const f = verifier(fx);
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.alerts).toEqual([`verifier: checkpoint 2: fee of ${A} is below the API (table ${FEE}, API ${2n * FEE}); alert only, a fill indexed after the grace`]);
    expect(f.v.nextMinute).toBe(4);
  });

  it("an unregistered user in the table", async () => {
    expectMismatch(await broken((f) => void (f.table += `\n2,${B},${FEE}`)), new RegExp(`${B} is not registered`));
  });

  it("a user registered after the end of the minute", async () => {
    const regs: Registration[] = [{ user: A, registeredAt: 1 }, { user: B, registeredAt: L + 60 * 3 + 1 }];
    expectMismatch(await broken((f) => void (f.table += `\n2,${B},${FEE}`), { setup: (_f, fx) => void fx.regs.splice(0, 2, ...regs) }), /after the end of the minute/);
  });

  it("a row for another minute", async () => {
    expectMismatch(await broken((f) => void (f.table = f.table.replace(`2,${A}`, `3,${A}`))), /row for minute 3/);
  });

  it("the same user twice for the minute", async () => {
    // parseTableCsv rejects the duplicate itself, which is a mismatch too
    expectMismatch(await broken((f) => void (f.table += `\n2,${A},${FEE}`)), /table/);
  });

  it("a user row with fee 0", async () => {
    expectMismatch(await broken((f) => void (f.table = f.table.replace(`2,${A},${FEE}`, `2,${A},0`))), /table/);
  });

  it("a signature by another key", async () => {
    expectMismatch(await broken(() => {}, { signer: privateKeyToAccount(generatePrivateKey()) }), /never a poster of this contract/);
  });

  it("a refBlock that goes backwards", async () => {
    expectMismatch(await broken((f) => void (f.refBlock = "105")), /refBlock 105 is below the previous checkpoint's 110/);
  });

  it("a refBlock equal to the previous checkpoint's is fine", async () => {
    const fx = await posterRun({ blockStep: 0n });
    const f = verifier(fx);
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(f.alerts).toEqual([]);
  });

  it("a refBlock that is not below the latest block waits (the RPC may lag) and is fine once the chain catches up", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 2);
    await tamper(fx, 2, (x) => void (x.refBlock = "1000"));
    f.clock.block = 1000n;
    const t0 = f.clock.time;
    expect(await f.v.tick()).toBe("waiting");
    f.clock.time = t0 + 299;
    expect(await f.v.tick()).toBe("waiting");
    expect(f.alerts).toEqual([]);
    expect(f.pause).not.toHaveBeenCalled();
    f.clock.block = 1001n;
    expect(await f.v.tick()).toBe("ok");
  });

  it("a refBlock still ahead of the chain after 5 minutes of chain time is a mismatch (pause off 999)", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 2);
    await tamper(fx, 2, (x) => void (x.refBlock = "1000"));
    f.clock.block = 1000n;
    const t0 = f.clock.time;
    expect(await f.v.tick()).toBe("waiting");
    f.clock.time = t0 + 300;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toMatch(/^verifier: checkpoint 2 mismatch: .*refBlock 1000.* ahead of the chain/);
  });

  it("now() is read after the file: a block that arrives while the file is being read is not a mismatch", async () => {
    const fx = await posterRun();
    const f = verifier(fx, { block: 115n }); // minute 2 has refBlock 120
    const realRead = f.deps.read;
    f.deps.read = async (p) => {
      const t = await realRead(p);
      if (p === "checkpoints/2.json") f.clock.block = 1000n;
      return t;
    };
    const v = new Verifier(f.deps);
    expect(await ticks(v, 3)).toEqual(["ok", "ok", "ok"]);
  });

  it("a failed wasPoster() read is an error for cycle()'s backoff, never a signature mismatch or a pause", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 1);
    let down = true;
    const real = f.deps.wasPoster;
    f.deps.wasPoster = async (a) => { if (down) throw new Error("rpc down"); return real(a); };
    const v = new Verifier(f.deps);
    await expect(v.tick()).rejects.toThrow("rpc down");
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.alerts).toEqual([]);
    down = false;
    expect(await v.tick()).toBe("ok");
  });

  it("a file for another minute", async () => {
    expectMismatch(await broken((f) => void (f.throughMinute = 3)), /file is for minute 3/);
  });

  it("a file of another chain or contract is another deployment's leftover (a redeploy publishes under the same prefix): not yet published, never a mismatch", async () => {
    for (const mutate of [(f: CheckpointFile) => void (f.chainId = 1), (f: CheckpointFile) => void (f.contract = A)]) {
      const fx = await posterRun();
      const own = fx.files.get("checkpoints/2.json")!;
      const f = verifier(fx, { time: L + 3 * 60 + 300 });
      expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
      await tamper(fx, 2, mutate);
      expect(await f.v.tick()).toBe("waiting");
      expect(f.alerts).toEqual(["poster: checkpoint 2 missing"]);
      expect(f.pause).not.toHaveBeenCalled();
      fx.files.set("checkpoints/2.json", own); // the poster overwrites it
      expect(await f.v.tick()).toBe("ok");
    }
  });

  it("a file that does not parse", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 2);
    fx.files.set("checkpoints/2.json", "{not json");
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toMatch(/checkpoint 2 mismatch: bad checkpoint file/);
  });

  it("a Settled event with a root that is not the one this verifier verified", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 2);
    f.events.push({ throughMinute: 1, root: `0x${"de".repeat(32)}`, block: 1005n });
    f.clock.block = 1010n;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toMatch(/checkpoint 1 mismatch: Settled\(1\) root 0xdede.* differs from the root this verifier verified/);
  });

  it("(a) a verified minute's file overwritten with a re-signed bad root plus a matching Settled event is a mismatch", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 2);
    const bad = `0x${"ab".repeat(32)}` as const;
    await tamper(fx, 1, (x) => void (x.root = bad));
    f.events.push({ throughMinute: 1, root: bad, block: 1005n });
    f.clock.block = 1010n;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toMatch(/checkpoint 1 mismatch: Settled\(1\)/);
  });

  it("(b) a Settled event ahead of the verifier is remembered: the file overwritten with the good root later is a mismatch when that minute is verified", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    expect(await f.v.tick()).toBe("ok"); // minute 0
    const good2 = fx.files.get("checkpoints/2.json")!;
    const bad = `0x${"ab".repeat(32)}` as const;
    await tamper(fx, 2, (x) => void (x.root = bad));
    f.events.push({ throughMinute: 2, root: bad, block: 1005n });
    f.clock.block = 1010n;
    expect(await f.v.tick()).toBe("ok"); // minute 1; the event for minute 2 matches the file as published now
    fx.files.set("checkpoints/2.json", good2);
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toMatch(/checkpoint 2 mismatch: .*Settled/);
  });

  it("(b) the remembered Settled event survives a restart", async () => {
    const fx = await posterRun();
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const f = verifier(fx, { dir });
    await f.v.tick();
    const good2 = fx.files.get("checkpoints/2.json")!;
    const bad = `0x${"ab".repeat(32)}` as const;
    await tamper(fx, 2, (x) => void (x.root = bad));
    f.events.push({ throughMinute: 2, root: bad, block: 1005n });
    f.clock.block = 1010n;
    expect(await f.v.tick()).toBe("ok");
    fx.files.set("checkpoints/2.json", good2);
    const g = verifier(fx, { dir, block: 1010n, tracker: ChainTracker.fromJSON(savedVerifierTracker(f.store)!, f.reader, 1000n) });
    expect(await g.v.tick()).toBe("mismatch");
    expect(g.pause).toHaveBeenCalledTimes(1);
  });

  it("a Settled event ahead of the verifier whose file differs from its root is a mismatch at once", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    f.events.push({ throughMinute: 2, root: `0x${"de".repeat(32)}`, block: 1005n });
    f.clock.block = 1010n;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts[0]).toMatch(/Settled\(2\).*differs from the published/);
  });

  it("a Settled event whose file reads 404 is not a mismatch at first; it is one if the file is still absent 5 minutes of chain time later", async () => {
    const fx = await posterRun({ minutes: 2 });
    const f = verifier(fx);
    await ticks(f.v, 2);
    f.events.push({ throughMinute: 7, root: `0x${"de".repeat(32)}`, block: 1005n });
    f.clock.block = 1010n;
    const t0 = f.clock.time;
    expect(await f.v.tick()).toBe("waiting");
    f.clock.time = t0 + 299;
    expect(await f.v.tick()).toBe("waiting");
    expect(f.pause).not.toHaveBeenCalled();
    f.clock.time = t0 + 300;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts.some((a) => /Settled\(7\).*no published checkpoint/.test(a))).toBe(true);
  });

  it("a Settled event ahead whose file is another deployment's leftover is treated like an absent file (5 minutes of chain time)", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await tamper(fx, 2, (x) => void (x.contract = A));
    f.events.push({ throughMinute: 2, root: `0x${"de".repeat(32)}`, block: 1005n });
    f.clock.block = 1010n;
    const t0 = f.clock.time;
    expect(await f.v.tick()).toBe("ok"); // minute 0
    f.clock.time = t0 + 299;
    expect(await f.v.tick()).toBe("ok"); // minute 1
    expect(f.pause).not.toHaveBeenCalled();
    f.clock.time = t0 + 300;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts.some((a) => /Settled\(2\).*no published checkpoint/.test(a))).toBe(true);
  });

  it("a withheld checkpoint M while a bad M+1 is settled is a mismatch after 5 minutes of chain time", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    expect(await f.v.tick()).toBe("ok"); // minute 0
    const bad = `0x${"ab".repeat(32)}` as const;
    await tamper(fx, 2, (x) => void (x.root = bad));
    f.events.push({ throughMinute: 2, root: bad, block: 1005n });
    f.clock.block = 1010n;
    fx.files.delete("checkpoints/1.json");
    const t0 = f.clock.time;
    expect(await f.v.tick()).toBe("waiting");
    f.clock.time = t0 + 299;
    expect(await f.v.tick()).toBe("waiting");
    expect(f.pause).not.toHaveBeenCalled();
    f.clock.time = t0 + 300;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts.some((a) => /checkpoint 1 mismatch: checkpoint 1 withheld while 2 settled/.test(a))).toBe(true);
  });

  it("a missing checkpoint with nothing settled ahead stays waiting however long it lasts", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await f.v.tick();
    fx.files.delete("checkpoints/1.json");
    const t0 = f.clock.time;
    for (const dt of [0, 400, 4000, 40000]) {
      f.clock.time = t0 + dt;
      expect(await f.v.tick()).toBe("waiting");
    }
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("a fresh verifier catching up on many Settled events reads each pending file once for the check, not on every tick", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    const reads = new Map<string, number>();
    const real = f.deps.read;
    f.deps.read = async (p) => (reads.set(p, (reads.get(p) ?? 0) + 1), real(p));
    const v = new Verifier(f.deps);
    for (const m of [1, 2, 3]) f.events.push({ throughMinute: m, root: parseCheckpointFile(fx.files.get(`checkpoints/${m}.json`)!).root, block: 1000n + BigInt(m) });
    f.clock.block = 1010n;
    expect(await ticks(v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    // one read by the pending check, one by the verification of that minute
    for (const m of [1, 2, 3]) expect(reads.get(`checkpoints/${m}.json`)).toBe(2);
  });

  it("a pending file that matched its event and is overwritten later still fails at verification (the replay is authoritative)", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    const good = fx.files.get("checkpoints/1.json")!;
    const bad = `0x${"ab".repeat(32)}` as const;
    await tamper(fx, 1, (x) => void (x.root = bad));
    f.events.push({ throughMinute: 1, root: bad, block: 1005n });
    f.clock.block = 1010n;
    f.clock.time += 0;
    // the event ahead (minute 1) is checked at minute 0's tick and matches the file as published then
    expect(await f.v.tick()).toBe("ok");
    fx.files.set("checkpoints/1.json", good);
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts[0]).toMatch(/Settled\(1\) root 0xabab.* differs from the replayed root/);
  });

  it("a Settled event whose file appears within the 5 minutes is fine", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    const text = fx.files.get("checkpoints/3.json")!;
    fx.files.delete("checkpoints/3.json");
    f.events.push({ throughMinute: 3, root: parseCheckpointFile(text).root, block: 1005n });
    f.clock.block = 1010n;
    const t0 = f.clock.time;
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "ok"]);
    f.clock.time = t0 + 200;
    fx.files.set("checkpoints/3.json", text);
    expect(await f.v.tick()).toBe("ok");
    f.clock.time = t0 + 4000;
    expect(await f.v.tick()).toBe("waiting");
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("events are read once: a good pass moves the cursor past the latest block", async () => {
    const fx = await posterRun({ minutes: 2 });
    const f = verifier(fx);
    const ranges: [bigint, bigint][] = [];
    f.deps.events = async (a, b) => {
      ranges.push([a, b]);
      return [];
    };
    await ticks(f.v, 3);
    // the upper bound lags the latest block by 3 (a lagging getLogs must not make it skip events); later ticks have nothing new
    expect(ranges).toEqual([[DEPLOY_BLOCK, 997n]]);
    f.clock.block = 1010n;
    await f.v.tick();
    expect(ranges.at(-1)).toEqual([998n, 1007n]);
  });

  it("the first chain read starts at the deploy block", async () => {
    const fx = await posterRun({ minutes: 1 });
    const claimedRanges: [bigint, bigint][] = [];
    const tracker = new ChainTracker({ claimedLogs: async (a, b) => (claimedRanges.push([a, b]), []), burnLogs: async () => [] }, 1000n);
    const f = verifier(fx, { tracker });
    await f.v.tick();
    expect(claimedRanges).toEqual([[DEPLOY_BLOCK, 100n]]);
  });
});

describe("Verifier.tick: the registry is read in full before a wallet is called unregistered", () => {
  const C: Addr = "0x00000000000000000000000000000000000000c3";
  /** A registry spy: `behind` is what an incremental list knows; a full read (`list(true)`) learns `all`, as R2Registry keeps what it read. */
  const registry = (behind: Registration[], all: Registration[]) => {
    let known = behind;
    return vi.fn(async (full?: boolean) => {
      if (full) known = all;
      return known;
    });
  };
  const fullReads = (list: ReturnType<typeof registry>) => list.mock.calls.filter(([full]) => full === true).length;

  it("a wallet that only the full read knows (found first by the poster's hourly read) passes with no mismatch, and the full read happens once", async () => {
    const fx = await posterRun();
    const list = registry([{ user: B, registeredAt: 1 }], fx.regs); // behind: it does not know A
    const f = verifier(fx, { registry: { list } });
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.alerts).toEqual([]);
    expect(fullReads(list)).toBe(1); // minute 0 learned A; the ticks after found it in the ordinary list
    expect(list.mock.calls[0]).toEqual([]);
    expect(list.mock.calls[1]).toEqual([true]);
  });

  it("the fresher list is the one the rest of the tick uses (the row's registration time counts from it)", async () => {
    // A is known only from the full read, registered after the end of minute 2: the finding comes from that fresh record
    const fx = await posterRun();
    const list = registry([], [{ user: A, registeredAt: L + 60 * 3 + 1 }]);
    const f = verifier(fx, { registry: { list } });
    const r = await f.v.tick();
    expect(r).toBe("mismatch");
    expect(f.alerts.some((a) => /registered at \d+, after the end of the minute/.test(a))).toBe(true);
    expect(f.alerts.some((a) => /not registered/.test(a))).toBe(false);
  });

  it("a wallet still unknown after the full read is still a mismatch and a pause, and the registry is read in full once for the tick", async () => {
    const fx = await posterRun();
    const list = registry(fx.regs, fx.regs); // neither knows B or C
    const f = verifier(fx, { registry: { list } });
    expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
    expect(fullReads(list)).toBe(0);
    list.mockClear();
    await tamper(fx, 2, (file) => void (file.table += `\n2,${B},${FEE}\n2,${C},${FEE}`));
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    const alert = f.alerts.find((a) => a.startsWith("verifier: checkpoint 2 mismatch:"))!;
    expect(alert).toContain(`${B} is not registered`);
    expect(alert).toContain(`${C} is not registered`);
    expect(list.mock.calls).toEqual([[], [true]]);
    expect(f.v.nextMinute).toBe(2);
  });

  it("an ordinary run never asks for a full read", async () => {
    const fx = await posterRun();
    const list = registry(fx.regs, fx.regs);
    const f = verifier(fx, { registry: { list } });
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(await f.v.tick()).toBe("waiting");
    expect(list.mock.calls.length).toBeGreaterThan(0);
    expect(fullReads(list)).toBe(0);
    expect(list.mock.calls.every((c) => c.length === 0)).toBe(true);
  });

  it("a wallet that is known, registered after the minute's end, is a mismatch without a full read (a record never changes)", async () => {
    const fx = await posterRun();
    const list = registry([...fx.regs, { user: B, registeredAt: L + 60 * 3 + 1 }], fx.regs);
    const f = verifier(fx, { registry: { list } });
    expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
    await tamper(fx, 2, (file) => void (file.table += `\n2,${B},${FEE}`));
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts.some((a) => /after the end of the minute/.test(a))).toBe(true);
    expect(fullReads(list)).toBe(0);
  });

  it("a table that cannot be parsed fails as before: a mismatch on the table, with no full read", async () => {
    const fx = await posterRun();
    const list = registry(fx.regs, fx.regs);
    const f = verifier(fx, { registry: { list } });
    expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
    list.mockClear();
    await tamper(fx, 2, (file) => void (file.table += `\n2,${A},${FEE}`)); // the same user twice: parseTableCsv refuses it
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts.some((a) => a.startsWith("verifier: checkpoint 2 mismatch:") && /table/.test(a))).toBe(true);
    expect(list.mock.calls).toEqual([[]]);
  });

  it("a full read that fails is an error with backoff, not a finding: no pause, no stored mismatch, the minute is tried again", async () => {
    const fx = await posterRun();
    let down = true;
    const list = vi.fn(async (full?: boolean) => {
      if (full && down) throw new Error("R2 list registry/998/: HTTP 503");
      return full ? fx.regs : [];
    });
    const f = verifier(fx, { registry: { list } });
    expect(await f.v.cycle()).toBe(5);
    expect(await f.v.cycle()).toBe(10); // the backoff grows
    expect(fullReads(list)).toBe(2); // asked again each time, the unregistered wallet never reported
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.alerts).toEqual(["verifier error: R2 list registry/998/: HTTP 503"]); // once an hour per text
    expect(f.v.nextMinute).toBe(0);
    expect(stateOf(f).mismatch ?? null).toBeNull();
    down = false;
    expect(await f.v.cycle()).toBe(0);
    expect(f.v.nextMinute).toBe(1);
    expect(f.pause).not.toHaveBeenCalled();
    expect(stateOf(f).mismatch ?? null).toBeNull();
  });

  it("an empty minute (no rows) asks for no full read", async () => {
    const fx = await posterRun({ regs: [], fills: {} });
    const list = registry([], []);
    const f = verifier(fx, { registry: { list } });
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(fullReads(list)).toBe(0);
  });
});

describe("Verifier.tick: a mismatch is final", () => {
  it("pauses once, stays 'mismatch', and re-alerts only once an hour of chain time", async () => {
    const fx = await posterRun();
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const f = verifier(fx, { dir });
    await f.v.tick();
    await tamper(fx, 1, (x) => void (x.root = `0x${"ab".repeat(32)}`));
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts).toHaveLength(2); // the mismatch and the pause
    expect(f.alerts[1]).toMatch(/paused Checkpoints/);
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts).toHaveLength(3); // the stored-mismatch reminder
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts).toHaveLength(3);
    f.clock.time += 3600;
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts).toHaveLength(4);
    expect(f.alerts[3]).toMatch(/checkpoint 1 mismatch is still unresolved/);
    expect(f.pause).toHaveBeenCalledTimes(1);
    // even a repaired file does nothing: a human decides
    fx.files.set("checkpoints/1.json", fx.files.get("checkpoints/1.json")!);
    expect(f.v.nextMinute).toBe(1);

    // and it survives a restart
    const g = verifier(fx, { dir });
    expect(await g.v.tick()).toBe("mismatch");
    expect(g.pause).not.toHaveBeenCalled();
    expect(g.alerts).toHaveLength(1);
  });

  it("a pause that fails is alerted, and the mismatch still stands", async () => {
    const fx = await posterRun({ minutes: 1 });
    await tamper(fx, 0, (x) => void (x.root = `0x${"ab".repeat(32)}`));
    const f = verifier(fx);
    f.pause.mockRejectedValue(new Error("not the guardian"));
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts.some((a) => a.includes("could not pause Checkpoints: not the guardian"))).toBe(true);
  });

  it("mainnet mode (pause null) only alerts", async () => {
    const fx = await posterRun({ minutes: 1 });
    await tamper(fx, 0, (x) => void (x.root = `0x${"ab".repeat(32)}`));
    const f = verifier(fx, { pause: null });
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]).toMatch(/^verifier: checkpoint 0 mismatch:/);
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("a failing alert channel does not stop the pause", async () => {
    const fx = await posterRun({ minutes: 1 });
    await tamper(fx, 0, (x) => void (x.root = `0x${"ab".repeat(32)}`));
    const f = verifier(fx, { alert: async () => { throw new Error("webhook down"); } });
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
  });
});

describe("recovery: former posters, cancelled minutes, guardian actions", () => {
  it("a file signed by a former poster is accepted (content is still replayed)", async () => {
    const fx = await posterRun({ minutes: 2 });
    const f = verifier(fx);
    // fx.account signed minute 0 and is a former poster now; the current poster re-signs minute 1
    const current = privateKeyToAccount(generatePrivateKey());
    f.posters.add(current.address.toLowerCase());
    await tamper(fx, 1, () => {}, current);
    expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
    expect(f.alerts).toEqual([]);
    // the content is still replayed: a former poster's bad root is a mismatch
    await tamper(fx, 0, (x) => void (x.root = `0x${"ab".repeat(32)}`));
    const g = verifier(fx);
    g.posters.add(current.address.toLowerCase());
    expect(await g.v.tick()).toBe("mismatch");
    expect(g.alerts[0]).toMatch(/^verifier: checkpoint 0 mismatch: root:/);
  });

  it("a file signed by a key that was never the poster is a mismatch naming the signer", async () => {
    const fx = await posterRun({ minutes: 1 });
    const stranger = privateKeyToAccount(generatePrivateKey());
    await tamper(fx, 0, () => {}, stranger);
    const f = verifier(fx);
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts[0]).toContain(`signed by ${stranger.address}, never a poster of this contract`);
  });

  it("a Settled event for a cancelled minute is ignored, and a pending one is dropped once cancelled", async () => {
    const bad = `0x${"de".repeat(32)}` as const;
    const fx = await posterRun();
    const f = verifier(fx);
    expect(await f.v.tick()).toBe("ok"); // minute 0
    // 1. Settled(1) with a root that is not the published one, in a cancelled range: not a mismatch
    f.cancelledRanges.push({ from: 1, to: 1 });
    f.events.push({ throughMinute: 1, root: bad, block: 1005n });
    f.clock.block = 1010n;
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "waiting"]);
    // 2. Settled(7), never published, is pending; once cancelled it is dropped (no "no published checkpoint", no "withheld")
    f.events.push({ throughMinute: 7, root: bad, block: 1012n });
    f.clock.block = 1020n;
    expect(await f.v.tick()).toBe("waiting");
    f.cancelledRanges.push({ from: 2, to: 7 });
    f.clock.time += 300;
    expect(await f.v.tick()).toBe("waiting");
    f.clock.time += 3600;
    expect(await f.v.tick()).toBe("waiting");
    expect(f.alerts).toEqual(["poster: checkpoint 4 missing"]); // the fixture published minutes 0..3 only
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.store.readJson<{ pending: object }>("verifier-state", { pending: { x: 1 } }).pending).toEqual({});

    // control: the same Settled(1) without the cancel is a mismatch
    const fx2 = await posterRun();
    const g = verifier(fx2);
    expect(await g.v.tick()).toBe("ok");
    g.events.push({ throughMinute: 1, root: bad, block: 1005n });
    g.clock.block = 1010n;
    expect(await g.v.tick()).toBe("mismatch");
    expect(g.alerts[0]).toMatch(/Settled\(1\).*differs from the published/);
  });

  it("guardian actions are announced; the first event of each role (the constructor's) only records it", async () => {
    const fx = await posterRun({ minutes: 1 });
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const f = verifier(fx, { dir });
    const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Addr;
    // the constructor's events land after the deployments file's deployBlock (the block at script start)
    f.extraEvents.push(
      { kind: "posterSet", address: addr(1), block: DEPLOY_BLOCK + 2n },
      { kind: "guardianSet", address: addr(2), block: DEPLOY_BLOCK + 2n },
      { kind: "pauserSet", address: addr(3), block: DEPLOY_BLOCK + 2n },
    );
    expect(await f.v.tick()).toBe("ok");
    expect(f.alerts).toEqual([]);
    f.extraEvents.push(
      { kind: "pausedSet", paused: true, block: 1001n },
      { kind: "cancelled", from: 3, to: 5, block: 1002n },
      { kind: "writtenOff", amount: 7n * 10n ** 18n, total: 125n * 10n ** 17n, block: 1003n },
      { kind: "posterSet", address: addr(4), block: 1004n },
      { kind: "pauserSet", address: addr(3), block: 1005n }, // the same pauser again: nothing new
      { kind: "pauserSet", address: addr(5), block: 1006n },
      { kind: "guardianSet", address: addr(6), block: 1007n },
      { kind: "pausedSet", paused: false, block: 1008n },
      // a second pause and unpause within the hour: each event's text names its block, so neither is deduplicated away
      { kind: "pausedSet", paused: true, block: 1009n },
      { kind: "pausedSet", paused: false, block: 1010n },
    );
    f.clock.block = 1020n;
    expect(await f.v.tick()).toBe("waiting");
    expect(f.alerts).toEqual([
      "checkpoints: paused (block 1001)",
      "checkpoints: cancelled minutes 3..5 (block 1002)",
      "checkpoints: wrote off 7.00 HLO (total 12.50 HLO) (block 1003)",
      `checkpoints: poster set to ${addr(4)} (block 1004)`,
      `checkpoints: pauser set to ${addr(5)} (block 1006)`,
      `checkpoints: guardian set to ${addr(6)} (block 1007)`,
      "checkpoints: unpaused (block 1008)",
      "checkpoints: paused (block 1009)",
      "checkpoints: unpaused (block 1010)",
    ]);
    expect(await f.v.tick()).toBe("waiting"); // events are read once
    expect(f.alerts).toHaveLength(9);

    // the roles survive a restart: the next poster change is news, not a first sighting
    const g = verifier(fx, { dir, block: 1020n, tracker: ChainTracker.fromJSON(savedVerifierTracker(f.store)!, f.reader, 1000n) });
    g.extraEvents.push({ kind: "posterSet", address: addr(7), block: 1021n });
    g.clock.block = 1030n;
    expect(await g.v.tick()).toBe("waiting");
    expect(g.alerts).toEqual([`checkpoints: poster set to ${addr(7)} (block 1021)`]);
  });

  it("a state file saved before the roles record reads as no roles known", async () => {
    const fx = await posterRun({ minutes: 2 });
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const f = verifier(fx, { dir });
    expect(await f.v.tick()).toBe("ok");
    const { roles: _roles, ...older } = f.store.readJson<Record<string, unknown>>("verifier-state", {});
    f.store.writeJson("verifier-state", older);
    const g = verifier(fx, { dir, tracker: ChainTracker.fromJSON(savedVerifierTracker(f.store)!, f.reader, 1000n) });
    g.extraEvents.push({ kind: "posterSet", address: B, block: 1001n });
    g.clock.block = 1010n;
    expect(await g.v.tick()).toBe("ok");
    expect(g.alerts).toEqual([]); // the first poster seen is recorded, not announced
  });

  it("on a mismatch the verifier pauses through deps.pause on every chain", async () => {
    const fx = await posterRun({ minutes: 1, chainId: 999 });
    fx.fills[A] = []; // the API no longer shows minute 0's fill: the table's fee is above it
    const f = verifier(fx, { chainId: 999 });
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.alerts[0]).toMatch(/^verifier: checkpoint 0 mismatch: fee of/);
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts).toContain("verifier: paused Checkpoints because of the checkpoint 0 mismatch");
  });
});

describe("minutes nobody trades (spec 2026-11-04)", () => {
  it("the poster and verifier both apply the chain's quiet-minute rule: on anvil a minute with no fee adds only 0.1 HLO", async () => {
    // anvil: odds 1 (every minute pops), no minimum, quiet minutes from launch. A trades in minute 0 only.
    const fx = await posterRun({ minutes: 4, chainId: 31337, fills: { [A]: [good(1, (L + 5) * 1000)] } });
    const latest = JSON.parse(fx.files.get("latest.json")!);
    // m0: A 1 HLO, vault 0.1, pops: A 0.09, 0.01 stays. m1..m3: +0.1 each, popping with no points: 0.31 (the launch rule: 3.31).
    expect(latest.vault.amount).toBe((31n * 10n ** 16n).toString());
    const f = verifier(fx, { chainId: 31337 });
    expect(await f.v.tick()).toBe("ok");
    expect(f.alerts).toEqual([]);
    expect(f.pause).not.toHaveBeenCalled();
  });
});

describe("Verifier.tick: a missing file", () => {
  it("waits quietly for 5 minutes past the minute's end, then alerts once for that minute", async () => {
    const fx = await posterRun({ minutes: 2 });
    fx.files.delete("checkpoints/0.json");
    const end0 = L + 60;
    const f = verifier(fx, { time: end0 + 299 });
    expect(await f.v.tick()).toBe("waiting");
    expect(f.alerts).toEqual([]);
    f.clock.time = end0 + 300;
    expect(await f.v.tick()).toBe("waiting");
    expect(f.alerts).toEqual(["poster: checkpoint 0 missing"]);
    f.clock.time = end0 + 4000; // past the hourly dedupe too
    expect(await f.v.tick()).toBe("waiting");
    expect(f.alerts).toHaveLength(1);
    expect(f.pause).not.toHaveBeenCalled();
    // when it appears, the verifier goes on
    fx.files.set("checkpoints/0.json", (await posterRun({ minutes: 1 })).files.get("checkpoints/0.json")!);
    expect(await f.v.tick()).toBe("mismatch"); // another poster's file: not signed by this poster
  });

  it("alerts again for the next minute that is missing", async () => {
    const fx = await posterRun({ minutes: 2 });
    fx.files.delete("checkpoints/1.json");
    const f = verifier(fx, { time: L + 120 + 400 });
    expect(await ticks(f.v, 2)).toEqual(["ok", "waiting"]);
    expect(f.alerts).toEqual(["poster: checkpoint 1 missing"]);
  });
});

describe("Verifier.cycle", () => {
  it("sleeps 0 after ok, 5 s after waiting, 60 s after a mismatch; an error backs off and alerts once", async () => {
    const fx = await posterRun({ minutes: 1 });
    const f = verifier(fx);
    expect(await f.v.cycle()).toBe(0);
    expect(await f.v.cycle()).toBe(5);
    let down = true;
    const real = f.deps.now;
    const g = verifier(fx, { now: async () => { if (down) throw new Error("rpc down"); return real(); } });
    expect(await g.v.cycle()).toBe(5);
    expect(await g.v.cycle()).toBe(10);
    expect(g.alerts).toEqual(["verifier error: rpc down"]);
    down = false;
    expect(await g.v.cycle()).toBe(0);
    await tamper(fx, 0, (x) => void (x.root = `0x${"ab".repeat(32)}`));
    const h = verifier(fx);
    expect(await h.v.cycle()).toBe(60);
  });
});

// ---------------------------------------------------------------- the daily check

const csvTime = (sec: number) => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
const HEADER = "time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee";
const csvRow = (sec: number, user: string, fee: string, coin = "BTC") => `${csvTime(sec)},${user},${coin},B,100,10,true,,Ioc,false,0xcc,0,,${fee}`;
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n") + "\n";

describe("parseBuilderFile", () => {
  it("reads columns by header name", () => {
    const [r] = parseBuilderFile(csv(csvRow(L, A.toUpperCase().replace("0X", "0x"), "1")));
    expect(r).toMatchObject({ time: L * 1000, user: A, coin: "BTC", px: "100", sz: "10", builderFee: "1" });
  });
  it("throws on a missing column or a ragged line", () => {
    expect(() => parseBuilderFile("time,user\n1,2")).toThrow("missing column");
    expect(() => parseBuilderFile(`${HEADER}\na,b`)).toThrow("fields");
  });
});

describe("makeDailyCheck", () => {
  // The launch is 150 s before UTC midnight, so minute 0 and 1 are in day D0 and minute 2 straddles the midnight.
  const D0 = dayOf(L);
  const launch = (D0 + 1) * 86400 - 150;
  const day = dayOf(launch);

  async function run(file: string | null, o: { userB?: boolean } = {}) {
    const regs: Registration[] = [{ user: A, registeredAt: 1 }, ...(o.userB ? [{ user: B, registeredAt: 1 }] : [])];
    const at = (m: number, sec = 5) => (launch + m * 60 + sec) * 1000;
    const fills: Record<string, ApiFill[]> = { [A]: [good(1, at(0)), good(2, at(1))], ...(o.userB ? { [B]: [good(3, at(0, 6))] } : {}) };
    const fx = await posterRun({ launch, minutes: 3, regs, fills });
    const dailyDeps = (store: Store) => makeDailyCheck({ store, registry: { list: async () => regs }, launchTime: launch, file: async () => file });
    const f = verifier(fx, { time: (day + 1) * 86400 + 2 * 3600 });
    f.deps.dailyCheck = dailyDeps(f.store);
    return { fx, f, dailyDeps };
  }

  it("reports exactly the wallet that is off by one unit", async () => {
    const A_ROWS = [csvRow(launch + 5, A, "1"), csvRow(launch + 65, A, "1")];
    const { f } = await run(csv(...A_ROWS, csvRow(launch + 6, B, "1.00000001")), { userB: true });
    // B's API fee is 1 USDC; the file says 1 USDC + 1 unit (inside the 0.000002 tolerance, so it counts)
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "ok"]);
    expect(f.alerts).toEqual([`verifier: daily check day ${day}: ${B}: builder file 100000001, API 100000000 (1e-8 USDC)`]);
  });

  it("is quiet when the file agrees; ignores unregistered wallets, spot fills and fills outside the day", async () => {
    const { f } = await run(csv(
      csvRow(launch + 5, A, "1"), csvRow(launch + 65, A, "1"),
      csvRow(launch + 6, B, "5"), // B is not registered
      csvRow(launch + 7, A, "1", "@107"), // spot: not counted
    ));
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "ok"]);
    expect(f.alerts).toEqual([]);
  });

  it("a wallet the poster left out shows up as a difference", async () => {
    // B is registered and the file shows a fill of B that no table row accounts for
    const { fx, f } = await run(csv(csvRow(launch + 5, A, "1")), { userB: true });
    // the poster's files never mention B, so the verifier's own sums have nothing for B; the check is run directly
    const check = makeDailyCheck({ store: f.store, registry: { list: async () => fx.regs }, launchTime: launch, file: async () => csv(csvRow(launch + 6, B, "1")) });
    expect(await check(day)).toEqual([`${B}: builder file 100000000, API 0 (1e-8 USDC)`]);
  });

  it("a fill before the wallet registered is not a difference", async () => {
    const regs: Registration[] = [{ user: A, registeredAt: launch + 30 }];
    const fx = await posterRun({ launch, minutes: 1, regs, fills: { [A]: [good(1, (launch + 5) * 1000), good(2, (launch + 40) * 1000)] } });
    const f = verifier(fx, { time: (day + 1) * 86400 + 2 * 3600 });
    f.deps.dailyCheck = makeDailyCheck({ store: f.store, registry: { list: async () => regs }, launchTime: launch, file: async () => csv(csvRow(launch + 5, A, "1"), csvRow(launch + 40, A, "1")) });
    await f.v.tick();
    expect(f.alerts).toEqual([]);
  });

  it("a missing file is an alert, not a difference, and is retried", async () => {
    const { fx, f } = await run(null);
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "ok"]);
    expect(f.alerts.at(-1)).toMatch(new RegExp(`daily check for day ${day} failed: .*not available`));
    expect(f.v.nextMinute).toBe(3);
    expect(fx).toBeTruthy();
  });
});

describe("Verifier daily scheduling", () => {
  const D0 = dayOf(L);
  const launch = (D0 + 1) * 86400 - 150; // minutes 0 and 1 are in D0; minute 2 straddles midnight

  async function scheduled(time: number) {
    const fx = await posterRun({ launch, minutes: 4 });
    const dailyCheck = vi.fn(async (_day: number) => ["lonely difference"]);
    const f = verifier(fx, { time, dailyCheck });
    return { f, dailyCheck, D0: dayOf(launch) };
  }

  it("waits for FILE_DELAY_HOURS past the day's end", async () => {
    const { f, dailyCheck, D0 } = await scheduled((dayOf(launch) + 1) * 86400 + 2 * 3600 - 1);
    await ticks(f.v, 4);
    expect(dailyCheck).not.toHaveBeenCalled();
    f.clock.time += 1;
    await f.v.tick(); // waiting for minute 4, but the day check runs
    expect(dailyCheck.mock.calls).toEqual([[D0]]);
  });

  it("waits until the minute that straddles midnight is verified, then runs once per day", async () => {
    const { f, dailyCheck, D0 } = await scheduled((dayOf(launch) + 1) * 86400 + 2 * 3600);
    await ticks(f.v, 2); // minutes 0, 1 verified; minute 2 (straddling midnight) is not
    expect(dailyCheck).not.toHaveBeenCalled();
    await f.v.tick(); // minute 2 verified
    expect(dailyCheck.mock.calls).toEqual([[D0]]);
    const daily = () => f.alerts.filter((a) => a.startsWith("verifier: daily"));
    expect(daily()).toEqual([`verifier: daily check day ${D0}: lonely difference`]);
    await ticks(f.v, 3);
    expect(dailyCheck).toHaveBeenCalledTimes(1);
    expect(daily()).toHaveLength(1);
    // and a restart does not repeat it
    const g = verifier({ ...({} as Fixture), launch, files: new Map(), account: privateKeyToAccount(generatePrivateKey()), regs: [], fills: {}, claimLogs: [] }, {
      dir: f.store.dir, time: (D0 + 1) * 86400 + 2 * 3600, dailyCheck,
    });
    await g.v.tick();
    expect(dailyCheck).toHaveBeenCalledTimes(1);
  });

  it("while the builder file is missing the fetch is retried at most every 10 minutes of chain time", async () => {
    const fx = await posterRun({ launch, minutes: 4 });
    const dailyCheck = vi.fn(async (_day: number) => {
      throw new Error("not available");
    });
    const t0 = (dayOf(launch) + 1) * 86400 + 2 * 3600;
    const f = verifier(fx, { time: t0, dailyCheck });
    await ticks(f.v, 4);
    expect(dailyCheck).toHaveBeenCalledTimes(1);
    f.clock.time = t0 + 599;
    await f.v.tick();
    expect(dailyCheck).toHaveBeenCalledTimes(1);
    f.clock.time = t0 + 600;
    await f.v.tick();
    expect(dailyCheck).toHaveBeenCalledTimes(2);
    expect(f.alerts.filter((a) => a.startsWith("verifier: daily check for day")).length).toBe(1); // same text, hourly dedupe
  });

  it("never runs without a dailyCheck (testnet)", async () => {
    const fx = await posterRun({ launch, minutes: 4 });
    const f = verifier(fx, { time: (dayOf(launch) + 5) * 86400 });
    expect(await ticks(f.v, 4)).toEqual(["ok", "ok", "ok", "ok"]);
  });
});

describe("hourly omission check", () => {
  const at = (m: number, sec = 5) => (L + m * 60 + sec) * 1000;

  /** The poster knows only A; B is registered (for the verifier) and has fills in minutes 5 and 6 that the tables lack. */
  async function omitted(o: { pause?: null } = {}) {
    const fills: Record<string, ApiFill[]> = {
      [A]: Array.from({ length: 61 }, (_, m) => good(m + 1, at(m))),
      [B]: [good(1000, at(5, 6)), good(1001, at(6, 6)), good(1002, at(70, 6))],
    };
    const fx = await posterRun({ minutes: 61, regs: [{ user: A, registeredAt: 1 }], fills });
    fx.regs = [{ user: A, registeredAt: 1 }, { user: B, registeredAt: 1 }];
    const f = verifier(fx, o);
    return { fx, f };
  }

  it("alerts the wallet whose fees in the last verified hour are missing from the tables; never pauses", async () => {
    const { f } = await omitted();
    const results = await ticks(f.v, 60);
    expect(new Set(results)).toEqual(new Set(["ok"]));
    expect(f.alerts).toEqual([`verifier: wallet ${B} fees in minutes 5..6 differ from the published tables`]);
    expect(f.pause).not.toHaveBeenCalled();
    // one call for the hour for this wallet, over exactly the hour
    expect(f.fillCalls.filter((c) => c[0] === B)).toEqual([[B, L * 1000, (L + 3600) * 1000 - 1]]);
    // and not again for the next ticks
    await f.v.tick();
    expect(f.fillCalls.filter((c) => c[0] === B)).toHaveLength(1);
    expect(f.alerts).toHaveLength(1);
  });

  it("works the same on mainnet (pause null)", async () => {
    const { f } = await omitted({ pause: null });
    await ticks(f.v, 60);
    expect(f.alerts).toHaveLength(1);
  });

  it("is quiet when every registered wallet's fills are in the tables", async () => {
    const fx = await posterRun({ minutes: 61 });
    const f = verifier(fx);
    await ticks(f.v, 60);
    expect(f.alerts).toEqual([]);
    expect(hourReads(f)).toEqual([A]); // A's one hourly call
  });

  it("does not run before the hour is verified", async () => {
    const { f } = await omitted();
    await ticks(f.v, 59);
    expect(f.fillCalls.filter((c) => c[0] === B)).toEqual([]);
  });
});

describe("state housekeeping", () => {
  it("without a dailyCheck (testnet) no API sums are kept", async () => {
    const fx = await posterRun();
    const f = verifier(fx);
    await ticks(f.v, 4);
    expect(f.store.readJson<{ sums: unknown }>("verifier-state", { sums: null }).sums).toEqual({});
  });

  it("alerts once when more than a day of verified roots is waiting for a Settled event; the roots stay", async () => {
    const fx = await posterRun();
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const first = verifier(fx, { dir });
    await first.v.tick();
    const saved = first.store.readJson<{ verifiedRoots: Record<string, string> }>("verifier-state", { verifiedRoots: {} });
    for (let i = 0; i < 1439; i++) saved.verifiedRoots[String(100_000 + i)] = `0x${"11".repeat(32)}`;
    first.store.writeJson("verifier-state", saved); // 1 real + 1439 = 1440: at the cap, no alert yet
    const g = verifier(fx, { dir, tracker: ChainTracker.fromJSON(savedVerifierTracker(first.store)!, first.reader, 1000n) });
    expect(await g.v.tick()).toBe("ok"); // minute 1 makes 1441
    expect(g.alerts).toEqual(["verifier: nothing has been settled for a day (1441 verified checkpoints are waiting for a Settled event)"]);
    expect(await g.v.tick()).toBe("ok");
    expect(g.alerts).toHaveLength(1);
    expect(Object.keys(g.store.readJson<{ verifiedRoots: object }>("verifier-state", { verifiedRoots: {} }).verifiedRoots).length).toBeGreaterThan(1440);
  });

  it("alerts when the omission check had to skip hours", async () => {
    const fills: Record<string, ApiFill[]> = { [A]: Array.from({ length: 121 }, (_, m) => good(m + 1, (L + m * 60 + 5) * 1000)) };
    const fx = await posterRun({ minutes: 121, fills, blockStep: 1n });
    fx.regs = [{ user: A, registeredAt: 1 }, { user: B, registeredAt: 1 }];
    let down = true;
    const f = verifier(fx);
    const real = f.deps.fills;
    f.deps.fills = async (u, a, b) => {
      if (down && u === B) throw new Error("hl down");
      return real(u, a, b);
    };
    const v = new Verifier(f.deps);
    await ticks(v, 60); // minutes 0..59: hour 0 is tried and fails
    expect(f.alerts).toEqual(["verifier: omission check for minutes 0..59 failed: hl down"]);
    down = false;
    await ticks(v, 59); // minutes 60..118: hour 0 is still inside its 10-minute retry pause
    f.clock.time += 600;
    await v.tick(); // minute 119 verified: hour 1 is complete, hour 0 was never done
    expect(f.alerts).toContain("verifier: omission check skipped minutes 0..59 (read 0 of 2 wallets of the first hour)");
    expect(f.alerts).toHaveLength(2);
  });
});

describe("checkVerifierKeys", () => {
  const key = privateKeyToAccount(generatePrivateKey()).address;
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const never = async (): Promise<`0x${string}`> => {
    throw new Error("pauser() must not be read");
  };
  it("passes for the on-chain pauser, whatever the address case", async () => {
    await expect(checkVerifierKeys({ chainId: 999, guardianKey: false, pauser: key, readPauser: async () => key.toLowerCase() as typeof key })).resolves.toBeUndefined();
  });
  it("refuses a PAUSER_KEY that is not Checkpoints.pauser(), naming both addresses", async () => {
    const p = checkVerifierKeys({ chainId: 998, guardianKey: false, pauser: key, readPauser: async () => other });
    await expect(p).rejects.toThrow(`PAUSER_KEY is not Checkpoints.pauser() (key ${key}, on chain ${other})`);
  });
  it("refuses a pauser key when the contract has no pauser", async () => {
    const zero = "0x0000000000000000000000000000000000000000" as const;
    await expect(checkVerifierKeys({ chainId: 998, guardianKey: false, pauser: key, readPauser: async () => zero })).rejects.toThrow("PAUSER_KEY is not Checkpoints.pauser()");
  });
  it("chain 999 needs PAUSER_KEY; other chains may run without it", async () => {
    await expect(checkVerifierKeys({ chainId: 999, guardianKey: false, pauser: null, readPauser: never })).rejects.toThrow("PAUSER_KEY is required on chain 999");
    await expect(checkVerifierKeys({ chainId: 998, guardianKey: false, pauser: null, readPauser: never })).resolves.toBeUndefined();
  });
  it("refuses GUARDIAN_KEY first, on every chain", async () => {
    for (const chainId of [999, 998, 31337]) {
      await expect(checkVerifierKeys({ chainId, guardianKey: true, pauser: key, readPauser: never })).rejects.toThrow(
        "GUARDIAN_KEY is set for the verifier: it holds the pauser key (PAUSER_KEY), never the guardian's",
      );
    }
  });
});

// ------------------------------------------------------------------ Plan 11: one read per wallet, omission in slices, builder total

const endSec = (m: number) => L + 60 * (m + 1);
const stateOf = (f: { store: Store }) => f.store.readJson<Record<string, any>>("verifier-state", {});
const omissionNext = (f: { store: Store }) => stateOf(f).omissionNext as number;
const HOUR_START_MS = L * 1000;
const HOUR_END_MS = (L + 3600) * 1000 - 1;
/** The wallets read over the whole first hour, in order (a row check never spans an hour). */
const hourReads = (f: { fillCalls: [string, number, number][] }) => f.fillCalls.filter((c) => c[1] === HOUR_START_MS && c[2] === HOUR_END_MS).map((c) => c[0]);
/** Verifies minutes from..to, the chain clock 20 s past each minute's end (so the verifier is never behind). */
async function through(f: { v: Verifier; clock: { time: number } }, from: number, to: number) {
  for (let m = from; m <= to; m++) {
    f.clock.time = endSec(m) + 20;
    expect(await f.v.tick()).toBe("ok");
  }
}

describe("Verifier.tick: one read per wallet", () => {
  const at = (m: number, sec = 5) => (L + m * 60 + sec) * 1000;
  /** Three minutes of chain time and the grace past launch: minutes 0..2 are finished. */
  const behind = { time: L + 3 * 60 + GRACE };

  it("3 minutes behind, one wallet trading in all 3: 3 ticks make one fills call for the wallet, through the newest finished minute", async () => {
    const fx = await posterRun({ minutes: 3 });
    const f = verifier(fx, behind);
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "ok"]);
    expect(f.fillCalls).toEqual([[A, L * 1000, (L + 180) * 1000 - 1]]);
  });

  it("a cached shortfall is read again fresh: a fill indexed since agrees, so the tick is ok, with no pause and no alert", async () => {
    const fx = await posterRun({ minutes: 3 });
    const [late] = fx.fills[A].splice(1, 1); // minute 1's fill is not indexed yet when the first read is made
    expect(late.time).toBe(at(1));
    const f = verifier(fx, behind);
    expect(await f.v.tick()).toBe("ok"); // minute 0: the one read, through minute 2
    fx.fills[A].splice(1, 0, late); // indexed since
    expect(await ticks(f.v, 2)).toEqual(["ok", "ok"]);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.alerts).toEqual([]);
    expect(f.fillCalls).toEqual([
      [A, L * 1000, (L + 180) * 1000 - 1],
      [A, (L + 60) * 1000, (L + 120) * 1000 - 1], // minute 1's own range, read now
    ]);
  });

  it("a shortfall that the fresh read also shows is a mismatch and pauses", async () => {
    const fx = await posterRun({ minutes: 3 });
    fx.fills[A].splice(1, 1); // never indexed
    const f = verifier(fx, behind);
    expect(await f.v.tick()).toBe("ok");
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toBe(`verifier: checkpoint 1 mismatch: fee of ${A}: table ${FEE}, API 0`);
    expect(f.fillCalls).toEqual([
      [A, L * 1000, (L + 180) * 1000 - 1],
      [A, (L + 60) * 1000, (L + 120) * 1000 - 1],
    ]);
  });

  it("a first read (nothing cached) that falls short is a mismatch at once, with no second read for that row", async () => {
    const fx = await posterRun({ minutes: 3 });
    fx.fills[A].splice(0, 1);
    const f = verifier(fx, behind);
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toBe(`verifier: checkpoint 0 mismatch: fee of ${A}: table ${FEE}, API 0`);
    expect(f.fillCalls).toHaveLength(1);
  });

  it("a row below the cached sum still alerts 'is below the API' and goes on, with no second read and no pause", async () => {
    const fx = await posterRun({ minutes: 3 });
    fx.fills[A].push(good(99, at(1, 30)));
    const f = verifier(fx, behind);
    expect(await ticks(f.v, 3)).toEqual(["ok", "ok", "ok"]);
    expect(f.pause).not.toHaveBeenCalled();
    expect(f.alerts).toEqual([`verifier: checkpoint 1: fee of ${A} is below the API (table ${FEE}, API ${2n * FEE}); alert only, a fill indexed after the grace`]);
    expect(f.fillCalls).toHaveLength(1);
  });

  it("drops what is older than the minute being checked, on every tick", async () => {
    const drop = vi.spyOn(FillCache.prototype, "dropBefore");
    try {
      const fx = await posterRun({ minutes: 3 });
      const f = verifier(fx, behind);
      await ticks(f.v, 3);
      expect(drop.mock.calls).toEqual([[L * 1000], [(L + 60) * 1000], [(L + 120) * 1000]]);
    } finally {
      drop.mockRestore();
    }
  });

  it("the first row that falls short fails the minute at once: a table padded with fee rows costs no read after it", async () => {
    const P: Addr = "0x0000000000000000000000000000000000000001"; // sorts first
    const rest = [1, 2, 3, 4, 5].map(wallet);
    const fx = await posterRun({ minutes: 1 });
    fx.regs = [reg(P), reg(A), ...rest.map(reg)];
    await tamper(fx, 0, (f) => {
      f.table = tableCsv([{ minute: 0, user: P, fee: 1n }, { minute: 0, user: A, fee: FEE }, ...rest.map((user) => ({ minute: 0, user, fee: FEE }))]);
    });
    const f = verifier(fx);
    expect(await f.v.tick()).toBe("mismatch");
    expect(f.fillCalls).toEqual([[P, L * 1000, (L + 240) * 1000 - 1]]); // one read: the padded row's, and none for the 6 rows after it
    expect(f.pause).toHaveBeenCalledTimes(1);
    expect(f.alerts[0]).toBe(`verifier: checkpoint 0 mismatch: fee of ${P}: table 1, API 0`);
  });

  describe.each([
    ["a first read", 1],
    ["a fresh read", 2],
  ] as const)("%s that throws", (_what, failCall) => {
    it("is an error for cycle()'s backoff: no mismatch and no pause, and the minute is retried", async () => {
      const fx = await posterRun({ minutes: 3 });
      const [late] = fx.fills[A].splice(1, 1); // minute 1's fill is not in the first read
      const f = verifier(fx, behind);
      const real = f.deps.fills;
      let calls = 0;
      f.deps.fills = async (u, s, e) => {
        if (++calls === failCall) throw new Error("hl down");
        return real(u, s, e);
      };
      const v = new Verifier(f.deps);
      if (failCall === 2) {
        expect(await v.cycle()).toBe(0); // minute 0 is fine
        fx.fills[A].splice(1, 0, late); // indexed since
      }
      expect(await v.cycle()).toBe(5); // backoff
      expect(f.alerts).toEqual(["verifier error: hl down"]);
      expect(f.pause).not.toHaveBeenCalled();
      expect(v.nextMinute).toBe(failCall - 1);
      expect(await v.cycle()).toBe(0); // the retry works
      expect(f.pause).not.toHaveBeenCalled();
      expect(stateOf(f).mismatch).toBeNull();
    });
  });

  it("a fill that appears after the wallet's cached read raises no row alert; the hour's omission check reports it", async () => {
    const fx = await posterRun({ minutes: 61 });
    const f = verifier(fx, { time: L + 61 * 60 + GRACE }); // minutes 0..60 are finished: the first read serves them all
    expect(await f.v.tick()).toBe("ok");
    fx.fills[A].push(good(500, (L + 10 * 60 + 30) * 1000)); // minute 10, indexed after that read
    expect(await ticks(f.v, 60)).toEqual(Array(60).fill("ok"));
    expect(f.alerts).toEqual([`verifier: wallet ${A} fees in minutes 10..10 differ from the published tables`]);
    expect(f.pause).not.toHaveBeenCalled();
  });

  describe("the daily check's sums", () => {
    const day = String(dayOf(L));
    const sumOf = (f: { store: Store }) => (stateOf(f).sums as Record<string, Record<string, string>>)[day]?.[A];

    it("count the fills of the cached read that was used", async () => {
      const fx = await posterRun({ minutes: 3 });
      fx.fills[A].push(good(99, at(1, 30))); // the API shows 2 fees in minute 1; the table has 1
      const f = verifier(fx, { ...behind, dailyCheck: async () => [] });
      await ticks(f.v, 3);
      expect(sumOf(f)).toBe((4n * FEE).toString());
    });

    it("count the fresh read when a cached shortfall was read again, not the stale one", async () => {
      const fx = await posterRun({ minutes: 3 });
      const [late] = fx.fills[A].splice(1, 1);
      const f = verifier(fx, { ...behind, dailyCheck: async () => [] });
      await f.v.tick();
      fx.fills[A].splice(1, 0, late);
      await ticks(f.v, 2);
      expect(sumOf(f)).toBe((3n * FEE).toString());
    });
  });
});

// ---- the hourly omission check

const C: Addr = "0x00000000000000000000000000000000000000c3";
const wallet = (i: number): Addr => `0x${(i + 0x100).toString(16).padStart(40, "0")}`;
const reg = (user: Addr): Registration => ({ user, registeredAt: 1 });

/**
 * A feed that answers from `state`, read at each call (change it between ticks). Keep the pairs the real class can give:
 * a gap with `delivered` false is a feed that died; no gap with `delivered` false is one waiting for a message or a `meta`
 * read. `askedInStep` says, per `uncovered` call, whether it came in the same synchronous step as the `deliveredPast` before it.
 */
function fakeFeed(s: Partial<{ users: string[]; uncovered: number; delivered: boolean }> = {}) {
  const state = { users: [] as string[], uncovered: 0, delivered: true, ...s };
  const askedInStep: boolean[] = [];
  let step = false;
  const feed = {
    usersSince: vi.fn((_ms: number) => state.users),
    prune: vi.fn((_ms: number) => {}),
    uncovered: vi.fn((_from: number, _to: number) => {
      askedInStep.push(step);
      return state.uncovered;
    }),
    deliveredPast: vi.fn((_ms: number) => {
      step = true;
      queueMicrotask(() => void (step = false)); // runs at the first await after this call
      return state.delivered;
    }),
    setCovered: vi.fn((_ms: number) => {}),
    takeLate: vi.fn((): string[] => []),
    lateTrades: 0,
  } satisfies ActiveWallets;
  return { feed, state, askedInStep };
}

describe("hourly omission check: which wallets, from the verifier's own feed", () => {
  const at = (m: number, sec = 5) => (L + m * 60 + sec) * 1000;

  /** The poster knows only A. B (registered) has fills in minutes 5 and 6 that the tables lack; C is registered and did nothing. */
  async function world(o: { minutes?: number } = {}) {
    const minutes = o.minutes ?? 61;
    const fills: Record<string, ApiFill[]> = {
      [A]: Array.from({ length: minutes }, (_, m) => good(m + 1, at(m))),
      [B]: [good(1000, at(5, 6)), good(1001, at(6, 6))],
    };
    const fx = await posterRun({ minutes, regs: [reg(A)], fills });
    fx.regs = [reg(A), reg(B), reg(C)];
    return fx;
  }
  const bAlert = `verifier: wallet ${B} fees in minutes 5..6 differ from the published tables`;

  it("watched all hour: reads the wallets the feed saw plus the hour's table wallets, not a registered wallet that did neither", async () => {
    const fx = await world();
    const { feed } = fakeFeed({ users: [B] });
    const f = verifier(fx, { feed });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, A]); // A from the tables, B from the feed
    expect(f.alerts).toEqual([bAlert]);
    expect(feed.usersSince).toHaveBeenCalledWith(HOUR_START_MS);
    expect(feed.deliveredPast).toHaveBeenCalledWith(HOUR_END_MS);
    expect(feed.uncovered).toHaveBeenCalledWith(HOUR_START_MS, HOUR_END_MS);
    expect(feed.prune.mock.calls).toEqual([[HOUR_END_MS - 3_600_000]]);
    expect(omissionNext(f)).toBe(1);
    await f.v.tick();
    expect(hourReads(f)).toEqual([B, A]); // and not again
  });

  it("a gap in the hour, registered wallets at most OMISSION_FULL_MAX: every registered wallet", async () => {
    const fx = await world();
    const { feed } = fakeFeed({ users: [], uncovered: 1_000 });
    const f = verifier(fx, { feed });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, C, A]);
    expect(f.alerts).toEqual([bAlert]);
  });

  it("a feed that died (a gap, nothing delivered) does not wait: every registered wallet at once", async () => {
    const fx = await world();
    const { feed } = fakeFeed({ uncovered: 3_600_000, delivered: false });
    const f = verifier(fx, { feed });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, C, A]);
    expect(omissionNext(f)).toBe(1);
  });

  it.each([true, false])("a gap and more registered wallets than OMISSION_FULL_MAX (delivered %s): one alert that the hour rests on the daily check, and the feed's and the tables' wallets are still read", async (delivered) => {
    const fx = await world();
    const { feed } = fakeFeed({ users: [B], uncovered: 1_000, delivered });
    const f = verifier(fx, { feed, omissionFullMax: 2 });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, A]);
    expect(f.alerts).toEqual([
      "verifier: the trade feed was not watching for part of minutes 0..59 and there are 3 wallets: that hour rests on the daily check",
      bAlert,
    ]);
    await f.v.tick();
    expect(f.alerts).toHaveLength(2);
  });

  it("at exactly OMISSION_FULL_MAX registered wallets a gap still reads every one", async () => {
    const fx = await world();
    const { feed } = fakeFeed({ uncovered: 1_000 });
    const f = verifier(fx, { feed, omissionFullMax: 3 });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, C, A]);
    expect(f.alerts).toEqual([bAlert]);
  });

  it("without a feed: every registered wallet, as before", async () => {
    const fx = await world();
    const f = verifier(fx, { feed: null });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, C, A]);
    expect(f.alerts).toEqual([bAlert]);
  });

  it("a wallet registered after the hour ended is not read, whatever the feed says", async () => {
    const fx = await world();
    fx.regs.push({ user: wallet(7), registeredAt: L + 3601 });
    const { feed } = fakeFeed({ users: [B, wallet(7)] });
    const f = verifier(fx, { feed });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, A]);
  });

  describe("waiting for the feed to deliver the hour", () => {
    it("with no gap and the hour not delivered yet, the check waits: no list, nothing marked done, asked again on each tick", async () => {
      const fx = await world();
      const { feed, state, askedInStep } = fakeFeed({ users: [B], delivered: false });
      const f = verifier(fx, { feed });
      expect(new Set(await ticks(f.v, 60))).toEqual(new Set(["ok"]));
      expect(hourReads(f)).toEqual([]);
      expect(omissionNext(f)).toBe(0);
      expect(feed.usersSince).not.toHaveBeenCalled();
      expect(feed.prune).not.toHaveBeenCalled();
      const asked = feed.deliveredPast.mock.calls.length;
      expect(await f.v.tick()).toBe("ok"); // verification goes on while the check waits
      expect(await f.v.tick()).toBe("waiting");
      expect(feed.deliveredPast.mock.calls.length).toBe(asked + 2);
      expect(hourReads(f)).toEqual([]);
      state.delivered = true;
      await f.v.tick();
      expect(hourReads(f)).toEqual([B, A]);
      expect(omissionNext(f)).toBe(1);
      expect(f.alerts).toEqual([bAlert]);
      // the gap is asked in the same synchronous step as the delivery, on every ask (4 ticks wanted the hour)
      expect(askedInStep).toEqual([true, true, true, true]);
    });

    it("is not silent: once the wait has lasted over 2 minutes of chain time it alerts once, and keeps waiting", async () => {
      const fx = await world();
      const { feed, state } = fakeFeed({ users: [B], delivered: false });
      const f = verifier(fx, { feed });
      await ticks(f.v, 60);
      const t0 = f.clock.time;
      f.clock.time = t0 + 120;
      await f.v.tick();
      expect(f.alerts).toEqual([]);
      f.clock.time = t0 + 121;
      await f.v.tick();
      const waitAlert = "verifier: the omission check for minutes 0..59 has waited over 2 minutes for the trade feed to deliver that hour; it goes on waiting";
      expect(f.alerts).toEqual([waitAlert]);
      f.clock.time = t0 + 900;
      await f.v.tick();
      expect(f.alerts).toEqual([waitAlert]); // once
      expect(omissionNext(f)).toBe(0);
      expect(hourReads(f)).toEqual([]);
      state.delivered = true;
      await f.v.tick();
      expect(hourReads(f)).toEqual([B, A]);
      expect(omissionNext(f)).toBe(1);
      expect(f.alerts).toEqual([waitAlert, bAlert]);
    });

    it("a wait that ends in a gap goes on at once with the wider list", async () => {
      const fx = await world();
      const { feed, state } = fakeFeed({ users: [B], delivered: false });
      const f = verifier(fx, { feed });
      await ticks(f.v, 60);
      expect(hourReads(f)).toEqual([]);
      state.uncovered = 5_000; // a coin found by the read that is being waited for cuts the coverage back
      await f.v.tick();
      expect(hourReads(f)).toEqual([B, C, A]);
    });
  });
});

describe("hourly omission check: slices", () => {
  const at = (m: number, sec = 5) => (L + m * 60 + sec) * 1000;
  const others = Array.from({ length: 24 }, (_, i) => wallet(i));

  /** 25 registered wallets (A and 24 more), the third of which (others[1]) has a fill in minute 5 that the tables lack. */
  async function crowd(minutes = 63) {
    const fills: Record<string, ApiFill[]> = {
      [A]: Array.from({ length: minutes }, (_, m) => good(m + 1, at(m))),
      [others[1]]: [good(1000, at(5, 6))],
    };
    const fx = await posterRun({ minutes, regs: [reg(A)], fills, blockStep: 1n });
    fx.regs = [reg(A), ...others.map(reg)];
    return fx;
  }
  const diff = `verifier: wallet ${others[1]} fees in minutes 5..5 differ from the published tables`;

  it("one tick reads at most 10 wallets; the hour completes on the third tick, which alerts the difference once", async () => {
    const fx = await crowd();
    const f = verifier(fx);
    await ticks(f.v, 59);
    expect(hourReads(f)).toEqual([]);
    await f.v.tick(); // minute 59: the hour is complete, the first slice
    expect(hourReads(f)).toHaveLength(10);
    expect(omissionNext(f)).toBe(0);
    expect(f.alerts).toEqual([]);
    await f.v.tick();
    expect(hourReads(f)).toHaveLength(20);
    expect(omissionNext(f)).toBe(0);
    expect(f.alerts).toEqual([]); // the wallet with the difference was in the first slice: held until the end
    await f.v.tick();
    expect(hourReads(f)).toEqual([...others, A]); // the wallets in no table first
    expect(omissionNext(f)).toBe(1);
    expect(f.alerts).toEqual([diff]);
    await ticks(f.v, 2);
    expect(hourReads(f)).toHaveLength(25);
    expect(f.alerts).toEqual([diff]);
  });

  it("the registry and the feed are asked once for the hour, not once per slice", async () => {
    const fx = await crowd();
    const list = vi.fn(async () => fx.regs);
    const { feed } = fakeFeed({ users: others });
    const f = verifier(fx, { feed, registry: { list } });
    await ticks(f.v, 59);
    const before = list.mock.calls.length; // one listing per verified minute
    await ticks(f.v, 3);
    expect(feed.usersSince).toHaveBeenCalledTimes(1);
    expect(list.mock.calls.length).toBe(before + 4); // the three row checks' own listings; the hour added one, not three
  });

  it("a failure in a later slice alerts 'failed', waits RETRY_SECONDS of chain time, and then goes on from the wallet that failed: every wallet is read once", async () => {
    const fx = await crowd();
    const f = verifier(fx);
    const real = f.deps.fills;
    let down = true;
    f.deps.fills = async (u, s, e) => {
      if (down && u === others[12]) {
        down = false;
        throw new Error("hl down");
      }
      return real(u, s, e);
    };
    const v = new Verifier(f.deps);
    await ticks(v, 60); // slice 1
    expect(hourReads(f)).toHaveLength(10);
    await v.tick(); // slice 2: others[10] and others[11] are read, others[12] fails
    const failed = "verifier: omission check for minutes 0..59 failed: hl down";
    expect(f.alerts).toEqual([failed]);
    expect(hourReads(f)).toHaveLength(12);
    expect(omissionNext(f)).toBe(0);
    await v.tick(); // inside the retry pause
    expect(hourReads(f)).toHaveLength(12);
    f.clock.time += 599;
    await v.tick();
    expect(hourReads(f)).toHaveLength(12);
    f.clock.time += 1;
    await v.tick(); // goes on at others[12]
    expect(hourReads(f)).toHaveLength(22);
    await v.tick();
    expect(omissionNext(f)).toBe(1);
    expect(hourReads(f)).toEqual([...others, A]); // each wallet once, the failed one only when it was read
    expect(f.alerts).toEqual([failed, diff]);
  });

  it("a pass in progress, a long replay, then idle: the dropped pass reports what it found and how far it got, and nothing is compared against pruned rows", async () => {
    const fx = await crowd(126);
    const f = verifier(fx);
    await ticks(f.v, 60); // hour 0: the first slice (10 wallets) finds the difference
    expect(hourReads(f)).toHaveLength(10);
    f.clock.time = L + 1_000_000; // the verifier is hours behind: the next minute is always due
    expect(await ticks(f.v, 66)).toEqual(Array(66).fill("ok")); // minutes 60..125: hour 0's rows are pruned on the way
    expect(hourReads(f)).toHaveLength(10); // no slice ran
    expect(f.alerts.filter((a) => !a.includes("is below"))).toEqual([]);
    expect(await f.v.tick()).toBe("waiting"); // idle: minute 126 is not there yet
    const omission = () => f.alerts.filter((a) => a.includes("omission") || a.includes("differ"));
    expect(omission()).toEqual([diff, "verifier: omission check skipped minutes 0..59 (read 10 of 25 wallets of the first hour)"]);
    await ticks(f.v, 2); // hour 1 goes on, from the start of its own list
    expect(omissionNext(f)).toBe(2);
    expect(omission()).toHaveLength(2); // hour 1 has no difference, and no false one from hour 0's missing rows
  });
});

describe("a dropped pass is forgotten", () => {
  it("a pass dropped while the next hour waits for its feed is not reported again when a later hour drops", async () => {
    const others = Array.from({ length: 24 }, (_, i) => wallet(i));
    const at = (m: number, sec = 5) => (L + m * 60 + sec) * 1000;
    const fills: Record<string, ApiFill[]> = { [A]: Array.from({ length: 190 }, (_, m) => good(m + 1, at(m))), [others[1]]: [good(1000, at(5, 6))] };
    const fx = await posterRun({ minutes: 190, regs: [reg(A)], fills, blockStep: 1n });
    fx.regs = [reg(A), ...others.map(reg)];
    const { feed, state } = fakeFeed({ uncovered: 1_000 }); // a gap: hour 0 reads every registered wallet
    const f = verifier(fx, { feed });
    await ticks(f.v, 60); // hour 0: the first slice
    state.uncovered = 0;
    state.delivered = false; // from here every hour waits for its feed
    f.clock.time = L + 1_000_000; // replaying: the next minute is always due
    await ticks(f.v, 65); // minutes 60..124
    f.clock.time = endSec(125) + 20; // caught up
    await f.v.tick(); // hour 1 is current: hour 0 drops, hour 1 waits
    const omission = () => f.alerts.filter((a) => a.includes("omission") || a.includes("differ"));
    const diff = `verifier: wallet ${others[1]} fees in minutes 5..5 differ from the published tables`;
    expect(omission()).toEqual([diff, "verifier: omission check skipped minutes 0..59 (read 10 of 25 wallets of the first hour)"]);
    f.clock.time = L + 1_000_000;
    await ticks(f.v, 59); // minutes 126..184
    f.clock.time = endSec(185) + 20; // caught up again, an hour after the first drop (the alerts' hourly deduplication has let go)
    await f.v.tick();
    expect(omission()).toEqual([diff, "verifier: omission check skipped minutes 0..59 (read 10 of 25 wallets of the first hour)", "verifier: omission check skipped minutes 60..119"]);
  });
});

describe("the omission check yields to the row checks", () => {
  /** A's fill every minute, 61 files; the replay clock is hours ahead, so the next minute is always due. */
  const replayClock = { time: L + 1_000_000 };
  const omissionAlerts = (f: { alerts: string[] }) => f.alerts.filter((a) => a.includes("omission") || a.includes("differ"));

  it("while the next minute is due no slice runs after a verified minute; an idle tick, with nothing to verify, runs it", async () => {
    const fx = await posterRun({ minutes: 61 });
    const f = verifier(fx, replayClock);
    expect(await ticks(f.v, 61)).toEqual(Array(61).fill("ok"));
    expect(hourReads(f)).toEqual([]);
    expect(omissionNext(f)).toBe(0);
    expect(await f.v.tick()).toBe("waiting"); // minute 61 is not there: the verifier is idle, not behind
    expect(hourReads(f)).toEqual([A]);
    expect(omissionNext(f)).toBe(1);
  });

  it.each([
    ["a slow row read makes the next minute due: it is read afresh, so the slice waits", 100, []],
    ["the chain time is exactly the end of the next minute plus the grace: due", 70, []],
    ["one second short of that: not due, the slice runs", 69, [A]],
    ["no slow read: the slice runs", null, [A]],
  ] as const)("%s", async (_what, slowTo, reads) => {
    const fx = await posterRun({ minutes: 60 });
    const f = verifier(fx);
    await through(f, 0, 58);
    const real = f.deps.fills;
    f.deps.fills = async (u, s, e) => {
      if (slowTo !== null) f.clock.time = endSec(59) + slowTo; // the read takes a while; minute 60 is due at its end + the grace, +70
      return real(u, s, e);
    };
    const v = new Verifier(f.deps);
    f.clock.time = endSec(59) + 20; // at the start of the tick it is not due
    expect(await v.tick()).toBe("ok");
    expect(hourReads(f)).toEqual(reads);
  });

  it("a replay of 3 hours reads nothing for the omission check and sends one skip alert when it catches up", async () => {
    const fx = await posterRun({ minutes: 183, blockStep: 1n });
    const f = verifier(fx, replayClock);
    expect(await ticks(f.v, 182)).toEqual(Array(182).fill("ok")); // minutes 0..181, all due
    expect(f.fillCalls.filter((c) => c[2] - c[1] === 3_600_000 - 1)).toEqual([]); // no whole-hour read
    expect(omissionAlerts(f)).toEqual([]);
    f.clock.time = endSec(182) + 20; // minute 183 is not due yet: caught up
    expect(await f.v.tick()).toBe("ok");
    expect(omissionAlerts(f)).toEqual(["verifier: omission check skipped minutes 0..119"]);
    expect(omissionNext(f)).toBe(3);
    // and it did hour 2 only: one read of A over the whole hour
    expect(f.fillCalls.filter((c) => c[2] - c[1] === 3_600_000 - 1).map((c) => c[1])).toEqual([(L + 7200) * 1000]);
  });

  it("a verifier that is current pays no extra chain read for the omission check on an ordinary minute", async () => {
    const fx = await posterRun({ minutes: 10 });
    const f = verifier(fx);
    const now = vi.spyOn(f.deps, "now");
    await through(f, 0, 9);
    // tick(): 1 read of now() each; nothing else: no pass could run in the first hour
    expect(now).toHaveBeenCalledTimes(10);
  });
});

// ---- the omission check with the real TradeFeed: the coverage and delivery gate

/** A WebSocket the test drives by hand. */
class Sock implements FeedSocket {
  isOpen = false;
  closed = false;
  onopen: FeedSocket["onopen"] = null;
  onmessage: FeedSocket["onmessage"] = null;
  onclose: FeedSocket["onclose"] = null;
  onerror: FeedSocket["onerror"] = null;
  send(_s: string) {
    if (!this.isOpen) throw new Error("not open");
  }
  close() {
    this.isOpen = false;
    this.closed = true;
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

describe("hourly omission check with the real TradeFeed (fake socket, fake clock)", () => {
  const at = (m: number, sec = 5) => (L + m * 60 + sec) * 1000;
  const feeds: TradeFeed[] = [];
  afterEach(() => {
    for (const f of feeds.splice(0)) f.stop();
    vi.useRealTimers();
  });

  /** The poster knew only A; B (minutes 5, 6) and C (minute 15) have fills the tables lack. Fake timers start 30 s before launch, and the wall clock stands for chain time. */
  async function world() {
    const fills: Record<string, ApiFill[]> = {
      [A]: Array.from({ length: 61 }, (_, m) => good(m + 1, at(m))),
      [B]: [good(1000, at(5, 6)), good(1001, at(6, 6))],
      [C]: [good(2000, at(15, 6))],
    };
    const fx = await posterRun({ minutes: 61, regs: [reg(A)], fills });
    fx.regs = [reg(A), reg(B), reg(C)];
    const sockets: Sock[] = [];
    const feed = new TradeFeed({
      url: "wss://hl.test/ws",
      coins: async () => ["BTC"],
      connect: () => {
        const s = new Sock();
        sockets.push(s);
        return s;
      },
      log: () => {},
    });
    feeds.push(feed);
    const ack = (s: Sock) => s.msg({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "trades", coin: "BTC" } } });
    const w = {
      fx, feed, sockets,
      /** Starts the feed, opens its socket and acknowledges the coin. */
      async start() {
        vi.useFakeTimers();
        vi.setSystemTime((L - 30) * 1000);
        feed.start();
        await vi.advanceTimersByTimeAsync(0);
        sockets[0].open();
        ack(sockets[0]);
      },
      /** `ms` of life in 5 s steps, a pong on the newest socket whenever the wall clock is on a multiple of 15 s; none while `silent`. */
      async live(ms: number, silent = false) {
        for (let left = ms; left > 0; left -= 5_000) {
          await vi.advanceTimersByTimeAsync(5_000);
          const s = sockets[sockets.length - 1];
          if (!silent && s.isOpen && Math.floor(Date.now() / 1000) % 15 === 0) s.msg({ channel: "pong" });
        }
      },
      /** The net is back: the next socket the feed makes is opened and acknowledged. */
      async reconnect() {
        for (let tries = 0; tries < 20; tries++) {
          const s = sockets[sockets.length - 1];
          if (!s.isOpen && !s.closed) {
            s.open();
            ack(s);
            return;
          }
          await w.live(5_000, true);
        }
        throw new Error("the feed never made a socket");
      },
    };
    return w;
  }

  it("a feed that watched the whole hour waits until it has delivered it, then reads the wallets it saw and the tables' (not C)", async () => {
    const w = await world();
    await w.start();
    await w.live(130_000);
    w.sockets[0].msg({ channel: "trades", data: [{ coin: "BTC", time: Date.now(), users: [B, wallet(99)] }] });
    await w.live(3_630_000 - 130_000); // the wall clock is at the end of the hour: nothing is heard past it yet
    expect(Date.now()).toBe((L + 3600) * 1000);
    const f = verifier(w.fx, { feed: w.feed });
    await ticks(f.v, 60);
    expect(w.feed.uncovered(HOUR_START_MS, HOUR_END_MS)).toBe(0);
    expect(hourReads(f)).toEqual([]);
    expect(omissionNext(f)).toBe(0);
    await w.live(15_000); // a message heard past the hour's end + 5 s
    await f.v.tick(); // asks for the `meta` read that has to start after the hour's end
    await vi.advanceTimersByTimeAsync(0);
    await f.v.tick();
    expect(hourReads(f)).toEqual([B, A]);
    expect(f.alerts).toEqual([`verifier: wallet ${B} fees in minutes 5..6 differ from the published tables`]);
    expect(omissionNext(f)).toBe(1);
  });

  it("a feed that was never live shows the whole hour as a gap: it does not wait, and every registered wallet is read", async () => {
    const { fx, feed } = await world(); // never started: nothing watched, nothing delivered
    const f = verifier(fx, { feed });
    await ticks(f.v, 60);
    expect(feed.deliveredPast(HOUR_END_MS)).toBe(false);
    expect(hourReads(f)).toEqual([B, C, A]);
    expect(omissionNext(f)).toBe(1);
  });

  it("an outage in the middle of the hour shows in the hour's window although the feed is live again and its last minute was fully watched", async () => {
    const w = await world();
    await w.start();
    await w.live(630_000); // wall clock at L + 600 s
    await w.live(1_200_000, true); // the connection is dead for 20 minutes: no pong, nothing at all
    await w.reconnect();
    await w.live((L + 3615) * 1000 - Date.now()); // on to the hour's end + 15 s
    expect(Date.now()).toBe((L + 3615) * 1000);
    // the minute windows the poster measures show nothing: the last minute of the hour was watched in full
    expect(w.feed.uncovered(HOUR_END_MS - 59_999, HOUR_END_MS)).toBe(0);
    // the whole hour does
    expect(w.feed.uncovered(HOUR_START_MS, HOUR_END_MS)).toBeGreaterThan(1_000_000);
    const f = verifier(w.fx, { feed: w.feed });
    await ticks(f.v, 60);
    expect(hourReads(f)).toEqual([B, C, A]); // C only traded inside the outage: nothing but a full read finds it
    expect(f.alerts).toEqual([
      `verifier: wallet ${B} fees in minutes 5..6 differ from the published tables`,
      `verifier: wallet ${C} fees in minutes 15..15 differ from the published tables`,
    ]);
    expect(omissionNext(f)).toBe(1);
  });

  it("an hour that is skipped prunes the feed to the start of the hour that replaces it: a wallet that traded in the new hour stays, one that traded before it goes", async () => {
    const fx = await posterRun({ minutes: 121, blockStep: 1n });
    const sockets: Sock[] = [];
    const feed = new TradeFeed({ url: "wss://hl.test/ws", coins: async () => ["BTC"], connect: () => (sockets[sockets.length] = new Sock()), log: () => {} });
    feeds.push(feed);
    feed.start();
    await new Promise((r) => setTimeout(r, 0));
    sockets[0].open();
    sockets[0].msg({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "trades", coin: "BTC" } } });
    const [before, during] = [wallet(50), wallet(51)];
    const hour1 = (L + 3600) * 1000;
    sockets[0].msg({ channel: "trades", data: [{ coin: "BTC", time: hour1 - 2, users: [before, wallet(52)] }, { coin: "BTC", time: hour1, users: [during, wallet(53)] }] });
    expect(feed.usersSince(0).sort()).toEqual([before, wallet(52), during, wallet(53)].sort());
    const f = verifier(fx, { feed, time: L + 1_000_000 }); // hours behind: hour 0 is never checked
    await ticks(f.v, 119);
    expect(feed.usersSince(0)).toHaveLength(4); // nothing pruned while replaying
    f.clock.time = endSec(119) + 20; // caught up: hour 0 is skipped, hour 1 is the one to check
    expect(await f.v.tick()).toBe("ok");
    expect(f.alerts).toContain("verifier: omission check skipped minutes 0..59");
    expect(feed.usersSince(0).sort()).toEqual([during, wallet(53)].sort()); // the wallets of hour 1 stay
  });
});

// ---- the builder total check

describe("hourly builder total check", () => {
  const USDC = 100_000_000n; // one fee of the fixture's wallet A per minute
  /** The fixture counts one USDC a minute: after minute m is verified the tables count (m + 1) USDC. Checks fall at minutes 0 and 60. */
  async function builder(rewards: (bigint | null | Error)[], o: Partial<VerifierDeps> & { dir?: string } = {}) {
    const fx = await posterRun({ minutes: 62 });
    const queue = [...rewards];
    const builderRewards = vi.fn(async () => {
      const r = queue.shift();
      if (r instanceof Error) throw r;
      return r ?? null;
    });
    const f = verifier(fx, { builderRewards, ...o });
    return { fx, f, builderRewards };
  }
  const builderAlerts = (f: { alerts: string[] }) => f.alerts.filter((a) => a.includes("builder"));
  const saved = (f: { store: Store }) => stateOf(f).builderCheck as { at: number; lastD: string; countedTotal: string } | undefined;

  it("the first check only records: no alert, and D = the builder total minus what the tables count", async () => {
    const { f, builderRewards } = await builder([10n * USDC]);
    await through(f, 0, 0);
    expect(f.alerts).toEqual([]);
    expect(builderRewards).toHaveBeenCalledTimes(1);
    expect(saved(f)).toEqual({ at: endSec(0) + 20, lastD: (9n * USDC).toString(), countedTotal: USDC.toString() });
  });

  it("D grew by more than 5 USDC + 5% of the hour's counted fees: alert with the amount, and record the new D", async () => {
    // 60 USDC counted in the hour: tolerance 5 + 3 = 8 USDC
    const { f } = await builder([10n * USDC, (10n + 60n + 10n) * USDC]);
    await through(f, 0, 60);
    expect(builderAlerts(f)).toEqual(["verifier: builder fees not in the tables grew by 10.00 USDC: a wallet was missed, or a wallet that is not registered pays our builder fee"]);
    expect(saved(f)).toEqual({ at: endSec(60) + 20, lastD: (19n * USDC).toString(), countedTotal: (61n * USDC).toString() });
    expect(f.pause).not.toHaveBeenCalled();
  });

  it("D fell by more than the tolerance: alert that the tables count more than Hyperliquid's builder total (D may go negative)", async () => {
    const { f } = await builder([10n * USDC, (10n + 60n - 10n) * USDC]);
    await through(f, 0, 60);
    expect(builderAlerts(f)).toEqual(["verifier: the tables count 10.00 USDC more than Hyperliquid's builder total: a registered wallet may be paying 0.1% to another builder"]);
    expect(saved(f)!.lastD).toBe((-1n * USDC).toString());
  });

  it("a restart between two checks keeps them: the next one compares with the saved D (negative here) and the saved count", async () => {
    const fx = await posterRun({ minutes: 62 });
    const dir = mkdtempSync(join(tmpdir(), "verifier-"));
    const first = verifier(fx, { dir, builderRewards: async () => 0n }); // D = 0 - 1 USDC
    await through(first, 0, 0);
    expect(saved(first)).toEqual({ at: endSec(0) + 20, lastD: (-USDC).toString(), countedTotal: USDC.toString() });
    // 8.02 USDC down: past the tolerance from the saved count (60 USDC since: 5 + 3 = 8 USDC), but not past the 8.05 USDC a
    // lost count would give, and a lost D would make it a first check
    const rewards2 = 60n * USDC - (8n * USDC + 2_000_000n);
    const second = verifier(fx, { dir, builderRewards: async () => rewards2, tracker: ChainTracker.fromJSON(savedVerifierTracker(first.store)!, first.reader, 1000n) });
    expect(second.v.nextMinute).toBe(1);
    await through(second, 1, 60);
    expect(builderAlerts(second)).toEqual(["verifier: the tables count 8.02 USDC more than Hyperliquid's builder total: a registered wallet may be paying 0.1% to another builder"]);
  });

  it("D within the tolerance, up or down, is quiet; the tolerance itself is not an alert, a unit more is", async () => {
    const tol = 5n * USDC + (60n * USDC * 5n) / 100n; // 8 USDC
    for (const [moved, alerts] of [[tol, 0], [-tol, 0], [7n * USDC, 0], [tol + 1n, 1], [-tol - 1n, 1]] as const) {
      const { f } = await builder([10n * USDC, 10n * USDC + 60n * USDC + moved]);
      await through(f, 0, 60);
      expect(builderAlerts(f), `moved ${moved}`).toHaveLength(alerts);
    }
  });

  it("runs at most once per chain hour", async () => {
    const { f, builderRewards } = await builder([10n * USDC, 70n * USDC]);
    await through(f, 0, 59);
    expect(builderRewards).toHaveBeenCalledTimes(1);
    await through(f, 60, 60);
    expect(builderRewards).toHaveBeenCalledTimes(2);
  });

  it("also runs from an idle tick, when the hour falls due between two minutes", async () => {
    const { fx, f, builderRewards } = await builder([10n * USDC, 70n * USDC]);
    await through(f, 0, 59);
    fx.files.delete("checkpoints/60.json"); // the poster is late with minute 60
    f.clock.time = endSec(59) + 80; // an hour after the first check (at minute 0's end + 20 s), 80 s past minute 59's end
    expect(await f.v.tick()).toBe("waiting");
    expect(builderRewards).toHaveBeenCalledTimes(2);
  });

  describe("is skipped", () => {
    it("when the verifier is more than 2 minutes behind", async () => {
      const { f, builderRewards } = await builder([10n * USDC]);
      f.clock.time = endSec(0) + 121;
      expect(await f.v.tick()).toBe("ok");
      expect(builderRewards).not.toHaveBeenCalled();
      const g = await builder([10n * USDC]);
      g.f.clock.time = endSec(0) + 120;
      await g.f.v.tick();
      expect(g.builderRewards).toHaveBeenCalledTimes(1);
    });

    it("when the read throws: logged, no alert, nothing recorded, and not tried again for 10 minutes of chain time", async () => {
      const { f, builderRewards } = await builder([new Error("hl down"), 10n * USDC]);
      await through(f, 0, 0);
      expect(f.logs).toContain("builder total: hl down");
      expect(f.alerts).toEqual([]);
      expect(saved(f)).toBeUndefined();
      await through(f, 1, 9); // the clock is 600 s short of the first try
      expect(builderRewards).toHaveBeenCalledTimes(1);
      await through(f, 10, 10);
      expect(builderRewards).toHaveBeenCalledTimes(2);
      expect(saved(f)!.lastD).toBe((10n * USDC - 11n * USDC).toString());
      expect(f.alerts).toEqual([]);
    });

    it("when the answer has no builder total (null): logged, no alert, nothing recorded", async () => {
      const { f } = await builder([null]);
      await through(f, 0, 0);
      expect(f.logs).toContain("builder total: no readable total in the answer");
      expect(f.alerts).toEqual([]);
      expect(saved(f)).toBeUndefined();
    });

    describe("a total that stays unreadable", () => {
      const unreadable = "verifier: the builder total has not been readable for a day: that check is off until it is";
      /** No wallets, so a day of checkpoints is cheap (and shared by the tests, which only read it): the clock sits 20 s past each minute's end, and a read is tried every 10 minutes. */
      let day: Promise<Fixture> | undefined;
      async function daylong(read: (m: number) => bigint | null) {
        const fx = await (day ??= posterRun({ minutes: 1510, regs: [], fills: {}, blockStep: 1n }));
        let m = 0;
        const f = verifier(fx, { block: 5000n, builderRewards: async () => read(m) });
        // the last minute is settled from the start, so the verified roots are not kept for a day (that state would make every tick slower)
        f.events.push({ throughMinute: 1509, root: parseCheckpointFile(fx.files.get("checkpoints/1509.json")!).root, block: 200n });
        const run = async (to: number) => {
          for (; m <= to; m++) {
            f.clock.time = endSec(m) + 20;
            await f.v.tick();
          }
          m = to + 1;
        };
        return { f, run: (to: number) => run(to) };
      }

      it("is alerted once a day of chain time, counted from the first attempt, and not again every hour", async () => {
        const { f, run } = await daylong(() => null);
        await run(1439); // 86,400 s after the first attempt, less a minute
        expect(f.alerts.filter((a) => a === unreadable)).toEqual([]);
        await run(1440);
        expect(f.alerts.filter((a) => a === unreadable)).toEqual([unreadable]);
        await run(1509); // an hour and more later: the per-hour deduplication has let go, so it is the field that waits for the next day
        expect(f.alerts.filter((a) => a === unreadable)).toEqual([unreadable]);
      });

      it("a read that worked starts the day again", async () => {
        const { f, run } = await daylong((m) => (m === 1430 ? 10n * USDC : null));
        await run(1509); // the failures after the success at minute 1430 are 80 minutes old at most
        expect(f.alerts.filter((a) => a === unreadable)).toEqual([]);
      });
    });

    it("when there is no builderRewards (anvil): nothing is read or kept", async () => {
      const fx = await posterRun({ minutes: 2 });
      const f = verifier(fx, { builderRewards: null });
      await through(f, 0, 1);
      expect(saved(f)).toBeUndefined();
    });
  });

  describe("the saved state", () => {
    it("a state saved without builderCheck loads, and its first check only records", async () => {
      const fx = await posterRun({ minutes: 3 });
      const dir = mkdtempSync(join(tmpdir(), "verifier-"));
      const first = verifier(fx, { dir });
      await through(first, 0, 0);
      expect("builderCheck" in stateOf(first)).toBe(false);
      const builderRewards = vi.fn(async () => 1_000_000n * USDC); // a huge D, but nothing to compare it with yet
      const second = verifier(fx, { dir, builderRewards, tracker: ChainTracker.fromJSON(savedVerifierTracker(first.store)!, first.reader, 1000n) });
      await through(second, 1, 1);
      expect(builderRewards).toHaveBeenCalledTimes(1);
      expect(second.alerts).toEqual([]);
      expect(saved(second)).toMatchObject({ lastD: (1_000_000n * USDC - 2n * USDC).toString(), countedTotal: (2n * USDC).toString() });
    });

    it("a malformed builderCheck is refused", async () => {
      const fx = await posterRun({ minutes: 1 });
      const dir = mkdtempSync(join(tmpdir(), "verifier-"));
      const first = verifier(fx, { dir });
      await first.v.tick();
      const good1 = { at: 5, lastD: "-7", countedTotal: "9" };
      for (const bad of [null, "x", [], { ...good1, at: "5" }, { ...good1, at: 1.5 }, { ...good1, lastD: "1.5" }, { ...good1, lastD: 5 }, { ...good1, countedTotal: "-1" }, { at: 5, lastD: "1" }]) {
        first.store.writeJson("verifier-state", { ...stateOf(first), builderCheck: bad });
        expect(() => verifier(fx, { dir }), JSON.stringify(bad)).toThrow(/builderCheck/);
      }
      first.store.writeJson("verifier-state", { ...stateOf(first), builderCheck: good1 });
      expect(() => verifier(fx, { dir })).not.toThrow();
    });
  });
});

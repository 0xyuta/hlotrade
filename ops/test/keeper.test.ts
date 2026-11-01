import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { buybackAbi, checkpointsAbi } from "../src/abi.js";
import { Keeper, newestRound, nextKeeperStep, settleDue, settleSleep, sleepFor, type KeeperView, type SettleChain } from "../src/keeper.js";

const v = (o: Partial<KeeperView>): KeeperView => ({
  now: 1_000_000n, poolOpen: false, openAt: 900_000n, usdcHeld: 45_000_000n, slice: 0n, lastBuy: 0n,
  buyInterval: 600n, lastTry: null, hype: 10n ** 18n, minHype: 5n * 10n ** 16n, ...o,
});

describe("nextKeeperStep", () => {
  it("waits for the opening time, then opens", () => {
    expect(nextKeeperStep(v({ now: 899_999n }))).toEqual({ kind: "wait", until: 900_000n, why: "pool not due yet" });
    expect(nextKeeperStep(v({}))).toEqual({ kind: "open" });
  });
  it("does not open with no USDC (openPool would revert NothingToSeed)", () => {
    expect(nextKeeperStep(v({ usdcHeld: 0n })).kind).toBe("idle");
  });
  it("after opening, a 0 slice waits for the next fee deposit", () => {
    const s = nextKeeperStep(v({ poolOpen: true, slice: 0n }));
    expect(s.kind).toBe("idle");
    expect(s.kind === "idle" && s.why).toContain("next fee deposit");
  });
  it("buys when the interval has passed since the last buy", () => {
    expect(nextKeeperStep(v({ poolOpen: true, slice: 125_000n, lastBuy: 999_500n }))).toEqual({ kind: "wait", until: 1_000_100n, why: "buy interval" });
    expect(nextKeeperStep(v({ poolOpen: true, slice: 125_000n, lastBuy: 999_400n }))).toEqual({ kind: "buy" });
  });
  it("after a skipped buy, waits one interval from the try", () => {
    expect(nextKeeperStep(v({ poolOpen: true, slice: 125_000n, lastTry: 999_900n }))).toEqual({ kind: "wait", until: 1_000_500n, why: "buy interval" });
  });
  it("with both set, the later of lastBuy and lastTry decides", () => {
    const open = { poolOpen: true, slice: 125_000n };
    // lastBuy + 600 = 1_000_300 is later than lastTry + 600 = 999_600
    expect(nextKeeperStep(v({ ...open, lastBuy: 999_700n, lastTry: 999_000n }))).toEqual({ kind: "wait", until: 1_000_300n, why: "buy interval" });
    // lastTry + 600 = 1_000_500 is later than lastBuy + 600 = 999_900
    expect(nextKeeperStep(v({ ...open, lastBuy: 999_300n, lastTry: 999_900n }))).toEqual({ kind: "wait", until: 1_000_500n, why: "buy interval" });
    expect(nextKeeperStep(v({ ...open, lastBuy: 999_300n, lastTry: 999_300n }))).toEqual({ kind: "buy" });
  });
  it("nothing to spend is idle", () => {
    expect(nextKeeperStep(v({ poolOpen: true, slice: 125_000n, usdcHeld: 0n })).kind).toBe("idle");
  });
  it("low gas stops before sending", () => {
    expect(nextKeeperStep(v({ hype: 1n }))).toEqual({ kind: "lowGas" });
    expect(nextKeeperStep(v({ poolOpen: true, slice: 1n, hype: 1n }))).toEqual({ kind: "lowGas" });
  });
});

describe("sleepFor", () => {
  it("wakes at the due time, at most one poll and at least 1 s", () => {
    const wait = (until: bigint) => ({ kind: "wait" as const, until, why: "buy interval" });
    expect(sleepFor(wait(1_000_020n), 1_000_000n, 60)).toBe(20);
    expect(sleepFor(wait(1_000_500n), 1_000_000n, 60)).toBe(60);
    expect(sleepFor(wait(1_000_000n), 1_000_000n, 60)).toBe(1);
    expect(sleepFor(wait(999_000n), 1_000_000n, 60)).toBe(1);
    expect(sleepFor({ kind: "idle", why: "x" }, 1_000_000n, 60)).toBe(60);
    expect(sleepFor({ kind: "buy" }, 1_000_000n, 60)).toBe(60);
  });
});

describe("a lost race is not an error", () => {
  const revert = (errorName: string) => {
    const cause = new ContractFunctionRevertedError({ abi: buybackAbi, data: encodeErrorResult({ abi: buybackAbi, errorName } as never), functionName: "buy" });
    return new ContractFunctionExecutionError(cause, { abi: buybackAbi, functionName: "buy" });
  };
  const keeperWith = (simulateError: unknown, view: { poolOpen: boolean; slice: bigint }) => {
    const reads: Record<string, unknown> = {
      usdc: "0x0000000000000000000000000000000000000001", poolOpen: view.poolOpen, launchTime: 0n, OPEN_DELAY: 1n,
      slice: view.slice, lastBuy: 0n, BUY_INTERVAL: 600n, balanceOf: 45_000_000n,
    };
    const ctx = {
      cfg: { keeperKey: generatePrivateKey(), forward: { minHype: 1n }, pollSeconds: 60 },
      d: { buyback: "0x0000000000000000000000000000000000000002" },
      client: {
        getBlock: async () => ({ number: 1n, timestamp: 10_000n }),
        readContract: async (a: { functionName: string }) => reads[a.functionName],
        getBalance: async () => 10n ** 18n,
        simulateContract: async () => {
          throw simulateError;
        },
      },
      log: () => {},
      alert: async () => {},
    };
    return { keeper: new Keeper(ctx as never) };
  };

  it("PoolAlreadyOpen on openPool and TooSoon on buy both map to nothing", async () => {
    const open = keeperWith(revert("PoolAlreadyOpen"), { poolOpen: false, slice: 0n });
    expect(await open.keeper.runOnce()).toMatchObject({ step: { kind: "open" }, result: "nothing" });
    const buy = keeperWith(revert("TooSoon"), { poolOpen: true, slice: 125_000n });
    expect(await buy.keeper.runOnce()).toMatchObject({ step: { kind: "buy" }, result: "nothing" });
  });
  it("any other revert is an error", async () => {
    const k = keeperWith(revert("NothingToSeed"), { poolOpen: false, slice: 0n });
    await expect(k.keeper.runOnce()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------- hourly settle

describe("settleDue", () => {
  const L = 1_000_000;
  const chain = (o: Partial<SettleChain> = {}): SettleChain => ({ anySettled: true, latestMinute: 9, now: 0, launchTime: L, ...o });
  const end = L + 60 * 10; // the end of settled minute 9
  const latest = { throughMinute: 10 };

  it("is true exactly 60 minutes after the last settled minute ended", () => {
    expect(settleDue(chain({ now: end + 3599 }), latest, 60)).toBe(false); // 59 min 59 s
    expect(settleDue(chain({ now: end + 3600 }), latest, 60)).toBe(true);
    expect(settleDue(chain({ now: end + 3600 }), latest, 61)).toBe(false);
  });
  it("with nothing settled, counts from launch", () => {
    const c = chain({ anySettled: false, latestMinute: 0 });
    expect(settleDue({ ...c, now: L + 3599 }, { throughMinute: 0 }, 60)).toBe(false);
    expect(settleDue({ ...c, now: L + 3600 }, { throughMinute: 0 }, 60)).toBe(true);
  });
  it("is false with nothing published", () => {
    expect(settleDue(chain({ now: end + 99_999 }), null, 60)).toBe(false);
  });
  it("is false when the published checkpoint is not newer than the chain's", () => {
    expect(settleDue(chain({ now: end + 99_999 }), { throughMinute: 9 }, 60)).toBe(false);
    expect(settleDue(chain({ now: end + 99_999 }), { throughMinute: 3 }, 60)).toBe(false);
  });
});

describe("settleSleep", () => {
  it("is at least 30 s, and 5 min when unknown", () => {
    expect(settleSleep(null, 1000)).toBe(300);
    expect(settleSleep(1010, 1000)).toBe(30);
    expect(settleSleep(900, 1000)).toBe(30); // due already: retry in 30 s
    expect(settleSleep(1100, 1000)).toBe(100);
  });
});

describe("newestRound", () => {
  it("is the newest multiple of 15 at or before the minute on mainnet and testnet, and the minute itself on anvil", () => {
    for (const chainId of [999, 998]) {
      expect([0, 14, 15, 16, 44, 45, 47, 59, 60, 1_000].map((m) => newestRound(m, chainId))).toEqual([0, 0, 15, 15, 30, 45, 45, 45, 60, 990]);
    }
    expect([0, 1, 10, 47].map((m) => newestRound(m, 31337))).toEqual([0, 1, 10, 47]);
  });
});

describe("the keeper's settle step", () => {
  const CP = "0x00000000000000000000000000000000000000c9";
  const SIG = `0x${"ab".repeat(65)}` as const;
  const ROOT = `0x${"12".repeat(32)}` as const;
  const LAUNCH = 1_000_000;
  const NOW = LAUNCH + 60 * 10 + 3600; // exactly due after settled minute 9

  /** The signed fields of checkpoint `m`: each minute's differ, so a test can tell which one was sent. */
  const signed = (m: number) => ({
    throughMinute: m, refBlock: String(70 + m), root: `0x${(0x20 + m).toString(16).padStart(2, "0").repeat(32)}`, totalEntitled: String(1000 + m), sig: `0x${(0xa0 + m).toString(16).padStart(2, "0").repeat(65)}`,
  });
  const fileJson = (m: number, o: Record<string, unknown> = {}, chainId = 31337) => ({
    v: 1, chainId, contract: CP.toUpperCase().replace("0X", "0x"), ...signed(m), publishedAt: 1, table: "minute,user,fee", ...o,
  });
  const latestJson = (o: Record<string, unknown> = {}, m = 10, chainId = 31337) =>
    JSON.stringify({ ...fileJson(m, {}, chainId), vault: { amount: "0", pointsTotal: "0", odds: 1, lastPopMinute: -1 }, pops: [], ...o });
  const archiveJson = (m: number, o: Record<string, unknown> = {}, chainId = 31337) => JSON.stringify(fileJson(m, o, chainId));

  const revertOf = (errorName: string) => {
    const cause = new ContractFunctionRevertedError({ abi: checkpointsAbi, data: encodeErrorResult({ abi: checkpointsAbi, errorName } as never), functionName: "settle" });
    return new ContractFunctionExecutionError(cause, { abi: checkpointsAbi, functionName: "settle", args: [{ throughMinute: 10n, refBlock: 77n, root: `0x${"12".repeat(32)}`, totalEntitled: 1n }, "0x"] });
  };

  /**
   * By default the newest published checkpoint is minute 10 (latest.json and checkpoints/10.json), on anvil, where every minute is a round.
   * `latest` is the newest minute, `archives` the minutes with an archive file (default: the newest round), or a text to write for one.
   */
  function setup(opts: {
    writeError?: unknown; sleepFn?: (ms: number) => Promise<void>; file?: string | null; simulateError?: unknown; anySettled?: boolean; latestMinute?: bigint; now?: number;
    rewards?: "dir" | "none"; chainId?: number; latest?: number; archives?: Record<number, string | null>;
  } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "keeper-settle-"));
    const chainId = opts.chainId ?? 31337;
    const latest = opts.latest ?? 10;
    if (opts.file !== null) writeFileSync(join(dir, "latest.json"), opts.file ?? latestJson({}, latest, chainId));
    const round = newestRound(latest, chainId);
    const archives = opts.archives ?? { [round]: archiveJson(round, {}, chainId) };
    mkdirSync(join(dir, "checkpoints"));
    for (const [m, text] of Object.entries(archives)) if (text !== null) writeFileSync(join(dir, "checkpoints", `${m}.json`), text);
    const reads: Record<string, unknown> = {
      usdc: "0x0000000000000000000000000000000000000001", poolOpen: false, launchTime: 0n, OPEN_DELAY: 1n, // pool open and due: idle (no USDC)
      slice: 0n, lastBuy: 0n, BUY_INTERVAL: 600n, balanceOf: 0n,
      anySettled: opts.anySettled ?? true, latestMinute: opts.latestMinute ?? 9n,
    };
    const sims: { functionName: string; args?: unknown }[] = [];
    const writes: { functionName: string; args: unknown[]; address: string }[] = [];
    const logs: string[] = [];
    const alerts: string[] = [];
    const ctx = {
      cfg: {
        keeperKey: generatePrivateKey(), forward: { minHype: 1n }, pollSeconds: 60, chainId, settleAfterMinutes: 60,
        ...(opts.rewards === "none" ? {} : { rewardsUrl: undefined, publishExplicit: true, publish: { kind: "local", dir } }),
      },
      d: { buyback: "0x0000000000000000000000000000000000000002", checkpoints: CP },
      client: {
        getBlock: async () => ({ number: 1n, timestamp: BigInt(opts.now ?? NOW) }),
        readContract: async (a: { functionName: string; address: string }) =>
          a.functionName === "launchTime" && a.address === CP ? BigInt(LAUNCH) : reads[a.functionName],
        getBalance: async () => 10n ** 18n,
        simulateContract: async (a: { functionName: string; args?: unknown }) => {
          sims.push(a);
          if (opts.simulateError) throw opts.simulateError;
        },
        waitForTransactionReceipt: async () => ({ status: "success", logs: [] }),
      },
      log: (s: string) => logs.push(s),
      alert: async (s: string) => void alerts.push(s),
    };
    const wallet = () => ({
      chain: undefined, account: undefined,
      writeContract: async (a: { functionName: string; args: unknown[]; address: string }) => {
        if (opts.writeError) throw opts.writeError;
        writes.push(a);
        return "0xhash" as const;
      },
    });
    return { keeper: new Keeper(ctx as never, wallet as never, opts.sleepFn), sims, writes, logs, alerts };
  }
  /** What a settle of checkpoint `m` sends. */
  const sentFor = (m: number) => {
    const f = signed(m);
    return [{ throughMinute: BigInt(m), refBlock: BigInt(f.refBlock), root: f.root, totalEntitled: BigInt(f.totalEntitled) }, f.sig];
  };
  /** On testnet (rounds of 15), with the chain's last settled minute 9 and the clock exactly an hour past its end by default. */
  const onTestnet = (o: Parameters<typeof setup>[0] = {}) => setup({ chainId: 998, ...o });

  it("sends settle with the archive file's exact checkpoint and signature (simulated first)", async () => {
    const t = setup();
    const r = await t.keeper.runOnce();
    expect(r.settle).toBe("settled");
    expect(t.sims.map((s) => s.functionName)).toEqual(["settle"]);
    expect(t.writes).toHaveLength(1);
    expect(t.writes[0]).toMatchObject({ functionName: "settle", address: CP });
    expect(t.writes[0].args).toEqual(sentFor(10));
    expect(t.alerts).toEqual([]);
  });
  it("does nothing before the hour is up, and reports when it will be due", async () => {
    const t = setup({ now: NOW - 1 });
    const r = await t.keeper.runOnce();
    expect(r.settle).toBeUndefined();
    expect(r.settleDueAt).toBe(NOW);
    expect(t.sims).toEqual([]);
    expect(t.writes).toEqual([]);
  });
  it("runs even though the Buyback pool is not open yet", async () => {
    const t = setup(); // poolOpen false, USDC 0: the buy step is idle
    const r = await t.keeper.runOnce();
    expect(r.step.kind).toBe("idle");
    expect(r.settle).toBe("settled");
  });
  it("nothing published: no send, no alert, due time unknown", async () => {
    const t = setup({ file: null });
    const r = await t.keeper.runOnce();
    expect(r).toMatchObject({ settleDueAt: null });
    expect(r.settle).toBeUndefined();
    expect(t.writes).toEqual([]);
    expect(t.alerts).toEqual([]);
  });
  it("a file for another chain or contract is alerted and not sent: the check is on the archive file that would be sent", async () => {
    const a = setup({ archives: { 10: archiveJson(10, {}, 999) } });
    expect((await a.keeper.runOnce()).settle).toBe("chainMismatch");
    expect(a.alerts).toHaveLength(1);
    expect(a.alerts[0]).toContain("checkpoints/10.json");
    expect(a.sims).toEqual([]);
    const b = setup({ archives: { 10: archiveJson(10, { contract: "0x00000000000000000000000000000000000000dd" }) } });
    expect((await b.keeper.runOnce()).settle).toBe("chainMismatch");
    expect(b.writes).toEqual([]);
  });
  it("NotNewer is logged and not alerted", async () => {
    const t = setup({ simulateError: revertOf("NotNewer") });
    const r = await t.keeper.runOnce();
    expect(r.settle).toBe("notNewer");
    expect(t.alerts).toEqual([]);
    expect(t.logs.some((l) => l.includes("settle(10): someone else settled"))).toBe(true);
    expect(t.writes).toEqual([]);
  });
  it("any other revert is alerted, never thrown", async () => {
    const t = setup({ simulateError: revertOf("IsPaused") });
    const r = await t.keeper.runOnce();
    expect(r.settle).toBe("failed");
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain("IsPaused");
    expect(t.writes).toEqual([]);
  });
  it("an unreadable latest.json is alerted, never thrown", async () => {
    const t = setup({ file: "{not json" });
    const r = await t.keeper.runOnce();
    expect(r.settle).toBeUndefined();
    expect(t.alerts).toHaveLength(1);
    expect(t.writes).toEqual([]);
  });
  it("no rewards source configured is alerted, never thrown", async () => {
    const t = setup({ rewards: "none" });
    await expect(t.keeper.runOnce()).resolves.toMatchObject({ step: { kind: "idle" } });
    expect(t.alerts[0]).toContain("REWARDS_URL");
  });
  it("a checkpoint no newer than the chain's is not sent", async () => {
    const t = setup({ latestMinute: 10n });
    const r = await t.keeper.runOnce();
    expect(r.settle).toBeUndefined();
    expect(t.sims).toEqual([]);
  });
  it("NotNewer from the send (settled between simulate and send) is logged, not alerted", async () => {
    const t = setup({ writeError: revertOf("NotNewer") });
    const r = await t.keeper.runOnce();
    expect(r.settle).toBe("notNewer");
    expect(t.sims).toHaveLength(1);
    expect(t.alerts).toEqual([]);
    expect(t.logs.some((l) => l.includes("someone else settled"))).toBe(true);
  });
  it("does not read latest.json while the chain says no settle can be due, and reads it once one can", async () => {
    const early = setup({ file: "{not json", now: NOW - 1 }); // a read would fail and alert
    const r1 = await early.keeper.runOnce();
    expect(r1.settleDueAt).toBe(NOW);
    expect(early.alerts).toEqual([]);
    const due = setup({ file: "{not json" });
    await due.keeper.runOnce();
    expect(due.alerts).toHaveLength(1);
    // nothing settled yet: due one hour after launch
    const fresh = setup({ file: "{not json", anySettled: false, latestMinute: 0n, now: LAUNCH + 3599 });
    expect((await fresh.keeper.runOnce()).settleDueAt).toBe(LAUNCH + 3600);
    expect(fresh.alerts).toEqual([]);
  });
  it("loop() sleeps for the earlier of the buy wait and the settle time", async () => {
    const sleeps: number[] = [];
    const stop = new Error("stop");
    const t = setup({ now: NOW - 40, sleepFn: async (ms) => { sleeps.push(ms); throw stop; } }); // idle buy step (60 s poll), settle in 40 s
    await expect(t.keeper.loop()).rejects.toBe(stop);
    expect(sleeps).toEqual([40_000]);
    // settle time unknown (nothing published past the gate): the buy wait decides
    const u = setup({ file: null, sleepFn: async (ms) => { sleeps.push(ms); throw stop; } });
    await expect(u.keeper.loop()).rejects.toBe(stop);
    expect(sleeps).toEqual([40_000, 60_000]);
  });

  describe("rounds (testnet and mainnet settle only multiples of 15)", () => {
    // The user files are written on every multiple of 15 at any wallet count, so a wallet's file for a settled round can always be read.
    const NOW_45 = LAUNCH + 60 * 10 + 3600; // an hour after the end of settled minute 9
    it("latest at 47 settles minute 45, with minute 45's signed fields from checkpoints/45.json", async () => {
      const t = onTestnet({ latest: 47, archives: { 45: archiveJson(45, {}, 998), 47: archiveJson(47, {}, 998) } });
      const r = await t.keeper.runOnce();
      expect(r.settle).toBe("settled");
      expect(t.sims).toHaveLength(1);
      expect(t.writes).toHaveLength(1);
      expect(t.writes[0].args).toEqual(sentFor(45));
      expect(t.writes[0].args).not.toEqual(sentFor(47));
      expect(t.alerts).toEqual([]);
    });
    it("latest at 45 settles 45", async () => {
      const t = onTestnet({ latest: 45 });
      expect((await t.keeper.runOnce()).settle).toBe("settled");
      expect(t.writes[0].args).toEqual(sentFor(45));
    });
    it("latest at 14 settles minute 0 when nothing is settled yet (a round older than the chain's none)", async () => {
      const t = onTestnet({ latest: 14, anySettled: false, latestMinute: 0n, now: LAUNCH + 3600 });
      expect((await t.keeper.runOnce()).settle).toBe("settled");
      expect(t.writes[0].args).toEqual(sentFor(0));
    });
    it("latest at 14 with minute 0 already settled has no newer round: nothing is sent", async () => {
      const t = onTestnet({ latest: 14, latestMinute: 0n, now: LAUNCH + 60 + 3600 });
      const r = await t.keeper.runOnce();
      expect(r.settle).toBeUndefined();
      expect(r.settleDueAt).toBeNull();
      expect(t.sims).toEqual([]);
      expect(t.alerts).toEqual([]);
    });
    it("a round not newer than the chain's latest settled minute does not settle, even when latest.json is far ahead", async () => {
      for (const settled of [45n, 46n, 50n]) {
        const t = onTestnet({ latest: 47, latestMinute: settled, now: LAUNCH + 60 * (Number(settled) + 1) + 3600 });
        const r = await t.keeper.runOnce();
        expect(r.settle, String(settled)).toBeUndefined();
        expect(t.sims, String(settled)).toEqual([]);
        expect(t.alerts, String(settled)).toEqual([]);
      }
    });
    it("a round newer than the chain's settles: the chain at 44, latest at 59", async () => {
      const t = onTestnet({ latest: 59, latestMinute: 44n, now: LAUNCH + 60 * 45 + 3600 });
      expect((await t.keeper.runOnce()).settle).toBe("settled");
      expect(t.writes[0].args).toEqual(sentFor(45));
    });
    it("a missing archive for the round is alerted and nothing is settled; the next pass tries again", async () => {
      const t = onTestnet({ latest: 47, archives: { 47: archiveJson(47, {}, 998) } }); // 45 is not there
      const r = await t.keeper.runOnce();
      expect(r.settle).toBeUndefined();
      expect(t.sims).toEqual([]);
      expect(t.writes).toEqual([]);
      expect(t.alerts).toHaveLength(1);
      expect(t.alerts[0]).toContain("checkpoints/45.json");
      writeFileSync(join(dirOf(t), "checkpoints", "45.json"), archiveJson(45, {}, 998));
      expect((await t.keeper.runOnce()).settle).toBe("settled");
      expect(t.writes[0].args).toEqual(sentFor(45));
    });
    it("an unreadable archive for the round is alerted and nothing is settled", async () => {
      const t = onTestnet({ latest: 47, archives: { 45: "{not json" } });
      expect((await t.keeper.runOnce()).settle).toBeUndefined();
      expect(t.alerts).toHaveLength(1);
      expect(t.alerts[0]).toContain("checkpoints/45.json");
      expect(t.sims).toEqual([]);
    });
    it("an archive that is another minute than its name says is alerted and not sent", async () => {
      const t = onTestnet({ latest: 47, archives: { 45: archiveJson(46, {}, 998) } });
      const r = await t.keeper.runOnce();
      expect(r.settle).toBe("failed");
      expect(t.alerts).toHaveLength(1);
      expect(t.alerts[0]).toContain("checkpoints/45.json");
      expect(t.sims).toEqual([]);
    });
    it("the chain and contract check is on the archive file that would be sent (latest.json itself is fine)", async () => {
      const wrongChain = onTestnet({ latest: 47, archives: { 45: archiveJson(45, {}, 999) } });
      expect((await wrongChain.keeper.runOnce()).settle).toBe("chainMismatch");
      expect(wrongChain.sims).toEqual([]);
      expect(wrongChain.alerts[0]).toContain("checkpoints/45.json");
      const wrongContract = onTestnet({ latest: 47, archives: { 45: archiveJson(45, { contract: "0x00000000000000000000000000000000000000dd" }, 998) } });
      expect((await wrongContract.keeper.runOnce()).settle).toBe("chainMismatch");
      expect(wrongContract.writes).toEqual([]);
    });
    it("reads the archive only once a settle is due, and an hour counts from the last settled minute as before", async () => {
      const early = onTestnet({ latest: 47, archives: {}, now: NOW_45 - 1 }); // the archive is missing: a read would alert
      const r = await early.keeper.runOnce();
      expect(r.settleDueAt).toBe(NOW_45);
      expect(early.alerts).toEqual([]);
    });
    it("on anvil every minute is a round, so the newest published checkpoint is the one settled", async () => {
      const t = setup({ latest: 47, latestMinute: 9n, now: LAUNCH + 60 * 10 + 3600 });
      expect((await t.keeper.runOnce()).settle).toBe("settled");
      expect(t.writes[0].args).toEqual(sentFor(47));
    });
  });
});

/** The directory the setup's published files are in (the keeper's rewards source). */
function dirOf(t: { keeper: Keeper }): string {
  const ctx = (t.keeper as unknown as { ctx: { cfg: { publish: { dir: string } } } }).ctx;
  return ctx.cfg.publish.dir;
}

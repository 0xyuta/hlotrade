import { describe, expect, it } from "vitest";
import {
  applyCheckpoint, deserializeState, newCalcState, popMinimum, popsAt, serializeState, type CalcState, type CheckpointInput, type FeeRow,
} from "../src/index.js";
import { hashWhere, seedsFor } from "./helpers/seeds.js";

const A = "0x00000000000000000000000000000000000000aa" as const;
const B = "0x00000000000000000000000000000000000000bb" as const;
const C = "0x00000000000000000000000000000000000000cc" as const;
const E = 10n ** 17n; // 0.1 HLO
const ODDS = 60;
const NO_MINIMUM = { fromMinute: 0, units: 0n };
const row = (minute: number, user: `0x${string}`, fee: bigint): FeeRow => ({ minute, user, fee });
/** The next checkpoint for `s` through `throughMinute`, with seeds for exactly its minutes that pop at `pop`. */
const input = (s: CalcState, o: Partial<CheckpointInput> & { throughMinute: number; pop?: number[] }): CheckpointInput => {
  const { pop, ...rest } = o;
  return { refBlock: 10n, rows: [], burned: 0n, refined: 0n, claimed: new Map(), minimum: NO_MINIMUM, quietFrom: null, seeds: seedsFor(s.nextMinute, o.throughMinute, { odds: s.odds, pop }), ...rest };
};
/** For inputs whose minute range is itself the fault (no seeds can be built for it). */
const RAW = { refBlock: 10n, rows: [], burned: 0n, refined: 0n, claimed: new Map(), minimum: NO_MINIMUM, quietFrom: null, seeds: [] };

describe("minutes nobody trades (spec 2026-11-04)", () => {
  it("before quietFrom an empty minute sends its 1 HLO to the vault; from quietFrom on it is never made", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 3, quietFrom: 2 }));
    // m0, m1: 1 + 0.1 each into the vault. m2, m3: only the 0.1.
    expect(r.emitted).toBe(24n * E);
    expect(r.toVault).toBe(24n * E);
    expect(r.vault).toBe(24n * E);
    expect(s.emitted).toBe(24n * E);
    expect(r.totalEntitled).toBe(0n);
  });

  it("a minute with a trader is unchanged: the trader gets the 1 HLO, the vault the 0.1", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 2, quietFrom: 0, rows: [row(1, A, 5n)] }));
    expect(r.entitlements.get(A)).toBe(10n * E);
    expect(r.toTraders).toBe(10n * E);
    expect(r.vault).toBe(3n * E);
    expect(r.emitted).toBe(13n * E);
  });

  it("null keeps the launch rule", () => {
    const s = newCalcState(0, ODDS);
    expect(applyCheckpoint(s, input(s, { throughMinute: 1, quietFrom: null })).vault).toBe(22n * E);
  });

  it("a pop after quiet minutes shares a smaller vault", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 2, quietFrom: 0, rows: [row(0, A, 100n)], pop: [2] }));
    // m0: A 1 HLO, vault 0.1. m1, m2: 0.1 each → 0.3; it pops: A gets 0.27, 0.03 stays.
    expect(r.pops).toEqual([{ minute: 2, block: 1002n, amount: (27n * E) / 10n, kept: (3n * E) / 10n, recipients: 1, pointsTotal: 100n }]);
    expect(r.vault).toBe((3n * E) / 10n);
  });

  it("checkpoints split across quietFrom give the same state as one", () => {
    const rows = [row(0, A, 3n), row(4, B, 7n)];
    const one = newCalcState(0, ODDS);
    applyCheckpoint(one, input(one, { throughMinute: 6, quietFrom: 3, rows, pop: [5] }));
    const two = newCalcState(0, ODDS);
    applyCheckpoint(two, input(two, { throughMinute: 2, quietFrom: 3, rows: rows.filter((r) => r.minute <= 2), pop: [5] }));
    applyCheckpoint(two, input(two, { throughMinute: 6, quietFrom: 3, rows: rows.filter((r) => r.minute > 2), pop: [5] }));
    expect(serializeState(two)).toBe(serializeState(one));
  });

  it("a quietFrom that is not a safe integer throws before touching the state", () => {
    const s = newCalcState(0, ODDS);
    expect(() => applyCheckpoint(s, input(s, { throughMinute: 0, quietFrom: 1.5 }))).toThrow(/quietFrom 1.5 is not a safe integer/);
    expect(s.nextMinute).toBe(0);
  });
});

describe("the minimum to share in a pop", () => {
  const ONE = 100_000_000n; // 1 point in fee units
  const minimum = { fromMinute: 0, units: ONE };
  it("a wallet under the minimum gets nothing and its points do not dilute the others'", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 0, minimum, pop: [0], rows: [row(0, A, ONE), row(0, B, 3n * ONE), row(0, C, ONE - 1n)] }));
    const pay = (s.vault + r.pops[0].amount) * 9n / 10n;
    expect(r.pops[0].pointsTotal).toBe(4n * ONE);
    expect(r.pops[0].recipients).toBe(2);
    expect(r.totals.get(A)!.fromVault).toBe(pay / 4n);
    expect(r.totals.get(B)!.fromVault).toBe((pay * 3n) / 4n);
    expect(r.totals.get(C)!.fromVault).toBe(0n);
  });
  it("exactly the minimum shares", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 0, minimum, pop: [0], rows: [row(0, A, ONE)] }));
    expect(r.pops[0].recipients).toBe(1);
    expect(r.totals.get(A)!.fromVault).toBe(r.pops[0].amount);
    expect(r.pops[0].amount).toBeGreaterThan(0n);
  });
  it("nobody at the minimum: the pop pays nothing, all stays in the vault, and every point still resets", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 0, minimum, pop: [0], rows: [row(0, A, ONE - 1n)] }));
    expect(r.pops[0].amount).toBe(0n);
    expect(r.pops[0].recipients).toBe(0);
    expect(r.pops[0].pointsTotal).toBe(0n);
    expect(r.pops[0].kept).toBe(r.vault);
    expect(r.pointsTotal).toBe(0n);
    expect(r.points.size).toBe(0);
  });
  it("points add up over the minutes since the last pop to reach the minimum", () => {
    const s = newCalcState(0, ODDS);
    const half = ONE / 2n;
    const r = applyCheckpoint(s, input(s, { throughMinute: 2, minimum, pop: [2], rows: [row(0, A, half), row(1, A, half)] }));
    expect(r.pops[0].recipients).toBe(1);
  });
  it("before `fromMinute` a pop pays every wallet with points; from it the minimum holds, so old minutes replay as they were", () => {
    const rule = { fromMinute: 1, units: ONE };
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 1, minimum: rule, pop: [0, 1], rows: [row(0, A, 5n), row(1, A, 5n)] }));
    expect(r.pops[0].recipients).toBe(1);
    expect(r.pops[1].recipients).toBe(0);
  });
  it("sharePoints counts only the wallets at the minimum for the next minute; pointsTotal counts them all", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 0, minimum, rows: [row(0, A, ONE), row(0, B, 5n)] }));
    expect(r.pointsTotal).toBe(ONE + 5n);
    expect(r.sharePoints).toBe(ONE);
    const s2 = newCalcState(0, ODDS);
    const r2 = applyCheckpoint(s2, input(s2, { throughMinute: 0, minimum: { fromMinute: 5, units: ONE }, rows: [row(0, A, ONE), row(0, B, 5n)] }));
    expect(r2.sharePoints).toBe(ONE + 5n);
  });
  it("is the rule on every network: on from the start on 999, off on anvil, and unknown chains refuse", () => {
    expect(popMinimum(999)).toEqual({ fromMinute: 0, units: ONE });
    expect(popMinimum(998).units).toBe(ONE);
    expect(popMinimum(998).fromMinute).toBeGreaterThan(0);
    expect(popMinimum(31337).units).toBe(0n);
    expect(() => popMinimum(1)).toThrow(/no vault pop minimum/);
  });
});

describe("applyCheckpoint: minutes and the vault", () => {
  it("two traders and an empty minute, no pop: the traders' share, the vault grows, the points add up", () => {
    const s = newCalcState(1_800_000_000, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 2, rows: [row(0, A, 100n), row(1, A, 100n), row(1, B, 300n)] }));
    // m0: A 1 HLO; vault 0.1. m1: A 0.25, B 0.75; vault 0.2. m2: empty → vault 1.3.
    expect(r.entitlements.get(A)).toBe((125n * E) / 10n);
    expect(r.entitlements.get(B)).toBe((75n * E) / 10n);
    expect(r.pops).toEqual([]);
    expect(r.vault).toBe(13n * E);
    expect(r.points).toEqual(new Map([[A, 200n], [B, 300n]]));
    expect(r.pointsTotal).toBe(500n);
    expect(r.totals.get(A)).toEqual({ fees: 200n, mined: (125n * E) / 10n, fromVault: 0n, refined: 0n });
    expect(s.nextMinute).toBe(3);
  });

  it("a pop with one holder: 90% of the vault (the minute's own 0.1 included) to them, 10% stays, points reset", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 1, rows: [row(0, A, 100n)], pop: [1] }));
    // m0: A 1 HLO, vault 0.1. m1: nobody traded, vault 0.1 + 1 + 0.1 = 1.2; it pops: A gets 1.08, 0.12 stays.
    expect(r.pops).toEqual([{ minute: 1, block: 1001n, amount: (108n * E) / 10n, kept: (12n * E) / 10n, recipients: 1, pointsTotal: 100n }]);
    expect(r.entitlements.get(A)).toBe((208n * E) / 10n);
    expect(r.totals.get(A)).toEqual({ fees: 100n, mined: 10n * E, fromVault: (108n * E) / 10n, refined: 0n });
    expect(r.vault).toBe((12n * E) / 10n);
    expect(r.points.size).toBe(0);
    expect(r.pointsTotal).toBe(0n);
  });

  it("a pop pays the minute's own traders by points; rounding dust stays in the vault", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 0, rows: [row(0, A, 1n), row(0, B, 2n), row(0, C, 4n)], pop: [0] }));
    // Traders: 1 HLO by 1:2:4 (1 wei dust) → vault 0.1 HLO + 1 wei. pay = 0.09 HLO, shared 1:2:4 rounding down; 0.01 HLO + 2 wei stays.
    expect(r.entitlements.get(A)).toBe(142857142857142857n + 12857142857142857n);
    expect(r.entitlements.get(B)).toBe(285714285714285714n + 25714285714285714n);
    expect(r.entitlements.get(C)).toBe(571428571428571428n + 51428571428571428n);
    expect(r.pops).toEqual([{ minute: 0, block: 1000n, amount: 89999999999999999n, kept: 10000000000000002n, recipients: 3, pointsTotal: 7n }]);
    expect(r.vault).toBe(10000000000000002n);
  });

  it("nobody has points: the pop pays nothing and the whole vault stays", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 3, pop: [0, 2] }));
    expect(r.pops).toEqual([
      { minute: 0, block: 1000n, amount: 0n, kept: 11n * E, recipients: 0, pointsTotal: 0n },
      { minute: 2, block: 1002n, amount: 0n, kept: 33n * E, recipients: 0, pointsTotal: 0n },
    ]);
    expect(r.vault).toBe(44n * E);
    expect(r.totalEntitled).toBe(0n);
  });

  it("a pop inside a checkpoint of several minutes: points reset there and later minutes count from 0", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 3, rows: [row(0, A, 100n), row(1, B, 100n), row(3, A, 100n)], pop: [2] }));
    // m0 A 1, m1 B 1, vault 0.2; m2 empty → 1.3, pops: 1.17 shared 1:1 (0.585 each), 0.13 stays; m3 A 1, vault 0.23, A's points 100.
    expect(r.pops).toEqual([{ minute: 2, block: 1002n, amount: (117n * E) / 10n, kept: (13n * E) / 10n, recipients: 2, pointsTotal: 200n }]);
    expect(r.entitlements.get(A)).toBe(10n * E + (585n * E) / 100n + 10n * E);
    expect(r.entitlements.get(B)).toBe(10n * E + (585n * E) / 100n);
    expect(r.vault).toBe((23n * E) / 10n);
    expect(r.points).toEqual(new Map([[A, 100n]]));
    expect(r.pointsTotal).toBe(100n);
  });

  it("two minutes with the same seed block (a stalled chain) draw separately: the minute is in the hash", () => {
    const h = hashWhere((x) => popsAt(x, 0, ODDS) && !popsAt(x, 1, ODDS));
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, { ...input(s, { throughMinute: 1, rows: [row(0, A, 100n)] }), seeds: [{ minute: 0, block: 7n, hash: h }, { minute: 1, block: 7n, hash: h }] });
    expect(r.pops.map((p) => [p.minute, p.block])).toEqual([[0, 7n]]);
  });

  it("odds 1 (anvil): every minute pops", () => {
    const s = newCalcState(0, 1);
    const r = applyCheckpoint(s, input(s, { throughMinute: 2, rows: [row(1, A, 5n)], pop: [0, 1, 2] }));
    expect(r.pops.map((p) => p.minute)).toEqual([0, 1, 2]);
  });

  it("rounding dust of the traders' share goes to the vault", () => {
    const s = newCalcState(0, ODDS);
    const r = applyCheckpoint(s, input(s, { throughMinute: 0, rows: [row(0, A, 1n), row(0, B, 1n), row(0, C, 1n)] }));
    expect(r.entitlements.get(A)).toBe(333_333_333_333_333_333n);
    expect(r.vault).toBe(E + 1n);
    expect(r.points.get(A)).toBe(1n);
  });

  it("refining is shared by unclaimed balance at refBlock; with no unclaimed holder it carries", () => {
    const s = newCalcState(0, ODDS);
    applyCheckpoint(s, input(s, { throughMinute: 0, rows: [row(0, A, 100n), row(0, B, 100n)] }));
    const r = applyCheckpoint(s, input(s, { throughMinute: 1, refBlock: 20n, refined: (3n * E) / 10n, claimed: new Map([[A, 5n * E]]) }));
    expect(r.entitlements.get(A)).toBe(5n * E);
    expect(r.entitlements.get(B)).toBe(5n * E + (3n * E) / 10n);
    expect(r.refiningShared).toBe((3n * E) / 10n);
    const r2 = applyCheckpoint(s, input(s, { throughMinute: 2, refBlock: 21n, refined: 7n, claimed: new Map([[A, 5n * E], [B, (53n * E) / 10n]]) }));
    expect(r2.refiningShared).toBe(0n);
    expect(r2.refiningCarry).toBe(7n);
  });

  it("supply room: the trader part first, then the vault part", () => {
    const s = newCalcState(0, ODDS);
    s.emitted = 5_000_000n * 10n ** 18n - 10_000n * 10n ** 18n - (105n * E) / 10n; // 1.05 HLO of room left
    const r = applyCheckpoint(s, input(s, { throughMinute: 0, rows: [row(0, A, 1n)] }));
    expect(r.entitlements.get(A)).toBe(10n * E);
    expect(r.vault).toBe((5n * E) / 10n);
    const r2 = applyCheckpoint(s, input(s, { throughMinute: 1, rows: [row(1, A, 1n)] }));
    expect(r2.emitted).toBe(0n);
    const s3 = newCalcState(0, ODDS);
    s3.emitted = 5_000_000n * 10n ** 18n - 10_000n * 10n ** 18n;
    const r3 = applyCheckpoint(s3, input(s3, { throughMinute: 0, burned: 2n * E, rows: [row(0, A, 1n)] }));
    expect(r3.entitlements.get(A)).toBe(2n * E); // burns free room
  });

  it("one checkpoint over minutes 0..5 equals three checkpoints of two minutes, with a pop at minute 3", () => {
    const rows = [row(0, A, 5n), row(1, B, 3n), row(2, A, 1n), row(2, B, 1n), row(4, C, 9n), row(5, A, 2n)];
    const s1 = newCalcState(0, ODDS);
    const one = applyCheckpoint(s1, input(s1, { throughMinute: 5, rows, pop: [3] }));
    const s = newCalcState(0, ODDS);
    applyCheckpoint(s, input(s, { throughMinute: 1, rows: rows.filter((x) => x.minute <= 1), pop: [3] }));
    applyCheckpoint(s, input(s, { throughMinute: 3, rows: rows.filter((x) => x.minute >= 2 && x.minute <= 3), pop: [3] }));
    const three = applyCheckpoint(s, input(s, { throughMinute: 5, rows: rows.filter((x) => x.minute >= 4), pop: [3] }));
    expect([...three.entitlements]).toEqual([...one.entitlements]);
    expect(three.vault).toBe(one.vault);
    expect(three.points).toEqual(one.points);
    expect(one.pops.map((p) => p.minute)).toEqual([3]);
  });

  it("rejects bad input and leaves the state unchanged", () => {
    const s = newCalcState(0, ODDS);
    applyCheckpoint(s, input(s, { throughMinute: 1, refBlock: 50n }));
    const before = serializeState(s);
    expect(() => applyCheckpoint(s, { ...RAW, throughMinute: 0, refBlock: 50n })).toThrow(/already/);
    expect(() => applyCheckpoint(s, input(s, { throughMinute: 3, refBlock: 50n, rows: [row(1, A, 1n)] }))).toThrow(/outside/);
    expect(() => applyCheckpoint(s, input(s, { throughMinute: 3, refBlock: 50n, rows: [row(4, A, 1n)] }))).toThrow(/outside/);
    expect(() => applyCheckpoint(s, input(s, { throughMinute: 3, refBlock: 50n, rows: [row(3, A, 0n)] }))).toThrow(/fee/);
    expect(() => applyCheckpoint(s, input(s, { throughMinute: 3, refBlock: 49n }))).toThrow(/refBlock/);
    expect(serializeState(s)).toBe(before);
  });

  it("rejects missing, extra, out-of-order or malformed seeds, before touching the state", () => {
    const s = newCalcState(0, ODDS);
    applyCheckpoint(s, input(s, { throughMinute: 1, refBlock: 50n }));
    const before = serializeState(s);
    const ok = seedsFor(2, 3, { odds: ODDS });
    const tries: CheckpointInput["seeds"][] = [
      ok.slice(0, 1), // minute 3 missing
      [...ok, { minute: 4, block: 1004n, hash: ok[0].hash }], // one too many
      [ok[1], ok[0]], // out of order
      [{ ...ok[0], minute: 1 }, ok[1]], // an earlier minute
      [{ ...ok[0], hash: "0x1234" }, ok[1]], // not 32 bytes
      [ok[0], { ...ok[1], block: 999n }], // a seed block below the previous one
    ];
    for (const [i, seeds] of tries.entries()) expect(() => applyCheckpoint(s, { ...input(s, { throughMinute: 3, refBlock: 50n }), seeds }), `try ${i}`).toThrow(/seed/);
    expect(serializeState(s)).toBe(before);
  });

  it("serializeState round-trips", () => {
    const s = newCalcState(7, ODDS);
    applyCheckpoint(s, input(s, { throughMinute: 4, rows: [row(1, A, 3n), row(4, B, 2n)], refined: 5n, pop: [2] }));
    const t = deserializeState(serializeState(s));
    expect(serializeState(t)).toBe(serializeState(s));
    expect(t.earned.get(A)).toBe(s.earned.get(A));
    expect(t.odds).toBe(ODDS);
    expect(JSON.parse(serializeState(s)).v).toBe(2);
  });

  it("a restored state resumes exactly like the original (points, refining carry and a pop in play)", () => {
    const s = newCalcState(0, ODDS);
    // Everyone is already claimed up to 1000 HLO, so no one is unclaimed and the refining pool carries.
    const claimedAll = new Map([[A, 1000n * E], [B, 1000n * E], [C, 1000n * E]]);
    applyCheckpoint(s, input(s, { throughMinute: 3, rows: [row(0, A, 100n), row(1, A, 100n), row(1, B, 300n), row(3, C, 50n)], refined: 7n, claimed: claimedAll, pop: [2] }));
    // Preconditions: the state really carries what the test is about.
    expect(s.points).toEqual(new Map([[C, 50n]])); // the pop at minute 2 reset A's and B's
    expect(s.refiningCarry).toBe(7n);

    const restored = deserializeState(serializeState(s));
    const next = input(s, { throughMinute: 5, refBlock: 11n, rows: [row(4, A, 10n), row(5, B, 10n)], refined: 3n, claimed: new Map([[A, 0n]]), pop: [5] });
    const ro = applyCheckpoint(s, next);
    const rr = applyCheckpoint(restored, next);
    expect(rr).toEqual(ro);
    expect(ro.pops.map((p) => p.minute)).toEqual([5]);
    expect(ro.totals.get(C)!.fromVault).toBeGreaterThan(0n); // C's restored points got a share of the minute-5 pop
    expect(serializeState(restored)).toBe(serializeState(s));
  });
});

describe("numeric input checks", () => {
  it("rejects a throughMinute that is not a safe integer, before touching the state", () => {
    const s = newCalcState(0, ODDS);
    const before = serializeState(s);
    expect(() => applyCheckpoint(s, { ...RAW, throughMinute: 1.5 })).toThrow(/safe integer/);
    expect(() => applyCheckpoint(s, { ...RAW, throughMinute: Number.MAX_SAFE_INTEGER + 2 })).toThrow(/safe integer/);
    expect(serializeState(s)).toBe(before);
  });

  it("rejects a negative burned", () => {
    const s = newCalcState(0, ODDS);
    expect(() => applyCheckpoint(s, input(s, { throughMinute: 0, burned: -1n, rows: [row(0, A, 1n)] }))).toThrow(/burned/);
    expect(s.nextMinute).toBe(0);
  });

  it("rejects a negative refined", () => {
    const s = newCalcState(0, ODDS);
    expect(() => applyCheckpoint(s, input(s, { throughMinute: 0, refined: -1n }))).toThrow(/refined/);
    expect(s.nextMinute).toBe(0);
  });

  it("newCalcState rejects odds that are not a positive integer", () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) expect(() => newCalcState(0, bad), String(bad)).toThrow(/odds/);
  });

  it("deserializeState refuses a version-1 state (from before the vault pops) and bad odds", () => {
    const j = JSON.parse(serializeState(newCalcState(0, ODDS)));
    expect(() => deserializeState(JSON.stringify({ ...j, v: 1 }))).toThrow("calc state version 1 is from before the vault pops: start from a fresh state directory");
    expect(() => deserializeState(JSON.stringify({ ...j, v: 3 }))).toThrow(/unknown calc state version/);
    for (const bad of [0, -3, 1.5]) expect(() => deserializeState(JSON.stringify({ ...j, odds: bad }))).toThrow(/odds/);
  });

  it("deserializeState rejects a launchTime that is not a safe integer", () => {
    const j = JSON.parse(serializeState(newCalcState(0, ODDS)));
    expect(() => deserializeState(JSON.stringify({ ...j, launchTime: 2 ** 53 }))).toThrow(/launchTime/);
  });
});

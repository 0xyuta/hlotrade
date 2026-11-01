import type { Addr } from "./fills.js";
import { feesByMinute } from "./apifills.js";
import { minimumAt, popsAt, type PopMinimum, type Seed } from "./pop.js";
import type { FeeRow } from "./table.js";
import { MAX_SUPPLY, POOL_RESERVE, TRADER_PER_MINUTE, VAULT_PER_MINUTE } from "./units.js";

/** Display breakdown per user (not in the leaf). Invariant: mined + fromVault + refined == earned. */
export interface UserTotals {
  fees: bigint; // 1e-8 USDC paid in checkpointed minutes
  mined: bigint;
  fromVault: bigint; // shares of vault pops
  refined: bigint;
}

export interface CalcState {
  launchTime: number;
  odds: number; // popOdds(chainId): each minute the vault pops with a 1-in-odds chance
  nextMinute: number; // first minute not yet in a checkpoint
  refBlock: bigint; // the last checkpoint's refBlock (0n before the first)
  emitted: bigint; // all minute emission so far (trader parts + vault parts), for the supply room
  vault: bigint; // HLO in the vault now (what the last pop kept, plus everything since)
  points: Map<Addr, bigint>; // points since the last pop, in fee units (1e-8 USDC)
  pointsTotal: bigint;
  earned: Map<Addr, bigint>; // cumulative entitlement E(u)
  totals: Map<Addr, UserTotals>;
  refiningCarry: bigint;
}

export interface CheckpointInput {
  throughMinute: number;
  refBlock: bigint;
  rows: readonly FeeRow[]; // counted fees of minutes nextMinute..throughMinute
  /** One seed per minute nextMinute..throughMinute, in order (ops/src/seed.ts). */
  seeds: readonly Seed[];
  burned: bigint; // HloToken.totalBurned() at refBlock
  refined: bigint; // Σ Mining.Claimed.refined in (previous refBlock, refBlock]
  claimed: ReadonlyMap<Addr, bigint>; // Mining.claimed[user] at refBlock
  minimum: PopMinimum; // popMinimum(chainId): the least a wallet needs to share in a pop
}

/** One pop of the vault (spec 2026-10-30 §2 rule 6). */
export interface VaultPop {
  minute: number;
  block: bigint; // the minute's seed block
  amount: bigint; // what holders of points got (at most 90% of the vault)
  kept: bigint; // what stayed in the vault: the 10% plus rounding dust, or all of it when nobody had the minimum
  recipients: number; // holders whose share was above 0
  pointsTotal: bigint; // the points it was shared by: those of the wallets at the minimum
}

export interface CheckpointResult {
  throughMinute: number;
  refBlock: bigint;
  emitted: bigint; // this checkpoint's minute emission
  toTraders: bigint;
  toVault: bigint;
  fees: bigint;
  pops: VaultPop[]; // oldest first
  refiningPool: bigint;
  refiningShared: bigint;
  refiningCarry: bigint;
  vault: bigint;
  points: Map<Addr, bigint>; // copy
  pointsTotal: bigint;
  sharePoints: bigint; // the points that would share in a pop in the next minute: those of the wallets at the minimum
  totalEntitled: bigint;
  entitlements: Map<Addr, bigint>; // E(u) > 0
  totals: Map<Addr, UserTotals>; // copy
}

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

const checkOdds = (odds: unknown): number => {
  if (typeof odds !== "number" || !Number.isSafeInteger(odds) || odds < 1) throw new Error(`pop odds ${odds} is not a positive integer`);
  return odds;
};

export function newCalcState(launchTime: number, odds: number): CalcState {
  return {
    launchTime, odds: checkOdds(odds), nextMinute: 0, refBlock: 0n, emitted: 0n, vault: 0n,
    points: new Map(), pointsTotal: 0n, earned: new Map(), totals: new Map(), refiningCarry: 0n,
  };
}

const add = (m: Map<Addr, bigint>, u: Addr, v: bigint) => m.set(u, (m.get(u) ?? 0n) + v);
const tot = (s: CalcState, u: Addr): UserTotals => {
  let t = s.totals.get(u);
  if (!t) s.totals.set(u, (t = { fees: 0n, mined: 0n, fromVault: 0n, refined: 0n }));
  return t;
};
const min = (a: bigint, b: bigint) => (a < b ? a : b);

const pointsAtLeast = (points: ReadonlyMap<Addr, bigint>, least: bigint): bigint => {
  let sum = 0n;
  for (const p of points.values()) if (p >= least) sum += p;
  return sum;
};

/**
 * Rule 6: 90% of the vault by points among the wallets with at least `least` (each share rounded down); the vault keeps the
 * rest; every point resets, also those under the minimum. Mutates `s`.
 */
function pop(s: CalcState, minute: number, block: bigint, least: bigint): VaultPop {
  const v = s.vault;
  const pay = (v * 9n) / 10n;
  let amount = 0n;
  let recipients = 0;
  const shared = pointsAtLeast(s.points, least);
  if (shared > 0n) {
    for (const [u, p] of s.points) {
      if (p < least) continue;
      const a = (pay * p) / shared;
      if (a > 0n) {
        add(s.earned, u, a);
        tot(s, u).fromVault += a;
        amount += a;
        recipients++;
      }
    }
  }
  const out: VaultPop = { minute, block, amount, kept: v - amount, recipients, pointsTotal: shared };
  s.vault = v - amount;
  s.points = new Map();
  s.pointsTotal = 0n;
  return out;
}

/**
 * Settles minutes nextMinute..throughMinute (spec 2026-10-29 §3 as changed by 2026-10-30 §2): per minute the trader
 * emission, the vault part and dust into the vault, the fees into the points, then the pop test on the minute's seed.
 * Then shares refining. Mutates `s`.
 */
export function applyCheckpoint(s: CalcState, c: CheckpointInput): CheckpointResult {
  // Validate before touching the state, so a throw leaves `s` unchanged.
  if (!Number.isSafeInteger(c.throughMinute)) throw new Error(`throughMinute ${c.throughMinute} is not a safe integer`);
  if (c.burned < 0n) throw new Error(`burned ${c.burned} is negative`);
  if (c.refined < 0n) throw new Error(`refined ${c.refined} is negative`);
  if (c.throughMinute < s.nextMinute) throw new Error(`minute ${c.throughMinute} is already checkpointed`);
  if (c.refBlock < s.refBlock) throw new Error(`refBlock ${c.refBlock} is below ${s.refBlock}`);
  const first = s.nextMinute;
  const count = c.throughMinute - first + 1;
  if (c.seeds.length !== count) throw new Error(`${c.seeds.length} seeds for the ${count} minutes ${first}..${c.throughMinute}`);
  c.seeds.forEach((sd, i) => {
    if (sd.minute !== first + i) throw new Error(`seed ${i} is for minute ${sd.minute}, not ${first + i}`);
    if (!HASH_RE.test(sd.hash)) throw new Error(`seed for minute ${sd.minute}: bad block hash ${sd.hash}`);
    if (sd.block < 0n || (i > 0 && sd.block < c.seeds[i - 1].block)) throw new Error(`seed for minute ${sd.minute}: block ${sd.block} is out of order`);
  });
  for (const r of c.rows) {
    if (r.minute < first || r.minute > c.throughMinute) throw new Error(`row for minute ${r.minute} is outside ${first}..${c.throughMinute}`);
    if (r.fee <= 0n) throw new Error(`non-positive fee in row for minute ${r.minute}`);
  }
  const fees = feesByMinute(c.rows);
  const room = MAX_SUPPLY - POOL_RESERVE + c.burned;
  let emitted = 0n;
  let toTraders = 0n;
  let toVault = 0n;
  let feeSum = 0n;
  const pops: VaultPop[] = [];

  for (let m = first; m <= c.throughMinute; m++) {
    const left = room > s.emitted ? room - s.emitted : 0n;
    const trader = min(TRADER_PER_MINUTE, left);
    const vaultPart = min(VAULT_PER_MINUTE, left - trader);
    s.emitted += trader + vaultPart;
    emitted += trader + vaultPart;

    const f = fees.get(m);
    let F = 0n;
    if (f) for (const v of f.values()) F += v;
    let paid = 0n;
    if (f && F > 0n) {
      for (const [u, v] of f) {
        const a = (trader * v) / F;
        const t = tot(s, u);
        t.fees += v;
        if (a > 0n) {
          add(s.earned, u, a);
          t.mined += a;
          paid += a;
        }
        add(s.points, u, v);
      }
      s.pointsTotal += F;
      feeSum += F;
    }
    toTraders += paid;
    toVault += trader - paid + vaultPart;
    s.vault += trader - paid + vaultPart;

    const seed = c.seeds[m - first];
    if (popsAt(seed.hash, m, s.odds)) pops.push(pop(s, m, seed.block, minimumAt(c.minimum, m)));
  }
  s.nextMinute = c.throughMinute + 1;
  s.refBlock = c.refBlock;

  // Refining (spec §3 rule 10): the pool plus carry, by unclaimed balance at refBlock.
  const pool = c.refined + s.refiningCarry;
  let shared = 0n;
  if (pool > 0n) {
    const base: [Addr, bigint][] = [];
    let total = 0n;
    for (const [u, e] of s.earned) {
      const cl = c.claimed.get(u) ?? 0n;
      if (e > cl) {
        base.push([u, e - cl]);
        total += e - cl;
      }
    }
    if (total > 0n) {
      for (const [u, b] of base) {
        const a = (pool * b) / total;
        if (a > 0n) {
          add(s.earned, u, a);
          tot(s, u).refined += a;
          shared += a;
        }
      }
    }
  }
  s.refiningCarry = pool - shared;

  let totalEntitled = 0n;
  const entitlements = new Map<Addr, bigint>();
  for (const [u, e] of s.earned) {
    if (e > 0n) entitlements.set(u, e);
    totalEntitled += e;
  }
  return {
    throughMinute: c.throughMinute, refBlock: c.refBlock, emitted, toTraders, toVault, fees: feeSum, pops,
    refiningPool: pool, refiningShared: shared, refiningCarry: s.refiningCarry,
    vault: s.vault, points: new Map(s.points), pointsTotal: s.pointsTotal,
    sharePoints: pointsAtLeast(s.points, minimumAt(c.minimum, s.nextMinute)),
    totalEntitled, entitlements, totals: new Map([...s.totals].map(([u, t]) => [u, { ...t }] as const)),
  };
}

const byAddr = ([a]: [Addr, unknown], [b]: [Addr, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** Deterministic JSON (maps as sorted arrays, bigints as strings). Version 2: the vault pops. */
export function serializeState(s: CalcState): string {
  const m = (x: Map<Addr, bigint>) => [...x].sort(byAddr).map(([u, v]) => [u, v.toString()]);
  const t = [...s.totals].sort(byAddr)
    .map(([u, v]) => [u, v.fees.toString(), v.mined.toString(), v.fromVault.toString(), v.refined.toString()]);
  return JSON.stringify({
    v: 2, launchTime: s.launchTime, odds: s.odds, nextMinute: s.nextMinute, refBlock: s.refBlock.toString(),
    emitted: s.emitted.toString(), vault: s.vault.toString(), points: m(s.points), pointsTotal: s.pointsTotal.toString(),
    earned: m(s.earned), totals: t, refiningCarry: s.refiningCarry.toString(),
  });
}

export function deserializeState(text: string): CalcState {
  const j = JSON.parse(text);
  if (j.v === 1) throw new Error("calc state version 1 is from before the vault pops: start from a fresh state directory");
  if (j.v !== 2) throw new Error("unknown calc state version");
  if (!Number.isSafeInteger(j.launchTime)) throw new Error(`launchTime ${j.launchTime} is not a safe integer`);
  const odds = checkOdds(j.odds);
  const m = (a: [string, string][]) => new Map(a.map(([u, v]) => [u as Addr, BigInt(v)] as const));
  return {
    launchTime: j.launchTime, odds, nextMinute: j.nextMinute, refBlock: BigInt(j.refBlock),
    emitted: BigInt(j.emitted), vault: BigInt(j.vault), points: m(j.points), pointsTotal: BigInt(j.pointsTotal),
    earned: m(j.earned),
    totals: new Map((j.totals as string[][]).map(([u, f, mi, fv, r]) => [u as Addr, { fees: BigInt(f), mined: BigInt(mi), fromVault: BigInt(fv), refined: BigInt(r) }] as const)),
    refiningCarry: BigInt(j.refiningCarry),
  };
}

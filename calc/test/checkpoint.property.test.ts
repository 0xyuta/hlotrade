import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applyCheckpoint, HLO, MAX_SUPPLY, newCalcState, POOL_RESERVE, type Addr, type FeeRow } from "../src/index.js";
import { seedsFor } from "./helpers/seeds.js";

const USERS = ["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"] as const;
const ODDS = 3;
/** Partway through and at a size some wallets miss, so the money still adds up with wallets left out of a pop. */
const MINIMUM = { fromMinute: 5, units: 50n };
/** Which of minutes 0..29 pop. */
const popBits = fc.array(fc.boolean(), { minLength: 30, maxLength: 30 });
const popList = (bits: readonly boolean[]) => bits.flatMap((b, m) => (b ? [m] : []));

describe("emission accounting", () => {
  it("minute payouts + pop payouts + the vault left = 1.1 HLO × minutes, however the minutes are split into checkpoints", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 29 }), fc.integer({ min: 0, max: 2 }), fc.bigInt({ min: 1n, max: 10n ** 9n }))),
        fc.array(fc.integer({ min: 0, max: 29 }), { maxLength: 6 }),
        popBits,
        (raw, cuts, bits) => {
          const rows: FeeRow[] = raw.map(([minute, u, fee]) => ({ minute, user: USERS[u], fee }));
          const pop = popList(bits);
          const ends = [...new Set([...cuts, 29])].sort((a, b) => a - b);
          const s = newCalcState(0, ODDS);
          let from = 0;
          let toTraders = 0n;
          let popped = 0n;
          let popCount = 0;
          let last;
          for (const end of ends) {
            last = applyCheckpoint(s, { minimum: MINIMUM,
              throughMinute: end, refBlock: 1n, rows: rows.filter((r) => r.minute >= from && r.minute <= end),
              seeds: seedsFor(from, end, { odds: ODDS, pop }), burned: 0n, refined: 0n, claimed: new Map(),
            });
            toTraders += last.toTraders;
            popped += last.pops.reduce((a, p) => a + p.amount, 0n);
            popCount += last.pops.length;
            for (const p of last.pops) expect(p.kept >= 0n && p.amount <= ((p.amount + p.kept) * 9n) / 10n).toBe(true); // at most 90% leaves
            from = end + 1;
          }
          expect(toTraders + popped + last!.vault).toBe(30n * 11n * 10n ** 17n);
          expect(last!.totalEntitled).toBe(toTraders + popped);
          expect(popCount).toBe(pop.length);
        },
      ),
    );
  });
});

describe("two checkpoints from a random starting state", () => {
  it("(a) supply room, (b) refining conservation, (c) entitlement growth", () => {
    const toMap = (pairs: readonly (readonly [number, bigint])[]) => new Map<Addr, bigint>(pairs.map(([u, v]) => [USERS[u], v] as const));
    const amount = fc.bigInt({ min: 0n, max: 10n ** 9n });
    const claims = fc.array(fc.tuple(fc.integer({ min: 0, max: 2 }), amount), { maxLength: 3 });
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: 29 }), fc.integer({ min: 0, max: 2 }), fc.bigInt({ min: 1n, max: 10n ** 9n })), { maxLength: 40 }),
        fc.integer({ min: 0, max: 28 }), // the first checkpoint covers minutes 0..cut, the second cut+1..29
        popBits,
        fc.bigInt({ min: 0n, max: 5n * HLO }), // room left below the cap at the start (may bind)
        amount, // burned at the first checkpoint
        amount, // burn added before the second
        amount, // refined in the first
        amount, // refined in the second
        claims,
        claims,
        (raw, cut, bits, headroom, burned1, extraBurn, refined1, refined2, claimed1, claimed2) => {
          const rows: FeeRow[] = raw.map(([minute, u, fee]) => ({ minute, user: USERS[u], fee }));
          const pop = popList(bits);
          const s = newCalcState(0, ODDS);
          s.emitted = MAX_SUPPLY - POOL_RESERVE - headroom;
          const r1 = applyCheckpoint(s, { minimum: MINIMUM, throughMinute: cut, refBlock: 1n, rows: rows.filter((r) => r.minute <= cut), seeds: seedsFor(0, cut, { odds: ODDS, pop }), burned: burned1, refined: refined1, claimed: toMap(claimed1) });
          const burned2 = burned1 + extraBurn;
          const r2 = applyCheckpoint(s, { minimum: MINIMUM, throughMinute: 29, refBlock: 2n, rows: rows.filter((r) => r.minute > cut), seeds: seedsFor(cut + 1, 29, { odds: ODDS, pop }), burned: burned2, refined: refined2, claimed: toMap(claimed2) });

          // (a) each checkpoint emits 1.1 HLO a minute until the supply room (cap - reserve + burned) runs out, counted from the starting emission
          const perMinute = HLO + HLO / 10n;
          const e0 = MAX_SUPPLY - POOL_RESERVE - headroom;
          const fit = (minutes: number, room: bigint, before: bigint) => {
            const left = room - before;
            const want = BigInt(minutes) * perMinute;
            return left <= 0n ? 0n : want < left ? want : left;
          };
          const want1 = fit(cut + 1, MAX_SUPPLY - POOL_RESERVE + burned1, e0);
          expect(r1.emitted).toBe(want1);
          expect(r2.emitted).toBe(fit(29 - cut, MAX_SUPPLY - POOL_RESERVE + burned2, e0 + want1));

          // (b) refining: the pool is this refined plus the carry from before; shared plus the new carry make up the pool
          expect(r2.refiningPool).toBe(refined2 + r1.refiningCarry);
          expect(r2.refiningShared + r2.refiningCarry).toBe(r2.refiningPool);

          // (c) the cumulative entitlement rises by the trader share, the pop payouts and the refining shared
          const popped2 = r2.pops.reduce((a, p) => a + p.amount, 0n);
          expect(r2.totalEntitled - r1.totalEntitled).toBe(r2.toTraders + popped2 + r2.refiningShared);
        },
      ),
    );
  });
});

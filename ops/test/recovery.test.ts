import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newCalcState, serializeState, type Addr } from "@hlo/calc";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { checkpointsAbi } from "../src/abi.js";
import type { Ctx } from "../src/context.js";
import { buildRecovery, formatRecovery, loadRecoveryInput, type RecoveryInput } from "../src/recovery.js";
import { Store } from "../src/store.js";

const CP = "0x00000000000000000000000000000000000000c0" as Address;
const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const BAD = "0x00000000000000000000000000000000000000ee";
const R = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const E = 10n ** 18n;
const base: RecoveryInput = {
  checkpoints: CP, paused: true, anySettled: true, latestMinute: 12, anyValid: true, latestValidMinute: 12, latestCancelled: false, writtenOff: 0n,
  verified: { minute: 9, root: R(9) }, rootOfVerified: R(9),
  honest: new Map([[A, 10n * E], [B, 4n * E]]),
  claimed: new Map([[A, 9n * E], [BAD, 5_000n * E]]),
  newPoster: "0x0000000000000000000000000000000000000077",
  honestThrough: 11,
};
const calls = (r: ReturnType<typeof buildRecovery>) => r.txs.map((t) => decodeFunctionData({ abi: checkpointsAbi, data: t.data }));

describe("buildRecovery", () => {
  it("keeps the verifier's last checked minute, writes off what was claimed above honest entitlements, rotates and unpauses last", () => {
    const r = buildRecovery(base);
    expect(r.keep).toBe(9);
    expect(r.cancel).toEqual({ from: 10, to: 12 });
    expect(r.excess).toEqual([{ user: BAD, claimed: 5_000n * E, honest: 0n, excess: 5_000n * E }]);
    expect(r.writeOff).toBe(5_000n * E);
    expect(calls(r).map((c) => [c.functionName, c.args])).toEqual([
      ["cancelAfter", [9n]], ["writeOff", [5_000n * E]], ["setPoster", [base.newPoster]], ["setPaused", [false]],
    ]);
    expect(r.txs.every((t) => t.to === CP)).toBe(true);
    expect(r.notes).toEqual([]);
  });
  it("nothing good ever settled: cancelAll", () => {
    const r = buildRecovery({ ...base, verified: null, rootOfVerified: null });
    expect(r.keep).toBeNull();
    expect(r.cancel).toEqual({ from: 0, to: 12 });
    expect(calls(r)[0].functionName).toBe("cancelAll");
  });
  it("the last checked minute is the latest: nothing to cancel, no write-off without excess", () => {
    const r = buildRecovery({ ...base, verified: { minute: 12, root: R(12) }, rootOfVerified: R(12), claimed: new Map([[A, 9n * E]]), newPoster: null });
    expect(r.cancel).toBeNull();
    expect(r.writeOff).toBe(0n);
    expect(calls(r).map((c) => c.functionName)).toEqual(["setPaused"]);
  });
  it("the chain's root for the verifier's minute differs (cancelled before?): no transactions, a note for a human", () => {
    const r = buildRecovery({ ...base, rootOfVerified: R(0) });
    expect(r.txs).toEqual([]);
    expect(r.notes[0]).toMatch(/minute 9 .* not the root the verifier checked/);
  });
  it("not paused: the first note says to pause first", () => {
    expect(buildRecovery({ ...base, paused: false }).notes[0]).toBe("Checkpoints is not paused: pause first (pause() with the pauser key, or from the Safe).");
  });
  it("already cancelled after the kept minute: no cancelAfter, a note", () => {
    const r = buildRecovery({ ...base, latestValidMinute: 9, latestCancelled: true });
    expect(calls(r).map((c) => c.functionName)).toEqual(["writeOff", "setPoster", "setPaused"]);
    expect(r.cancel).toBeNull();
    expect(r.notes).toEqual(["Minutes after 9 are already cancelled."]);
  });
  it("already cancelAll'd: no cancelAll, a note", () => {
    const r = buildRecovery({ ...base, verified: null, rootOfVerified: null, anyValid: false, latestValidMinute: 0, latestCancelled: true });
    expect(calls(r).map((c) => c.functionName)).not.toContain("cancelAll");
    expect(r.notes).toEqual(["Every settled minute is already cancelled."]);
  });
  it("already written off in full: no writeOff transaction, both amounts shown", () => {
    const r = buildRecovery({ ...base, writtenOff: 5_000n * E });
    expect(calls(r).map((c) => c.functionName)).toEqual(["cancelAfter", "setPoster", "setPaused"]);
    const text = formatRecovery(r);
    expect(text).toContain("write-off: 5000.00 HLO");
    expect(text).toContain("already written off: 5000.00 HLO");
  });
  it("partly written off: writeOff of the difference", () => {
    const r = buildRecovery({ ...base, writtenOff: 2_000n * E });
    expect(r.writeOff).toBe(5_000n * E);
    expect(calls(r).map((c) => [c.functionName, c.args]).find(([f]) => f === "writeOff")).toEqual(["writeOff", [3_000n * E]]);
    expect(formatRecovery(r)).toContain("writeOff(3000000000000000000000)");
  });
  it("formats for a human: amounts in HLO, each transaction's function, target and calldata", () => {
    const text = formatRecovery(buildRecovery(base));
    expect(text).toContain("keep minute 9, cancel minutes 10..12");
    expect(text).toContain("write-off: 5000.00 HLO");
    expect(text).toContain("1. cancelAfter(9)");
    expect(text).toContain(`to ${CP}`);
    expect(text).toMatch(/data 0x[0-9a-f]+/);
  });
  it("says which minute \"honest\" is as of", () => {
    expect(formatRecovery(buildRecovery(base))).toContain(`"honest" is each wallet's entitlement as of the verifier's last verified minute 11`);
    expect(formatRecovery(buildRecovery({ ...base, honestThrough: null }))).toContain(`"honest" is 0 for every wallet: the verifier has verified no minute yet`);
  });
});

describe("loadRecoveryInput", () => {
  const MINING = "0x00000000000000000000000000000000000000d0" as Address;
  const DEPLOY = 100n;
  const HEAD = 1_000n;
  /** A verifier state dir whose replay is through minute 11, with refBlock 500; a fake chain with Claimed events. */
  function fixture(claims: { user: string; block: bigint; claimed: bigint }[]) {
    const dir = mkdtempSync(join(tmpdir(), "recovery-"));
    const store = new Store(dir);
    const state = newCalcState(1_800_000_000, 1);
    state.nextMinute = 12;
    state.refBlock = 500n;
    state.earned = new Map([[A as Addr, 10n * E], [BAD as Addr, 1n * E]]);
    store.writeJson("verifier-state", { last: { minute: 9, root: R(9) }, state: serializeState(state) });
    const ranges: [bigint, bigint][] = [];
    const cpReads: Record<string, unknown> = {
      paused: true, anySettled: true, latestMinute: 12n, anyValid: true, latestValidMinute: 12n, writtenOff: 0n, isCancelled: false, rootOf: R(9),
    };
    const client = {
      readContract: async ({ address, functionName, args }: { address: Address; functionName: string; args?: readonly unknown[] }) => {
        if (address === MINING && functionName === "claimed") {
          const u = (args![0] as string).toLowerCase();
          return claims.filter((c) => c.user === u).reduce((m, c) => (c.claimed > m ? c.claimed : m), 0n);
        }
        if (address === CP && functionName in cpReads) return cpReads[functionName];
        throw new Error(`unexpected read ${functionName}`);
      },
      getBlockNumber: async () => HEAD,
      getContractEvents: async ({ address, eventName, fromBlock, toBlock }: { address: Address; eventName: string; fromBlock: bigint; toBlock: bigint }) => {
        expect(address).toBe(MINING);
        expect(eventName).toBe("Claimed");
        ranges.push([fromBlock, toBlock]);
        return claims.filter((c) => c.block >= fromBlock && c.block <= toBlock).map((c) => ({ args: { user: c.user } }));
      },
    };
    const ctx = { store, client, d: { checkpoints: CP, mining: MINING, deployBlock: DEPLOY }, cfg: { logChunk: 300n } } as unknown as Ctx;
    return { ctx, ranges, done: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("finds a claim made before the verifier's refBlock (a bad minute claimed while the poster was behind)", async () => {
    const f = fixture([
      { user: BAD, block: 200n, claimed: 400n * E }, // before refBlock 500
      { user: A, block: 600n, claimed: 9n * E },
    ]);
    try {
      const input = await loadRecoveryInput(f.ctx, null);
      // Every Claimed event from the deploy block to the head, in LOG_CHUNK pieces.
      expect(f.ranges).toEqual([[100n, 399n], [400n, 699n], [700n, 999n], [1000n, 1000n]]);
      expect(input.claimed).toEqual(new Map([[BAD, 400n * E], [A, 9n * E]]));
      expect(input.honestThrough).toBe(11);
      const r = buildRecovery(input);
      expect(r.excess).toEqual([{ user: BAD, claimed: 400n * E, honest: 1n * E, excess: 399n * E }]);
      expect(r.writeOff).toBe(399n * E);
    } finally {
      f.done();
    }
  });
});

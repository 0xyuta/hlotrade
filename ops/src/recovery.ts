import { deserializeState, type Addr } from "@hlo/calc";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { checkpointsAbi, miningAbi } from "./abi.js";
import type { Ctx } from "./context.js";

/**
 * The recovery report (spec 2026-10-30 §4): what the guardian (the Safe) should send after a bad checkpoint was settled.
 * Read-only: it prints transactions and sends nothing.
 */
export interface RecoveryInput {
  checkpoints: Address;
  paused: boolean;
  anySettled: boolean;
  latestMinute: number;
  anyValid: boolean;
  latestValidMinute: number;
  /** Checkpoints.isCancelled(latestMinute), false when nothing was settled. */
  latestCancelled: boolean;
  /** Checkpoints.writtenOff(): already written off (a write-off accumulates, so only the rest is sent). */
  writtenOff: bigint;
  /** The verifier's `last`: the newest Settled minute whose root it checked against its own replay. */
  verified: { minute: number; root: Hex } | null;
  /** Checkpoints.rootOf(verified.minute) now. */
  rootOfVerified: Hex | null;
  /** Honest cumulative entitlements: the verifier's replayed state, through minute `honestThrough`. */
  honest: ReadonlyMap<string, bigint>;
  /** The verifier's last verified minute (its replay is through it), or null when it has verified none. */
  honestThrough: number | null;
  /** Mining.claimed at the head, for every wallet with a Claimed event since the deploy block. */
  claimed: ReadonlyMap<string, bigint>;
  newPoster: Address | null;
}

export interface RecoveryReport {
  keep: number | null;
  cancel: { from: number; to: number } | null;
  excess: { user: string; claimed: bigint; honest: bigint; excess: bigint }[];
  /** The sum of the excess claims. */
  writeOff: bigint;
  /** Checkpoints.writtenOff() already (0 on a first run). */
  alreadyWrittenOff: bigint;
  /** The minute "honest" is as of (the verifier's last verified minute), or null when it has verified none. */
  honestThrough: number | null;
  txs: { to: Address; call: string; data: Hex }[];
  notes: string[];
}

const tx = (to: Address, functionName: "cancelAfter" | "cancelAll" | "writeOff" | "setPoster" | "setPaused", args: readonly unknown[], call: string) => ({
  to, call, data: encodeFunctionData({ abi: checkpointsAbi, functionName, args } as never) as Hex,
});

export function buildRecovery(i: RecoveryInput): RecoveryReport {
  const notes: string[] = [];
  if (!i.paused) notes.push("Checkpoints is not paused: pause first (pause() with the pauser key, or from the Safe).");
  const excess = [...i.claimed]
    .map(([user, claimed]) => ({ user, claimed, honest: i.honest.get(user) ?? 0n }))
    .filter((x) => x.claimed > x.honest)
    .map((x) => ({ ...x, excess: x.claimed - x.honest }))
    .sort((a, b) => (a.excess > b.excess ? -1 : a.excess < b.excess ? 1 : 0));
  const writeOff = excess.reduce((s, x) => s + x.excess, 0n);
  const alreadyWrittenOff = i.writtenOff;
  let keep: number | null = null;
  let cancel: RecoveryReport["cancel"] = null;
  const txs: RecoveryReport["txs"] = [];
  if (i.verified && i.rootOfVerified?.toLowerCase() !== i.verified.root.toLowerCase()) {
    notes.push(`The chain's root for minute ${i.verified.minute} is ${i.rootOfVerified}, not the root the verifier checked (${i.verified.root}). Choose the minute to keep by hand.`);
    return { keep, cancel, excess, writeOff, alreadyWrittenOff, honestThrough: i.honestThrough, txs, notes };
  }
  if (i.anySettled) {
    if (i.verified === null) {
      if (!i.anyValid && i.latestCancelled) notes.push("Every settled minute is already cancelled.");
      else {
        cancel = { from: 0, to: i.latestMinute };
        txs.push(tx(i.checkpoints, "cancelAll", [], "cancelAll()"));
      }
    } else {
      keep = i.verified.minute;
      if (keep < i.latestMinute) {
        if (keep === i.latestValidMinute && i.latestCancelled) notes.push(`Minutes after ${keep} are already cancelled.`);
        else {
          cancel = { from: keep + 1, to: i.latestMinute };
          txs.push(tx(i.checkpoints, "cancelAfter", [BigInt(keep)], `cancelAfter(${keep})`));
        }
      }
    }
  }
  const remaining = writeOff - alreadyWrittenOff;
  if (remaining > 0n) txs.push(tx(i.checkpoints, "writeOff", [remaining], `writeOff(${remaining})`));
  if (i.newPoster) txs.push(tx(i.checkpoints, "setPoster", [i.newPoster], `setPoster(${i.newPoster})`));
  txs.push(tx(i.checkpoints, "setPaused", [false], "setPaused(false)"));
  return { keep, cancel, excess, writeOff, alreadyWrittenOff, honestThrough: i.honestThrough, txs, notes };
}

const hlo = (x: bigint) => `${x / 10n ** 18n}.${((x % 10n ** 18n) / 10n ** 16n).toString().padStart(2, "0")}`;

export function formatRecovery(r: RecoveryReport): string {
  const out: string[] = [];
  for (const n of r.notes) out.push(`NOTE: ${n}`);
  out.push(r.cancel ? (r.keep === null ? `cancel every settled minute 0..${r.cancel.to}` : `keep minute ${r.keep}, cancel minutes ${r.cancel.from}..${r.cancel.to}`) : "nothing to cancel");
  out.push(`write-off: ${hlo(r.writeOff)} HLO`);
  out.push(
    r.honestThrough === null
      ? `"honest" is 0 for every wallet: the verifier has verified no minute yet`
      : `"honest" is each wallet's entitlement as of the verifier's last verified minute ${r.honestThrough}`,
  );
  if (r.alreadyWrittenOff > 0n) out.push(`already written off: ${hlo(r.alreadyWrittenOff)} HLO`);
  for (const x of r.excess) out.push(`  ${x.user}: claimed ${hlo(x.claimed)}, honest ${hlo(x.honest)}, excess ${hlo(x.excess)}`);
  out.push("Safe transactions, in this order (setPaused(false) only after the poster runs with the new key and the verifier is ok):");
  r.txs.forEach((t, k) => out.push(`${k + 1}. ${t.call} to ${t.to} data ${t.data}`));
  return out.join("\n");
}

/**
 * Reads the chain and the verifier's saved state (this process's store must be the verifier's: run with the verifier's env).
 * `claimed` covers every wallet with a Claimed event since the deploy block (a bad minute may have been claimed before the
 * verifier's last refBlock, e.g. with settleAndClaim while the poster was behind): the claimers in the verifier's saved
 * tracker (through its last refBlock) plus a log scan after it. Each is read from Mining.claimed at the head
 * and compared with its honest entitlement as of the verifier's last verified minute.
 */
export async function loadRecoveryInput(ctx: Ctx, newPoster: Address | null): Promise<RecoveryInput> {
  const saved = ctx.store.readJson<{ last: { minute: number; root: Hex } | null; state: string } | null>("verifier-state", null);
  if (!saved) throw new Error("no verifier-state.json in this state dir: run with the verifier's env (STATE_DIR)");
  const state = deserializeState(saved.state);
  const read = <T>(functionName: string, args: readonly unknown[] = []) =>
    ctx.client.readContract({ address: ctx.d.checkpoints, abi: checkpointsAbi, functionName, args } as never) as Promise<T>;
  const [paused, anySettled, latestMinute, anyValid, latestValidMinute] = await Promise.all([
    read<boolean>("paused"), read<boolean>("anySettled"), read<bigint>("latestMinute"), read<boolean>("anyValid"), read<bigint>("latestValidMinute"),
  ]);
  const [writtenOff, latestCancelled] = await Promise.all([
    read<bigint>("writtenOff"),
    anySettled ? read<boolean>("isCancelled", [latestMinute]) : Promise.resolve(false),
  ]);
  const rootOfVerified = saved.last ? await read<Hex>("rootOf", [BigInt(saved.last.minute)]) : null;
  const head = await ctx.client.getBlockNumber();
  // Every claimer up to the verifier's last refBlock is in its saved tracker; only the blocks after it need a scan.
  const tracked = (saved as { tracker?: string }).tracker;
  const users = new Set<string>(tracked ? Object.keys((JSON.parse(tracked) as { claimed: Record<string, string> }).claimed).map((u) => u.toLowerCase()) : []);
  const from = tracked && state.refBlock + 1n > ctx.d.deployBlock ? state.refBlock + 1n : ctx.d.deployBlock;
  for (let a = from; a <= head; a += ctx.cfg.logChunk) {
    const b = a + ctx.cfg.logChunk - 1n < head ? a + ctx.cfg.logChunk - 1n : head;
    const logs = await ctx.client.getContractEvents({ address: ctx.d.mining, abi: miningAbi, eventName: "Claimed", fromBlock: a, toBlock: b });
    for (const l of logs) users.add((l.args.user as string).toLowerCase());
  }
  const claimed = new Map<string, bigint>();
  for (const u of users) {
    claimed.set(u, (await ctx.client.readContract({ address: ctx.d.mining, abi: miningAbi, functionName: "claimed", args: [u as Address] })) as bigint);
  }
  const honest = new Map<string, bigint>([...state.earned].map(([u, e]) => [u.toLowerCase(), e] as [string, bigint]));
  return {
    checkpoints: ctx.d.checkpoints, paused, anySettled, latestMinute: Number(latestMinute), anyValid, latestValidMinute: Number(latestValidMinute),
    latestCancelled, writtenOff,
    verified: saved.last, rootOfVerified, honest, honestThrough: state.nextMinute > 0 ? state.nextMinute - 1 : null, claimed, newPoster,
  };
}

export type { Addr };

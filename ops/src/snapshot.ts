import type { Addr } from "@hlo/calc";
import { miningAbi, tokenAbi } from "./abi.js";
import type { Ctx } from "./context.js";

export interface ClaimLog {
  user: Addr;
  /** Mining.claimed[user] after the claim (the Claimed event's claimedTotal). */
  claimedTotal: bigint;
  refined: bigint;
  block: bigint;
}

/** One HloToken `Transfer` log whose `to` is the zero address (the reader filters on it; `from` is checked again here). */
export interface BurnLog {
  from: Addr;
  to: Addr;
  value: bigint;
  block: bigint;
}

export interface ChainReaderForSnapshot {
  claimedLogs(from: bigint, to: bigint): Promise<ClaimLog[]>;
  /** HloToken Transfer logs with `to` = address(0) in [from, to]. */
  burnLogs(from: bigint, to: bigint): Promise<BurnLog[]>;
}

const ZERO = "0x0000000000000000000000000000000000000000";

export interface Snapshot {
  burned: bigint; // cumulative HLO burned since the deployment, as of ref (Σ Transfer(from ≠ 0, to = 0)); equals HloToken.totalBurned() at ref
  refined: bigint; // Σ Mining.Claimed.refined in (prev, ref]
  claimed: Map<Addr, bigint>; // Mining.claimed[user] as of ref
}

export const DEFAULT_LOG_CHUNK = 1000n;

/**
 * The chain inputs of a checkpoint, as of its `refBlock`. It keeps the running `claimed` map (the latest
 * Claimed.claimedTotal per user (= Mining.claimed[user])) and the running `burned` total (Σ of HloToken burns) so each checkpoint reads only the
 * logs since the previous one. Nothing here reads contract state at a block: an archive node is not needed.
 */
export class ChainTracker {
  private readonly claimed = new Map<Addr, bigint>();
  private burned = 0n;

  constructor(private readonly reader: ChainReaderForSnapshot, private readonly logChunk: bigint = DEFAULT_LOG_CHUNK) {
    if (logChunk <= 0n) throw new Error("logChunk must be > 0");
  }

  /** Reads the logs in (prevRef, ref] and folds them in. A throw leaves the tracker unchanged. */
  async snapshot(prevRef: bigint, ref: bigint): Promise<Snapshot> {
    if (ref < prevRef) throw new Error(`ref ${ref} is below prevRef ${prevRef}`);
    let refined = 0n;
    let burned = this.burned;
    const latest = new Map<Addr, bigint>();
    for (let from = prevRef + 1n; from <= ref; from += this.logChunk) {
      const to = from + this.logChunk - 1n < ref ? from + this.logChunk - 1n : ref;
      const [claimLogs, burnLogs] = await Promise.all([this.reader.claimedLogs(from, to), this.reader.burnLogs(from, to)]);
      const logs = [...claimLogs].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
      for (const l of logs) {
        refined += l.refined;
        // claimedTotal only grows, so the largest seen is the current claimed[user] whatever order the logs come in.
        const seen = latest.get(l.user);
        if (seen === undefined || l.claimedTotal > seen) latest.set(l.user, l.claimedTotal);
      }
      // A mint is Transfer(0, to, v): never a burn.
      for (const l of burnLogs) if (l.to.toLowerCase() === ZERO && l.from.toLowerCase() !== ZERO) burned += l.value;
    }
    for (const [u, e] of latest) {
      const prev = this.claimed.get(u);
      this.claimed.set(u, prev !== undefined && prev > e ? prev : e);
    }
    this.burned = burned;
    return { burned, refined, claimed: new Map(this.claimed) };
  }

  /** An independent copy (same reader and chunk size), so a caller can snapshot into it and keep this one if the work fails. */
  clone(): ChainTracker {
    const t = new ChainTracker(this.reader, this.logChunk);
    for (const [u, e] of this.claimed) t.claimed.set(u, e);
    t.burned = this.burned;
    return t;
  }

  toJSON(): string {
    return JSON.stringify({ claimed: Object.fromEntries([...this.claimed].map(([u, e]) => [u, e.toString()])), burned: this.burned.toString() });
  }

  static fromJSON(text: string, reader: ChainReaderForSnapshot, logChunk: bigint = DEFAULT_LOG_CHUNK): ChainTracker {
    const j = JSON.parse(text) as { claimed?: Record<string, string>; burned?: string };
    if (!j || typeof j.claimed !== "object" || j.claimed === null || Array.isArray(j.claimed)) throw new Error("bad tracker file");
    // A file without the running total (an older format) is refused: reading it as 0 would under-count every earlier burn.
    if (typeof j.burned !== "string" || !/^\d+$/.test(j.burned)) throw new Error("bad tracker file: burned total missing or malformed (start from a fresh state directory)");
    const t = new ChainTracker(reader, logChunk);
    t.burned = BigInt(j.burned);
    for (const [u, e] of Object.entries(j.claimed)) {
      if (!/^0x[0-9a-f]{40}$/.test(u) || typeof e !== "string" || !/^\d+$/.test(e)) throw new Error(`bad tracker entry ${u}`);
      t.claimed.set(u as Addr, BigInt(e));
    }
    return t;
  }
}

/** Reads Mining's Claimed logs and the token's Transfer-to-zero logs (the burns) from the public client. */
export function viemChainReader(ctx: Pick<Ctx, "client" | "d">): ChainReaderForSnapshot {
  const { client, d } = ctx;
  return {
    async claimedLogs(fromBlock, toBlock) {
      const logs = await client.getContractEvents({ address: d.mining, abi: miningAbi, eventName: "Claimed", fromBlock, toBlock });
      return logs.map((l) => ({
        user: l.args.user!.toLowerCase() as Addr,
        claimedTotal: l.args.claimedTotal!,
        refined: l.args.refined!,
        block: l.blockNumber,
      }));
    },
    async burnLogs(fromBlock, toBlock) {
      const logs = await client.getContractEvents({ address: d.token, abi: tokenAbi, eventName: "Transfer", args: { to: ZERO }, fromBlock, toBlock });
      return logs.map((l) => ({ from: l.args.from!.toLowerCase() as Addr, to: l.args.to!.toLowerCase() as Addr, value: l.args.value!, block: l.blockNumber }));
    },
  };
}

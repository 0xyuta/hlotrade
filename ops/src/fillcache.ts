import type { Addr, ApiFill } from "@hlo/calc";
import type { FillRead } from "./pacer.js";

interface Entry {
  from: number;
  through: number;
  fills: ApiFill[];
}

/** Per-wallet fills read through the newest finished minute, so several minutes of one wallet cost one call (spec 2026-10-31 §6). */
export class FillCache {
  private readonly held = new Map<string, Entry>();

  constructor(private readonly read: FillRead) {}

  /** The wallet's fills in [startMs, endMs]. `cached` says they came from an earlier read, which may predate a late-indexed fill. */
  async get(user: Addr, startMs: number, endMs: number, throughMs: number): Promise<{ fills: ApiFill[]; cached: boolean }> {
    let e = this.held.get(user);
    const cached = e !== undefined && e.from <= startMs && e.through >= endMs;
    if (!cached) {
      const through = Math.max(endMs, throughMs);
      e = { from: startMs, through, fills: await this.read(user, startMs, through) };
      this.held.set(user, e);
    }
    return { fills: e!.fills.filter((f) => f.time >= startMs && f.time <= endMs), cached };
  }

  /** Read now, whatever is held. */
  fresh(user: Addr, startMs: number, endMs: number): Promise<ApiFill[]> {
    return this.read(user, startMs, endMs);
  }

  /** Forgets fills older than `ms`. */
  dropBefore(ms: number): void {
    for (const [u, e] of this.held) {
      if (e.through < ms) this.held.delete(u);
      else if (e.from < ms) this.held.set(u, { from: ms, through: e.through, fills: e.fills.filter((f) => f.time >= ms) });
    }
  }
}

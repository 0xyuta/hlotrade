import { countedFee, minuteOf, type Addr, type ApiFill, type FeeRow } from "@hlo/calc";
import type { Registration } from "./registry.js";
import type { Store } from "./store.js";

export interface FillSource {
  fills(user: Addr, startMs: number, endMs: number): Promise<ApiFill[]>;
}

interface Saved {
  v: 2;
  /** The last ms of the last minute fully read; −1 before the first. */
  coveredThrough: number;
  /** Only wallets ahead of coveredThrough. */
  cursors: Record<string, number>;
  /** Wallet → its newest counted fill (ms), for the last 24 hours. */
  recent: Record<string, number>;
  rows: [number, string, string][]; // [minute, user, fee]
}

const FILE = "ingest";
const ADDR = /^0x[0-9a-f]{40}$/;
const SAVE_EVERY_MS = 10_000;
const RECENT_MS = 24 * 3600 * 1000;

/**
 * Per-wallet fills → per-minute fee rows. A cursor per wallet (ms, the last `endMs` fetched through) lets each pass ask
 * only for what is new; `coveredThrough` is the end of the last minute whose wallets were all read, so a wallet with no
 * cursor behind it needs no fetch up to there, and only cursors ahead of it are kept. `recent` is each wallet's newest
 * counted fill over the last 24 hours. Rows, cursors and `recent` persist together in one atomic `ingest.json`, saved at
 * most every 10 s while a pass runs and at its end: a crash refetches what was not saved and never counts a fee twice.
 * Addresses are lowercase. A version 1 file (cursors and rows only) loads with nothing covered.
 */
export class Ingest {
  private readonly cursors = new Map<string, number>();
  private readonly recent = new Map<string, number>();
  private covered = -1;
  private savedAt: number;
  /** minute → user → fee */
  private readonly byMinute = new Map<number, Map<string, bigint>>();

  constructor(
    private readonly store: Store,
    private readonly src: FillSource,
    private readonly launchTime: number,
    private readonly clock: () => number = Date.now,
  ) {
    this.savedAt = clock();
    const saved = store.readJson<unknown>(FILE, null);
    if (saved === null) return;
    const bad = (why: string) => new Error(`${FILE}.json is not a valid ingest file (${why}); delete it to refetch`);
    const version = typeof saved === "object" ? (saved as { v?: unknown }).v : undefined;
    if (version !== 1 && version !== 2) throw bad("version");
    const { cursors, rows } = saved as Saved;
    const addrMap = (m: unknown): m is Record<string, number> => typeof m === "object" && m !== null && !Array.isArray(m);
    if (!addrMap(cursors)) throw bad("cursors");
    if (!Array.isArray(rows)) throw bad("rows");
    for (const [u, c] of Object.entries(cursors)) {
      if (!ADDR.test(u) || !Number.isSafeInteger(c)) throw bad("cursor");
      this.cursors.set(u, c);
    }
    if (version === 2) {
      const { coveredThrough, recent } = saved as Saved;
      if (!Number.isSafeInteger(coveredThrough) || coveredThrough < -1) throw bad("coveredThrough");
      if (!addrMap(recent)) throw bad("recent");
      for (const [u, t] of Object.entries(recent)) {
        if (!ADDR.test(u) || !Number.isSafeInteger(t)) throw bad("recent");
        this.recent.set(u, t);
      }
      this.covered = coveredThrough;
    }
    for (const r of rows) {
      if (!Array.isArray(r) || r.length !== 3 || !Number.isSafeInteger(r[0]) || typeof r[1] !== "string" || !ADDR.test(r[1]) || typeof r[2] !== "string" || !/^\d+$/.test(r[2])) throw bad("row");
      this.add(r[0], r[1], BigInt(r[2]));
    }
  }

  private add(minute: number, user: string, fee: bigint) {
    let m = this.byMinute.get(minute);
    if (!m) this.byMinute.set(minute, (m = new Map()));
    m.set(user, (m.get(user) ?? 0n) + fee);
  }

  private save() {
    const rows: Saved["rows"] = this.rows(-Infinity, Infinity).map((r) => [r.minute, r.user, r.fee.toString()]);
    const saved: Saved = { v: 2, coveredThrough: this.covered, cursors: Object.fromEntries(this.cursors), recent: Object.fromEntries(this.recent), rows };
    this.store.writeJson(FILE, saved);
    this.savedAt = this.clock();
  }

  /** The last ms of the last minute whose wallets were all read, or −1 when none was. */
  get coveredThrough(): number {
    return this.covered;
  }

  /** Everything through `endMs` has been read. Cursors at or below it are no longer needed. */
  markCovered(endMs: number): void {
    this.covered = Math.max(this.covered, endMs);
    for (const [u, c] of this.cursors) if (c <= this.covered) this.cursors.delete(u);
    const oldest = this.covered - RECENT_MS;
    for (const [u, t] of this.recent) if (t < oldest) this.recent.delete(u);
    this.save();
  }

  /** Lowercase wallets whose newest counted fill (within the last 24 hours covered) is at or after `ms`. */
  recentSince(ms: number): string[] {
    const out: string[] = [];
    for (const [u, t] of this.recent) if (t >= ms) out.push(u);
    return out;
  }

  /**
   * Brings every wallet to at least `endMs` (inclusive), by its cursor or by `coveredThrough`: a wallet that is already
   * there is skipped, so a pass that is cut short (a rate limit, a timeout) is continued by the next one with the wallets
   * still behind, never from the first wallet again. A wallet that is fetched is fetched through `throughMs` (default
   * `endMs`; larger when more minutes are already finished, so a long gap costs one request per wallet). Stores the counted
   * fills and saves at most every 10 s, and at the end of the pass (also when it throws). A wallet's rows, `recent` entry
   * and cursor are applied together only after all its fills were read, so a failure leaves it untouched and the error
   * reaches the caller.
   * `throughMs` must not exceed what Hyperliquid has indexed: the caller's grace past a minute's end covers that ("now"
   * is chain time, never the wall clock). Returns how many wallets it fetched (a skipped wallet, or one with nothing to ask
   * for, is not counted).
   */
  async catchUp(regs: readonly Registration[], endMs: number, throughMs: number = endMs): Promise<number> {
    const fetchEnd = Math.max(endMs, throughMs);
    let dirty = false;
    let fetched = 0;
    try {
      for (const reg of regs) {
        const user = reg.user.toLowerCase() as Addr;
        const before = this.fetchedThrough(user);
        if (before >= endMs) continue;
        const startSec = Math.max(this.launchTime, reg.registeredAt);
        const start = Math.max(before + 1, startSec * 1000);
        const found: [number, bigint, number][] = [];
        if (start <= fetchEnd) {
          for (const f of await this.src.fills(user, start, fetchEnd)) {
            const fee = countedFee(f, startSec);
            if (fee !== null) found.push([minuteOf(this.launchTime, f.time), fee, f.time]);
          }
          fetched++;
        }
        for (const [minute, fee, time] of found) {
          this.add(minute, user, fee);
          if ((this.recent.get(user) ?? -1) < time) this.recent.set(user, time);
        }
        this.cursors.set(user, fetchEnd);
        dirty = true;
        if (this.clock() - this.savedAt >= SAVE_EVERY_MS) {
          this.save();
          dirty = false;
        }
      }
    } finally {
      if (dirty) this.save();
    }
    return fetched;
  }

  /** Stored rows of minutes in [from, through], by minute then user. */
  rows(from: number, through: number): FeeRow[] {
    const out: FeeRow[] = [];
    for (const [minute, users] of this.byMinute) {
      if (minute < from || minute > through) continue;
      for (const [user, fee] of users) out.push({ minute, user: user as Addr, fee });
    }
    return out.sort((a, b) => a.minute - b.minute || (a.user < b.user ? -1 : a.user > b.user ? 1 : 0));
  }

  /** The ms the wallet is fetched through: its cursor or `coveredThrough`, whichever is later; −1 when neither. */
  fetchedThrough(user: Addr): number {
    return Math.max(this.cursors.get(user.toLowerCase()) ?? -1, this.covered);
  }

  /** Forgets rows of minutes below `belowMinute`. Cursors, `coveredThrough` and `recent` stay. */
  prune(belowMinute: number): void {
    for (const m of [...this.byMinute.keys()]) if (m < belowMinute) this.byMinute.delete(m);
    this.save();
  }
}

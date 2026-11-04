import {
  applyCheckpoint, buildTree, deserializeState, newCalcState, popMinimum, popOdds, quietMinuteFrom, serializeState, type CalcState, type Seed,
} from "@hlo/calc";
import type { Address, Hex } from "viem";
import {
  buildFiles, buildUserFiles, checkpointPath, knownWallets, LATEST_PATH, MAX_POPS, ROUND, userFileEvery, type BuildArgs, type PopEntry, type UserFile,
} from "./checkpoint-files.js";
import type { Ingest } from "./ingest.js";
import { forEachLimit } from "./limit.js";
import { toJson, type Publisher, type PutOpts } from "./publish.js";
import type { Registration, Registry } from "./registry.js";
import type { Cp } from "./sign.js";
import type { ChainTracker } from "./snapshot.js";
import type { Store } from "./store.js";
import type { ActiveWallets } from "./tradefeed.js";

/**
 * The poster signs one checkpoint per minute and publishes it (spec §3 "Checkpoints", §5). It never sends a
 * transaction: anyone settles a published checkpoint on chain.
 */

export interface PosterDeps {
  /** The latest block's timestamp and number: "now" is chain time, never the wall clock. */
  now(): Promise<{ time: number; block: bigint }>;
  registry: Registry;
  ingest: Ingest;
  tracker: ChainTracker;
  /** Throws "POSTER_KEY is not Checkpoints.poster()" when the signing key is no longer the contract's poster. Called before every new checkpoint is signed. */
  checkSigner(): Promise<void>;
  /**
   * `Checkpoints.latestMinute()` where `anySettled()` (null while nothing is settled; minute 0 is a real minute). Anyone can settle a
   * published checkpoint, so the chain can be past the last user files written (see `writeUserFiles`).
   */
  settledMinute(): Promise<number | null>;
  sign(cp: Cp): Promise<Hex>;
  publish: Publisher;
  store: Store;
  launchTime: number;
  /** The seed blocks of minutes from..through, searched between block lo and hi (ops/src/seed.ts `seedBlocks` on the poster's client). */
  seeds(fromMinute: number, throughMinute: number, lo: bigint, hi: bigint): Promise<Seed[]>;
  chainId: number;
  contract: Address;
  /** Seconds past a minute's end before it is checkpointed (Hyperliquid indexing, registry writes). */
  graceSeconds: number;
  /** First block of the deployment: the first checkpoint reads chain logs from here. */
  deployBlock: bigint;
  /** Who traded and whether we were watching; null reads every wallet each minute (TRADE_FEED=off). */
  feed: ActiveWallets | null;
  log(s: string): void;
  alert(s: string): Promise<void>;
}

export type TickResult = "waiting" | "published" | "republished";

const STATE_FILE = "poster-state";
const PENDING_FILE = "pending";
const JSON_TYPE = "application/json";
/** latest.json changes every minute; the archive file never changes. */
const LATEST_OPTS: PutOpts = { maxAgeSeconds: 60 };
/** The user files are stored gzipped, and are not rewritten every minute (see `writeUserFiles`). */
const USER_FILE_OPTS: PutOpts = { maxAgeSeconds: 60, gzip: true };
const USER_FILE_LIMIT = 8;
/**
 * While the next minute is already due, or in a quiet minute, the user files are written only on the minutes divisible by
 * this, whatever the wallet count says. These are the minutes the keeper settles, so a file exists for what it settles.
 */
const SPARSE_EVERY = ROUND;

interface Pop {
  minute: number;
  block: bigint;
  amount: bigint;
  kept: bigint;
  recipients: number;
}

/** What survives a restart: the calculator state, the chain tracker, the last vault pops (newest first) and where the next seed search starts. */
interface Saved {
  state: string;
  tracker: string | null;
  pops: Pop[];
  seedFrom: bigint;
}

interface SavedFile {
  v: 2;
  state: string;
  tracker: string | null;
  pops: PopEntry[];
  seedFrom: string;
}

interface PendingFile {
  v: 1;
  throughMinute: number;
  archive: string;
  latest: string;
  next: SavedFile;
}

const toSavedFile = (s: Saved): SavedFile => ({
  v: 2,
  state: s.state,
  tracker: s.tracker,
  pops: s.pops.map((p) => ({ minute: p.minute, block: p.block.toString(), amount: p.amount.toString(), kept: p.kept.toString(), recipients: p.recipients })),
  seedFrom: s.seedFrom.toString(),
});

const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

const DIGITS = /^\d+$/;

function fromSavedFile(f: unknown, what: string): Saved {
  const bad = (why: string) => new Error(`${what} is not a valid poster state file (${why}); a human must look before it is deleted`);
  const v = (f as { v?: unknown } | null)?.v;
  if (v === 1) throw new Error(`${what} is from before the vault pops (version 1): it cannot be continued; a redeploy starts with a fresh state directory`);
  const j = f as Partial<SavedFile> | null;
  if (typeof j !== "object" || j === null || v !== 2) throw bad("version");
  if (typeof j.state !== "string") throw bad("state");
  if (j.tracker !== null && typeof j.tracker !== "string") throw bad("tracker");
  if (typeof j.seedFrom !== "string" || !DIGITS.test(j.seedFrom)) throw bad("seedFrom");
  if (!Array.isArray(j.pops)) throw bad("pops");
  return {
    state: j.state,
    tracker: j.tracker,
    seedFrom: BigInt(j.seedFrom),
    pops: j.pops.map((p) => {
      const ok = [p?.block, p?.amount, p?.kept].every((x) => typeof x === "string" && DIGITS.test(x)) && Number.isSafeInteger(p?.minute) && Number.isSafeInteger(p?.recipients);
      if (!ok) throw bad("pop");
      return { minute: p.minute, block: BigInt(p.block), amount: BigInt(p.amount), kept: BigInt(p.kept), recipients: p.recipients };
    }),
  };
}

/** The tracker JSON to restart from: the unfinished checkpoint's, else the last saved one, else null (start empty). */
export function savedTrackerJson(store: Store): string | null {
  const pending = store.readJson<PendingFile | null>(PENDING_FILE, null);
  if (pending) return fromSavedFile(pending.next, "pending.json").tracker;
  const saved = store.readJson<SavedFile | null>(STATE_FILE, null);
  return saved ? fromSavedFile(saved, `${STATE_FILE}.json`).tracker : null;
}

/** Throws unless the key's address is Checkpoints.poster(). Run at startup: a checkpoint signed by another key can never be settled. */
export async function checkPosterKey(account: Address, readPoster: () => Promise<Address>): Promise<void> {
  const onChain = await readPoster();
  if (account.toLowerCase() !== onChain.toLowerCase()) {
    throw new Error(`POSTER_KEY is not Checkpoints.poster() (key ${account}, on chain ${onChain})`);
  }
}

/**
 * Lets an alert through unless the same text went out less than `repeatMs` ago. Every distinct text has its own timer, so
 * two alternating alerts are each sent once per window. Entries older than the window are dropped, so the map stays small.
 */
export class AlertDedupe {
  private readonly sentAt = new Map<string, number>();
  constructor(private readonly repeatMs = 3_600_000) {}
  shouldSend(text: string, nowMs: number): boolean {
    for (const [t, at] of this.sentAt) if (nowMs - at >= this.repeatMs) this.sentAt.delete(t);
    if (this.sentAt.has(text)) return false;
    this.sentAt.set(text, nowMs);
    return true;
  }
}

/** Sleep seconds: `base`, then doubled on each further failure, capped. */
export class Backoff {
  private cur: number;
  constructor(private readonly base: number, private readonly cap: number) {
    this.cur = Math.min(base, cap);
  }
  next(): number {
    const out = this.cur;
    this.cur = Math.min(this.cur * 2, this.cap);
    return out;
  }
  reset() {
    this.cur = Math.min(this.base, this.cap);
  }
}

/** Seconds to sleep after a tick that had to wait. */
export const WAIT_SECONDS = 5;
const ERROR_BACKOFF_CAP = 300;
/** More than this not watched in a run of gap minutes: every registered wallet is read. */
export const LONG_GAP_MS = 300_000;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const FEED_KEEP_MS = 3_600_000;
/** A minute that has waited this long (chain time) for the feed is alerted. */
const FEED_WAIT_ALERT_SECONDS = 120;

export class Poster {
  private state: CalcState;
  private pops: Pop[];
  private seedFrom: bigint;
  private tracker: ChainTracker;
  private pending: PendingFile | null;
  private readonly dedupe = new AlertDedupe();
  private readonly backoff = new Backoff(WAIT_SECONDS, ERROR_BACKOFF_CAP);
  private lateSeen = 0;
  /** Unwatched ms in the current run of gap minutes (consecutive minutes that each have a gap); a fully watched minute ends the run. Not saved. */
  private gapRunMs = 0;
  /** The chain time the current minute began waiting for the feed to deliver; null when it is not waiting. */
  private feedWaitSince: number | null = null;
  /**
   * The next checkpoint that is in step writes its user files whatever the round says: true at a start, after a failed write,
   * after a checkpoint was republished from the write-ahead file (its numbers are not in memory) and after a skip while
   * behind. Not saved: a start sets it.
   */
  private userFilesOwed = true;
  /** Whether a write has been tried since this process started: the first checkpoint writes even while the poster is behind. */
  private userFilesTried = false;
  /** The checkpoint whose user files were last all written by this process; null before the first. Not saved. */
  private userFilesAt: number | null = null;
  /** The root of the last user files written: a minute with this root, no fee rows and no pop changes nothing a proof says. */
  private userFilesRoot: Hex | null = null;

  constructor(private readonly deps: PosterDeps) {
    this.tracker = deps.tracker;
    const odds = popOdds(deps.chainId);
    // An unfinished checkpoint's "next" state is the newest: it was written before the publish began.
    this.pending = deps.store.readJson<PendingFile | null>(PENDING_FILE, null);
    const file = this.pending ? this.pending.next : deps.store.readJson<SavedFile | null>(STATE_FILE, null);
    if (file) {
      const saved = fromSavedFile(file, this.pending ? "pending.json" : `${STATE_FILE}.json`);
      this.state = deserializeState(saved.state);
      this.pops = saved.pops;
      this.seedFrom = saved.seedFrom;
      if (this.state.launchTime !== deps.launchTime || this.state.odds !== odds) {
        throw new Error("the saved poster state is for another deployment (launchTime or pop odds differ)");
      }
    } else {
      this.state = newCalcState(deps.launchTime, odds);
      this.pops = [];
      this.seedFrom = deps.deployBlock;
    }
  }

  /** The next minute to checkpoint. */
  get nextMinute(): number {
    return this.state.nextMinute;
  }

  private saved(state: CalcState, tracker: ChainTracker, pops: Pop[], seedFrom: bigint): SavedFile {
    return toSavedFile({ state: serializeState(state), tracker: tracker.toJSON(), pops, seedFrom });
  }

  async tick(): Promise<TickResult> {
    const d = this.deps;
    if (this.pending) {
      this.userFilesOwed = true; // this checkpoint's user files were never written, and cannot be now
      return this.republish(this.pending);
    }

    const M = this.state.nextMinute;
    const end = d.launchTime + 60 * (M + 1);
    const now = await d.now();
    if (!this.isDue(M, now.time)) return "waiting";

    // Minute M needs every wallet fetched through M's end; a wallet that is already there is skipped, so a pass cut short
    // by a rate limit is continued next tick with the wallets still behind. A wallet that is fetched is fetched through the
    // newest finished minute, so a poster far behind asks once per wallet, not once per minute.
    const lastFinished = Math.floor((now.time - d.graceSeconds - d.launchTime) / 60) - 1;
    const finishedEndMs = (d.launchTime + 60 * (lastFinished + 1)) * 1000 - 1;
    const regs = (await d.registry.list()).filter((r) => r.registeredAt <= end);
    const endMs = end * 1000 - 1;
    const pick = await this.walletsToRead(regs, endMs, finishedEndMs, now.time);
    if (pick === null) return "waiting"; // the feed has not delivered through this minute yet
    const { list } = pick;
    d.feed?.setCovered(endMs); // from the moment the list is made: a trade of this minute arriving now is on no list
    let read = await d.ingest.catchUp(list, endMs, finishedEndMs);
    // A trade of this minute heard during the reads: read its wallets too. No await from the last ask to `markCovered`:
    // a trade heard after that counts as late and is alerted. Only trades timed at or before the minute enter, so it ends.
    for (let late = this.takeLate(); late.size > 0; late = this.takeLate()) {
      read += await d.ingest.catchUp(regs.filter((r) => late.has(r.user.toLowerCase())), endMs, finishedEndMs);
    }
    d.ingest.markCovered(endMs);
    // The run moves only here, once per minute: a read that fails and is retried does not count its gap again, and a retry
    // after this point (the minute already covered) has pick.gap null and does not end the run.
    if (pick.gap !== null) this.gapRunMs = pick.gap === 0 ? 0 : this.gapRunMs + pick.gap;
    d.feed?.prune(endMs - FEED_KEEP_MS);
    await this.reportLate(now.time);

    const refBlock = now.block;
    const prevRef = this.state.refBlock === 0n ? d.deployBlock - 1n : this.state.refBlock;
    // Snapshot into a copy: the tracker in use changes only once the write-ahead file is on disk.
    const tracker = this.tracker.clone();
    const snap = await tracker.snapshot(prevRef, refBlock);
    // Minute M's seed block lies between the previous seed block and refBlock (refBlock's time is past M's end plus the grace).
    const seeds = await d.seeds(M, M, this.seedFrom, refBlock);

    // Work on a copy: nothing in memory moves until the write-ahead file is on disk.
    const next = deserializeState(serializeState(this.state));
    const rows = d.ingest.rows(M, M);
    const result = applyCheckpoint(next, { throughMinute: M, refBlock, rows, seeds, burned: snap.burned, refined: snap.refined, claimed: snap.claimed, minimum: popMinimum(d.chainId), quietFrom: quietMinuteFrom(d.chainId) });
    const tree = buildTree(result.entitlements);
    await d.checkSigner();
    const sig = await d.sign({ throughMinute: M, refBlock, root: tree.root, totalEntitled: result.totalEntitled });
    // result.pops run oldest first; the list is newest first.
    const pops = [
      ...[...result.pops].reverse().map((p) => ({ minute: p.minute, block: p.block, amount: p.amount, kept: p.kept, recipients: p.recipients })),
      ...this.pops,
    ].slice(0, MAX_POPS);
    const seedFrom = seeds[seeds.length - 1].block;
    const built: BuildArgs = { chainId: d.chainId, contract: d.contract, throughMinute: M, refBlock, sig, publishedAt: now.time, rows, result, tree, pops };
    const { archive, latest } = buildFiles(built);

    // Write ahead: the signature, both bodies and the new state in one atomic file. A crash after this republishes the same bytes.
    const pending: PendingFile = { v: 1, throughMinute: M, archive: toJson(archive), latest: toJson(latest), next: this.saved(next, tracker, pops, seedFrom) };
    d.store.writeJson(PENDING_FILE, pending);
    this.pending = pending;
    this.state = next;
    this.tracker = tracker;
    this.pops = pops;
    this.seedFrom = seedFrom;

    const popped = result.pops.map((p) => `; the vault popped: ${p.amount} to ${p.recipients} holders, ${p.kept} kept`).join("");
    d.log(`checkpoint ${M}: ${result.entitlements.size} users, total ${result.totalEntitled}, ${rows.length} fee rows, read ${read} of ${regs.length} wallets, refBlock ${refBlock}${popped}`);
    await this.republish(pending);
    await this.writeUserFiles(built, now.time);
    return "published";
  }

  /** Whether `minute` is due at chain time `nowSec`: its end plus the grace has passed. */
  private isDue(minute: number, nowSec: number): boolean {
    return nowSec >= this.deps.launchTime + 60 * (minute + 1) + this.deps.graceSeconds;
  }

  /**
   * Which wallets minute M needs (spec 2026-10-31 §5). Watched since the last covered minute: those the feed saw, once it
   * has delivered past the minute's end. A gap adds every wallet that traded or registered in the last 24 hours. More than
   * LONG_GAP_MS unwatched in a run of gap minutes, no feed, or nothing covered yet: every registered wallet. Null: wait.
   * The gap is asked again on every tick: a coin found while waiting cuts coverage back, and then the wider read follows
   * instead of the wait. `gap` is what the run should take up once the minute is read: null when this tick must not move
   * the run (no feed, nothing covered yet, or the minute already covered by an earlier tick that failed afterwards).
   * That last case has nothing to read and nothing to wait for: a dead feed never answers `deliveredPast`.
   */
  private async walletsToRead(regs: readonly Registration[], endMs: number, finishedEndMs: number, nowSec: number): Promise<{ list: readonly Registration[]; gap: number | null } | null> {
    const d = this.deps;
    const waitingSince = this.feedWaitSince;
    this.feedWaitSince = null; // a tick that does not wait ends the wait; the next minute counts its own
    const covered = d.ingest.coveredThrough;
    if (!d.feed || covered < 0) return { list: regs, gap: null };
    if (covered >= endMs) return { list: [], gap: null }; // read by an earlier tick that failed afterwards: nothing to read, nothing to wait for
    const gap = d.feed.uncovered(covered, endMs);
    if (gap > 0) {
      const run = this.gapRun(d.feed, covered, endMs, finishedEndMs);
      if (run > LONG_GAP_MS) {
        d.log(`poster: the trade feed was not watching for at least ${Math.round(run / MINUTE_MS)} minutes of the current run: reading every wallet (${regs.length})`);
        await this.warn("poster: the trade feed has not been watching for over 5 minutes: reading every wallet, rewards may run late", nowSec);
        return { list: regs, gap };
      }
    }
    // The gap and the delivery are asked in one go (no await between): a cut made before `deliveredPast` turns true is already in `gap`.
    if (gap === 0 && !d.feed.deliveredPast(endMs)) {
      this.feedWaitSince = waitingSince ?? nowSec;
      if (nowSec - this.feedWaitSince > FEED_WAIT_ALERT_SECONDS) {
        await this.warn(`poster: waiting for the trade feed to deliver minute ${this.state.nextMinute} for over ${FEED_WAIT_ALERT_SECONDS / 60} minutes: no checkpoint is published until it does`, nowSec);
      }
      return null;
    }
    const want = new Set(d.feed.usersSince(covered));
    if (gap > 0) {
      for (const u of d.ingest.recentSince(endMs - DAY_MS)) want.add(u);
      for (const r of regs) if (r.registeredAt * 1000 >= endMs - DAY_MS) want.add(r.user.toLowerCase());
    }
    return { list: regs.filter((r) => want.has(r.user.toLowerCase())), gap };
  }

  /**
   * The run so far plus this minute and the finished minutes after it, up to the first fully watched one (and no further
   * than the point where it is long). One minute's window shows at most 60 s however long the feed has been down, so the
   * run is what measures an outage; the finished minutes ahead are counted so that a poster that was down for an hour reads
   * everyone on its first minute, not after publishing short-path minutes that a wider read can no longer fix.
   */
  private gapRun(feed: ActiveWallets, covered: number, endMs: number, finishedEndMs: number): number {
    let run = this.gapRunMs;
    let from = covered;
    for (let to = endMs; to <= finishedEndMs && run <= LONG_GAP_MS; from = to, to += MINUTE_MS) {
      const gap = feed.uncovered(from, to);
      if (gap === 0) break;
      run += gap;
    }
    return run;
  }

  /** An alert, at most once an hour per text; a failing channel never stops the poster. */
  private async warn(text: string, nowSec: number) {
    if (!this.dedupe.shouldSend(text, nowSec * 1000)) return;
    try {
      await this.deps.alert(text);
    } catch (e) {
      this.deps.log(`alert failed: ${(e as Error).message}`);
    }
  }

  /** Trades that arrived after the minute's list was made (read at once, see `tick`) are a sign of a slow feed: alerted when their count grew, once an hour (the text has no number). */
  private async reportLate(nowSec: number) {
    const late = this.deps.feed?.lateTrades ?? 0;
    if (late > this.lateSeen) {
      this.lateSeen = late;
      await this.warn("poster: trades arrived after their minute was read (a very late feed): the verifier's checks will show any fee this missed", nowSec);
    }
  }

  private takeLate(): Set<string> {
    return new Set(this.deps.feed?.takeLate() ?? []);
  }

  /** Publishes the pending checkpoint's two files (archive first, latest last), then saves its state and drops the write-ahead file. */
  private async republish(p: PendingFile): Promise<"republished"> {
    const d = this.deps;
    await d.publish.put(checkpointPath(p.throughMinute), p.archive, JSON_TYPE);
    await d.publish.put(LATEST_PATH, p.latest, JSON_TYPE, LATEST_OPTS);
    d.store.writeJson(STATE_FILE, p.next);
    d.store.remove(PENDING_FILE);
    this.pending = null;
    d.ingest.prune(p.throughMinute + 1);
    return "republished";
  }

  /**
   * The wallets' `users/<xx>.json` of a checkpoint just published (spec 2026-10-31 §8). Derived data, not in the write-ahead
   * file: a failure alerts and a later checkpoint tries again, it never holds up checkpoints. In step, written on the round
   * for the wallet count (`userFileEvery`) and whatever the round when a write is owed (a start, a failure, a republish, a
   * skip while behind, or the chain settled past the files, see `chainPastFiles`). A quiet minute (no fee rows, no pop, the root
   * of the last files) has only every 15th minute as a round: idle wallets cost no writes, a file up to 15 minutes old still
   * proves the same entitlement, and only its vault amount lags. While the next minute is already due (the poster is behind)
   * only every 15th minute is a round too, and the only other write is the first one since the start, so a catch-up burst
   * spends no time on files nobody reads yet nor on retries; the first in-step checkpoint makes up for what was skipped. Each file stands alone (it carries its checkpoint's signed fields) and one file's failure does not stop the
   * others, so files of two checkpoints can lie side by side, and the next write rewrites all of them.
   */
  private async writeUserFiles(a: BuildArgs, nowSec: number): Promise<void> {
    const d = this.deps;
    const behind = this.isDue(a.throughMinute + 1, nowSec);
    const wallets = knownWallets(a.result).size;
    const quiet = a.rows.length === 0 && a.result.pops.length === 0 && a.tree.root === this.userFilesRoot;
    const round = a.throughMinute % (behind || quiet ? SPARSE_EVERY : userFileEvery(wallets)) === 0;
    // The chain is read only when the answer could change what is written: in step, off the round, with nothing else owed.
    let owed: boolean;
    if (behind) owed = !this.userFilesTried;
    else owed = this.userFilesOwed || (!round && (await this.chainPastFiles()));
    if (!round && !owed) {
      if (behind) this.userFilesOwed = true;
      return;
    }
    this.userFilesTried = true;
    let built: [string, UserFile][];
    try {
      built = [...buildUserFiles(a)];
    } catch (e) {
      await this.userFilesFailed(a.throughMinute, asError(e), "could not be built", nowSec);
      return;
    }
    const failed = { count: 0, first: null as Error | null };
    await forEachLimit(built, USER_FILE_LIMIT, async ([path, f]) => {
      try {
        await d.publish.put(path, toJson(f), JSON_TYPE, USER_FILE_OPTS);
      } catch (e) {
        failed.count++;
        failed.first ??= asError(e);
      }
    });
    if (failed.first) {
      await this.userFilesFailed(a.throughMinute, failed.first, `${failed.count} of ${built.length} files failed`, nowSec);
      return;
    }
    this.userFilesOwed = false;
    this.userFilesAt = a.throughMinute;
    this.userFilesRoot = a.tree.root;
    d.log(`user files of checkpoint ${a.throughMinute}: ${built.length} files, ${wallets} wallets`);
  }

  /**
   * Whether the chain has settled a minute newer than the last one this process wrote user files for. Anyone can settle a published
   * checkpoint, so someone settling an off-round minute every minute would otherwise leave every wallet with a file older than the
   * chain until the next round; a write now makes the next file newer than the chain, which Settle & claim settles. A process that has
   * written nothing returns false: its first checkpoint writes anyway. A read that fails is logged and counts as "not past".
   */
  private async chainPastFiles(): Promise<boolean> {
    if (this.userFilesAt === null) return false;
    try {
      const settled = await this.deps.settledMinute();
      return settled !== null && settled > this.userFilesAt;
    } catch (e) {
      this.deps.log(`could not read the chain's settled minute (user files wait for their round): ${asError(e).message}`);
      return false;
    }
  }

  /** The alert text has no count (the hourly dedupe is per text) and carries the first error; what went wrong in full goes to the log. */
  private async userFilesFailed(minute: number, first: Error, what: string, nowSec: number): Promise<void> {
    this.userFilesOwed = true;
    await this.warn(`poster: writing the user files failed, a later checkpoint tries again: ${first.message}`, nowSec);
    this.deps.log(`user files of checkpoint ${minute}: ${what}`);
  }

  /**
   * One pass of the loop: a tick, then how long to sleep. A checkpoint was published (or republished) → 0 s, so a poster
   * that fell behind catches up minute by minute; waiting → 5 s; an error is logged, alerted (once an hour per text) and backs off.
   */
  async cycle(): Promise<number> {
    try {
      const r = await this.tick();
      this.backoff.reset();
      return r === "waiting" ? WAIT_SECONDS : 0;
    } catch (e) {
      const msg = (e as Error).message;
      this.deps.log(`error: ${msg}`);
      if (this.dedupe.shouldSend(msg, Date.now())) {
        try {
          await this.deps.alert(`poster error: ${msg}`);
        } catch {
          // an alert channel failing never stops the loop
        }
      }
      return this.backoff.next();
    }
  }

  async run(sleep: (seconds: number) => Promise<void> = (s) => new Promise((r) => setTimeout(r, s * 1000))): Promise<never> {
    for (;;) {
      const s = await this.cycle();
      if (s > 0) await sleep(s);
    }
  }
}

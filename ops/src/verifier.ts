import {
  applyCheckpoint, buildTree, countedFee, DAY, dayOf, deserializeState, minuteOf, newCalcState, parseTableCsv, popMinimum, popOdds, quietMinuteFrom, serializeState,
  type Addr, type ApiFill, type CalcState, type FeeRow, type Seed,
} from "@hlo/calc";
import type { Address, Hex } from "viem";
import { checkpointPath, parseCheckpointFile, type CheckpointFile } from "./checkpoint-files.js";
import { FillCache } from "./fillcache.js";
import { AlertDedupe, Backoff } from "./poster.js";
import type { Registration, Registry } from "./registry.js";
import { SeedRangeError } from "./seed.js";
import { recoverCheckpointSigner } from "./sign.js";
import type { ChainTracker } from "./snapshot.js";
import type { Store } from "./store.js";
import type { ActiveWallets } from "./tradefeed.js";

/**
 * The verifier replays every checkpoint the poster publishes, minute by minute, from its own state (it never reads the
 * poster's). On a mismatch it alerts and, where it holds the pauser key, pauses Checkpoints (every chain; the pauser can
 * only pause). It never sends anything else. It announces every guardian and pauser action it reads from the chain. On
 * chain 999 a daily check compares its own API sums with Hyperliquid's builder file. Spec 2026-10-31 §6: one cached fill
 * read per wallet for the row checks, the hourly omission check from its own trade feed in slices, and an hourly check of
 * Hyperliquid's builder total.
 */

/** The Checkpoints events the verifier reads. */
export type ChainEvent =
  | { kind: "settled"; throughMinute: number; root: Hex; block: bigint }
  | { kind: "posterSet" | "guardianSet" | "pauserSet"; address: Addr; block: bigint }
  | { kind: "cancelled"; from: number; to: number; block: bigint }
  | { kind: "writtenOff"; amount: bigint; total: bigint; block: bigint }
  | { kind: "pausedSet"; paused: boolean; block: bigint };

export interface VerifierDeps {
  /** The latest block's timestamp and number: "now" is chain time, never the wall clock. */
  now(): Promise<{ time: number; block: bigint }>;
  /** A published file's text, or null when absent. */
  read(path: string): Promise<string | null>;
  registry: Registry;
  /** One wallet's fills in [startMs, endMs], through the pacer (the row checks and the omission check share it). */
  fills(user: Addr, startMs: number, endMs: number): Promise<ApiFill[]>;
  /** The verifier's own trade feed (who traded, whether it was watching); null reads every registered wallet in the omission check (TRADE_FEED=off, `--once`). */
  feed: ActiveWallets | null;
  /** Seconds past a minute's end before it is checkpointed: the row checks read each wallet through the newest minute that is finished by it. */
  graceSeconds: number;
  /** The omission check reads every registered wallet when its feed has a gap in the hour, up to this many; above it that hour rests on the daily check. */
  omissionFullMax: number;
  /** Hyperliquid's cumulative builder fees in 1e-8 USDC, or null without a readable total. Null here: no builder total check (anvil). */
  builderRewards: (() => Promise<bigint | null>) | null;
  tracker: ChainTracker;
  /** Checkpoints.wasPoster(signer) right now: the current poster or a former one. */
  wasPoster(signer: Addr): Promise<boolean>;
  /** Checkpoints' cancelled minute ranges (inclusive) right now. */
  cancelled(): Promise<{ from: number; to: number }[]>;
  /** Checkpoints' events in [from, to] (the real one splits the range into LOG_CHUNK pieces). */
  events(from: bigint, to: bigint): Promise<ChainEvent[]>;
  /**
   * The seed blocks of minutes from..through, searched between block lo and hi (ops/src/seed.ts `seedBlocks` on the
   * verifier's own client). Throws SeedRangeError (a finding about the checkpoint, not an RPC failure) when hi is before the last
   * minute's end or when lo > hi.
   */
  seeds(fromMinute: number, throughMinute: number, lo: bigint, hi: bigint): Promise<Seed[]>;
  /** Pauses Checkpoints through the pauser key (`pause()`). Null without PAUSER_KEY. */
  pause: (() => Promise<void>) | null;
  store: Store;
  launchTime: number;
  chainId: number;
  contract: Address;
  /** First block of the deployment: the first replay and the first event read start here. */
  deployBlock: bigint;
  /** The daily check waits this long past a day's end (Hyperliquid publishes its file late). */
  fileDelayHours: number;
  alert(s: string): Promise<void>;
  log(s: string): void;
  /** Chain 999 only: the differences between the verifier's API sums and Hyperliquid's builder file for UTC `day`. */
  dailyCheck: ((day: number) => Promise<string[]>) | null;
}

/**
 * The verifier's keys, checked before it starts: never the guardian's key (every chain); on chain 999 the pauser key is
 * required; a pauser key must be Checkpoints.pauser()'s, or a mismatch would find it unable to pause. Messages name
 * addresses only, never a key.
 */
export async function checkVerifierKeys(o: {
  chainId: number;
  /** GUARDIAN_KEY is set in the verifier's env. */
  guardianKey: boolean;
  /** PAUSER_KEY's address, or null without one. */
  pauser: Address | null;
  readPauser: () => Promise<Address>;
}): Promise<void> {
  if (o.guardianKey) throw new Error("GUARDIAN_KEY is set for the verifier: it holds the pauser key (PAUSER_KEY), never the guardian's");
  if (o.pauser === null) {
    if (o.chainId === 999) throw new Error("PAUSER_KEY is required on chain 999: the verifier pauses Checkpoints on a mismatch");
    return;
  }
  const onChain = await o.readPauser();
  if (o.pauser.toLowerCase() !== onChain.toLowerCase()) {
    throw new Error(`PAUSER_KEY is not Checkpoints.pauser() (key ${o.pauser}, on chain ${onChain})`);
  }
}

export type VerifierResult = "waiting" | "ok" | "mismatch";

const STATE_FILE = "verifier-state";
/** A checkpoint still absent this long after its minute ended is reported missing. */
export const OVERDUE_SECONDS = 300;
/** Seconds to sleep after a tick that had to wait, and after a stored mismatch. */
export const WAIT_SECONDS = 5;
export const MISMATCH_SLEEP_SECONDS = 60;
const ERROR_BACKOFF_CAP = 300;

/** What survives a restart, besides the calculator state and the tracker. All of it is JSON. */
interface Persisted {
  /** The first block whose Settled events have not been read. */
  eventsFrom: string;
  /** The lowest block the next seed search starts at: the last verified minute's seed block (the deploy block before the first). */
  seedFrom: string;
  /** The minute of the stored mismatch, and what was wrong. */
  mismatch: { minute: number; why: string } | null;
  /** day → user → counted fee in 1e-8 USDC, from the Hyperliquid API, by fill time. For the daily check. */
  sums: Record<string, Record<string, string>>;
  /** The next UTC day the daily check has not done. */
  dailyNext: number;
  /** minute → root this verifier verified, for verified minutes above the highest Settled minute seen. */
  verifiedRoots: Record<string, string>;
  /**
   * minute → root of a Settled event for a minute not yet verified. `seen` is the chain time the event was first read;
   * `since` the chain time its file first read absent (null while present); `checked` is set once the file was read and
   * matched the event (it is not read again: the replay at verification is authoritative).
   */
  pending: Record<string, { root: string; seen: number; since: number | null; checked: boolean }>;
  /** The highest Settled minute whose event was checked, and the root it was checked against. */
  last: { minute: number; root: string } | null;
  /** minute → user → fee of the verified tables, for the hourly omission check. */
  rows: Record<string, Record<string, string>>;
  /** The next hour (60 minutes from launch) the omission check has not done. */
  omissionNext: number;
  /**
   * The last builder total check: the chain time it was made, D = Hyperliquid's builder total minus the fees the verified
   * tables count (can be negative), and that count, both in 1e-8 USDC. Absent until the first check.
   */
  builderCheck?: { at: number; lastD: string; countedTotal: string };
  /** The last address seen in each role's event; the first one (the constructor's) is recorded, not announced. */
  roles: Roles;
}

type Roles = { poster?: string; guardian?: string; pauser?: string };

interface SavedState extends Persisted {
  v: 2;
  state: string;
  tracker: string | null;
}

const isRec = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const UINT = /^\d+$/;
const SIGNED = /^-?\d+$/;

function parseSaved(f: unknown): SavedState {
  const bad = (why: string) => new Error(`${STATE_FILE}.json is not a valid verifier state file (${why}); a human must look before it is deleted`);
  const j = f as Partial<SavedState> | null;
  if ((f as { v?: unknown } | null)?.v === 1) {
    throw new Error(`${STATE_FILE}.json is from before the vault pops (version 1): start the verifier with a fresh state directory (it replays from launch)`);
  }
  if (!isRec(j) || j.v !== 2) throw bad("version");
  if (typeof j.state !== "string") throw bad("state");
  if (j.tracker !== null && typeof j.tracker !== "string") throw bad("tracker");
  if (typeof j.eventsFrom !== "string" || !UINT.test(j.eventsFrom)) throw bad("eventsFrom");
  if (typeof j.seedFrom !== "string" || !UINT.test(j.seedFrom)) throw bad("seedFrom");
  if (j.mismatch !== null && (!isRec(j.mismatch) || !Number.isSafeInteger(j.mismatch.minute) || typeof j.mismatch.why !== "string")) throw bad("mismatch");
  const nested = (x: unknown, what: string) => {
    if (!isRec(x)) throw bad(what);
    for (const users of Object.values(x)) {
      if (!isRec(users)) throw bad(what);
      for (const v of Object.values(users)) if (typeof v !== "string" || !UINT.test(v)) throw bad(what);
    }
  };
  nested(j.sums, "sums");
  nested(j.rows, "rows");
  if (!isRec(j.verifiedRoots) || !Object.values(j.verifiedRoots).every((v) => typeof v === "string")) throw bad("verifiedRoots");
  if (!isRec(j.pending)) throw bad("pending");
  for (const p of Object.values(j.pending)) {
    if (!isRec(p) || typeof p.root !== "string" || !Number.isSafeInteger(p.seen) || (p.since !== null && !Number.isSafeInteger(p.since)) || typeof p.checked !== "boolean") throw bad("pending");
  }
  if (j.last !== null && (!isRec(j.last) || !Number.isSafeInteger(j.last.minute) || typeof j.last.root !== "string")) throw bad("last");
  if (!Number.isSafeInteger(j.dailyNext)) throw bad("dailyNext");
  if (!Number.isSafeInteger(j.omissionNext)) throw bad("omissionNext");
  // A state file saved before the builder total check has none: its first check only records.
  const bc = j.builderCheck as unknown;
  if (bc !== undefined && (!isRec(bc) || !Number.isSafeInteger(bc.at) || typeof bc.lastD !== "string" || !SIGNED.test(bc.lastD) || typeof bc.countedTotal !== "string" || !UINT.test(bc.countedTotal))) {
    throw bad("builderCheck");
  }
  // A state file saved before the roles record has none: every role's next event is recorded, not announced.
  if (j.roles !== undefined && (!isRec(j.roles) || !Object.values(j.roles).every((v) => typeof v === "string"))) throw bad("roles");
  return { ...j, roles: j.roles ?? {} } as SavedState;
}

/** The tracker JSON to restart from, or null (start empty). */
export function savedVerifierTracker(store: Store): string | null {
  const saved = store.readJson<unknown>(STATE_FILE, null);
  return saved === null ? null : parseSaved(saved).tracker;
}

const lower = (a: string) => a.toLowerCase();
const endOfMinute = (launch: number, m: number) => launch + 60 * (m + 1);

/** How many minutes start before the end of UTC `day`; the daily check needs them all verified. */
const minutesStartingBefore = (launch: number, day: number) => Math.ceil(((day + 1) * DAY - launch) / 60);

/** The Settled events lag the latest block by this much, so a getLogs that lags the head never makes the cursor skip one. */
export const EVENT_LAG_BLOCKS = 3n;
/**
 * Chain time a Settled minute's file may read absent, a refBlock may stay ahead of the RPC, or a checkpoint may be withheld
 * while a later one is settled, before it is a mismatch.
 */
export const PATIENCE_SECONDS = 300;
/** More verified roots than this (a day of minutes) waiting for a Settled event: alert once. */
const MAX_UNSETTLED_ROOTS = 1440;
/** Minimum chain-time gap between two tries of a failing daily-file fetch or omission check. */
const RETRY_SECONDS = 600;
/** The omission check covers this many minutes at a time. */
const HOUR_MINUTES = 60;
/** Wallets one tick reads for the omission check, so a large hour never holds up verification (spec 2026-10-31 §6). */
const OMISSION_SLICE = 10;
/** An omission check that has waited this long (chain time) for its feed to deliver the hour is alerted; it keeps waiting. */
const FEED_WAIT_ALERT_SECONDS = 120;
const USDC_UNITS = 100_000_000n;
/** The builder total is checked once per chain hour, and only while the verifier is at most this far behind. */
const BUILDER_CHECK_SECONDS = 3600;
const BUILDER_MAX_BEHIND_SECONDS = 120;
/** Of the fees counted since the last check: Hyperliquid's total runs ahead of the tables by up to ~2 minutes of fees, and that lag can change by up to 2 of 60 minutes (3.3%) between two checks. */
const BUILDER_TOLERANCE_PERCENT = 5n;
/** A builder total that stays unreadable this long is alerted. */
const BUILDER_UNREADABLE_SECONDS = DAY;

const highSettled = (p: Persisted): number => Math.max(p.last?.minute ?? -1, ...Object.keys(p.pending).map(Number));
const pruneRoots = (p: Persisted, through: number) => {
  for (const k of Object.keys(p.verifiedRoots)) if (Number(k) <= through) delete p.verifiedRoots[k];
};

export class Verifier {
  private state: CalcState;
  private tracker: ChainTracker;
  private p: Persisted;
  private readonly dedupe = new AlertDedupe();
  private readonly backoff = new Backoff(WAIT_SECONDS, ERROR_BACKOFF_CAP);
  private readonly missingAlerted = new Set<number>();
  private unsettledAlerted = false;
  /** The minute whose refBlock is ahead of the RPC, and the chain time it was first seen. */
  private refWait: { minute: number; since: number } | null = null;
  private dailyRetryAt = 0;
  private omissionRetryAt = 0;
  private builderRetryAt = 0;
  /** The chain time of the last builder total read that worked, or of the first attempt before one has. Memory only. */
  private builderOkAt: number | null = null;
  /** Each wallet's fills read through the newest finished minute, for the row checks. */
  private readonly cache: FillCache;
  /** The hour being checked: its wallets, how far the slices have got, and the differences found so far. Memory only: a restart redoes that hour. */
  private omissionWork: { k: number; list: Registration[]; next: number; diffs: [string, number[]][] } | null = null;
  /** The chain time the omission check for hour `k` began waiting for the feed to deliver it. */
  private omissionWait: { k: number; since: number } | null = null;

  constructor(private readonly deps: VerifierDeps) {
    this.tracker = deps.tracker;
    this.cache = new FillCache(deps.fills);
    const odds = popOdds(deps.chainId);
    const raw = deps.store.readJson<unknown>(STATE_FILE, null);
    if (raw !== null) {
      const { v: _v, state, tracker: _t, ...p } = parseSaved(raw);
      this.state = deserializeState(state);
      if (this.state.launchTime !== deps.launchTime || this.state.odds !== odds) {
        throw new Error("the saved verifier state is for another deployment (launchTime or pop odds differ)");
      }
      this.p = p;
    } else {
      this.state = newCalcState(deps.launchTime, odds);
      this.p = {
        eventsFrom: deps.deployBlock.toString(), seedFrom: deps.deployBlock.toString(), mismatch: null, sums: {}, dailyNext: dayOf(deps.launchTime),
        verifiedRoots: {}, pending: {}, last: null, rows: {}, omissionNext: 0, roles: {},
      };
    }
  }

  /** The next minute to verify. */
  get nextMinute(): number {
    return this.state.nextMinute;
  }

  private persist(p: Persisted, state: CalcState, tracker: ChainTracker) {
    const saved: SavedState = { v: 2, state: serializeState(state), tracker: tracker.toJSON(), ...p };
    this.deps.store.writeJson(STATE_FILE, saved);
  }

  private save() {
    this.persist(this.p, this.state, this.tracker);
  }

  /** An alert, but not the same text again within an hour of chain time. A failing channel never stops the verifier. */
  private async alert(text: string, nowSec: number) {
    if (!this.dedupe.shouldSend(text, nowSec * 1000)) return;
    try {
      await this.deps.alert(text);
    } catch (e) {
      this.deps.log(`alert failed: ${(e as Error).message}`);
    }
  }

  async tick(): Promise<VerifierResult> {
    const d = this.deps;
    if (this.p.mismatch) {
      const m = this.p.mismatch;
      await this.alert(`verifier: checkpoint ${m.minute} mismatch is still unresolved (a human decides): ${m.why}`, (await d.now()).time);
      return "mismatch";
    }

    const M = this.state.nextMinute;
    const text = await this.readOwn(checkpointPath(M));
    // "Now" is read after the file: a block that arrives while the file is being fetched must not make its refBlock look too new.
    const now = await d.now();
    if (text === null) {
      if (now.time >= endOfMinute(d.launchTime, M) + OVERDUE_SECONDS && !this.missingAlerted.has(M)) {
        this.missingAlerted.add(M);
        await this.alert(`poster: checkpoint ${M} missing`, now.time);
      }
      return this.idle(M, now, "missing");
    }

    let file: CheckpointFile | null = null;
    let parseError = "";
    try {
      file = parseCheckpointFile(text);
    } catch (e) {
      parseError = (e as Error).message;
    }
    // A refBlock the RPC has not reached yet is the RPC lagging (or the poster ahead of it), not a lie: wait, and alert if it lasts.
    if (file && BigInt(file.refBlock) >= now.block) {
      if (this.refWait?.minute !== M) this.refWait = { minute: M, since: now.time };
      if (now.time - this.refWait.since >= PATIENCE_SECONDS) {
        return this.fail(M, `refBlock ${file.refBlock} is ahead of the chain (latest block ${now.block}) ${PATIENCE_SECONDS} s after it was first seen`, now.time);
      }
      return this.idle(M, now, "present");
    }
    this.refWait = null;

    let regs = await d.registry.list();
    // An incremental registry can be behind the poster's: a record found first by the poster's hourly full read, past the
    // index's look-back. "Not registered" pauses the contract, so the whole registry is read once, here, before it is
    // reported, and the fresher list serves the rest of the tick. A table that cannot be parsed has no file: no extra read.
    if (file && hasUnregisteredRow(file, regs)) regs = await d.registry.list(true);
    const problems = file ? await this.checkFile(M, file, now, regs) : [parseError];
    if (problems.length > 0 || !file) return this.fail(M, problems.join("; "), now.time);

    const rows = parseRows(file);
    const byUser = new Map(regs.map((r) => [lower(r.user), r] as const));

    // Step 3: every row's fee equals what the Hyperliquid API says the wallet paid in this minute. A wallet is read once,
    // through the newest finished minute, and the read is kept for the minutes after (spec 2026-10-31 §6).
    const startMs = (d.launchTime + 60 * M) * 1000;
    const endMs = endOfMinute(d.launchTime, M) * 1000 - 1;
    const lastFinished = Math.floor((now.time - d.graceSeconds - d.launchTime) / 60) - 1;
    const throughMs = (d.launchTime + 60 * (lastFinished + 1)) * 1000 - 1;
    this.cache.dropBefore(startMs);
    // A row ABOVE the API's sum credits a wallet for fees the API does not show: a mismatch, and the first one fails the
    // minute at once (a table padded with fee rows would otherwise cost a read each before the pause). A row BELOW it is
    // a fill the API indexed after the poster's grace: alert only (like the hourly omission check), verification goes on.
    const under: string[] = [];
    const sums = cloneSums(this.p.sums);
    for (const row of rows) {
      const reg = byUser.get(lower(row.user))!;
      const startSec = Math.max(d.launchTime, reg.registeredAt);
      const counted = (fills: readonly ApiFill[]) => {
        const out: { fee: bigint; time: number }[] = [];
        for (const f of fills) {
          if (f.time < startMs || f.time > endMs) continue;
          const fee = countedFee(f, startSec);
          if (fee !== null) out.push({ fee, time: f.time });
        }
        return out;
      };
      const sum = (c: readonly { fee: bigint }[]) => c.reduce((t, x) => t + x.fee, 0n);
      const got = await this.cache.get(row.user, startMs, endMs, throughMs);
      let fees = counted(got.fills);
      // A shortfall from an earlier read may be a fill indexed since: only a read made now can lead to a mismatch and a pause.
      if (got.cached && sum(fees) < row.fee) fees = counted(await this.cache.fresh(row.user, startMs, endMs));
      const total = sum(fees);
      if (d.dailyCheck) {
        // the sums are only for the daily check (chain 999)
        for (const { fee, time } of fees) {
          const day = String(dayOf(Math.floor(time / 1000)));
          const users = (sums[day] ??= {});
          users[lower(row.user)] = (BigInt(users[lower(row.user)] ?? "0") + fee).toString();
        }
      }
      if (total < row.fee) return this.fail(M, `fee of ${row.user}: table ${row.fee}, API ${total}`, now.time);
      if (total > row.fee) under.push(`verifier: checkpoint ${M}: fee of ${row.user} is below the API (table ${row.fee}, API ${total}); alert only, a fill indexed after the grace`);
    }

    // Step 4: replay into a copy of the tracker; it replaces ours only once the state is on disk. The seeds come from the
    // verifier's own chain reads; a refBlock before the end of its minute leaves no seed block and is a finding.
    const refBlock = BigInt(file.refBlock);
    const prevRef = this.state.refBlock === 0n ? d.deployBlock - 1n : this.state.refBlock;
    const tracker = this.tracker.clone();
    const snap = await tracker.snapshot(prevRef, refBlock);
    let seeds: Seed[];
    try {
      seeds = await d.seeds(M, M, BigInt(this.p.seedFrom), refBlock);
    } catch (e) {
      if (e instanceof SeedRangeError) return this.fail(M, `seed: ${e.message}`, now.time);
      throw e;
    }
    const next = deserializeState(serializeState(this.state));
    const result = applyCheckpoint(next, { throughMinute: M, refBlock, rows, seeds, burned: snap.burned, refined: snap.refined, claimed: snap.claimed, minimum: popMinimum(this.deps.chainId), quietFrom: quietMinuteFrom(this.deps.chainId) });
    const root = buildTree(result.entitlements).root;
    const replayProblems: string[] = [];
    if (lower(root) !== lower(file.root)) replayProblems.push(`root: file ${file.root}, replay ${root}`);
    if (result.totalEntitled.toString() !== file.totalEntitled) replayProblems.push(`totalEntitled: file ${file.totalEntitled}, replay ${result.totalEntitled}`);
    if (replayProblems.length > 0) return this.fail(M, replayProblems.join("; "), now.time);

    // Step 5: Settled events against the roots this verifier verified (never against a file that can be overwritten).
    const w: Persisted = structuredClone(this.p);
    w.seedFrom = seeds[seeds.length - 1].block.toString();
    const bad = await this.checkEvents(w, M, now);
    if (bad) return this.fail(bad.minute, bad.why, now.time);
    const settled = w.pending[M];
    if (settled) {
      if (lower(settled.root) !== lower(root)) return this.fail(M, `Settled(${M}) root ${settled.root} differs from the replayed root ${root}`, now.time);
      delete w.pending[M];
      w.last = { minute: M, root };
      pruneRoots(w, M);
    } else if (M > highSettled(w)) {
      w.verifiedRoots[M] = root;
    }
    w.sums = sums;
    if (Object.keys(w.verifiedRoots).length <= MAX_UNSETTLED_ROOTS) this.unsettledAlerted = false;
    w.rows[M] = Object.fromEntries(rows.map((r) => [lower(r.user), r.fee.toString()]));
    for (const k of Object.keys(w.rows)) if (Number(k) < HOUR_MINUTES * (Math.floor((M + 1) / HOUR_MINUTES) - 1)) delete w.rows[k];

    this.persist(w, next, tracker);
    this.p = w;
    this.state = next;
    this.tracker = tracker;
    const unsettled = Object.keys(w.verifiedRoots).length;
    if (unsettled > MAX_UNSETTLED_ROOTS && !this.unsettledAlerted) {
      this.unsettledAlerted = true;
      await this.alert(`verifier: nothing has been settled for a day (${unsettled} verified checkpoints are waiting for a Settled event)`, now.time);
    }
    d.log(`checkpoint ${M} ok: ${rows.length} fee rows, root ${root}`);
    for (const a of under) await this.alert(a, now.time);
    await this.omissionWhenCaughtUp(now.time);
    await this.builderTotal(now.time);
    await this.daily(now.time);
    return "ok";
  }

  /**
   * Nothing to verify right now: the Settled events, the omission check and the daily check still run. A checkpoint whose
   * file is missing while a later minute has been settled for PATIENCE_SECONDS is withheld: the chain is ahead of the replay.
   */
  private async idle(M: number, now: { time: number; block: bigint }, file: "missing" | "present"): Promise<"waiting" | "mismatch"> {
    const w: Persisted = structuredClone(this.p);
    const bad = await this.checkEvents(w, M, now);
    if (bad) return this.fail(bad.minute, bad.why, now.time);
    if (JSON.stringify(w) !== JSON.stringify(this.p)) {
      this.p = w;
      this.save();
    }
    if (file === "missing") {
      const ahead = Object.entries(w.pending).filter(([k]) => Number(k) > M).sort((a, b) => a[1].seen - b[1].seen);
      if (ahead.length > 0 && now.time - ahead[0][1].seen >= PATIENCE_SECONDS) {
        return this.fail(M, `checkpoint ${M} withheld while ${ahead[0][0]} settled`, now.time);
      }
    }
    await this.omission(now.time);
    await this.builderTotal(now.time);
    await this.daily(now.time);
    return "waiting";
  }

  /** Step 2: the file against the signer, the chain and the registry. Returns what is wrong (empty when nothing). */
  private async checkFile(M: number, file: CheckpointFile, now: { time: number; block: bigint }, regs: readonly Registration[]): Promise<string[]> {
    const d = this.deps;
    const p: string[] = [];
    if (file.throughMinute !== M) p.push(`file is for minute ${file.throughMinute}`);
    // A failed read must reach cycle()'s backoff (no mismatch, no pause); only a bad signature is a finding.
    // A file signed by a former poster is fine: its content is replayed like any other, and settle accepts only the current poster.
    let signer: Address | null = null;
    try {
      signer = await recoverCheckpointSigner(
        d.chainId, d.contract,
        { throughMinute: file.throughMinute, refBlock: BigInt(file.refBlock), root: file.root, totalEntitled: BigInt(file.totalEntitled) },
        file.sig,
      );
    } catch (e) {
      p.push(`signature: ${(e as Error).message}`);
    }
    if (signer && !(await d.wasPoster(lower(signer) as Addr))) p.push(`signed by ${signer}, never a poster of this contract`);
    const refBlock = BigInt(file.refBlock);
    const prevRef = this.state.refBlock === 0n ? d.deployBlock - 1n : this.state.refBlock;
    if (refBlock < this.state.refBlock) p.push(`refBlock ${refBlock} is below the previous checkpoint's ${this.state.refBlock}`);
    else if (refBlock < prevRef) p.push(`refBlock ${refBlock} is before the deployment block ${d.deployBlock}`);

    const end = endOfMinute(d.launchTime, M);
    const byUser = new Map(regs.map((r) => [lower(r.user), r] as const));
    const seen = new Set<string>();
    for (const row of parseRows(file)) {
      if (row.minute !== M) p.push(`row for minute ${row.minute}`);
      const reg = byUser.get(lower(row.user));
      if (!reg) p.push(`${row.user} is not registered`);
      else if (reg.registeredAt > end) p.push(`${row.user} registered at ${reg.registeredAt}, after the end of the minute`);
      if (seen.has(lower(row.user))) p.push(`${row.user} appears twice`);
      seen.add(lower(row.user));
      if (row.fee <= 0n) p.push(`${row.user} has fee ${row.fee}`);
    }
    return p;
  }

  /**
   * Step 5, on the working copy `w` (the caller keeps it only if the tick succeeds). Reads the Checkpoints events in
   * [eventsFrom, latest − 3]. Settled events for a cancelled minute are skipped; for the others:
   * - a minute below `nextMinute` must carry the root this verifier verified for it (kept in `verifiedRoots`);
   * - a minute ahead is remembered in `pending` and must match the published file now, and the replayed root later;
   *   a file that reads absent is given 5 minutes of chain time. A pending minute that is cancelled since is dropped.
   * Every other event is announced (`announce`).
   */
  private async checkEvents(w: Persisted, nextMinute: number, now: { time: number; block: bigint }): Promise<{ minute: number; why: string } | null> {
    const d = this.deps;
    // Read at the latest block, so a Settled event read before its Cancelled event is skipped too.
    const cancelled = await d.cancelled();
    const isCancelled = (m: number) => cancelled.some((r) => m >= r.from && m <= r.to);
    const to = now.block - EVENT_LAG_BLOCKS;
    const from = BigInt(w.eventsFrom);
    if (to >= from) {
      // By block; inside a block the other events come first (in log order: the sort is stable), then Settled by minute.
      const key = (e: ChainEvent) => (e.kind === "settled" ? e.throughMinute : -1);
      const events = [...(await d.events(from, to))].sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : key(a) - key(b)));
      for (const e of events) {
        if (e.kind !== "settled") {
          await this.announce(w, e, now.time);
          continue;
        }
        const m = e.throughMinute;
        if (isCancelled(m)) continue;
        const bad = (why: string) => ({ minute: m, why: `Settled(${m}) root ${e.root} (block ${e.block}) ${why}` });
        if (m < nextMinute) {
          const known = w.last?.minute === m ? w.last.root : w.verifiedRoots[m];
          if (known === undefined) return bad("is for a minute below an earlier Settled one, or one never verified");
          if (lower(known) !== lower(e.root)) return bad(`differs from the root this verifier verified ${known}`);
          if (w.last?.minute !== m) {
            w.last = { minute: m, root: known };
            pruneRoots(w, m);
          }
        } else {
          const have = w.pending[m];
          if (have) {
            if (lower(have.root) !== lower(e.root)) return bad(`differs from the earlier event's ${have.root}`);
          } else {
            if (m < highSettled(w)) return bad("is below an earlier Settled minute");
            w.pending[m] = { root: e.root, seen: now.time, since: null, checked: false };
            pruneRoots(w, m);
          }
        }
      }
      w.eventsFrom = (to + 1n).toString();
    }
    for (const k of Object.keys(w.pending)) if (isCancelled(Number(k))) delete w.pending[k];
    for (const key of Object.keys(w.pending).sort((a, b) => Number(a) - Number(b))) {
      const m = Number(key);
      const pend = w.pending[key];
      if (pend.checked) continue;
      const text = await this.readOwn(checkpointPath(m));
      if (text === null) {
        pend.since ??= now.time;
        if (now.time - pend.since >= PATIENCE_SECONDS) {
          return { minute: m, why: `Settled(${m}) with root ${pend.root} has no published checkpoint (absent since chain time ${pend.since})` };
        }
        continue;
      }
      pend.since = null;
      let file: CheckpointFile;
      try {
        file = parseCheckpointFile(text);
      } catch (err) {
        return { minute: m, why: `Settled(${m}): the published file is bad (${(err as Error).message})` };
      }
      if (lower(file.root) !== lower(pend.root)) return { minute: m, why: `Settled(${m}) root ${pend.root} differs from the published ${file.root}` };
      pend.checked = true;
    }
    return null;
  }

  /**
   * Guardian and pauser actions are public information: announce each. Each text ends with the event's block, so a second
   * pause or unpause within the hour is not deduplicated away, and a fresh state dir's replay of old events shows when they
   * happened. The first event of a role is the constructor's (it lands after the deployments file's deployBlock, the block
   * at script start), so it is recorded in `w.roles`, not announced; a later one with another address is announced. The
   * constructor never emits the other kinds.
   */
  private async announce(w: Persisted, e: Exclude<ChainEvent, { kind: "settled" }>, nowSec: number) {
    if (e.kind === "posterSet" || e.kind === "guardianSet" || e.kind === "pauserSet") {
      const role = e.kind === "posterSet" ? "poster" : e.kind === "pauserSet" ? "pauser" : "guardian";
      const known = w.roles[role];
      w.roles = { ...w.roles, [role]: e.address };
      if (known !== undefined && lower(known) !== lower(e.address)) await this.alert(`checkpoints: ${role} set to ${e.address} (block ${e.block})`, nowSec);
      return;
    }
    const hlo = (x: bigint) => `${x / 10n ** 18n}.${((x % 10n ** 18n) / 10n ** 16n).toString().padStart(2, "0")}`;
    const text =
      e.kind === "cancelled" ? `checkpoints: cancelled minutes ${e.from}..${e.to}`
      : e.kind === "writtenOff" ? `checkpoints: wrote off ${hlo(e.amount)} HLO (total ${hlo(e.total)} HLO)`
      : e.kind === "pausedSet" && e.paused ? "checkpoints: paused" : "checkpoints: unpaused";
    await this.alert(`${text} (block ${e.block})`, nowSec);
  }

  /**
   * Reads a published checkpoint, or null when it is absent or belongs to another chain or contract: a redeploy publishes
   * under the same prefix, so the old deployment's file stays there until this poster overwrites it. Such a file could not
   * be settled on this contract anyway (the signature names the contract). A file that does not parse is returned as is.
   */
  private async readOwn(path: string): Promise<string | null> {
    const text = await this.deps.read(path);
    if (text === null) return null;
    try {
      const f = parseCheckpointFile(text);
      if (f.chainId !== this.deps.chainId || lower(f.contract) !== lower(this.deps.contract)) return null;
    } catch {
      // the caller reports it
    }
    return text;
  }

  /** Step 6: alert, pause once, remember. The state (tracker, minute) stays where it was. */
  private async fail(minute: number, why: string, nowSec: number): Promise<"mismatch"> {
    const d = this.deps;
    await this.alert(`verifier: checkpoint ${minute} mismatch: ${why}`, nowSec);
    if (d.pause) {
      try {
        await d.pause();
        await this.alert(`verifier: paused Checkpoints because of the checkpoint ${minute} mismatch`, nowSec);
      } catch (e) {
        await this.alert(`verifier: could not pause Checkpoints: ${(e as Error).message}`, nowSec);
      }
    }
    this.p = { ...this.p, mismatch: { minute, why } };
    this.save();
    return "mismatch";
  }

  /**
   * Once per hour (60 minutes from launch) of verified minutes: one userFillsByTime call over that hour for each wallet
   * that may have traded in it, summed per minute, against the verified tables' rows. This is the only check that sees a
   * wallet the poster left out. Alert only (the poster cannot be proven wrong by one API read), on every chain. The wallets
   * are read OMISSION_SLICE a tick, so a large hour never holds up verification; the differences are alerted when the last
   * wallet is done, and only then is the hour marked done. A restart redoes the hour.
   */
  private async omission(nowSec: number): Promise<void> {
    const d = this.deps;
    const k = Math.floor(this.state.nextMinute / HOUR_MINUTES) - 1;
    if (k < this.p.omissionNext || nowSec < this.omissionRetryAt) return;
    const first = HOUR_MINUTES * k;
    const last = first + HOUR_MINUTES - 1;
    const startMs = (d.launchTime + 60 * first) * 1000;
    const endSec = endOfMinute(d.launchTime, last);
    const endMs = endSec * 1000 - 1;
    if (k > this.p.omissionNext) {
      // Hours went by without a pass (or it did not finish). What the dropped pass found is reported, and how far it got:
      // under sustained load every hour would drop, and nothing else sees these wallets. Always before any comparison:
      // the dropped hour's rows may be gone by now.
      const w = this.omissionWork;
      if (w) for (const [user, bad] of w.diffs) await this.alertDiff(user, bad, nowSec);
      const progress = w ? ` (read ${w.next} of ${w.list.length} wallets of the first hour)` : "";
      await this.alert(`verifier: omission check skipped minutes ${HOUR_MINUTES * this.p.omissionNext}..${HOUR_MINUTES * k - 1}${progress}`, nowSec);
      this.p = { ...this.p, omissionNext: k };
      this.omissionWork = null;
      d.feed?.prune(startMs - 1); // what the dropped hours' passes would have pruned (the new hour's wallets stay)
      this.save();
    }
    try {
      if (this.omissionWork?.k !== k) {
        const list = await this.omissionList(k, first, last, startMs, endMs, endSec, nowSec);
        if (list === null) return; // the feed has not delivered the hour yet: asked again on the next tick
        this.omissionWork = { k, list, next: 0, diffs: [] };
      }
      const w = this.omissionWork;
      for (const reg of w.list.slice(w.next, w.next + OMISSION_SLICE)) {
        const user = lower(reg.user);
        const startSec = Math.max(d.launchTime, reg.registeredAt);
        const api = new Map<number, bigint>();
        for (const f of await d.fills(user as Addr, startMs, endMs)) {
          const fee = countedFee(f, startSec);
          if (fee === null) continue;
          const m = minuteOf(d.launchTime, f.time);
          if (m >= first && m <= last) api.set(m, (api.get(m) ?? 0n) + fee);
        }
        const bad: number[] = [];
        for (let m = first; m <= last; m++) {
          if ((api.get(m) ?? 0n) !== BigInt(this.p.rows[m]?.[user] ?? "0")) bad.push(m);
        }
        if (bad.length > 0) w.diffs.push([user, bad]);
        w.next++; // only after a read that succeeded: a retry goes on from here
      }
    } catch (e) {
      this.omissionRetryAt = nowSec + RETRY_SECONDS;
      await this.alert(`verifier: omission check for minutes ${first}..${last} failed: ${(e as Error).message}`, nowSec);
      return;
    }
    const w = this.omissionWork;
    if (w.next < w.list.length) return; // the next tick goes on
    for (const [user, bad] of w.diffs) await this.alertDiff(user, bad, nowSec);
    this.omissionWork = null;
    d.feed?.prune(endMs - 3_600_000);
    this.p = { ...this.p, omissionNext: k + 1 };
    this.save();
  }

  private alertDiff(user: string, bad: number[], nowSec: number) {
    return this.alert(`verifier: wallet ${user} fees in minutes ${bad[0]}..${bad[bad.length - 1]} differ from the published tables`, nowSec);
  }

  /**
   * The omission check after a verified minute, only while the verifier is caught up: its slice costs seconds, and a
   * verifier that is behind must spend that time on the rows (it is the check that pauses). "Due" is the poster's own
   * rule for publishing the next minute, read from a fresh chain time because the row reads just took some. The chain is
   * read again only when a pass could run, so an ordinary minute costs no extra call. Idle ticks (no file yet) are not
   * guarded: the verifier really is idle then. While it replays, hours pile up and the next pass reports them in one alert.
   */
  private async omissionWhenCaughtUp(nowSec: number): Promise<void> {
    const d = this.deps;
    const k = Math.floor(this.state.nextMinute / HOUR_MINUTES) - 1;
    if (k < this.p.omissionNext || nowSec < this.omissionRetryAt) return;
    const fresh = await d.now();
    if (fresh.time >= endOfMinute(d.launchTime, this.state.nextMinute) + d.graceSeconds) return;
    await this.omission(fresh.time);
  }

  /**
   * The wallets hour `k` needs (spec 2026-10-31 §6): those the feed saw in it plus the hour's table wallets; a gap in the
   * feed's coverage widens it to every registered wallet, up to OMISSION_FULL_MAX, and above that the hour rests on the daily
   * check. Null: the hour shows no gap but the feed has not delivered it yet (a trade may be on its way, or a coin listed in
   * it not yet found), so nothing is read and the hour is not done: the next tick asks again. A dead feed shows a gap, so
   * it cannot hold the hour for ever. The delivery is asked first and the gap right after it, with no await between: a
   * coin found by the read that made the delivery true has already cut coverage back.
   */
  private async omissionList(k: number, first: number, last: number, startMs: number, endMs: number, endSec: number, nowSec: number): Promise<Registration[] | null> {
    const d = this.deps;
    const feed = d.feed;
    const delivered = feed ? feed.deliveredPast(endMs) : true;
    const gap = feed ? feed.uncovered(startMs, endMs) : 0;
    if (gap === 0 && !delivered) {
      if (this.omissionWait?.k !== k) this.omissionWait = { k, since: nowSec };
      if (nowSec - this.omissionWait.since > FEED_WAIT_ALERT_SECONDS) {
        await this.alert(`verifier: the omission check for minutes ${first}..${last} has waited over ${FEED_WAIT_ALERT_SECONDS / 60} minutes for the trade feed to deliver that hour; it goes on waiting`, nowSec);
      }
      return null;
    }
    this.omissionWait = null;
    const regs = (await d.registry.list()).filter((r) => r.registeredAt <= endSec);
    const tabled = new Set<string>();
    for (let m = first; m <= last; m++) for (const u of Object.keys(this.p.rows[m] ?? {})) tabled.add(u);
    // Wallets in none of the hour's tables first: nothing else sees them (a table wallet was read by its row check), so a
    // pass that is dropped has at least looked at these.
    const ordered = (list: readonly Registration[]) => [...list.filter((r) => !tabled.has(lower(r.user))), ...list.filter((r) => tabled.has(lower(r.user)))];
    if (!feed) return ordered(regs);
    if (gap > 0 && regs.length <= d.omissionFullMax) return ordered(regs);
    if (gap > 0) await this.alert(`verifier: the trade feed was not watching for part of minutes ${first}..${last} and there are ${regs.length} wallets: that hour rests on the daily check`, nowSec);
    const want = new Set([...feed.usersSince(startMs), ...tabled]);
    return ordered(regs.filter((r) => want.has(lower(r.user))));
  }

  /**
   * Hourly, alert only (spec 2026-10-31 §6): D = Hyperliquid's builder total minus the fees the verified tables count. The
   * first D is only recorded. After that D growing by more than the tolerance (5 USDC plus 5% of the fees counted since
   * the last check) says fees reached our builder that no table counts; D falling by more than it says the tables count
   * more than Hyperliquid paid us. Skipped while the verifier is more than 2 minutes behind (the total runs ahead of the
   * tables). A read that fails or has no total is logged and tried again after 10 minutes of chain time; one that stays
   * unreadable for a day is alerted (once a day).
   */
  private async builderTotal(nowSec: number): Promise<void> {
    const d = this.deps;
    if (!d.builderRewards || nowSec < this.builderRetryAt) return;
    const prev = this.p.builderCheck;
    if (prev && nowSec - prev.at < BUILDER_CHECK_SECONDS) return;
    const m = this.state.nextMinute - 1;
    if (m < 0 || nowSec - endOfMinute(d.launchTime, m) > BUILDER_MAX_BEHIND_SECONDS) return;
    this.builderOkAt ??= nowSec;
    let rewards: bigint | null = null;
    try {
      rewards = await d.builderRewards();
      if (rewards === null) d.log("builder total: no readable total in the answer");
    } catch (e) {
      d.log(`builder total: ${(e as Error).message}`);
    }
    if (rewards === null) {
      this.builderRetryAt = nowSec + RETRY_SECONDS;
      if (nowSec - this.builderOkAt >= BUILDER_UNREADABLE_SECONDS) {
        this.builderOkAt = nowSec; // the next alert is a day from now
        await this.alert("verifier: the builder total has not been readable for a day: that check is off until it is", nowSec);
      }
      return;
    }
    this.builderOkAt = nowSec;
    const counted = [...this.state.totals.values()].reduce((t, u) => t + u.fees, 0n);
    const D = rewards - counted;
    if (prev) {
      const moved = D - BigInt(prev.lastD);
      const tolerance = 5n * USDC_UNITS + ((counted - BigInt(prev.countedTotal)) * BUILDER_TOLERANCE_PERCENT) / 100n;
      const usdc = (x: bigint) => `${x / USDC_UNITS}.${(x % USDC_UNITS).toString().padStart(8, "0").slice(0, 2)} USDC`;
      if (moved > tolerance) await this.alert(`verifier: builder fees not in the tables grew by ${usdc(moved)}: a wallet was missed, or a wallet that is not registered pays our builder fee`, nowSec);
      else if (-moved > tolerance) await this.alert(`verifier: the tables count ${usdc(-moved)} more than Hyperliquid's builder total: a registered wallet may be paying 0.1% to another builder`, nowSec);
    }
    this.p = { ...this.p, builderCheck: { at: nowSec, lastD: D.toString(), countedTotal: counted.toString() } };
    this.save();
  }

  /** The daily check for every UTC day that is over, delayed, and fully verified. A failure retries after 10 minutes of chain time. */
  private async daily(nowSec: number): Promise<void> {
    const d = this.deps;
    if (!d.dailyCheck || nowSec < this.dailyRetryAt) return;
    for (;;) {
      const day = this.p.dailyNext;
      if (nowSec < (day + 1) * DAY + d.fileDelayHours * 3600) return;
      if (this.state.nextMinute < minutesStartingBefore(d.launchTime, day)) return;
      let diffs: string[];
      try {
        diffs = await d.dailyCheck(day);
      } catch (e) {
        this.dailyRetryAt = nowSec + RETRY_SECONDS;
        await this.alert(`verifier: daily check for day ${day} failed: ${(e as Error).message}`, nowSec);
        return;
      }
      for (const diff of diffs) await this.alert(`verifier: daily check day ${day}: ${diff}`, nowSec);
      const sums: Persisted["sums"] = {};
      for (const [k, v] of Object.entries(this.p.sums)) if (Number(k) > day) sums[k] = v;
      this.p = { ...this.p, sums, dailyNext: day + 1 };
      this.save();
    }
  }

  /** One pass: a tick, then how long to sleep. Errors are logged, alerted (once an hour per text) and back off. */
  async cycle(): Promise<number> {
    try {
      const r = await this.tick();
      this.backoff.reset();
      return r === "ok" ? 0 : r === "waiting" ? WAIT_SECONDS : MISMATCH_SLEEP_SECONDS;
    } catch (e) {
      const msg = (e as Error).message;
      this.deps.log(`error: ${msg}`);
      if (this.dedupe.shouldSend(`error: ${msg}`, Date.now())) {
        try {
          await this.deps.alert(`verifier error: ${msg}`);
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


function cloneSums(s: Persisted["sums"]): Persisted["sums"] {
  return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v }]));
}

const parseRows = (file: CheckpointFile): FeeRow[] => parseTableCsv(file.table);

/** True when a row of the table names a wallet that `regs` does not have. */
function hasUnregisteredRow(file: CheckpointFile, regs: readonly Registration[]): boolean {
  const want = new Set(parseRows(file).map((r) => lower(r.user)));
  for (const r of regs) {
    if (want.size === 0) break;
    want.delete(lower(r.user));
  }
  return want.size > 0;
}

// ------------------------------------------------------------------ daily check

/** Hyperliquid's builder-fill CSV, as ApiFill (ms) with the user. Columns are found by header name. */
export function parseBuilderFile(text: string): (ApiFill & { user: Addr })[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, "")).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`builder file: missing column ${name}`);
    return i;
  };
  const iTime = col("time"), iUser = col("user"), iCoin = col("coin"), iPx = col("px"), iSz = col("sz"), iFee = col("builder_fee");
  return lines.slice(1).map((line, k) => {
    const f = line.split(",");
    if (f.length !== header.length) throw new Error(`builder file line ${k + 2}: ${f.length} fields, expected ${header.length}`);
    const time = Date.parse(f[iTime]);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(f[iTime]) || Number.isNaN(time)) throw new Error(`builder file line ${k + 2}: bad time "${f[iTime]}"`);
    return { time, user: f[iUser].toLowerCase() as Addr, coin: f[iCoin], px: f[iPx], sz: f[iSz], builderFee: f[iFee], tid: k };
  });
}

/**
 * The daily check for chain 999 (spec §5): for UTC `day`, each registered wallet's counted fees in Hyperliquid's builder
 * file (same counting rule as the API fills) against the verifier's own API sums for that day. Wallets that are not
 * registered, and fills before a wallet registered or before launch, are not differences. Returns one line per differing wallet.
 */
export function makeDailyCheck(o: {
  store: Store;
  registry: Registry;
  launchTime: number;
  /** The builder file's text for `day`, or null when Hyperliquid has not published it. */
  file(day: number): Promise<string | null>;
}): (day: number) => Promise<string[]> {
  return async (day) => {
    const text = await o.file(day);
    if (text === null) throw new Error(`Hyperliquid's builder file for day ${day} is not available`);
    const regs = new Map((await o.registry.list()).map((r) => [lower(r.user), r.registeredAt] as const));
    const fromFile = new Map<string, bigint>();
    for (const f of parseBuilderFile(text)) {
      const registeredAt = regs.get(f.user);
      if (registeredAt === undefined || dayOf(Math.floor(f.time / 1000)) !== day) continue;
      const fee = countedFee(f, Math.max(o.launchTime, registeredAt));
      if (fee !== null) fromFile.set(f.user, (fromFile.get(f.user) ?? 0n) + fee);
    }
    const saved = o.store.readJson<unknown>(STATE_FILE, null);
    const own = (saved === null ? {} : parseSaved(saved).sums)[String(day)] ?? {};
    const out: string[] = [];
    for (const user of [...new Set([...fromFile.keys(), ...Object.keys(own)])].sort()) {
      const a = fromFile.get(user) ?? 0n;
      const b = BigInt(own[user] ?? "0");
      if (a !== b) out.push(`${user}: builder file ${a}, API ${b} (1e-8 USDC)`);
    }
    return out;
  };
}

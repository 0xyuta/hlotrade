import { BaseError, ContractFunctionRevertedError, parseEventLogs, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { buybackAbi, checkpointsAbi, erc20Abi } from "./abi.js";
import { makeWallet } from "./chain.js";
import { checkpointPath, LATEST_PATH, parseCheckpointFile, parseLatestFile, readPublished, settleRound, type CheckpointFile, type LatestFile } from "./checkpoint-files.js";
import { rewardsSource } from "./config.js";
import { chainNow, checkpointConstants, send as sendTx, type Ctx } from "./context.js";
import { AlertDedupe, Backoff } from "./poster.js";

export interface KeeperView {
  now: bigint; // latest HyperEVM block timestamp
  poolOpen: boolean;
  openAt: bigint; // Buyback.launchTime() + OPEN_DELAY
  usdcHeld: bigint; // Buyback's USDC balance (1e6)
  slice: bigint;
  lastBuy: bigint;
  buyInterval: bigint;
  lastTry: bigint | null; // chain time of this keeper's last buy() that did not execute (a skip)
  hype: bigint; // keeper's gas balance (1e18)
  minHype: bigint;
}

export type KeeperStep =
  | { kind: "open" }
  | { kind: "buy" }
  | { kind: "lowGas" }
  | { kind: "wait"; until: bigint; why: string }
  | { kind: "idle"; why: string };

export type KeeperResult = "opened" | "bought" | "skipped" | "nothing";
export type SettleResult = "settled" | "notNewer" | "chainMismatch" | "failed";

/** Longest sleep when the next settle time is unknown (nothing published yet, or the read failed): re-read then. */
export const SETTLE_UNKNOWN_SLEEP = 300;
/** Shortest sleep that a settle time alone asks for. */
export const SETTLE_MIN_SLEEP = 30;

export interface SettleChain {
  anySettled: boolean;
  latestMinute: number;
  now: number;
  launchTime: number;
}

/**
 * Chain time at which the newest published checkpoint is due to be settled by the keeper, or null when there is
 * nothing to settle (nothing published, or not newer than the chain's).
 * Nothing settled yet: SETTLE_AFTER launch. Otherwise: SETTLE_AFTER the end of the last settled minute.
 */
export function settleDueAt(
  chain: Pick<SettleChain, "anySettled" | "latestMinute" | "launchTime">,
  latest: { throughMinute: number } | null,
  afterMinutes: number,
): number | null {
  if (!latest) return null;
  if (!chain.anySettled) return chain.launchTime + 60 * afterMinutes;
  if (latest.throughMinute <= chain.latestMinute) return null;
  return chain.launchTime + 60 * (chain.latestMinute + 1) + 60 * afterMinutes;
}

/** True when a published checkpoint is newer than the chain's and nobody has settled for `afterMinutes`. */
export function settleDue(chain: SettleChain, latest: { throughMinute: number } | null, afterMinutes: number): boolean {
  const at = settleDueAt(chain, latest, afterMinutes);
  return at !== null && chain.now >= at;
}

/**
 * The newest minute the keeper may settle at or before `throughMinute`: the newest multiple of `settleRound(chainId)`. The poster
 * writes the user files on every multiple of 15 at any wallet count, so a wallet always has a file with a proof for a round the
 * keeper settled; an off-round minute could leave wallets with files for a settled minute that is never rewritten (spec 2026-10-31 §8).
 */
export function newestRound(throughMinute: number, chainId: number): number {
  const every = settleRound(chainId);
  return throughMinute - (throughMinute % every);
}

/** Seconds until a settle is due: at least 30 s, at most 5 min when unknown. A settle already due is retried after 30 s. */
export function settleSleep(dueAt: number | null, now: number): number {
  if (dueAt === null) return SETTLE_UNKNOWN_SLEEP;
  return Math.max(SETTLE_MIN_SLEEP, dueAt - now);
}

/** One decision from on-chain state. A skipped buy (TWAP guard) is not retried for one BUY_INTERVAL. */
export function nextKeeperStep(v: KeeperView): KeeperStep {
  if (!v.poolOpen) {
    if (v.now < v.openAt) return { kind: "wait", until: v.openAt, why: "pool not due yet" };
    if (v.usdcHeld === 0n) return { kind: "idle", why: "no USDC to seed the pool yet" };
    return v.hype < v.minHype ? { kind: "lowGas" } : { kind: "open" };
  }
  if (v.slice === 0n) return { kind: "idle", why: "slice is 0: buying starts after the next fee deposit" };
  if (v.usdcHeld === 0n) return { kind: "idle", why: "no USDC left to spend" };
  let due = v.lastBuy + v.buyInterval;
  if (v.lastTry !== null && v.lastTry + v.buyInterval > due) due = v.lastTry + v.buyInterval;
  if (v.now < due) return { kind: "wait", until: due, why: "buy interval" };
  return v.hype < v.minHype ? { kind: "lowGas" } : { kind: "buy" };
}

/** Seconds to sleep after a step: until a known wake-up time (chain time), at most one poll, at least 1 s. */
export function sleepFor(step: KeeperStep, now: bigint, pollSeconds: number): number {
  if (step.kind !== "wait") return pollSeconds;
  const left = step.until > now ? Number(step.until - now) : 0;
  return Math.max(1, Math.min(pollSeconds, left));
}

/** The custom error name of a revert, if the error is one. */
function revertName(e: unknown): string | undefined {
  if (!(e instanceof BaseError)) return undefined;
  const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
  return r instanceof ContractFunctionRevertedError ? r.data?.errorName : undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Keeper {
  private readonly account: PrivateKeyAccount;
  private readonly dedupe = new AlertDedupe();
  private lastTry: bigint | null = null;

  constructor(private readonly ctx: Ctx, private readonly wallet: typeof makeWallet = makeWallet, private readonly sleepFn: (ms: number) => Promise<void> = sleep) {
    if (!ctx.cfg.keeperKey) throw new Error("KEEPER_KEY is required");
    this.account = privateKeyToAccount(ctx.cfg.keeperKey);
  }

  private async alert(text: string): Promise<void> {
    if (this.dedupe.shouldSend(text, Date.now())) await this.ctx.alert(text);
  }

  async view(): Promise<KeeperView> {
    const c = this.ctx.client;
    const address = this.ctx.d.buyback;
    const usdc: Address = await c.readContract({ address, abi: buybackAbi, functionName: "usdc" });
    const [head, poolOpen, launch, delay, slice, lastBuy, buyInterval, usdcHeld, hype] = await Promise.all([
      chainNow(this.ctx),
      c.readContract({ address, abi: buybackAbi, functionName: "poolOpen" }),
      c.readContract({ address, abi: buybackAbi, functionName: "launchTime" }),
      c.readContract({ address, abi: buybackAbi, functionName: "OPEN_DELAY" }),
      c.readContract({ address, abi: buybackAbi, functionName: "slice" }),
      c.readContract({ address, abi: buybackAbi, functionName: "lastBuy" }),
      c.readContract({ address, abi: buybackAbi, functionName: "BUY_INTERVAL" }),
      c.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      c.getBalance({ address: this.account.address }),
    ]);
    return {
      now: BigInt(head.timestamp), poolOpen, openAt: launch + delay, usdcHeld, slice, lastBuy, buyInterval,
      lastTry: this.lastTry, hype, minHype: this.ctx.cfg.forward.minHype,
    };
  }

  /** Sends openPool() or buy(). A revert that means "someone else just did it" is "nothing", not an error. */
  private async send(fn: "openPool" | "buy", now: bigint): Promise<KeeperResult> {
    const address = this.ctx.d.buyback;
    try {
      await this.ctx.client.simulateContract({ address, abi: buybackAbi, functionName: fn, account: this.account });
    } catch (e) {
      const name = revertName(e);
      if (name === "PoolAlreadyOpen" || name === "TooSoon") return "nothing";
      throw e;
    }
    const wallet = this.wallet(this.ctx.cfg, this.ctx.cfg.keeperKey!);
    const hash = await wallet.writeContract({ address, abi: buybackAbi, functionName: fn, chain: wallet.chain, account: wallet.account });
    const rcpt = await this.ctx.client.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`${fn} reverted (${hash})`);
    this.ctx.log(`${fn}() → ${hash}`);
    if (fn === "openPool") return "opened";
    const events = parseEventLogs({ abi: buybackAbi, logs: rcpt.logs, eventName: ["Bought", "Skipped"] });
    if (events.some((x) => x.eventName === "Bought")) {
      this.lastTry = null;
      return "bought";
    }
    this.lastTry = now; // a TWAP skip still recorded an observation; try again after one interval
    return events.some((x) => x.eventName === "Skipped") ? "skipped" : "nothing";
  }

  /** The newest published checkpoint, or null when none (or no place to read it from, or an unreadable file: alerted). */
  private async readLatest(): Promise<LatestFile | null> {
    try {
      const src = rewardsSource(this.ctx.cfg);
      const text = await readPublished(src.kind === "url" ? src.base : { dir: src.dir }, LATEST_PATH);
      return text === null ? null : parseLatestFile(text);
    } catch (e) {
      await this.alert(`keeper: cannot read ${LATEST_PATH}: ${(e as Error).message}`);
      return null;
    }
  }

  /** The archive file of minute `m` (the signed fields the contract settles), or null when it is missing or unreadable (alerted, tried again next pass). */
  private async readArchive(m: number): Promise<CheckpointFile | null> {
    const path = checkpointPath(m);
    try {
      const src = rewardsSource(this.ctx.cfg);
      const text = await readPublished(src.kind === "url" ? src.base : { dir: src.dir }, path);
      if (text === null) {
        await this.alert(`keeper: ${path} is not published: not settling minute ${m} yet`);
        return null;
      }
      return parseCheckpointFile(text);
    } catch (e) {
      await this.alert(`keeper: cannot read ${path}: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Settles the newest published round (the newest multiple of 15 at or before latest.json's minute; every minute on anvil)
   * when nobody has for SETTLE_AFTER_MINUTES. Its signed fields come from its archive file, `checkpoints/<round>.json`.
   * A round is settled, not an off-round minute, because the poster writes the wallets' user files on rounds: a settled
   * minute with no user files would leave every wallet without a proof if the poster never came back (newestRound).
   * Never throws: a failure is alerted (deduped) and retried on the next pass. `dueAt` (chain time) is null when unknown.
   * latest.json is read only once the chain alone says a settle could be due, and the archive file only once one is due.
   */
  async settleStep(now: bigint): Promise<{ result?: SettleResult; dueAt: number | null }> {
    const { cfg, client, d } = this.ctx;
    const address = d.checkpoints;
    let chain: SettleChain;
    try {
      const [anySettled, latestMinute, { launchTime }] = await Promise.all([
        client.readContract({ address, abi: checkpointsAbi, functionName: "anySettled" }),
        client.readContract({ address, abi: checkpointsAbi, functionName: "latestMinute" }),
        checkpointConstants(this.ctx),
      ]);
      chain = { anySettled, latestMinute: Number(latestMinute), now: Number(now), launchTime };
    } catch (e) {
      await this.alert(`keeper: cannot read the Checkpoints state: ${(e as Error).message}`);
      return { result: "failed", dueAt: null };
    }
    // The earliest a settle could be due, from the chain alone: any newer checkpoint is at least this old.
    const earliest = chain.anySettled
      ? chain.launchTime + 60 * (chain.latestMinute + 1 + cfg.settleAfterMinutes)
      : chain.launchTime + 60 * cfg.settleAfterMinutes;
    if (chain.now < earliest) return { dueAt: earliest };

    const latest = await this.readLatest();
    if (!latest) return { dueAt: null };
    const round = { throughMinute: newestRound(latest.throughMinute, cfg.chainId) };
    const dueAt = settleDueAt(chain, round, cfg.settleAfterMinutes);
    if (!settleDue(chain, round, cfg.settleAfterMinutes)) return { dueAt };
    const file = await this.readArchive(round.throughMinute);
    if (!file) return { dueAt: null };
    try {
      const path = checkpointPath(round.throughMinute);
      if (file.chainId !== cfg.chainId || file.contract.toLowerCase() !== d.checkpoints.toLowerCase()) {
        await this.alert(`keeper: ${path} is for chain ${file.chainId} contract ${file.contract}, not ${cfg.chainId} ${d.checkpoints}: not settling`);
        return { result: "chainMismatch", dueAt: null };
      }
      if (file.throughMinute !== round.throughMinute) {
        await this.alert(`keeper: ${path} holds minute ${file.throughMinute}, not ${round.throughMinute}: not settling`);
        return { result: "failed", dueAt: null };
      }
      const args = [
        { throughMinute: BigInt(file.throughMinute), refBlock: BigInt(file.refBlock), root: file.root, totalEntitled: BigInt(file.totalEntitled) },
        file.sig,
      ] as const;
      try {
        await client.simulateContract({ address, abi: checkpointsAbi, functionName: "settle", args, account: this.account });
        const wallet = this.wallet(cfg, cfg.keeperKey!);
        await sendTx(this.ctx, wallet, { address, abi: checkpointsAbi, functionName: "settle", args: [...args] });
      } catch (e) {
        if (revertName(e) !== "NotNewer") throw e; // NotNewer, from the simulation or from the send: someone else settled first
        this.ctx.log(`settle(${file.throughMinute}): someone else settled`);
        return { result: "notNewer", dueAt };
      }
      return { result: "settled", dueAt };
    } catch (e) {
      const name = revertName(e);
      await this.alert(`keeper: settle(${round.throughMinute}) failed: ${name ?? (e as Error).message}`);
      return { result: "failed", dueAt: null };
    }
  }

  async runOnce(): Promise<{ step: KeeperStep; result?: KeeperResult; now: bigint; settle?: SettleResult; settleDueAt: number | null }> {
    const v = await this.view();
    const step = nextKeeperStep(v);
    let result: KeeperResult | undefined;
    let failure: unknown;
    if (step.kind === "lowGas") {
      await this.alert(`keeper: ${this.account.address} needs HYPE for gas (has ${v.hype})`);
      return { step, now: v.now, settleDueAt: null };
    }
    try {
      if (step.kind === "open") result = await this.send("openPool", v.now);
      else if (step.kind === "buy") result = await this.send("buy", v.now);
    } catch (e) {
      failure = e; // the settle step still runs; the error is rethrown after it
    }
    const settle = await this.settleStep(v.now);
    if (failure !== undefined) throw failure;
    return { step, result, now: v.now, settle: settle.result, settleDueAt: settle.dueAt };
  }

  /** Polls every POLL_SECONDS. Errors back off (doubling up to 30 min); repeat alerts are deduped. */
  async loop(): Promise<never> {
    const backoff = new Backoff(this.ctx.cfg.pollSeconds, 1800);
    for (;;) {
      let sleepSeconds = this.ctx.cfg.pollSeconds;
      try {
        const r = await this.runOnce();
        if (r.result) this.ctx.log(`${r.step.kind}: ${r.result}`);
        if (r.settle) this.ctx.log(`settle: ${r.settle}`);
        // wake at the next buy/open due time (so buys land on the 10-minute mark) or the next settle time, whichever is first
        sleepSeconds = Math.min(sleepFor(r.step, r.now, this.ctx.cfg.pollSeconds), settleSleep(r.settleDueAt, Number(r.now)));
        backoff.reset();
      } catch (e) {
        this.ctx.log(`error: ${(e as Error).message}`);
        await this.alert(`keeper error: ${(e as Error).message}`);
        sleepSeconds = backoff.next();
      }
      await this.sleepFn(sleepSeconds * 1000);
    }
  }
}

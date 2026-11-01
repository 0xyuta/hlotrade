import type { Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { erc20Abi, splitterAbi } from "./abi.js";
import { makeWallet } from "./chain.js";
import type { Config } from "./config.js";
import { send, type Ctx } from "./context.js";
import {
  claimRewards, coreUsdc, MAINNET, perpWithdrawable, referralUnclaimed, spotSendUsdc, TESTNET, usdClassTransfer, USDC_SYSTEM_ADDRESS,
} from "./hl.js";
import { AlertDedupe, Backoff } from "./poster.js";

export interface ForwardState {
  unclaimed: bigint; // Core referral/builder rewards, 1e6
  perpWithdrawable: bigint; // 1e6
  spotUsdc: bigint; // 1e6
  evmUsdc: bigint; // HyperEVM USDC on the builder address, 1e6
  evmHype: bigint; // 1e18
}

export type ForwardStep =
  | { kind: "deposit"; amount: bigint }
  | { kind: "toEvm"; amount: bigint }
  | { kind: "toSpot"; amount: bigint }
  | { kind: "claim" }
  | { kind: "lowGas" }
  | { kind: "idle" };

/** One step per call, draining downstream first so that money never queues behind a stuck stage. */
export function nextStep(s: ForwardState, p: Config["forward"]): ForwardStep {
  if (s.evmUsdc > 0n) return s.evmHype < p.minHype ? { kind: "lowGas" } : { kind: "deposit", amount: s.evmUsdc };
  if (s.spotUsdc >= p.minMove) return { kind: "toEvm", amount: s.spotUsdc };
  if (s.perpWithdrawable >= p.reserve + p.minMove) return { kind: "toSpot", amount: s.perpWithdrawable - p.reserve };
  if (s.unclaimed >= p.minClaim) return { kind: "claim" };
  return { kind: "idle" };
}

/**
 * The perps-to-spot amount from a withdrawable read just before the transfer. A second forwarder (a deploy overlap)
 * may have moved money since the plan; 0 or less means the transfer would touch the reserve and must be skipped.
 */
export const toSpotAmount = (freshWithdrawable: bigint, reserve: bigint) => freshWithdrawable - reserve;

/** The HyperCore side. Faked in the anvil e2e, since anvil has no HyperCore. */
export interface HlPort {
  unclaimed(): Promise<bigint>;
  perpWithdrawable(): Promise<bigint>;
  spotUsdc(): Promise<bigint>;
  claim(): Promise<void>;
  toSpot(amount: bigint): Promise<void>;
  toEvm(amount: bigint): Promise<void>;
}

export function realHl(cfg: Config, account: PrivateKeyAccount): HlPort {
  if (cfg.chainId === 31337) throw new Error("no HyperCore on anvil");
  const net = cfg.chainId === 999 ? MAINNET : TESTNET;
  // submit() in hl.ts throws unless the exchange answered status "ok".
  return {
    unclaimed: () => referralUnclaimed(account.address, net),
    perpWithdrawable: () => perpWithdrawable(account.address, net),
    spotUsdc: async () => {
      const b = await coreUsdc(account.address, net);
      return b ? b.total - b.hold : 0n;
    },
    claim: async () => void (await claimRewards(account, net)),
    toSpot: async (a) => void (await usdClassTransfer(account, a, false, net)),
    toEvm: async (a) => void (await spotSendUsdc(account, USDC_SYSTEM_ADDRESS, a, net)),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_STEPS = 8;

export interface ForwarderOpts {
  /** Poll interval while waiting for a step to take effect (default 3 s). */
  pollMs?: number;
  /** Polls before giving up on a step (default 40, i.e. 120 s). */
  pollTries?: number;
}

/** Has `step` visibly taken effect between `before` and `now`? */
function took(step: ForwardStep, before: ForwardState, now: ForwardState): boolean {
  switch (step.kind) {
    case "toEvm":
      return now.evmUsdc > before.evmUsdc; // the bridge credit, not just the Core debit
    case "deposit":
      return now.evmUsdc < before.evmUsdc;
    case "toSpot":
      return now.spotUsdc > before.spotUsdc || now.perpWithdrawable < before.perpWithdrawable;
    case "claim":
      return now.unclaimed < before.unclaimed;
    default:
      return true;
  }
}

export class Forwarder {
  private readonly account: PrivateKeyAccount;
  private readonly hl: HlPort;
  private readonly dedupe = new AlertDedupe();
  private readonly pollMs: number;
  private readonly pollTries: number;

  constructor(private readonly ctx: Ctx, hl?: HlPort, opts: ForwarderOpts = {}) {
    if (!ctx.cfg.builderKey) throw new Error("BUILDER_KEY is required");
    this.account = privateKeyToAccount(ctx.cfg.builderKey);
    if (this.account.address.toLowerCase() !== ctx.cfg.builder) throw new Error("BUILDER_KEY does not belong to BUILDER");
    this.hl = hl ?? realHl(ctx.cfg, this.account);
    this.pollMs = opts.pollMs ?? 3000;
    this.pollTries = opts.pollTries ?? 40;
  }

  private async alert(text: string): Promise<void> {
    if (this.dedupe.shouldSend(text, Date.now())) await this.ctx.alert(text);
  }

  private usdc(): Promise<Address> {
    return this.ctx.client.readContract({ address: this.ctx.d.splitter, abi: splitterAbi, functionName: "usdc" });
  }

  async state(): Promise<ForwardState> {
    const usdc = await this.usdc();
    const [unclaimed, perp, spot, evmUsdc, evmHype] = await Promise.all([
      this.hl.unclaimed(),
      this.hl.perpWithdrawable(),
      this.hl.spotUsdc(),
      this.ctx.client.readContract({ address: usdc, abi: erc20Abi, functionName: "balanceOf", args: [this.account.address] }),
      this.ctx.client.getBalance({ address: this.account.address }),
    ]);
    return { unclaimed, perpWithdrawable: perp, spotUsdc: spot, evmUsdc, evmHype };
  }

  /** Sends the step. False when it was skipped (nothing sent). */
  private async execute(step: ForwardStep): Promise<boolean> {
    switch (step.kind) {
      case "claim":
        await this.hl.claim();
        return true;
      case "toSpot": {
        const amount = toSpotAmount(await this.hl.perpWithdrawable(), this.ctx.cfg.forward.reserve);
        if (amount <= 0n) {
          this.ctx.log(`toSpot skipped: perps withdrawable is no longer above the reserve`);
          return false;
        }
        await this.hl.toSpot(amount);
        return true;
      }
      case "toEvm":
        await this.hl.toEvm(step.amount);
        return true;
      case "deposit": {
        const wallet = makeWallet(this.ctx.cfg, this.ctx.cfg.builderKey!);
        const usdc = await this.usdc();
        const allowance = await this.ctx.client.readContract({
          address: usdc, abi: erc20Abi, functionName: "allowance", args: [this.account.address, this.ctx.d.splitter],
        });
        if (allowance < step.amount) {
          await send(this.ctx, wallet, { address: usdc, abi: erc20Abi, functionName: "approve", args: [this.ctx.d.splitter, step.amount] });
        }
        await send(this.ctx, wallet, { address: this.ctx.d.splitter, abi: splitterAbi, functionName: "deposit", args: [step.amount] });
        return true;
      }
      default:
        return false;
    }
  }

  /** Runs up to 8 steps, re-planning from fresh state after each. Returns the steps taken, ending in idle, lowGas or a stall. */
  async runOnce(): Promise<ForwardStep[]> {
    const done: ForwardStep[] = [];
    for (let i = 0; i < MAX_STEPS; i++) {
      const before = await this.state();
      const step = nextStep(before, this.ctx.cfg.forward);
      done.push(step);
      if (step.kind === "idle") break;
      if (step.kind === "lowGas") {
        await this.alert(`forwarder: ${this.account.address} needs HYPE for gas (has ${before.evmHype})`);
        break;
      }
      this.ctx.log(`${step.kind}${"amount" in step ? ` ${step.amount}` : ""}`);
      if (!(await this.execute(step))) break; // skipped: the next run plans again from fresh balances
      let moved = false;
      for (let t = 0; t < this.pollTries; t++) {
        if (took(step, before, await this.state())) {
          moved = true;
          break;
        }
        await sleep(this.pollMs);
      }
      if (!moved) {
        // Never re-issue a step that has not visibly landed: it could double-send. The next run re-plans.
        this.ctx.log(`${step.kind} not visible after ${(this.pollMs * this.pollTries) / 1000}s, stopping this run`);
        await this.alert(`forwarder: ${step.kind} did not take effect within ${(this.pollMs * this.pollTries) / 1000}s`);
        break;
      }
    }
    return done;
  }

  /** Runs hourly. Errors back off (doubling up to 30 min) and repeat alerts are deduped. */
  async loop(): Promise<never> {
    const backoff = new Backoff(this.ctx.cfg.pollSeconds, 1800);
    for (;;) {
      let sleepSeconds = 3600;
      try {
        await this.runOnce();
        backoff.reset();
      } catch (e) {
        this.ctx.log(`error: ${(e as Error).message}`);
        await this.alert(`forwarder error: ${(e as Error).message}`);
        sleepSeconds = backoff.next();
      }
      await sleep(sleepSeconds * 1000);
    }
  }
}

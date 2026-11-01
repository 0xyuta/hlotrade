import type { Addr, ApiFill } from "@hlo/calc";

/** What a fill read weighs (Hyperliquid: `userFillsByTime` weighs 20, plus 1 per 20 items returned). */
const READ_WEIGHT = 20;
const ITEMS_PER_WEIGHT = 20;

/**
 * Spaces out fill reads so a process stays inside its IP's weight allowance (1,200 a minute). Idle time earns no burst.
 * The 429 retry in hl.ts stays as the safety net. Wall-clock on purpose: it paces real requests.
 */
export class Pacer {
  private nextAt = 0;
  private readonly intervalMs: number;

  constructor(perMinute: number, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.intervalMs = 60_000 / perMinute;
  }

  /** Waits for the next slot and takes it. */
  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextAt);
    this.nextAt = at + this.intervalMs;
    if (at > now) await this.sleep(at - now);
  }

  /** A response of `n` items: what it weighed above the read itself pushes the next slot back. */
  addItems(n: number): void {
    if (n <= ITEMS_PER_WEIGHT) return;
    this.nextAt += (Math.floor(n / ITEMS_PER_WEIGHT) / READ_WEIGHT) * this.intervalMs;
  }
}

export type FillRead = (user: Addr, startMs: number, endMs: number) => Promise<ApiFill[]>;

export const pacedFills = (pacer: Pacer, read: FillRead): FillRead => async (user, startMs, endMs) => {
  await pacer.wait();
  const fills = await read(user, startMs, endMs);
  pacer.addItems(fills.length);
  return fills;
};

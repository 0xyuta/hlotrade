import { describe, expect, it } from "vitest";
import { nextStep, toSpotAmount, type ForwardState } from "../src/forwarder.js";

const p = { reserve: 110_000_000n, minMove: 10_000_000n, minClaim: 1_000_000n, minHype: 50_000_000_000_000_000n };
const s = (o: Partial<ForwardState>): ForwardState => ({ unclaimed: 0n, perpWithdrawable: 0n, spotUsdc: 0n, evmUsdc: 0n, evmHype: 10n ** 18n, ...o });

describe("nextStep", () => {
  it("drains downstream first", () => {
    expect(nextStep(s({ evmUsdc: 5n, spotUsdc: 50_000_000n, unclaimed: 9_000_000n }), p)).toEqual({ kind: "deposit", amount: 5n });
    expect(nextStep(s({ spotUsdc: 50_000_000n, unclaimed: 9_000_000n }), p)).toEqual({ kind: "toEvm", amount: 50_000_000n });
    expect(nextStep(s({ perpWithdrawable: 130_000_000n, unclaimed: 9_000_000n }), p)).toEqual({ kind: "toSpot", amount: 20_000_000n });
    expect(nextStep(s({ unclaimed: 9_000_000n }), p)).toEqual({ kind: "claim" });
  });
  it("keeps the reserve and ignores dust", () => {
    expect(nextStep(s({ perpWithdrawable: 119_000_000n }), p)).toEqual({ kind: "idle" });
    expect(nextStep(s({ spotUsdc: 9_999_999n }), p)).toEqual({ kind: "idle" });
    expect(nextStep(s({ unclaimed: 999_999n }), p)).toEqual({ kind: "idle" });
  });
  it("stops on low gas instead of depositing", () => {
    expect(nextStep(s({ evmUsdc: 5n, evmHype: 1n }), p)).toEqual({ kind: "lowGas" });
  });
});

describe("toSpotAmount", () => {
  it("is the fresh withdrawable minus the reserve, and 0 or less when the reserve would be touched", () => {
    expect(toSpotAmount(130_000_000n, p.reserve)).toBe(20_000_000n);
    expect(toSpotAmount(110_000_000n, p.reserve)).toBe(0n);
    expect(toSpotAmount(90_000_000n, p.reserve)).toBe(-20_000_000n);
  });
});

// ---- Forwarder.runOnce / constructor with a fake HyperCore and a fake chain client

import { privateKeyToAccount } from "viem/accounts";
import { Forwarder, type HlPort } from "../src/forwarder.js";
import type { Ctx } from "../src/context.js";

const KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // anvil dev key #0
const OTHER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil dev key #1
const builder = privateKeyToAccount(KEY).address.toLowerCase();

interface Fake { unclaimed: bigint; perp: bigint; spot: bigint; evm: bigint; hype: bigint; calls: string[]; log: string[]; alerts: string[] }

function setup(init: Partial<Fake>, o: { key?: string; chainId?: number; stall?: boolean } = {}) {
  const f: Fake = { unclaimed: 0n, perp: 0n, spot: 0n, evm: 0n, hype: 10n ** 18n, calls: [], log: [], alerts: [], ...init };
  const hl: HlPort = {
    unclaimed: async () => f.unclaimed,
    perpWithdrawable: async () => f.perp,
    spotUsdc: async () => f.spot,
    claim: async () => { f.calls.push("claim"); if (!o.stall) { f.perp += f.unclaimed; f.unclaimed = 0n; } },
    toSpot: async (a) => { f.calls.push(`toSpot ${a}`); if (!o.stall) { f.perp -= a; f.spot += a; } },
    toEvm: async (a) => { f.calls.push(`toEvm ${a}`); if (!o.stall) { f.spot -= a; f.evm += a; } },
  };
  const ctx = {
    cfg: { chainId: o.chainId ?? 998, builder, builderKey: o.key ?? KEY, forward: p, rpcUrls: ["http://127.0.0.1:1"], pollSeconds: 1 },
    d: { splitter: "0x00000000000000000000000000000000000000a1" },
    client: {
      readContract: async (c: { functionName: string }) => {
        if (c.functionName === "usdc") return "0x00000000000000000000000000000000000000b2";
        if (c.functionName === "balanceOf") return f.evm;
        if (c.functionName === "allowance") return 0n;
        throw new Error(`unexpected ${c.functionName}`);
      },
      getBalance: async () => f.hype,
    },
    log: (s: string) => f.log.push(s),
    alert: async (s: string) => void f.alerts.push(s),
  } as unknown as Ctx;
  return { f, hl, ctx };
}

describe("Forwarder", () => {
  it("refuses a missing key, a foreign key, and anvil without an HlPort", () => {
    const a = setup({});
    expect(() => new Forwarder({ ...a.ctx, cfg: { ...a.ctx.cfg, builderKey: undefined } } as Ctx, a.hl)).toThrow("BUILDER_KEY is required");
    expect(() => new Forwarder(setup({}, { key: OTHER }).ctx, a.hl)).toThrow("does not belong to BUILDER");
    expect(() => new Forwarder(setup({}, { chainId: 31337 }).ctx)).toThrow("no HyperCore on anvil");
    expect(() => new Forwarder(setup({}, { chainId: 31337 }).ctx, a.hl)).not.toThrow(); // the e2e fake
  });

  it("walks claim → toSpot → toEvm, then stops at the deposit when HYPE is short", async () => {
    const { f, hl, ctx } = setup({ unclaimed: 200_000_000n, hype: 1n });
    const steps = await new Forwarder(ctx, hl, { pollMs: 1 }).runOnce();
    expect(steps.map((s) => s.kind)).toEqual(["claim", "toSpot", "toEvm", "lowGas"]);
    expect(f.calls).toEqual(["claim", "toSpot 90000000", "toEvm 90000000"]);
    expect(f.evm).toBe(90_000_000n);
    expect(f.perp).toBe(110_000_000n); // the reserve stays
    expect(f.alerts).toHaveLength(1);
    expect(f.alerts[0]).toContain("needs HYPE");
  });

  it("does not re-issue a step that never landed", async () => {
    const { f, hl, ctx } = setup({ unclaimed: 5_000_000n }, { stall: true });
    const steps = await new Forwarder(ctx, hl, { pollMs: 1, pollTries: 3 }).runOnce();
    expect(steps.map((s) => s.kind)).toEqual(["claim"]);
    expect(f.calls).toEqual(["claim"]);
    expect(f.alerts[0]).toContain("did not take effect");
  });

  it("re-reads perps withdrawable right before the transfer and sends only what is above the reserve now", async () => {
    const { f, hl, ctx } = setup({ perp: 130_000_000n });
    let reads = 0;
    // Another instance moved 15 USDC between this run's plan and its transfer.
    const racing: HlPort = { ...hl, perpWithdrawable: async () => (++reads === 2 ? (f.perp = 115_000_000n) : f.perp) };
    await new Forwarder(ctx, racing, { pollMs: 1 }).runOnce();
    expect(f.calls[0]).toBe("toSpot 5000000");
    expect(f.perp).toBe(110_000_000n);
  });

  it("skips the transfer and stops the run when the fresh withdrawable is at or below the reserve", async () => {
    const { f, hl, ctx } = setup({ perp: 130_000_000n });
    let reads = 0;
    const racing: HlPort = { ...hl, perpWithdrawable: async () => (++reads === 2 ? (f.perp = 105_000_000n) : f.perp) };
    const steps = await new Forwarder(ctx, racing, { pollMs: 1 }).runOnce();
    expect(f.calls).toEqual([]);
    expect(steps.map((x) => x.kind)).toEqual(["toSpot"]);
    expect(f.log.some((l) => l.includes("skipped"))).toBe(true);
    expect(f.alerts).toEqual([]);
  });

  it("is idle with nothing to move", async () => {
    const { f, hl, ctx } = setup({ spot: 9_999_999n, unclaimed: 999_999n });
    expect((await new Forwarder(ctx, hl).runOnce()).map((s) => s.kind)).toEqual(["idle"]);
    expect(f.calls).toEqual([]);
  });
});

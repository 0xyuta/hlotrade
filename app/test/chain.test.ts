import { describe, expect, it } from "vitest";
import { joinChain, readCoreChain, readExtraChain, readRootOf } from "../src/rewards/chain";

const K = {
  token: "0x00000000000000000000000000000000000000a1", checkpoints: "0x00000000000000000000000000000000000000a2", mining: "0x00000000000000000000000000000000000000a3",
  staking: "0x00000000000000000000000000000000000000a4", buyback: "0x00000000000000000000000000000000000000a5", splitter: "0x00000000000000000000000000000000000000a6",
  profiles: "0x00000000000000000000000000000000000000a7", pair: "0x00000000000000000000000000000000000000a8",
} as const;
const USER = "0x1111111111111111111111111111111111111111";
const ROOT = (d: number) => `0x${d.toString(16).padStart(64, "0")}`;
const POSTER = "0x00000000000000000000000000000000000000b1";

/** Checkpoints settled through minute 40 (or none); pool open or not. */
function fake(o: { poolOpen: boolean; anySettled?: boolean; anyValid?: boolean; latestMinute?: bigint; latestValidMinute?: bigint; latestRoot?: string; paused?: boolean }) {
  const reads: { fn: string; address: string; args: readonly unknown[] }[] = [];
  const anySettled = o.anySettled ?? true;
  const anyValid = o.anyValid ?? anySettled;
  const vals: Record<string, (args: readonly unknown[]) => unknown> = {
    anyValid: () => anyValid, latestValidMinute: () => (anyValid ? (o.latestValidMinute ?? o.latestMinute ?? 40n) : 0n),
    anySettled: () => anySettled, latestMinute: () => (anySettled ? (o.latestMinute ?? 40n) : 0n), launchTime: () => 8_640_000n,
    poster: () => POSTER, paused: () => o.paused ?? false, rootOf: ([m]) => (Number(m) === Number(o.latestMinute ?? 40n) ? (o.latestRoot ?? ROOT(40)) : ROOT(0)),
    claimed: () => 5n, claimAvailable: () => 1234n, balanceOf: () => 40n, staked: () => 3n, pending: () => 2n, allowance: () => 1n,
    totalStaked: () => 30n, undripped: () => 9n, totalBurned: () => 11n, totalSpent: () => 12n, totalBought: () => 13n,
    poolOpen: () => o.poolOpen, OPEN_DELAY: () => 604_800n, BUY_INTERVAL: () => 600n, slice: () => 4n, lastBuy: () => 9_100_000n,
    usdc: () => "0x00000000000000000000000000000000000000c1", hloIsToken0: () => true, getReserves: () => [10n ** 21n, 2_000_000_000n, 0],
  };
  return {
    reads,
    getBlock: async () => ({ timestamp: 9_200_000n }),
    readContract: async (a: { address: string; functionName: string; args?: readonly unknown[] }) => {
      reads.push({ fn: a.functionName, address: a.address, args: a.args ?? [] });
      const f = vals[a.functionName];
      if (!f) throw new Error(`unexpected ${a.functionName}`);
      return f(a.args ?? []);
    },
  };
}
const names = (f: ReturnType<typeof fake>) => f.reads.map((r) => r.fn);

describe("readRootOf (the root a minute was settled at, for a user file older than the chain)", () => {
  it("is rootOf(minute) on the Checkpoints contract, and one read", async () => {
    const f = fake({ poolOpen: true, latestMinute: 33n, latestRoot: ROOT(33) });
    expect(await readRootOf(f as never, K, 33)).toBe(ROOT(33));
    expect(f.reads).toEqual([{ fn: "rootOf", address: K.checkpoints, args: [33n] }]);
  });
  it("is null when it reads zero: a minute never settled, or cancelled by the guardian", async () => {
    const f = fake({ poolOpen: true, latestMinute: 33n });
    expect(await readRootOf(f as never, K, 32)).toBeNull();
  });
  it("a failing read throws (the caller decides what that means)", async () => {
    await expect(readRootOf({ readContract: async () => { throw new Error("rpc down"); }, getBlock: async () => ({ timestamp: 0n }) } as never, K, 3)).rejects.toThrow("rpc down");
  });
});

describe("readCoreChain (the Checkpoints and Mining reads)", () => {
  it("block time, launch, latest settled minute and root, paused, poster; claimed from Mining", async () => {
    const f = fake({ poolOpen: true });
    const r = await readCoreChain(f as never, K, USER);
    expect(r).toEqual({
      now: 9_200_000, launchTime: 8_640_000, anySettled: true, latestMinute: 40, latestValidMinute: 40, latestRoot: ROOT(40), paused: false, poster: POSTER, claimed: 5n, claimAvailable: 1234n,
    });
    expect(f.reads.find((x) => x.fn === "rootOf")).toMatchObject({ address: K.checkpoints, args: [40n] });
    expect(f.reads.find((x) => x.fn === "claimed")).toMatchObject({ address: K.mining, args: [USER] });
    expect(f.reads.find((x) => x.fn === "claimAvailable")).toMatchObject({ address: K.mining, args: [] });
    expect(f.reads.filter((x) => ["anySettled", "latestMinute", "launchTime", "poster", "paused"].includes(x.fn)).every((x) => x.address === K.checkpoints)).toBe(true);
  });
  it("nothing settled yet: no latest minute or root (minute 0 is not 'settled'), and rootOf is not read", async () => {
    const f = fake({ poolOpen: true, anySettled: false });
    const r = await readCoreChain(f as never, K, USER);
    expect(r).toMatchObject({ anySettled: false, latestMinute: null, latestValidMinute: null, latestRoot: null });
    expect(names(f)).not.toContain("rootOf");
  });
  it("reads the latest valid minute; null when nothing valid is settled (all cancelled)", async () => {
    const r = await readCoreChain(fake({ poolOpen: true, latestMinute: 40n, latestValidMinute: 30n }) as never, K, USER);
    expect(r).toMatchObject({ latestMinute: 40, latestValidMinute: 30 });
    const none = await readCoreChain(fake({ poolOpen: true, latestMinute: 40n, anyValid: false }) as never, K, USER);
    expect(none.latestValidMinute).toBeNull();
  });
  it("a zero root at the latest minute is no root", async () => {
    const r = await readCoreChain(fake({ poolOpen: true, latestRoot: ROOT(0) }) as never, K, USER);
    expect(r.latestRoot).toBeNull();
  });
  it("paused is passed through", async () => {
    expect((await readCoreChain(fake({ poolOpen: true, paused: true }) as never, K, USER)).paused).toBe(true);
  });
  it("reads nothing from Staking, Buyback, the token or the pair", async () => {
    const f = fake({ poolOpen: true });
    await readCoreChain(f as never, K, USER);
    for (const n of ["staked", "pending", "totalStaked", "undripped", "totalBurned", "totalSpent", "poolOpen", "slice", "getReserves", "balanceOf", "allowance", "usdc"]) {
      expect(names(f), n).not.toContain(n);
    }
  });
  it("claimAvailable is global: read in the same batch with or without a user, and the whole batch stays within 20 calls", async () => {
    const f = fake({ poolOpen: true });
    expect((await readCoreChain(f as never, K, null)).claimAvailable).toBe(1234n);
    expect(names(f)).toContain("claimAvailable");
    const g = fake({ poolOpen: true });
    await readCoreChain(g as never, K, USER);
    expect(g.reads.length).toBeLessThanOrEqual(20);
  });
  it("no user → no claimed read, claimed null", async () => {
    const f = fake({ poolOpen: false });
    const r = await readCoreChain(f as never, K, null);
    expect(r.claimed).toBeNull();
    expect(names(f)).not.toContain("claimed");
  });
  it("a latestMinute too large for a JS number is an error, not a wrong number", async () => {
    await expect(readCoreChain(fake({ poolOpen: true, latestMinute: 2n ** 60n, latestRoot: ROOT(1) }) as never, K, USER)).rejects.toThrow(/latestMinute/);
  });
});

describe("readExtraChain (Staking, token and Buyback reads)", () => {
  it("staking, protocol and the user's token and staking numbers", async () => {
    const f = fake({ poolOpen: true });
    const r = await readExtraChain(f as never, K, USER);
    expect(r).toEqual({
      user: { hlo: 40n, staked: 3n, pending: 2n, allowance: 1n },
      staking: { totalStaked: 30n, undripped: 9n },
      protocol: { totalBurned: 11n, totalSpent: 12n, totalBought: 13n, poolOpen: true, openAt: 8_640_000 + 604_800, slice: 4n, lastBuy: 9_100_000, buyInterval: 600, usdcHeld: 40n, price: 2 },
    });
    expect(names(f)).not.toContain("latestMinute");
    expect(names(f)).not.toContain("claimed");
  });
  it("no user → no user reads; closed pool → no reserves read, price null", async () => {
    const f = fake({ poolOpen: false });
    const r = await readExtraChain(f as never, K, null);
    expect(r.user).toBeNull();
    expect(r.protocol.price).toBeNull();
    expect(names(f)).not.toContain("getReserves");
  });
  it("a Buyback failure does not touch the core read", async () => {
    const f = fake({ poolOpen: true });
    const bad = { ...f, readContract: async (a: { functionName: string; args?: readonly unknown[] }) => {
      if (a.functionName === "slice") throw new Error("reverted");
      return f.readContract(a as never);
    } };
    await expect(readExtraChain(bad as never, K, USER)).rejects.toThrow("reverted");
    await expect(readCoreChain(bad as never, K, USER)).resolves.toMatchObject({ latestMinute: 40 });
  });
});

describe("joinChain", () => {
  it("is the shape the staking and protocol cards take: claimed plus the extra user numbers", async () => {
    const f = fake({ poolOpen: true });
    const full = joinChain(await readCoreChain(f as never, K, USER), await readExtraChain(f as never, K, USER));
    expect(full.user).toEqual({ claimed: 5n, hlo: 40n, staked: 3n, pending: 2n, allowance: 1n });
    expect(full).not.toHaveProperty("claimed");
    expect(full.protocol.poolOpen).toBe(true);
  });
  it("no user: user null", async () => {
    const f = fake({ poolOpen: true });
    expect(joinChain(await readCoreChain(f as never, K, null), await readExtraChain(f as never, K, null)).user).toBeNull();
  });
});

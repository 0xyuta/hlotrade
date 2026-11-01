import { describe, expect, it } from "vitest";
import { ARBITRUM_WITHDRAW_MIN_NET, cctpMaxFee, ETHEREUM_WITHDRAW_MIN_NET, fmtSol, parseUsdc, quote, SOLANA_DEPOSIT_SOL_ESTIMATE, SOLANA_WITHDRAW_MIN_NET, type IrisFee } from "../src/routes/fees";
import { routesFor } from "../src/routes/list";

const eth: IrisFee[] = [
  { finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 228733, med: 241300, high: 253867 } },
  { finalityThreshold: 2000, minimumFee: 0, forwardFee: { low: 228733, med: 241300, high: 253867 } },
];
const arb: IrisFee[] = [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 200000, med: 200000, high: 200000 } }];

describe("parseUsdc", () => {
  it("parses up to 6 decimals", () => {
    expect(parseUsdc("10.5")).toBe(10_500_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("1.1234567")).toBeNull();
    expect(parseUsdc("")).toBeNull();
    expect(parseUsdc("-1")).toBeNull();
  });
});

describe("cctpMaxFee [R §6.3]", () => {
  it("protocol bps (rounded up) + forwardFee.med", () => {
    expect(cctpMaxFee(10_000_000n, eth)).toBe(1_000n + 241_300n);
    expect(cctpMaxFee(10_000_000n, arb)).toBe(200_000n);
    expect(cctpMaxFee(1_000_000_000n, [{ finalityThreshold: 1000, minimumFee: 1.4, forwardFee: { low: 0, med: 0, high: 0 } }])).toBe(140_000n);
    expect(cctpMaxFee(1n, eth)).toBe(1n + 241_300n);
  });
  it("throws when the fast threshold is missing", () => {
    expect(() => cctpMaxFee(1n, [])).toThrow();
  });
  it("rounds the protocol fee up for fractional bps, never down (review I1)", () => {
    const one = (minimumFee: number): IrisFee[] => [{ finalityThreshold: 1000, minimumFee, forwardFee: { low: 0, med: 0, high: 0 } }];
    expect(cctpMaxFee(10_000_000n, one(1.005))).toBe(1_005n); // exact: 10e6 * 1.005 / 1e4
    expect(cctpMaxFee(10_000_000n, one(1.004))).toBe(1_004n);
    expect(cctpMaxFee(10_000_000n, one(1.0001))).toBe(1_001n); // 1000.1 rounds up
    expect(cctpMaxFee(1_000_000_000n, one(0.333))).toBe(33_300n);
    expect(cctpMaxFee(1_000_000_001n, one(0.333))).toBe(33_301n); // 33300.0333 rounds up
    expect(cctpMaxFee(3_000_000n, one(1.3))).toBe(390n);
    expect(cctpMaxFee(1_000_000n, one(1e-7))).toBe(1n); // exponent form of a tiny positive bps
    expect(cctpMaxFee(10_000_000n, one(0))).toBe(0n);
  });
  it("rejects unusable Iris numbers (review I2)", () => {
    const row = (o: Partial<IrisFee> & { forwardFee?: unknown }): IrisFee[] => [{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 0, med: 1, high: 2 }, ...o } as IrisFee];
    expect(() => cctpMaxFee(1n, row({ minimumFee: -1 }))).toThrow();
    expect(() => cctpMaxFee(1n, row({ minimumFee: NaN }))).toThrow();
    expect(() => cctpMaxFee(1n, row({ minimumFee: Infinity }))).toThrow();
    expect(() => cctpMaxFee(1n, row({ forwardFee: { low: 0, med: -5, high: 0 } }))).toThrow();
    expect(() => cctpMaxFee(1n, row({ forwardFee: { low: 0, med: 1.5, high: 0 } }))).toThrow();
    expect(() => cctpMaxFee(1n, row({ forwardFee: { low: 0, med: NaN, high: 0 } }))).toThrow();
    expect(() => cctpMaxFee(1n, row({ forwardFee: undefined }))).toThrow();
  });
});

describe("quote", () => {
  it("HyperCore moves are free; HyperEVM deposits cost only gas", () => {
    expect(quote("hypercore", "deposit", 5_000_000n, null)).toMatchObject({ fee: 0n, receiveAtLeast: 5_000_000n, error: null });
    expect(quote("hyperevm", "deposit", 5_000_000n, null)).toMatchObject({ fee: 0n, receiveAtLeast: 5_000_000n });
  });
  it("HyperEVM withdraw fee is unknown [R §4.3]", () => {
    expect(quote("hyperevm", "withdraw", 5_000_000n, null)).toMatchObject({ fee: null, receiveAtLeast: null, error: null });
  });
  it("CCTP deposits need a fee quote and more than the fee", () => {
    expect(quote("ethereum", "deposit", 10_000_000n, null).error).toContain("Fee quote");
    expect(quote("ethereum", "deposit", 10_000_000n, eth)).toMatchObject({ fee: 242_300n, receiveAtLeast: 9_757_700n, error: null });
    expect(quote("arbitrum", "deposit", 200_000n, arb).error).toContain("more than");
  });
  it("CCTP withdrawals show the on-chain cap [R §5.5, §6.4]", () => {
    expect(quote("arbitrum", "withdraw", 10_000_000n, null)).toMatchObject({ fee: 200_000n, receiveAtLeast: 9_800_000n });
    expect(quote("ethereum", "withdraw", 10_000_000n, null)).toMatchObject({ fee: 1_200_000n, receiveAtLeast: 8_800_000n });
  });
  it("an Arbitrum withdrawal must clear the fee by 1 USDC (final polish ruling)", () => {
    expect(ARBITRUM_WITHDRAW_MIN_NET).toBe(1_000_000n);
    expect(quote("arbitrum", "withdraw", 200_001n, null).error).toBe("Withdraw at least 1.20 USDC (the 0.20 fee plus 1.00).");
    expect(quote("arbitrum", "withdraw", 1_199_999n, null).error).toContain("at least 1.20");
    expect(quote("arbitrum", "withdraw", 1_200_000n, null)).toMatchObject({ fee: 200_000n, receiveAtLeast: 1_000_000n, error: null });
  });
  it("an Ethereum withdrawal must clear the fee by 5 USDC (review M9 ruling)", () => {
    expect(ETHEREUM_WITHDRAW_MIN_NET).toBe(5_000_000n);
    expect(quote("ethereum", "withdraw", 1_200_000n, null).error).toContain("at least 6.20");
    expect(quote("ethereum", "withdraw", 6_199_999n, null).error).toContain("at least 6.20");
    expect(quote("ethereum", "withdraw", 6_200_000n, null)).toMatchObject({ fee: 1_200_000n, receiveAtLeast: 5_000_000n, error: null });
  });
  it("bad Iris answers give an error quote, never a throw (review I2)", () => {
    expect(quote("ethereum", "deposit", 10_000_000n, []).error).toContain("Fee quote unavailable");
    expect(quote("ethereum", "deposit", 10_000_000n, [{ finalityThreshold: 1000, minimumFee: NaN, forwardFee: { low: 0, med: 0, high: 0 } }]).error).toContain("Fee quote unavailable");
    expect(quote("arbitrum", "deposit", 10_000_000n, [{ finalityThreshold: 1000, minimumFee: 0, forwardFee: { low: 0, med: -1, high: 0 } }]).error).toContain("Fee quote unavailable");
    expect(quote("arbitrum", "deposit", 10_000_000n, [{ finalityThreshold: 1000, minimumFee: 0 } as IrisFee]).error).toContain("Fee quote unavailable");
  });
  it("error text rounds a fee up to the cent, never down (review M4)", () => {
    expect(quote("ethereum", "deposit", 241_325n, eth).error).toContain("more than 0.25 USDC");
  });
  it("notes carry no research citations (review M1)", () => {
    const all = [quote("hyperevm", "deposit", 1n, null), quote("hyperevm", "withdraw", 1n, null), quote("ethereum", "deposit", 10_000_000n, eth), quote("arbitrum", "withdraw", 10_000_000n, null), quote("hypercore", "deposit", 1n, null)];
    for (const x of all) for (const n of x.notes) expect(n).not.toMatch(/\[R|§/);
  });
  it("a zero amount is an error", () => {
    expect(quote("hyperevm", "deposit", 0n, null).error).toBe("Enter an amount.");
  });
});

describe("route list", () => {
  it("solanaEnabled false: Solana and Robinhood Chain are disabled 'coming soon'; no Bridge2 row", () => {
    const rows = routesFor({ solanaEnabled: false });
    expect(rows.filter((r) => !r.enabled).map((r) => [r.id, r.note])).toEqual([["solana", "coming soon"], ["robinhood", "coming soon"]]);
    expect(rows.some((r) => /bridge2|legacy/i.test(r.label))).toBe(false);
  });
  it("solanaEnabled true: the Solana row is offered", () => {
    expect(routesFor({ solanaEnabled: true }).find((r) => r.id === "solana")).toEqual({ id: "solana", label: "Solana", enabled: true });
  });
});

describe("Solana quotes (Plan 4 C) [P4 §1, §2.2]", () => {
  // [P4 §1] live sandbox numbers for 5 → 19 on 2026-10-28
  const sol: IrisFee[] = [{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 230000, med: 243456, high: 260000 } }];
  it("a deposit uses Iris's fee like the EVM routes and names the SOL cost", () => {
    const qd = quote("solana", "deposit", 10_000_000n, sol);
    expect(qd).toMatchObject({ fee: 1_000n + 243_456n, receiveAtLeast: 10_000_000n - 244_456n, error: null });
    expect(qd.notes.join(" ")).toMatch(/about 0\.004 SOL/);
    // a fresh record account for every deposit, not a one-time cost (Task 10 review m3)
    expect(qd.notes.join(" ")).toMatch(/a temporary record account for this transfer/);
    expect(qd.notes.join(" ")).not.toMatch(/one-time/);
    expect(quote("solana", "deposit", 10_000_000n, null).error).toMatch(/unavailable/);
  });
  it("a withdrawal shows the 0.50 cap and must clear it by 1 USDC: minimum 1.50", () => {
    expect(SOLANA_WITHDRAW_MIN_NET).toBe(1_000_000n);
    expect(quote("solana", "withdraw", 1_499_999n, null).error).toBe("Withdraw at least 1.50 USDC (the 0.50 fee plus 1.00).");
    expect(quote("solana", "withdraw", 1_500_000n, null)).toMatchObject({ fee: 500_000n, receiveAtLeast: 1_000_000n, error: null });
    expect(quote("solana", "withdraw", 10_000_000n, null).notes.join(" ")).toMatch(/creating your USDC account on Solana/);
  });
  it("fmtSol rounds lamports up to 4 decimals", () => {
    expect(fmtSol(SOLANA_DEPOSIT_SOL_ESTIMATE)).toBe("0.004");
    expect(fmtSol(3_108_960n)).toBe("0.0032");
    expect(fmtSol(1_000_000_000n)).toBe("1");
    expect(fmtSol(1n)).toBe("0.0001");
  });
});

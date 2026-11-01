import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import type { IrisMessage, Pending } from "../src/routes/pending";
import { SOLANA_UNCONFIRMED_NOTE, SOLANA_WATCH_NOTE } from "../src/routes/solana/settle";

const log: string[] = [];
const readSolanaDeposit = vi.fn();
const fetchIrisMessage = vi.fn();
const readSolanaUsdcAt = vi.fn();
vi.mock("../src/routes/solana/settle", async (orig) => ({
  ...(await orig<typeof import("../src/routes/solana/settle")>()),
  readSolanaDeposit: (...a: unknown[]) => (log.push("chain"), readSolanaDeposit(...a)),
}));
vi.mock("../src/routes/exec", () => ({ fetchIrisMessage: (...a: unknown[]) => (log.push("iris"), fetchIrisMessage(...a)) }));
vi.mock("../src/routes/solana/rpc", async (orig) => ({ ...(await orig<typeof import("../src/routes/solana/rpc")>()), readSolanaUsdcAt: (...a: unknown[]) => readSolanaUsdcAt(...a) }));

import { pollSolana } from "../src/routes/solana/poll";

const RPC = "https://api.devnet.solana.com";
const SIG = "4".repeat(88);
const EVENT = "7Nq4Hc7gsxCC2KYLbVvTykJDaGQwBnBQ6pYaPFFqpGyp";
const ATA = "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M";
const NOW = 1_000_000;
const cfg = { network: "testnet", solanaEnabled: true, solanaRpc: RPC } as AppConfig;
const dep = (o: Partial<Pending> = {}): Pending => ({ id: SIG, dir: "deposit", route: "solana", amount: "10000000", startedAt: NOW - 1000, status: "pending", srcDomain: 5, txHash: SIG, lastValid: "9", ...o });
const forwarded: IrisMessage = { status: "complete", delayReason: null, forwardTxHash: `0x${"ab".repeat(32)}` };

beforeEach(() => {
  log.length = 0;
  for (const m of [readSolanaDeposit, fetchIrisMessage, readSolanaUsdcAt]) m.mockReset();
  fetchIrisMessage.mockResolvedValue(null);
});

describe("pollSolana (Plan 4 C)", () => {
  it("deposit: reads the chain first, then asks Iris (domain 5) by the signature, and settles", async () => {
    readSolanaDeposit.mockImplementation(async (_u: string, p: Pending) => ({ p, tx: "landed" }));
    fetchIrisMessage.mockResolvedValue(forwarded);
    const out = await pollSolana(cfg, dep(), NOW);
    expect(log).toEqual(["chain", "iris"]);
    expect(readSolanaDeposit).toHaveBeenCalledWith(RPC, dep());
    expect(fetchIrisMessage).toHaveBeenCalledWith("testnet", 5, SIG);
    expect(out.status).toBe("done");
  });
  it("deposit with only an event account: Iris is asked by the signature the chain read adopted, and that record is returned", async () => {
    const adopted = "5".repeat(88);
    const rec = dep({ id: "s-1", txHash: undefined, eventAccount: EVENT, note: SOLANA_UNCONFIRMED_NOTE });
    readSolanaDeposit.mockImplementation(async (_u: string, p: Pending) => ({ p: { ...p, txHash: adopted, note: SOLANA_WATCH_NOTE }, tx: "landed" }));
    const out = await pollSolana(cfg, rec, NOW);
    expect(fetchIrisMessage).toHaveBeenCalledWith("testnet", 5, adopted);
    expect(out).toMatchObject({ id: "s-1", txHash: adopted, eventAccount: EVENT, status: "pending" });
    expect(out.note).toBeUndefined(); // landed: the watch note goes
  });
  it("deposit with only an event account and no signature yet: Iris is not asked, the record stays unconfirmed", async () => {
    const rec = dep({ id: "s-1", txHash: undefined, eventAccount: EVENT, note: SOLANA_UNCONFIRMED_NOTE });
    readSolanaDeposit.mockImplementation(async (_u: string, p: Pending) => ({ p, tx: "unknown" }));
    const out = await pollSolana(cfg, rec, NOW);
    expect(fetchIrisMessage).not.toHaveBeenCalled();
    expect(out).toEqual(rec);
  });
  it("deposit without a Solana RPC: only Iris is asked", async () => {
    fetchIrisMessage.mockResolvedValue(forwarded);
    const out = await pollSolana({ ...cfg, solanaRpc: null }, dep(), NOW);
    expect(readSolanaDeposit).not.toHaveBeenCalled();
    expect(out.status).toBe("done");
  });
  it("withdraw: the watched token account's balance on the build's network settles it", async () => {
    const w: Pending = { id: "w-1", dir: "withdraw", route: "solana", amount: "2000000", startedAt: NOW, status: "pending", balanceKind: "solana", watch: ATA, baseline: "1000000", minArrive: "1500000" };
    readSolanaUsdcAt.mockResolvedValueOnce(2_400_000n);
    expect(await pollSolana(cfg, w, NOW)).toEqual(w);
    readSolanaUsdcAt.mockResolvedValueOnce(2_500_000n);
    expect((await pollSolana(cfg, w, NOW)).status).toBe("done");
    readSolanaUsdcAt.mockResolvedValueOnce(null);
    expect(await pollSolana(cfg, w, NOW)).toEqual(w);
    expect(readSolanaUsdcAt).toHaveBeenCalledWith(RPC, "testnet", ATA);
  });
  it("with the route turned off, the Solana RPC is never asked (the CSP lets it through only while solanaEnabled): signed deposits still settle by Iris (final review M3)", async () => {
    const off = { ...cfg, solanaEnabled: false };
    fetchIrisMessage.mockResolvedValue(forwarded);
    expect((await pollSolana(off, dep(), NOW)).status).toBe("done");
    expect(readSolanaDeposit).not.toHaveBeenCalled();
    const w: Pending = { id: "w-1", dir: "withdraw", route: "solana", amount: "2000000", startedAt: NOW, status: "pending", balanceKind: "solana", watch: ATA, baseline: "0", minArrive: "1500000" };
    expect(await pollSolana(off, w, NOW)).toEqual(w);
    expect(readSolanaUsdcAt).not.toHaveBeenCalled();
  });
  it("a finished record is not read again", async () => {
    const done = dep({ status: "done" });
    expect(await pollSolana(cfg, done, NOW)).toBe(done);
    expect(log).toEqual([]);
  });
});

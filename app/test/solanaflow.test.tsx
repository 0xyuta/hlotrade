// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { UNCONFIRMED_NOTE, UnconfirmedPostError, type SignedBody } from "../src/hl/userSigned";
import { loadPending, pendingKey, type Pending } from "../src/routes/pending";
import { SOLANA_ERROR__SUBTLE_CRYPTO__ED25519_ALGORITHM_UNIMPLEMENTED, SolanaError } from "@solana/kit";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SolanaSendUncertainError } from "../src/routes/solana/deposit";
import { SOLANA_EXPIRED_NOTE, SOLANA_FAILED_NOTE, SOLANA_UNCONFIRMED_NOTE, SOLANA_WATCH_NOTE } from "../src/routes/solana/settle";
import { resetTransferState, transferLock } from "../src/routes/unconfirmed";

let busyOverride: boolean | null = null; // lets a test keep the button enabled while the lock is held, to reach the handler's own guard

const USER = "0x00000000000000000000000000000000000000aa";
const OWNER = "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9";
const ATA = "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M";
const OTHER_ATA = "Ey9dqpS9PBRuNDuG4F2aDWLHFjjoqGD6JsWT3U2mmZsj";
const EVENT = "7Nq4Hc7gsxCC2KYLbVvTykJDaGQwBnBQ6pYaPFFqpGyp";
const SIG = "4".repeat(88);
let cfg: AppConfig;
let wallets: { name: string }[];
const runSolanaDeposit = vi.fn();
const runSolanaWithdraw = vi.fn();
const pollSolana = vi.fn();
const fetchIrisFees = vi.fn();
const readSolanaUsdcAt = vi.fn();
const chains: string[] = [];
const signer = { kind: "sign", address: OWNER, sign: vi.fn() };
const mem = new Map<string, string>();
const fake = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session: { kind: "wallet", address: USER }, write: vi.fn(), hlWallet: () => ({ id: "hl" }) }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => ({ balances: { trade: 100, perps: 100, spot: 0 }, abstraction: "disabled", refresh: vi.fn() }) }));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/routes/useBalances", () => ({ useBalances: () => ({ balances: null, reload: vi.fn() }), readUsdc: vi.fn() }));
vi.mock("../src/routes/exec", async (orig) => ({ ...(await orig<typeof import("../src/routes/exec")>()), fetchIrisFees: (...a: unknown[]) => fetchIrisFees(...a), fetchIrisMessage: vi.fn(async () => null) }));
vi.mock("../src/wallet/solana", async (orig) => ({
  ...(await orig<typeof import("../src/wallet/solana")>()),
  watchSolanaWallets: (chain: string, cb: (w: unknown[]) => void) => (chains.push(`watch ${chain}`), cb(wallets), () => {}),
  connectSolana: async (_w: unknown, chain: string) => (chains.push(`connect ${chain}`), { address: OWNER, chains: [chain], features: [] }),
  solanaSigner: (_w: unknown, _a: unknown, chain: string) => (chains.push(`signer ${chain}`), signer),
}));
vi.mock("../src/routes/solana/ata", async (orig) => ({ ...(await orig<typeof import("../src/routes/solana/ata")>()), usdcAta: async () => ATA }));
vi.mock("../src/routes/solana/rpc", async (orig) => ({ ...(await orig<typeof import("../src/routes/solana/rpc")>()), readSolanaUsdcAt: (...a: unknown[]) => readSolanaUsdcAt(...a) }));
vi.mock("../src/routes/solana/deposit", async (orig) => ({ ...(await orig<typeof import("../src/routes/solana/deposit")>()), runSolanaDeposit: (...a: unknown[]) => runSolanaDeposit(...a) }));
vi.mock("../src/routes/solana/withdraw", () => ({ runSolanaWithdraw: (...a: unknown[]) => runSolanaWithdraw(...a) }));
vi.mock("../src/routes/solana/poll", () => ({ pollSolana: (...a: unknown[]) => pollSolana(...a) }));
vi.mock("../src/routes/unconfirmed", async (orig) => {
  const real = await orig<typeof import("../src/routes/unconfirmed")>();
  return {
    ...real,
    useTransferBusy: () => {
      const busy = real.useTransferBusy(); // always called: the hook order stays the same
      return busyOverride ?? busy;
    },
  };
});

import { TransferModal } from "../src/ui/transfer/TransferModal";
import { EVM_WALLET_TEXT, NO_ED25519_TEXT } from "../src/ui/transfer/SolanaFlow";

const IRIS = [{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 243_456, high: 3 } }];
const stored = () => loadPending(fake, "testnet", USER);
const seed = (list: Pending[]) => fake.setItem(pendingKey("testnet", USER), JSON.stringify(list));
const openSolana = async (dir: "deposit" | "withdraw") => {
  render(<TransferModal dir={dir} onClose={() => {}} />);
  fireEvent.click(screen.getByText("Solana"));
  await screen.findByText(EVM_WALLET_TEXT);
};
const connect = async () => {
  fireEvent.click(screen.getByText("Connect Phantom"));
  await screen.findByText("5tzFki…uAi9");
};
const type = (v: string) => fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: v } });
const depositRec = (o: Partial<Pending> = {}): Pending => ({ id: SIG, dir: "deposit", route: "solana", amount: "10000000", startedAt: 1, status: "pending", srcDomain: 5, txHash: SIG, lastValid: "9", ...o });

beforeEach(() => {
  mem.clear();
  chains.length = 0;
  busyOverride = null;
  resetTransferState();
  vi.stubGlobal("localStorage", fake);
  cfg = { network: "testnet", withdrawEnabled: true, solanaEnabled: true, solanaRpc: "https://api.devnet.solana.com" } as AppConfig;
  wallets = [{ name: "Phantom" }];
  for (const m of [runSolanaDeposit, runSolanaWithdraw, pollSolana, fetchIrisFees, readSolanaUsdcAt]) m.mockReset();
  fetchIrisFees.mockResolvedValue(IRIS);
  readSolanaUsdcAt.mockResolvedValue(50_000_000n);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the Solana route (Plan 4 C)", () => {
  it("is 'coming soon' while solanaEnabled is false", () => {
    cfg = { ...cfg, solanaEnabled: false, solanaRpc: null };
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    expect((screen.getByText("Solana").closest("button") as HTMLButtonElement).disabled).toBe(true);
  });
  it("says an EVM wallet is needed, and when no Solana wallet is installed, says so", async () => {
    wallets = [];
    await openSolana("deposit");
    expect(screen.getByText(/No Solana wallet found/)).toBeTruthy();
  });
  it("uses the build's Solana network: a testnet build discovers, connects and signs on devnet, and reads balances with its network", async () => {
    runSolanaDeposit.mockImplementation(async () => depositRec());
    await openSolana("deposit");
    await connect();
    await screen.findByText(/USDC 50\.00/);
    expect(readSolanaUsdcAt).toHaveBeenCalledWith("https://api.devnet.solana.com", "testnet", ATA);
    type("10");
    await screen.findByText("0.24 USDC");
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    await screen.findByText(/Circle finishes the transfer/);
    expect(chains).toEqual(["watch solana:devnet", "connect solana:devnet", "signer solana:devnet"]);
  });
  it("deposit: shows the Solana USDC balance, Circle's fee and the SOL estimate, then runs one deposit to the connected EVM account, which takes the lock itself", async () => {
    let lockFreeAtCall: boolean | null = null;
    runSolanaDeposit.mockImplementation(async (d: { record(p: Pending): void; lock: typeof transferLock }) => {
      lockFreeAtCall = transferLock.tryBegin(); // the UI must not hold the lock: runSolanaDeposit takes it after its checks
      if (lockFreeAtCall) transferLock.end();
      const rec = depositRec();
      d.record(rec);
      return rec;
    });
    await openSolana("deposit");
    await connect();
    expect(await screen.findByText(/USDC 50\.00/)).toBeTruthy();
    type("10");
    expect(await screen.findByText("0.24 USDC")).toBeTruthy();
    expect(screen.getByText("9.76 USDC")).toBeTruthy(); // what arrives, before any signature
    expect(screen.getByText(/about 0\.004 SOL/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    fireEvent.click(screen.getByRole("button", { name: /Deposit|Confirm in your wallet|Checking/ }));
    expect(await screen.findByText(/Circle finishes the transfer/)).toBeTruthy();
    expect(runSolanaDeposit).toHaveBeenCalledTimes(1);
    expect(lockFreeAtCall).toBe(true);
    expect(runSolanaDeposit.mock.calls[0][0]).toMatchObject({ net: "testnet", rpc: "https://api.devnet.solana.com", owner: OWNER, recipient: USER, amount: 10_000_000n, quotedFee: 244_456n, signer, lock: transferLock });
    expect(stored()).toEqual([expect.objectContaining({ id: SIG, route: "solana" })]);
    expect(screen.getByText(/deposit · Solana · 10\.00 USDC/)).toBeTruthy();
  });
  it("a refused or failed deposit shows the reason and that nothing was sent, and records nothing here", async () => {
    runSolanaDeposit.mockRejectedValueOnce(new Error("The wallet changed the transaction (its content differs), so it was not sent. Nothing moved."));
    await openSolana("deposit");
    await connect();
    type("10");
    await screen.findByText("0.24 USDC");
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    expect(await screen.findByText(/so it was not sent\. Nothing moved\./)).toBeTruthy();
    expect(stored()).toEqual([]);
  });
  it("a browser without WebCrypto Ed25519 is told to update, and that nothing was sent (final review M6)", async () => {
    for (const err of [new SolanaError(SOLANA_ERROR__SUBTLE_CRYPTO__ED25519_ALGORITHM_UNIMPLEMENTED), Object.assign(new Error("Algorithm: Unrecognized name"), { name: "NotSupportedError" })]) {
      runSolanaDeposit.mockRejectedValueOnce(err);
      await openSolana("deposit");
      await connect();
      type("10");
      await screen.findByText("0.24 USDC");
      fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
      expect(await screen.findByText(NO_ED25519_TEXT)).toBeTruthy();
      cleanup();
    }
  });
  it("a Solana USDC balance that could not be read says so and offers Try again (Task 16 review m8)", async () => {
    readSolanaUsdcAt.mockResolvedValueOnce(null);
    await openSolana("deposit");
    await connect();
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/USDC 50\.00/)).toBeTruthy();
    expect(readSolanaUsdcAt).toHaveBeenCalledTimes(2);
  });
  it("the form takes the closed-withdrawal text from a leaf module, not from TransferModal (no import cycle; Task 16 review m4)", () => {
    const src = readFileSync(join(__dirname, "../src/ui/transfer/SolanaFlow.tsx"), "utf8"); // jsdom: import.meta.url is not a file URL here
    expect(src).not.toMatch(/from "\.\/TransferModal"/);
  });
  it("the deposit's record written before a signAndSend prompt leaves the list when the wallet says nothing was sent", async () => {
    runSolanaDeposit.mockImplementationOnce(async (d: { record(p: Pending): void; forget(id: string): void }) => {
      d.record(depositRec({ id: "s-1", txHash: undefined, eventAccount: EVENT, startedAt: Date.now(), note: SOLANA_UNCONFIRMED_NOTE }));
      expect(stored().map((p) => p.id)).toEqual(["s-1"]);
      d.forget("s-1");
      throw new Error("The wallet declined. Nothing was sent.");
    });
    await openSolana("deposit");
    await connect();
    type("10");
    await screen.findByText("0.24 USDC");
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    await screen.findByText("The wallet declined. Nothing was sent.");
    expect(stored()).toEqual([]);
    expect(screen.queryByText(/deposit · Solana/)).toBeNull();
  });
  it("a deposit check that fails before the wallet is asked says nothing was sent", async () => {
    runSolanaDeposit.mockRejectedValueOnce(new Error("Circle's fee service did not answer. Try again in a moment."));
    await openSolana("deposit");
    await connect();
    type("10");
    await screen.findByText("0.24 USDC");
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    expect(await screen.findByText("Circle's fee service did not answer. Try again in a moment. Nothing was sent.")).toBeTruthy();
  });
  it("an unconfirmed deposit says 'unconfirmed: check your balance' and offers no re-send", async () => {
    runSolanaDeposit.mockImplementationOnce(async (d: { record(p: Pending): void }) => {
      d.record(depositRec({ id: "s-1", txHash: undefined, eventAccount: EVENT, note: SOLANA_UNCONFIRMED_NOTE }));
      throw new SolanaSendUncertainError(null);
    });
    await openSolana("deposit");
    await connect();
    type("10");
    await screen.findByText("0.24 USDC");
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    expect(await screen.findByText(/^unconfirmed: check your balance\./)).toBeTruthy();
    expect(screen.getByText(/do not send it again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
    expect(stored()).toEqual([expect.objectContaining({ id: "s-1", note: SOLANA_UNCONFIRMED_NOTE })]);
  });
  it("withdraw: names the 1.50 minimum, the fee and what arrives, then withdraws to the Solana wallet's USDC account under the page-wide lock", async () => {
    let lockHeld: boolean | null = null;
    runSolanaWithdraw.mockImplementation(async () => {
      lockHeld = !transferLock.tryBegin();
      return {};
    });
    await openSolana("withdraw");
    await connect();
    expect(screen.getByText("Withdraw at least 1.50 USDC (the 0.50 fee plus 1.00).")).toBeTruthy();
    expect(screen.getByText(/USDC account \(A37BHq…NU6M\)/)).toBeTruthy();
    type("1.4");
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
    type("2");
    expect(screen.getByText("0.50 USDC")).toBeTruthy();
    expect(screen.getByText("1.50 USDC")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText(/Circle delivers it to your USDC account on Solana/)).toBeTruthy();
    expect(runSolanaWithdraw).toHaveBeenCalledTimes(1);
    expect(lockHeld).toBe(true);
    expect(runSolanaWithdraw.mock.calls[0][0]).toMatchObject({ net: "testnet", wallet: { id: "hl" }, amount: 2_000_000n, sourceDex: "", owner: OWNER });
    expect(transferLock.tryBegin()).toBe(true); // released afterwards
  });
  it("withdraw does not start while another transfer holds the lock", async () => {
    await openSolana("withdraw");
    await connect();
    type("2");
    expect(transferLock.tryBegin()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Withdraw|Confirm in your wallet/ }));
    await act(async () => {});
    expect(runSolanaWithdraw).not.toHaveBeenCalled();
  });
  it("withdraw: the handler's own lock check refuses even when the button is still enabled (Task 16 review m6)", async () => {
    busyOverride = false; // the button does not see the lock: only the handler's tryBegin stands in the way
    await openSolana("withdraw");
    await connect();
    type("2");
    expect(transferLock.tryBegin()).toBe(true);
    const btn = screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await act(async () => {});
    expect(runSolanaWithdraw).not.toHaveBeenCalled();
    transferLock.end();
  });
  it("withdraw: earlier withdrawals are counted only when they watch the same Solana token account", async () => {
    seed([
      { id: "w-1", dir: "withdraw", route: "solana", amount: "5000000", startedAt: Date.now(), status: "pending", balanceKind: "solana", watch: ATA, baseline: "7000000", minArrive: "4500000" },
      { id: "w-2", dir: "withdraw", route: "solana", amount: "90000000", startedAt: Date.now(), status: "pending", balanceKind: "solana", watch: OTHER_ATA, baseline: "90000000", minArrive: "89500000" },
      { id: "w-3", dir: "withdraw", route: "arbitrum", amount: "90000000", startedAt: Date.now(), status: "pending", balanceKind: "arbitrum", baseline: "80000000", minArrive: "89800000" },
    ]);
    let ahead: bigint | null = null;
    runSolanaWithdraw.mockImplementation(async (d: { watching(ata: string): bigint }) => {
      ahead = d.watching(ATA);
      return {};
    });
    await openSolana("withdraw");
    await connect();
    type("2");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await screen.findByText(/Circle delivers it/);
    expect(ahead).toBe(11_500_000n);
  });
  it("an unconfirmed withdrawal keeps its signed body: 'Retry (same request)' shows in the list and nothing new can start", async () => {
    const body = { action: { type: "sendToEvmWithData" }, nonce: 1, signature: { r: "0x1", s: "0x2", v: 27 } } as unknown as SignedBody;
    runSolanaWithdraw.mockImplementation(async (d: { record(p: Pending): void; keepSigned(id: string, b: SignedBody): void }) => {
      d.keepSigned("w-9", body);
      d.record({ id: "w-9", dir: "withdraw", route: "solana", amount: "2000000", startedAt: Date.now(), status: "pending", balanceKind: "solana", watch: ATA, baseline: "0", minArrive: "1500000", note: UNCONFIRMED_NOTE });
      throw new UnconfirmedPostError(body);
    });
    await openSolana("withdraw");
    await connect();
    type("2");
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText(/Hyperliquid did not confirm this transfer/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry (same request)" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("the form itself refuses a withdrawal once withdrawEnabled or solanaEnabled is off (belt and braces under the modal's gate)", async () => {
    for (const key of ["withdrawEnabled", "solanaEnabled"] as const) {
      await openSolana("withdraw");
      await connect();
      type("2");
      cfg[key] = false; // the form's handler sees the same config object
      fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
      await act(async () => {});
      expect(runSolanaWithdraw, key).not.toHaveBeenCalled();
      cleanup();
      cfg = { ...cfg, withdrawEnabled: true, solanaEnabled: true };
    }
  });
  it("withdraw stays closed while withdrawEnabled is false", () => {
    cfg = { ...cfg, withdrawEnabled: false };
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    expect(screen.getByText("Withdrawals open after testing.")).toBeTruthy();
    expect(screen.queryByText("Solana")).toBeNull();
  });
  it("the poll hands Solana records to the lazily loaded Solana poll, a record with only an event account included, and stores what it returns", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const rec = depositRec({ startedAt: Date.now() });
    const noSig = depositRec({ id: "s-2", txHash: undefined, eventAccount: EVENT, startedAt: Date.now(), note: SOLANA_UNCONFIRMED_NOTE });
    seed([rec, noSig]);
    // the second: the chain read adopted the burn's signature and nothing else changed; that record must be stored too
    pollSolana.mockImplementation(async (_c: unknown, p: Pending) => (p.id === SIG ? { ...p, status: "done" } : { ...p, txHash: SIG.replace(/4/g, "5") }));
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(pollSolana).toHaveBeenCalledWith(cfg, rec);
    expect(pollSolana).toHaveBeenCalledWith(cfg, noSig);
    const after = stored();
    expect(after.find((p) => p.id === SIG)?.status).toBe("done");
    expect(after.find((p) => p.id === "s-2")).toMatchObject({ txHash: SIG.replace(/4/g, "5") });
  });
  it("a Solana poll that fails leaves the record as it was and the modal on screen", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const rec = depositRec({ startedAt: Date.now() });
    seed([rec]);
    pollSolana.mockRejectedValue(new Error("chunk failed to load"));
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(pollSolana).toHaveBeenCalled();
    expect(stored()).toEqual([rec]);
    expect(screen.getByText(/deposit · Solana · 10\.00 USDC/)).toBeTruthy();
  });
  it("a final 'not sent' row reads 'not sent', not 'pending…', and is no longer polled; a young expired one still is (final review M2)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const now = Date.now();
    const failed = depositRec({ id: "f", txHash: "5".repeat(88), startedAt: now - 1000, note: SOLANA_FAILED_NOTE });
    const oldExpired = depositRec({ id: "x-old", txHash: "6".repeat(88), startedAt: now - 2 * 3_600_000, note: SOLANA_EXPIRED_NOTE });
    const youngExpired = depositRec({ id: "x-young", txHash: "7".repeat(88), startedAt: now - 2000, note: SOLANA_EXPIRED_NOTE });
    seed([failed, oldExpired, youngExpired]);
    pollSolana.mockImplementation(async (_c: unknown, p: Pending) => p);
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    expect(screen.getAllByText(/^not sent$/)).toHaveLength(3);
    expect(screen.queryByText("pending…")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(pollSolana).toHaveBeenCalledTimes(1);
    expect(pollSolana).toHaveBeenCalledWith(cfg, youngExpired);
  });
  it("no Dismiss on a Solana row while a transfer is being signed or sent: the deposit's record is written before its broadcast (final review M4)", async () => {
    const watched = depositRec({ startedAt: Date.now() - 2 * 3_600_000, note: SOLANA_WATCH_NOTE });
    seed([watched]);
    expect(transferLock.tryBegin()).toBe(true);
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /^Dismiss deposit Solana/ })).toBeNull();
    act(() => transferLock.end());
    expect(screen.getByRole("button", { name: /^Dismiss deposit Solana/ })).toBeTruthy();
  });
  it("an unconfirmed Solana deposit cannot be dismissed in its first hour, while the chain decides it (Task 16 review m1)", () => {
    const now = Date.now();
    seed([
      depositRec({ id: "u-young", startedAt: now - 60_000, note: SOLANA_WATCH_NOTE }),
      depositRec({ id: "s-young", txHash: undefined, eventAccount: EVENT, startedAt: now - 60_000, note: SOLANA_UNCONFIRMED_NOTE }),
      depositRec({ id: "u-old", txHash: "5".repeat(88), startedAt: now - 2 * 3_600_000, note: SOLANA_WATCH_NOTE }),
      depositRec({ id: "n-young", txHash: "6".repeat(88), startedAt: now - 60_000, note: SOLANA_EXPIRED_NOTE }),
    ]);
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    // the old unconfirmed one and the young "not sent" one can go; the two young unconfirmed ones cannot
    expect(screen.getAllByRole("button", { name: /^Dismiss deposit Solana/ })).toHaveLength(2);
  });
  it("no Solana module is asked for while no Solana record is pending and the route is not opened", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    seed([{ id: "w-1", dir: "withdraw", route: "arbitrum", amount: "5000000", startedAt: Date.now(), status: "pending", balanceKind: "arbitrum", baseline: "0", minArrive: "1" }]);
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(pollSolana).not.toHaveBeenCalled();
  });
});

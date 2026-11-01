// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { ApprovedNotSentError, BurnUncertainError } from "../src/routes/exec";
import { loadPending, pendingKey, type Pending } from "../src/routes/pending";
import { beginRetry, endRetry, resetTransferState, transferLock } from "../src/routes/unconfirmed";
import { PAIRED_BLOCKED_TEXT } from "../src/wallet/permissions";
import { UNCONFIRMED_NOTE, UnconfirmedPostError } from "../src/hl/userSigned";

const USER = "0x00000000000000000000000000000000000000aa";
const HASH = `0x${"cd".repeat(32)}`;
let session: { kind: "wallet" | "paired" | "none"; address?: string };
let account: Record<string, unknown>;
const refresh = vi.fn();
const reload = vi.fn();
const write = vi.fn();
const hlWallet = vi.fn(() => ({ id: "wallet" }));
const readUsdc = vi.fn();
const withdrawCctp = vi.fn();
const withdrawToHyperEvm = vi.fn();
const moveCoreUsdc = vi.fn();
const depositCctp = vi.fn();
const depositFromHyperEvm = vi.fn();
const fetchIrisFees = vi.fn();
const fetchIrisMessage = vi.fn();
const readAllowance = vi.fn();
const postSigned = vi.fn();
let cfg: AppConfig;
const mem = new Map<string, string>();
let failWrites = false;
const fake = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (failWrites) throw new Error("quota");
    mem.set(k, v);
  },
  removeItem: (k: string) => void mem.delete(k),
};

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, write, hlWallet }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => account }));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/routes/useBalances", () => ({
  useBalances: () => ({ balances: { hyperEvm: 50_000_000n, arbitrum: 50_000_000n, ethereum: 50_000_000n, hype: 1n }, reload }),
  readUsdc: (...a: unknown[]) => readUsdc(...a),
}));
vi.mock("../src/routes/exec", async (orig) => ({
  ...(await orig<typeof import("../src/routes/exec")>()),
  withdrawCctp: (...a: unknown[]) => withdrawCctp(...a),
  withdrawToHyperEvm: (...a: unknown[]) => withdrawToHyperEvm(...a),
  moveCoreUsdc: (...a: unknown[]) => moveCoreUsdc(...a),
  depositCctp: (...a: unknown[]) => depositCctp(...a),
  depositFromHyperEvm: (...a: unknown[]) => depositFromHyperEvm(...a),
  fetchIrisFees: (...a: unknown[]) => fetchIrisFees(...a),
  fetchPreTransfer: async () => null,
  fetchIrisMessage: (...a: unknown[]) => fetchIrisMessage(...a),
  readAllowance: (...a: unknown[]) => readAllowance(...a),
}));
vi.mock("../src/hl/userSigned", async (orig) => ({ ...(await orig<typeof import("../src/hl/userSigned")>()), postSigned: (...a: unknown[]) => postSigned(...a) }));

import { TransferModal } from "../src/ui/transfer/TransferModal";

const IRIS = [{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 2, high: 3 } }];
const BODY = { action: { type: "sendToEvmWithData" }, nonce: 7, signature: { r: "0x1", s: "0x2", v: 27 } };
const p = (o: Partial<Pending> = {}): Pending => ({ id: "a", dir: "deposit", route: "arbitrum", amount: "10000000", startedAt: Date.now() - 1000, status: "pending", ...o });
const stored = () => loadPending(fake, "testnet", USER);
const pick = (label: RegExp) => fireEvent.click(screen.getByText(label));
const type = (v: string) => fireEvent.change(screen.getByLabelText(/^Amount/), { target: { value: v } });
const submit = (name: RegExp) => fireEvent.click(screen.getByRole("button", { name }));

beforeEach(() => {
  mem.clear();
  resetTransferState();
  failWrites = false;
  vi.stubGlobal("localStorage", fake);
  session = { kind: "wallet", address: USER };
  account = { balances: { trade: 100, perps: 60, spot: 40, source: "perps" }, abstraction: "disabled", refresh };
  cfg = { network: "testnet", withdrawEnabled: true, solanaEnabled: false, solanaRpc: null } as unknown as AppConfig;
  for (const m of [refresh, reload, write, readUsdc, withdrawCctp, withdrawToHyperEvm, moveCoreUsdc, depositCctp, depositFromHyperEvm, fetchIrisFees, fetchIrisMessage, readAllowance, postSigned]) m.mockReset();
  hlWallet.mockReset().mockReturnValue({ id: "wallet" });
  readUsdc.mockResolvedValue(1_000_000n);
  fetchIrisFees.mockResolvedValue(IRIS);
  fetchIrisMessage.mockResolvedValue(null);
  readAllowance.mockResolvedValue(null);
  withdrawCctp.mockResolvedValue(undefined);
  withdrawToHyperEvm.mockResolvedValue(undefined);
  moveCoreUsdc.mockResolvedValue(undefined);
  depositCctp.mockResolvedValue(HASH);
  depositFromHyperEvm.mockResolvedValue(HASH);
  postSigned.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("who may open it", () => {
  it("a paired phone is told to use the device with the wallet; nothing else is offered", () => {
    session = { kind: "paired", address: USER };
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    expect(screen.getByText(PAIRED_BLOCKED_TEXT)).toBeTruthy();
    expect(screen.queryByText(/HyperEVM/)).toBeNull();
    session = { kind: "none" };
    cleanup();
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    expect(screen.getByText("Connect a wallet first.")).toBeTruthy();
  });
});

describe("withdrawEnabled gate", () => {
  it("false: a withdraw shows the closed text, offers no route and never reaches the wallet", () => {
    cfg = { network: "testnet", withdrawEnabled: false } as unknown as AppConfig;
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    expect(screen.getByText("Withdrawals open after testing.")).toBeTruthy();
    expect(screen.queryByText(/^Ethereum/)).toBeNull();
    expect(screen.queryByText(/^Arbitrum/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Withdraw$/ })).toBeNull();
    expect(withdrawCctp).not.toHaveBeenCalled();
    expect(withdrawToHyperEvm).not.toHaveBeenCalled();
    expect(moveCoreUsdc).not.toHaveBeenCalled();
  });
  it("the Solana row is shown but off ('coming soon') while solanaEnabled is false (Task 10 review m4)", () => {
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    const row = screen.getByText("Solana").closest("button") as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.textContent).toMatch(/coming soon/);
  });
  it("false: deposits are unaffected", () => {
    cfg = { network: "testnet", withdrawEnabled: false } as unknown as AppConfig;
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    expect(screen.queryByText("Withdrawals open after testing.")).toBeNull();
    expect(screen.getByText(/Where is the USDC now/)).toBeTruthy();
  });
});

describe("withdraw to Ethereum", () => {
  it("shows the minimum (fee cap + 5) and keeps the button off below it", () => {
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    expect(screen.getByText(/Withdraw at least 6\.20 USDC/)).toBeTruthy();
    const btn = screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement;
    type("6.1");
    expect(btn.disabled).toBe(true);
    type("6.2");
    expect(btn.disabled).toBe(false);
  });
  it("sends to the connected address with CCTP domain 0, records a pending withdrawal and watches the Ethereum balance", async () => {
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(withdrawCctp).toHaveBeenCalledTimes(1));
    expect(withdrawCctp).toHaveBeenCalledWith({ id: "wallet" }, "testnet", 10_000_000n, "", USER, 0);
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({ dir: "withdraw", route: "ethereum", amount: "10000000", status: "pending", balanceKind: "ethereum", baseline: "1000000", minArrive: "8800000" });
  });
  it("Arbitrum uses domain 3", async () => {
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(withdrawCctp).toHaveBeenCalled());
    expect(withdrawCctp.mock.calls[0][5]).toBe(3);
  });
  it("does not ask the wallet to sign when it cannot read the destination balance", async () => {
    readUsdc.mockResolvedValue(null);
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByText(/Nothing was sent/);
    expect(withdrawCctp).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });
});

describe("20 transfers in progress", () => {
  const full = () => fake.setItem(pendingKey("testnet", USER), JSON.stringify(Array.from({ length: 20 }, (_, i) => p({ id: `y${i}`, startedAt: Date.now() - 1000 - i }))));
  it("a withdrawal is refused before the wallet is asked to sign", async () => {
    full();
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByText("Too many transfers in progress. Wait for one to finish.");
    expect(withdrawCctp).not.toHaveBeenCalled();
    expect(hlWallet).not.toHaveBeenCalled();
  });
  it("a CCTP deposit is refused before any approve is sent", async () => {
    full();
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("20");
    await waitFor(() => expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(false));
    submit(/^Deposit$/);
    await screen.findByText("Too many transfers in progress. Wait for one to finish.");
    expect(depositCctp).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
});

describe("deposits", () => {
  it("HyperEVM deposits need no record and no Iris", async () => {
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^HyperEVM/);
    type("5");
    submit(/^Deposit$/);
    await waitFor(() => expect(depositFromHyperEvm).toHaveBeenCalledWith(write, "testnet", 5_000_000n, null));
    expect(fetchIrisFees).not.toHaveBeenCalled();
  });
  it("HyperEVM: the allowance already approved to the CoreDepositWallet is read and passed on (final review M7)", async () => {
    readAllowance.mockResolvedValue(5_000_000n);
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^HyperEVM/);
    type("5");
    submit(/^Deposit$/);
    await waitFor(() => expect(depositFromHyperEvm).toHaveBeenCalledWith(write, "testnet", 5_000_000n, 5_000_000n));
    expect(readAllowance.mock.calls[0][1]).toBe("hyperEvm");
  });
  it("CCTP: re-queries the Iris fee for the burn, then records the transfer by its tx hash", async () => {
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("20");
    await waitFor(() => expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(false));
    expect(fetchIrisFees).toHaveBeenCalledTimes(1); // on opening the route
    submit(/^Deposit$/);
    await waitFor(() => expect(depositCctp).toHaveBeenCalledTimes(1));
    expect(fetchIrisFees).toHaveBeenCalledTimes(2); // again right before the burn
    expect(depositCctp.mock.calls[0].slice(1, 3)).toEqual(["testnet", "arbitrum"]);
    expect(depositCctp.mock.calls[0][5]).toBe(USER);
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0]).toMatchObject({ id: HASH, txHash: HASH, srcDomain: 3, route: "arbitrum", status: "pending" });
  });
  it("a burn that was sent but not confirmed is still recorded by its hash, and says not to send again", async () => {
    depositCctp.mockRejectedValue(new BurnUncertainError(HASH as never));
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("20");
    await waitFor(() => expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(false));
    submit(/^Deposit$/);
    await screen.findByText(/do not send it again/);
    expect(stored()).toHaveLength(1);
    expect(stored()[0]).toMatchObject({ txHash: HASH, status: "pending" });
  });
  it("a fee that rose since the quote is not taken: the new quote is shown and nothing is sent", async () => {
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("20");
    await waitFor(() => expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(false));
    fetchIrisFees.mockResolvedValue([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 500_000, high: 3 } }]);
    submit(/^Deposit$/);
    await screen.findByText(/fee changed from .* to .* USDC\. Check it and press Deposit again/);
    expect(depositCctp).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    // the shown fee is now the new one, so the next press goes through
    await waitFor(() => expect(screen.getAllByText(/0\.5\d USDC/).length).toBeGreaterThan(0));
    submit(/^Deposit$/);
    await waitFor(() => expect(depositCctp).toHaveBeenCalledTimes(1));
  });
  it("an approval left from an earlier try is passed on, and an approve-without-burn says so", async () => {
    readAllowance.mockResolvedValue(20_000_000n);
    depositCctp.mockRejectedValueOnce(new ApprovedNotSentError(new Error("User rejected the request.")));
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("20");
    await waitFor(() => expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(false));
    submit(/^Deposit$/);
    await screen.findByText(/Approved, not sent\. Nothing left your wallet\./);
    expect(depositCctp.mock.calls[0][6]).toBe(20_000_000n);
    expect(stored()).toEqual([]);
  });
  it("a burn fee that now eats the amount is refused before the wallet is asked", async () => {
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("20");
    await waitFor(() => expect((screen.getByRole("button", { name: "Deposit" }) as HTMLButtonElement).disabled).toBe(false));
    fetchIrisFees.mockResolvedValue([{ finalityThreshold: 1000, minimumFee: 1, forwardFee: { low: 1, med: 25_000_000, high: 3 } }]);
    submit(/^Deposit$/);
    await screen.findByText(/Send more than/);
    expect(depositCctp).not.toHaveBeenCalled();
  });
});

describe("a post that got no answer (no double send)", () => {
  it("keeps the record as unconfirmed, blocks a new send, and Retry re-posts the same signed body without signing again", async () => {
    withdrawCctp.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByRole("alert");
    expect(stored()[0]).toMatchObject({ note: UNCONFIRMED_NOTE, status: "pending", balanceKind: "ethereum" });
    expect(screen.getAllByText(new RegExp(UNCONFIRMED_NOTE)).length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /^Retry/ }));
    await waitFor(() => expect(postSigned).toHaveBeenCalledWith("testnet", BODY));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(withdrawCctp).toHaveBeenCalledTimes(1); // never signed again
    expect(hlWallet).toHaveBeenCalledTimes(1);
    expect(stored()[0].note).toBeUndefined();
  });
  it("Retry with no answer again keeps the banner", async () => {
    withdrawToHyperEvm.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never));
    postSigned.mockRejectedValue(new UnconfirmedPostError(BODY as never));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^HyperEVM/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /^Retry/ }));
    await screen.findByText(/Still not confirmed/);
    expect(screen.getByRole("alert")).toBeTruthy();
  });
  it("a spot to perps move whose post got no answer is kept for a safe repeat too", async () => {
    moveCoreUsdc.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^HyperCore/);
    fireEvent.change(screen.getByLabelText(/Move between spot and perps/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Spot → perps/ }));
    await screen.findByRole("alert");
    expect(stored()).toHaveLength(1); // a record without a balance watch, so the body can be re-posted from the list
    expect(stored()[0]).toMatchObject({ route: "hypercore", status: "pending", note: UNCONFIRMED_NOTE });
    fireEvent.click(screen.getByRole("button", { name: /^Retry/ }));
    await waitFor(() => expect(postSigned).toHaveBeenCalledWith("testnet", BODY));
    await waitFor(() => expect(stored()[0].status).toBe("done"));
    expect(moveCoreUsdc).toHaveBeenCalledTimes(1);
  });
  it("an HTTP 5xx is handled like no answer: same banner, same Retry", async () => {
    withdrawCctp.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never, { cause: new Error("HTTP 502") }));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByText(/Hyperliquid did not confirm it/);
    expect(stored()[0].note).toBe(UNCONFIRMED_NOTE);
  });
  it("spot ↔ perps is hidden for 'default' accounts too (research: do not assume a rule until tested)", () => {
    account = { ...account, abstraction: "default" };
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^HyperCore/);
    expect(screen.queryByLabelText(/Move between spot and perps/)).toBeNull();
  });
  it("spot ↔ perps is hidden for unified accounts", () => {
    account = { ...account, abstraction: "unifiedAccount" };
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^HyperCore/);
    expect(screen.queryByLabelText(/Move between spot and perps/)).toBeNull();
  });
});

describe("two withdrawals to the same chain", () => {
  const seedW = (...l: Pending[]) => fake.setItem(pendingKey("testnet", USER), JSON.stringify(l));
  const w = (o: Partial<Pending>): Pending => p({ dir: "withdraw", route: "arbitrum", balanceKind: "arbitrum", ...o });

  it("a new withdrawal starts its baseline above the earlier one that is still on its way", async () => {
    seedW(w({ id: "w-0", baseline: "1000000", minArrive: "9800000" }));
    readUsdc.mockResolvedValue(1_000_000n); // the first has not landed
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(stored()).toHaveLength(2));
    expect(stored().find((x) => x.id !== "w-0")).toMatchObject({ baseline: "10800000", minArrive: "9800000" });
  });
  it("a finished earlier withdrawal does not push the baseline", async () => {
    seedW(w({ id: "w-0", status: "done", baseline: "1000000", minArrive: "9800000" }));
    readUsdc.mockResolvedValue(11_000_000n);
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(stored()).toHaveLength(2));
    expect(stored().find((x) => x.id !== "w-0")).toMatchObject({ baseline: "11000000" });
  });
  it("a dust-sized minimum is raised to 0.01 USDC, so dust cannot complete a small withdrawal", async () => {
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^HyperEVM/);
    type("0.01"); // 99% would be 0.0099
    submit(/^Withdraw$/);
    await waitFor(() => expect(stored()).toHaveLength(1));
    expect(stored()[0].minArrive).toBe("10000");
  });
});

describe("stuck records", () => {
  const seedW = (...l: Pending[]) => fake.setItem(pendingKey("testnet", USER), JSON.stringify(l));
  it("a record with a note, or one over an hour old, can be dismissed, with the plain warning; a young plain one cannot", () => {
    seedW(
      p({ id: "young", startedAt: Date.now() - 1000 }),
      p({ id: "noted", startedAt: Date.now() - 2000, note: UNCONFIRMED_NOTE }),
      p({ id: "old", startedAt: Date.now() - 2 * 3_600_000 }),
    );
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    expect(screen.getAllByRole("button", { name: /^Dismiss deposit/ })).toHaveLength(2);
    expect(screen.getByText(/does not cancel anything on chain/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /^Dismiss deposit/ })[0]);
    expect(stored().map((x) => x.id).sort()).toEqual(["old", "young"]); // the noted one went (the list is newest first, so the first button was it)
    expect(stored()).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: /^Dismiss deposit/ })).toHaveLength(1);
  });
});

describe("storage that fails", () => {
  it("a transfer stays visible in the list when the store cannot be written", async () => {
    failWrites = true;
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByText(/withdraw · Arbitrum · 10\.00 USDC/);
    expect(stored()).toEqual([]);
  });
});

describe("polling pending transfers", () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: false }));
  afterEach(() => vi.useRealTimers());
  const seed = (...l: Pending[]) => fake.setItem(pendingKey("testnet", USER), JSON.stringify(l));

  it("a withdrawal is done once the destination balance has grown by the expected amount", async () => {
    seed(p({ id: "w-1", dir: "withdraw", route: "arbitrum", balanceKind: "arbitrum", baseline: "1000000", minArrive: "9800000" }));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    readUsdc.mockResolvedValue(5_000_000n); // not yet
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stored()[0].status).toBe("pending");
    readUsdc.mockResolvedValue(10_900_000n);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stored()[0].status).toBe("done");
    expect(refresh).toHaveBeenCalled();
  });
  it("two withdrawals watching one balance: one arrival completes only the first", async () => {
    seed(
      p({ id: "w-1", dir: "withdraw", route: "arbitrum", balanceKind: "arbitrum", baseline: "1000000", minArrive: "9800000", startedAt: Date.now() - 2000 }),
      p({ id: "w-2", dir: "withdraw", route: "arbitrum", balanceKind: "arbitrum", baseline: "10800000", minArrive: "9800000", startedAt: Date.now() - 1000 }),
    );
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    readUsdc.mockResolvedValue(11_000_000n);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stored().find((x) => x.id === "w-1")?.status).toBe("done");
    expect(stored().find((x) => x.id === "w-2")?.status).toBe("pending");
    readUsdc.mockResolvedValue(21_000_000n);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stored().find((x) => x.id === "w-2")?.status).toBe("done");
  });
  it("the unconfirmed note survives polls until the record settles", async () => {
    seed(
      p({ id: "w-1", dir: "withdraw", route: "arbitrum", balanceKind: "arbitrum", baseline: "1000000", minArrive: "9800000", note: UNCONFIRMED_NOTE }),
      p({ id: "0xabc", srcDomain: 3, txHash: HASH, note: "unconfirmed: watching the transaction", startedAt: Date.now() - 1000 }),
    );
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    readUsdc.mockResolvedValue(2_000_000n);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(stored().find((x) => x.id === "w-1")?.note).toBe(UNCONFIRMED_NOTE);
    expect(stored().find((x) => x.id === "0xabc")?.note).toBe("unconfirmed: watching the transaction");
    expect(stored().every((x) => x.status === "pending")).toBe(true);
  });
  it("a balance that cannot be read changes nothing", async () => {
    seed(p({ id: "w-1", dir: "withdraw", route: "arbitrum", balanceKind: "arbitrum", baseline: "0", minArrive: "1" }));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    readUsdc.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(stored()[0].status).toBe("pending");
  });
  it("a CCTP deposit is done when Iris shows the forward tx; a tampered srcDomain is never polled", async () => {
    seed(p({ id: "t1", srcDomain: 3, txHash: HASH }), p({ id: "t2", srcDomain: 7, txHash: HASH, startedAt: Date.now() - 5 }));
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    fetchIrisMessage.mockResolvedValue({ status: "complete", delayReason: null, forwardTxHash: "0xfeed" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stored().find((x) => x.id === "t1")?.status).toBe("done");
    expect(stored().find((x) => x.id === "t2")?.status).toBe("pending");
    expect(fetchIrisMessage).toHaveBeenCalledTimes(1);
    expect(fetchIrisMessage).toHaveBeenCalledWith("testnet", 3, HASH);
  });
});

describe("one transfer at a time (a second prompt over an unanswered one is how a double send happens)", () => {
  it("while a withdrawal waits in the wallet, going back and picking a route cannot start another", async () => {
    let release!: () => void;
    withdrawCctp.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(withdrawCctp).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: /Routes/ }));
    pick(/^Ethereum/);
    type("10");
    const btn = screen.getByRole("button", { name: /Confirm in your wallet/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(withdrawCctp).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(false));
    expect(stored()).toHaveLength(1);
  });
  it("closing and reopening the modal does not release it either; it is free again once the first transfer ends", async () => {
    let release!: () => void;
    withdrawCctp.mockReturnValueOnce(new Promise<void>((r) => (release = r)));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(withdrawCctp).toHaveBeenCalledTimes(1));
    cleanup();
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    expect((screen.getByRole("button", { name: /Confirm in your wallet/ }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(transferLock.tryBegin()).toBe(true)); // free again
    transferLock.end();
  });
  it("the lock is exclusive and synchronous: a second begin in the same tick fails (a double click cannot get two through)", () => {
    expect(transferLock.tryBegin()).toBe(true);
    expect(transferLock.tryBegin()).toBe(false);
    transferLock.end();
    expect(transferLock.tryBegin()).toBe(true);
    transferLock.end();
  });
  it("a spot to perps move waits for the same lock", async () => {
    expect(transferLock.tryBegin()).toBe(true);
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^HyperCore/);
    fireEvent.change(screen.getByLabelText(/Move between spot and perps/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: /Spot → perps/ }));
    expect(moveCoreUsdc).not.toHaveBeenCalled();
    transferLock.end();
  });
});

describe("an unconfirmed transfer outlives the modal (until the page is reloaded)", () => {
  const unconfirmedWithdrawal = async () => {
    withdrawCctp.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByRole("alert");
  };
  it("reopening shows 'Retry (same request)' on the record, and it re-posts the same body without signing", async () => {
    await unconfirmedWithdrawal();
    cleanup();
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry (same request)" }));
    await waitFor(() => expect(postSigned).toHaveBeenCalledWith("testnet", BODY));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(withdrawCctp).toHaveBeenCalledTimes(1);
    expect(stored()[0].note).toBeUndefined();
  });
  it("the body is never written to storage", async () => {
    await unconfirmedWithdrawal();
    expect(JSON.stringify([...mem.values()])).not.toMatch(/signature|"r":|sendToEvmWithData/);
  });
  it("closing with an unconfirmed transfer asks first; cancelling keeps the dialog open", async () => {
    await unconfirmedWithdrawal();
    cleanup();
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<TransferModal dir="withdraw" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(confirm).toHaveBeenCalledWith("This transfer is unconfirmed. Close anyway? You can retry it from the history list until you reload the page.");
    expect(onClose).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
  it("closing with nothing unconfirmed does not ask", () => {
    const onClose = vi.fn();
    const confirm = vi.spyOn(window, "confirm");
    render(<TransferModal dir="withdraw" onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(confirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
  });
  it("after a page reload the body is gone: the record says to check the balance before sending again, with no Retry and no lock", async () => {
    await unconfirmedWithdrawal();
    cleanup();
    resetTransferState(); // what a reload does to module memory; storage stays
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    expect(screen.getByText(/unconfirmed: check your balance before sending again/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /^Dismiss/ })).toBeTruthy();
  });
  it("dismissing the record drops the held body and ends the lock", async () => {
    await unconfirmedWithdrawal();
    fireEvent.click(screen.getByRole("button", { name: /^Dismiss/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Retry/ })).toBeNull();
  });
  it("a record that settles by balance drops its body", async () => {
    vi.useFakeTimers();
    try {
      withdrawCctp.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never));
      render(<TransferModal dir="withdraw" onClose={() => {}} />);
      pick(/^Ethereum/);
      type("10");
      submit(/^Withdraw$/);
      await vi.advanceTimersByTimeAsync(50);
      expect(screen.getByRole("alert")).toBeTruthy();
      readUsdc.mockResolvedValue(50_000_000n); // arrived
      await vi.advanceTimersByTimeAsync(10_000);
      expect(stored()[0].status).toBe("done");
      expect(screen.queryByRole("alert")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a modal reopened while a transfer is still in flight (review F1)", () => {
  it("sees the unconfirmed result that lands later: the banner, Retry and a locked Withdraw", async () => {
    let fail!: (e: unknown) => void;
    withdrawCctp.mockReturnValueOnce(new Promise<void>((_, rej) => (fail = rej)));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(withdrawCctp).toHaveBeenCalledTimes(1));
    cleanup(); // closed while the wallet is open
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: /Confirm in your wallet/ }) as HTMLButtonElement).disabled).toBe(true);
    // the first post comes back unconfirmed, after the reopen
    await act(async () => {
      fail(new UnconfirmedPostError(BODY as never));
    });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Retry (same request)" })).toBeTruthy();
    expect(screen.getByText(new RegExp(UNCONFIRMED_NOTE))).toBeTruthy();
    expect((screen.getByRole("button", { name: "Withdraw" }) as HTMLButtonElement).disabled).toBe(true);
    expect(stored()[0]).toMatchObject({ note: UNCONFIRMED_NOTE, status: "pending" });
    // and Retry from the reopened modal posts the held body, still without signing
    fireEvent.click(screen.getByRole("button", { name: "Retry (same request)" }));
    await waitFor(() => expect(postSigned).toHaveBeenCalledWith("testnet", BODY));
    expect(withdrawCctp).toHaveBeenCalledTimes(1);
  });
  it("a record added by a closed modal's transfer shows up in the open one without a reload", async () => {
    let done!: () => void;
    withdrawCctp.mockReturnValueOnce(new Promise<void>((r) => (done = r)));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await waitFor(() => expect(withdrawCctp).toHaveBeenCalledTimes(1));
    cleanup();
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    expect(screen.queryByText("Recent transfers")).toBeNull();
    await act(async () => done());
    await screen.findByText("Recent transfers");
    expect(screen.getByText(/withdraw · Arbitrum · 10\.00 USDC/)).toBeTruthy();
  });
});

describe("a wallet that stays silent (review F2): no automatic release", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it("after 60 s the user is told where the way out is; the lock is still held", async () => {
    withdrawCctp.mockReturnValueOnce(new Promise<void>(() => {}));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await vi.advanceTimersByTimeAsync(100);
    expect(withdrawCctp).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(screen.queryByText(/Waiting for your wallet/)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_500);
    expect(screen.getByText("Waiting for your wallet. Approve or reject it there, or reload the page to start over.")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(transferLock.tryBegin()).toBe(false); // never released by itself
    expect((screen.getByRole("button", { name: /Confirm in your wallet/ }) as HTMLButtonElement).disabled).toBe(true);
  });
  it("a modal reopened after 40 s shows it 20 s later (the clock runs from when the transfer started)", async () => {
    withdrawCctp.mockReturnValueOnce(new Promise<void>(() => {}));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Arbitrum/);
    type("10");
    submit(/^Withdraw$/);
    await vi.advanceTimersByTimeAsync(40_000);
    cleanup();
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    await vi.advanceTimersByTimeAsync(19_000);
    expect(screen.queryByText(/Waiting for your wallet/)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(screen.getByText(/Waiting for your wallet/)).toBeTruthy();
  });
});

describe("Retry (same request) posts once at a time (review F3)", () => {
  const heldWithdrawal = async () => {
    withdrawCctp.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never));
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    pick(/^Ethereum/);
    type("10");
    submit(/^Withdraw$/);
    await screen.findByRole("alert");
  };
  it("a second click, and a click from a reopened modal, while the first post is out do not post again", async () => {
    await heldWithdrawal();
    let answer!: () => void;
    postSigned.mockReturnValueOnce(new Promise<void>((r) => (answer = r)));
    fireEvent.click(screen.getByRole("button", { name: "Retry (same request)" }));
    await waitFor(() => expect(postSigned).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    render(<TransferModal dir="withdraw" onClose={() => {}} />);
    const again = screen.getByRole("button", { name: "Retrying…" }) as HTMLButtonElement;
    expect(again.disabled).toBe(true);
    fireEvent.click(again);
    expect(postSigned).toHaveBeenCalledTimes(1);
    await act(async () => answer());
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull()); // the reopened modal follows the first retry's result
    expect(postSigned).toHaveBeenCalledTimes(1);
    expect(stored()[0].note).toBeUndefined();
  });
  it("beginRetry is exclusive per record and synchronous, other records are independent", () => {
    expect(beginRetry("testnet", USER, "a")).toBe(true);
    expect(beginRetry("testnet", USER, "a")).toBe(false);
    expect(beginRetry("testnet", USER.toUpperCase().replace("0X", "0x"), "a")).toBe(false); // same account, any case
    expect(beginRetry("testnet", USER, "b")).toBe(true);
    endRetry("testnet", USER, "a");
    expect(beginRetry("testnet", USER, "a")).toBe(true);
  });
  it("after an unconfirmed retry the button is free again", async () => {
    await heldWithdrawal();
    postSigned.mockRejectedValueOnce(new UnconfirmedPostError(BODY as never));
    fireEvent.click(screen.getByRole("button", { name: "Retry (same request)" }));
    await screen.findByText(/Still not confirmed/);
    expect((screen.getByRole("button", { name: "Retry (same request)" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

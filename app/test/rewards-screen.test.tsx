// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RewardsState } from "../src/rewards/useRewards";
import type { AppConfig } from "../src/config/validate";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from "viem";
import { miningAbi, settleAndClaimAbi } from "../src/evm/abi";
import { PAUSED_TEXT } from "../src/hl/errors";
import { PAIRED_BLOCKED_TEXT } from "../src/wallet/permissions";

const A = "0x00000000000000000000000000000000000000aa";
const MINING = "0x00000000000000000000000000000000000000a3";
let state: RewardsState;
let session: { kind: "none" | "wallet" | "paired"; address?: string };
let master: string | null;
const write = vi.fn();
const reload = vi.fn();
const hold = vi.fn();
const getTransactionReceipt = vi.fn();
let cfg: AppConfig;

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, write }) }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => ({ master }) }));
vi.mock("../src/evm/clients", () => ({ publicClient: () => ({ getTransactionReceipt }) }));
vi.mock("../src/wallet/chains", () => ({ viemChain: () => ({}) }));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/rewards/useRewards", () => ({ CLAIM_HOLD_MS: 600_000, useRewards: () => ({ state, reload, hold }) }));

// The staking and protocol cards have their own tests (staking-ui.test.tsx); here they only need to be placed with the chain and reload.
vi.mock("../src/ui/rewards/StakingCard", () => ({ StakingCard: (p: { chain: unknown; onDone(): void }) => <button onClick={p.onDone}>staking-card {String(p.chain === full)}</button> }));
vi.mock("../src/ui/rewards/ProtocolCard", () => ({ ProtocolCard: (p: { chain: unknown }) => <div>protocol-card {String(p.chain === full)}</div> }));

import { RewardsScreen } from "../src/ui/rewards/RewardsScreen";

const E18 = 10n ** 18n;
const ROOT = `0x${"11".repeat(32)}` as const;
const PROOF = [`0x${"ab".repeat(32)}`] as const;
const chain = {
  now: 1_800_000_000 + 60 * 21, launchTime: 1_800_000_000, anySettled: true, latestMinute: 19, latestValidMinute: 19, latestRoot: ROOT,
  paused: false, poster: A, claimed: 20n * E18, claimAvailable: 5000n * E18,
};
/** The core chain plus the Staking and Buyback reads: what the staking and protocol cards are given. */
const full = { ...chain, user: { claimed: 20n * E18, hlo: 0n, staked: 0n, pending: 0n, allowance: 0n }, staking: { totalStaked: 0n, undripped: 0n }, protocol: { poolOpen: true, openAt: 0 } };
const yours = { earned: 120n * E18, claimed: 20n * E18, claimable: 100n * E18, claimNow: 100n * E18, youGet: 90n * E18, refined: 0n, points: 65_727_600n, vaultShare: 0n };
const plan = (kind: "settleAndClaim" | "claim") => ({ kind, cp: { throughMinute: 20, refBlock: 77n, root: ROOT, totalEntitled: 500n * E18 }, sig: `0x${"cd".repeat(65)}`, entitlement: 120n * E18, expectClaimed: 120n * E18, proof: [...PROOF] });
const latest = { vault: { amount: (50n * E18).toString(), pointsTotal: "131455200", odds: 60, lastPopMinute: -1 }, pops: [] };
const ready = (o: object = {}): RewardsState => ({
  kind: "ready",
  data: { chain, full, extraError: null, latest, latestProblem: null, yours, plan: plan("settleAndClaim"), ...o },
} as never);

beforeEach(() => {
  state = ready();
  session = { kind: "wallet", address: A };
  master = A;
  cfg = { network: "testnet", hyperEvmChainId: 998, contracts: { mining: MINING } } as unknown as AppConfig;
  write.mockReset().mockResolvedValue("0xhash");
  reload.mockReset();
  hold.mockReset();
  getTransactionReceipt.mockReset().mockRejectedValue(new Error("receipt not available"));
});

/** A Claimed log as Mining emits it: indexed user and throughMinute, then claimedTotal, paid, refined. */
const claimedLog = (o: { address?: string; user?: string; claimedTotal: bigint; paid?: bigint }) => ({
  address: o.address ?? MINING,
  topics: encodeEventTopics({ abi: miningAbi, eventName: "Claimed", args: { user: (o.user ?? A) as `0x${string}`, throughMinute: 20n } }),
  data: encodeAbiParameters(parseAbiParameters("uint256, uint256, uint256"), [o.claimedTotal, o.paid ?? 1n, 2n]),
  logIndex: 0, blockNumber: 1n, blockHash: `0x${"00".repeat(32)}`, transactionHash: "0xhash", transactionIndex: 0, removed: false,
});
afterEach(cleanup);

describe("RewardsScreen", () => {
  it("not deployed: says so", () => {
    state = { kind: "off" };
    render(<RewardsScreen />);
    expect(screen.getByText(/not deployed on this network yet/)).toBeTruthy();
  });
  it("loading", () => {
    state = { kind: "loading" };
    render(<RewardsScreen />);
    expect(screen.getByText("Loading rewards…")).toBeTruthy();
  });
  it("HyperEVM unreachable: 'Rewards are paused', says trading still works, retry reloads", () => {
    state = { kind: "down", error: "fetch failed" };
    render(<RewardsScreen />);
    expect(screen.getByText("Rewards are paused")).toBeTruthy();
    expect(screen.getByText(/Trading still works/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(reload).toHaveBeenCalled();
  });
  it("shows the claimable amount, the 90%, the points and how far the checkpoints are settled", () => {
    render(<RewardsScreen />);
    expect(screen.getByText("100.00 HLO")).toBeTruthy();
    expect(screen.getByText(/You receive 90%: 90\.00 HLO/)).toBeTruthy();
    expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("0.65");
    expect(screen.getByText("settled through 08:20 UTC")).toBeTruthy();
  });
  it("puts the Yours card and the Vault card on top, then Staking and Protocol", () => {
    render(<RewardsScreen />);
    const text = document.body.textContent ?? "";
    const at = ["Yours", "In the vault", "staking-card", "protocol-card"].map((t) => text.indexOf(t));
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(screen.getByText("In the vault").nextSibling?.textContent).toBe("50.00 HLO");
    expect(screen.getByText(/a 1 in 60 chance to pop/)).toBeTruthy();
  });
  it("paused: Claim is off and says why", () => {
    state = ready({ chain: { ...chain, paused: true } });
    render(<RewardsScreen />);
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(PAUSED_TEXT)).toBeTruthy();
  });
  it("places the staking and protocol cards with the chain read, and reload as their onDone", () => {
    render(<RewardsScreen />);
    expect(screen.getByText("protocol-card true")).toBeTruthy();
    fireEvent.click(screen.getByText("staking-card true"));
    expect(reload).toHaveBeenCalled();
  });
  it("Staking or Buyback failing alone: the claim card stays and the two cards give way to a note", () => {
    state = ready({ full: null, extraError: "fetch failed" });
    render(<RewardsScreen />);
    expect(screen.getByRole("button", { name: "Settle & claim" })).toBeTruthy();
    expect(screen.getByText(/Not available right now: fetch failed/)).toBeTruthy();
    expect(screen.queryByText(/protocol-card/)).toBeNull();
  });
  it("no account: asks to connect", () => {
    master = null;
    session = { kind: "none" };
    state = ready({ yours: null, plan: null }); // useRewards gives no figures without an account
    render(<RewardsScreen />);
    expect(screen.getByText(/Connect a wallet to see your rewards/)).toBeTruthy();
    expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("—");
    expect(screen.getByText("In the vault").nextSibling?.textContent).toBe("50.00 HLO");
  });
  it("a settleAndClaim plan sends the checkpoint tuple, the signature, the entitlement and the proof, then holds the claim and reloads", async () => {
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Claimed.")).toBeTruthy());
    expect(write).toHaveBeenCalledWith("hyperEvm", {
      address: MINING, abi: settleAndClaimAbi, functionName: "settleAndClaim",
      args: [{ throughMinute: 20n, refBlock: 77n, root: ROOT, totalEntitled: 500n * E18 }, `0x${"cd".repeat(65)}`, 120n * E18, [...PROOF]],
    });
    expect(hold).toHaveBeenCalledWith(120n * E18);
    expect(reload).toHaveBeenCalled();
  });
  it("a partial claim holds expectClaimed (what the allowance lets through), not the whole entitlement", async () => {
    state = ready({ plan: { ...plan("settleAndClaim"), expectClaimed: 60n * E18 }, yours: { ...yours, claimNow: 40n * E18, youGet: 36n * E18 } });
    render(<RewardsScreen />);
    expect(screen.getByText("Claims share an hourly allowance. You can claim 40.00 HLO now; the rest stays claimable.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Claimed.")).toBeTruthy());
    expect(hold).toHaveBeenCalledWith(60n * E18);
  });
  it("holds the claimed total the receipt reports when the claim was paid less than expected", async () => {
    getTransactionReceipt.mockResolvedValue({ logs: [claimedLog({ claimedTotal: 45n * E18 })] });
    state = ready({ plan: { ...plan("settleAndClaim"), expectClaimed: 60n * E18 } });
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(hold).toHaveBeenCalledWith(45n * E18));
    expect(getTransactionReceipt).toHaveBeenCalledWith({ hash: "0xhash" });
  });
  it("the success message says what was paid (the log's paid), and that the rest stays claimable after a partial claim", async () => {
    getTransactionReceipt.mockResolvedValue({ logs: [claimedLog({ claimedTotal: 60n * E18, paid: 36n * E18 })] });
    state = ready({ plan: { ...plan("settleAndClaim"), expectClaimed: 60n * E18 } }); // entitlement 120
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Claimed 36.00 HLO; the rest stays claimable.")).toBeTruthy());
  });
  it("a full claim says 'Claimed X HLO.'", async () => {
    getTransactionReceipt.mockResolvedValue({ logs: [claimedLog({ claimedTotal: 120n * E18, paid: 90n * E18 })] });
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Claimed 90.00 HLO.")).toBeTruthy());
    expect(hold).toHaveBeenCalledWith(120n * E18);
  });
  it("ignores Claimed logs of another contract or another user, and falls back to expectClaimed when none matches", async () => {
    getTransactionReceipt.mockResolvedValue({
      logs: [claimedLog({ address: "0x00000000000000000000000000000000000000ff", claimedTotal: 1n }), claimedLog({ user: "0x00000000000000000000000000000000000000bb", claimedTotal: 2n })],
    });
    state = ready({ plan: { ...plan("settleAndClaim"), expectClaimed: 60n * E18 } });
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Claimed.")).toBeTruthy());
    expect(hold).toHaveBeenCalledWith(60n * E18);
  });
  it("matches the user case-insensitively", async () => {
    getTransactionReceipt.mockResolvedValue({ logs: [claimedLog({ user: A.toUpperCase().replace("0X", "0x"), claimedTotal: 50n * E18 })] });
    state = ready({ plan: { ...plan("settleAndClaim"), expectClaimed: 60n * E18 } });
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(hold).toHaveBeenCalledWith(50n * E18));
  });
  it("a receipt that cannot be read falls back to expectClaimed (the claim still shows as done)", async () => {
    state = ready({ plan: { ...plan("settleAndClaim"), expectClaimed: 60n * E18 } });
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Claimed.")).toBeTruthy());
    expect(hold).toHaveBeenCalledWith(60n * E18);
    expect(screen.getByText("Claimed.")).toBeTruthy(); // no receipt, no amount
    expect(reload).toHaveBeenCalled();
  });
  it("before the pool opens, with something claimable: a notice to claim before the queue, timed by chain time", () => {
    state = ready({ full: { ...full, protocol: { poolOpen: false, openAt: chain.now + 2 * 3600 } } });
    render(<RewardsScreen />);
    expect(screen.getByText(/^Claim before trading opens \(in 2h 0m\)\./)).toBeTruthy();
  });
  it("once the pool is open: no queue notice", () => {
    render(<RewardsScreen />);
    expect(screen.queryByText(/Claim before trading opens/)).toBeNull();
  });
  it("limited: the 'You receive 90%' line is hidden on the screen too", () => {
    state = ready({ chain: { ...chain, claimAvailable: 0n }, yours: { ...yours, claimNow: 0n, youGet: 0n } });
    render(<RewardsScreen />);
    expect(screen.queryByText(/You receive 90%/)).toBeNull();
  });
  it("only dust (under 0.01 HLO) can be claimed now: Claim is off with the limit text and there is no allowance line", () => {
    state = ready({ chain: { ...chain, claimAvailable: 10n ** 16n - 1n }, yours: { ...yours, claimNow: 10n ** 16n - 1n, youGet: 0n } });
    render(<RewardsScreen />);
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Claims are at their hourly limit. Try again in a few minutes.")).toBeTruthy();
    expect(screen.queryByText(/hourly allowance/)).toBeNull();
  });
  it("an empty allowance with something claimable: Claim is off with the limit text", () => {
    state = ready({ chain: { ...chain, claimAvailable: 0n }, yours: { ...yours, claimNow: 0n, youGet: 0n } });
    render(<RewardsScreen />);
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Claims are at their hourly limit. Try again in a few minutes.")).toBeTruthy();
    expect(screen.queryByText(/hourly allowance/)).toBeNull();
  });
  it("a ClaimLimitReached revert says so in plain words and holds nothing", async () => {
    write.mockRejectedValue(new Error('The contract function "settleAndClaim" reverted with the following signature: ClaimLimitReached()'));
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Claims are at their hourly limit. Try again in a few minutes.")).toBeTruthy());
    expect(hold).not.toHaveBeenCalled();
  });
  it("a claim plan calls claim with the minute, the entitlement and the proof", async () => {
    state = ready({ plan: plan("claim") });
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Claim" }));
    await waitFor(() => expect(screen.getByText("Claimed.")).toBeTruthy());
    expect(write).toHaveBeenCalledWith("hyperEvm", { address: MINING, abi: expect.anything(), functionName: "claim", args: [20n, 120n * E18, [...PROOF]] });
  });
  it("a failed claim says why in plain words, keeps the button usable and holds nothing", async () => {
    write.mockRejectedValue(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("You cancelled the request in your wallet.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });
  it("a NotNewer revert says someone else settled first", async () => {
    write.mockRejectedValue(new Error('The contract function "settleAndClaim" reverted with the following signature: NotNewer()'));
    render(<RewardsScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    await waitFor(() => expect(screen.getByText("Someone settled a newer checkpoint first. Try again.")).toBeTruthy());
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("a second click while the claim is in flight does not send a second one", async () => {
    let done: (h: string) => void = () => {};
    write.mockReturnValue(new Promise((r) => (done = r)));
    render(<RewardsScreen />);
    const btn = screen.getByRole("button", { name: "Settle & claim" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => done("0xh"));
  });
  it("no plan (nothing to claim, or no usable file): the button is off, and the problem is said", () => {
    state = ready({ plan: null, latest: null, yours: null, latestProblem: "Rewards are updating…" });
    render(<RewardsScreen />);
    expect((screen.getByRole("button", { name: "Claim" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Rewards are updating…")).toBeTruthy();
    // the vault card stays, with dashes
    expect(screen.getByText("Vault")).toBeTruthy();
    expect(screen.getByText("In the vault").nextSibling?.textContent).toBe("—");
  });
  it("the Vault card shows dashes for the wallet's points and share while the vault popped after the wallet's file, and the numbers once the file catches up", () => {
    state = ready({ latest: { ...latest, vault: { ...latest.vault, lastPopMinute: 18 } }, yoursAt: 15 });
    const { unmount } = render(<RewardsScreen />);
    expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("—");
    expect(screen.getByText("Your share if it popped now").nextSibling?.textContent).toBe("—");
    expect(screen.getByText("Earned so far").nextSibling?.textContent).toBe("120.00 HLO"); // the Yours card is not affected
    unmount();
    state = ready({ latest: { ...latest, vault: { ...latest.vault, lastPopMinute: 18 } }, yoursAt: 18 });
    render(<RewardsScreen />);
    expect(screen.getByText("Your points since the last pop").nextSibling?.textContent).toBe("0.65");
  });
  it("a paired phone sees the numbers but is sent to the wallet device for Claim", () => {
    session = { kind: "paired", address: A };
    render(<RewardsScreen />);
    expect(screen.getByText("100.00 HLO")).toBeTruthy();
    expect(screen.getByText(PAIRED_BLOCKED_TEXT)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("says nothing about a pot, a day or today, and uses no gambling words (word boundaries: 'spot' and 'deposit' are fine)", () => {
    const { container } = render(<RewardsScreen />);
    expect(container.textContent).not.toMatch(/\bpots?\b|jackpot|lottery|prize|motherlode|\bwins?\b|\btoday\b|\bdays?\b/i);
  });
});

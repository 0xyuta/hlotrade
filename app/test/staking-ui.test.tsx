// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RewardsChain } from "../src/rewards/chain";
import type { AppConfig } from "../src/config/validate";
import { PAIRED_BLOCKED_TEXT } from "../src/wallet/permissions";

const TOKEN = "0x00000000000000000000000000000000000000a1";
const STAKING = "0x00000000000000000000000000000000000000a4";
const BUYBACK = "0x00000000000000000000000000000000000000a5";
let session: { kind: "none" | "wallet" | "paired" };
let cfg: AppConfig;
const simulateBuy = vi.fn();
const buyOutcome = vi.fn();
const write = vi.fn();
const onDone = vi.fn();

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, write }) }));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/evm/clients", () => ({ publicClient: () => ({}) }));
vi.mock("../src/wallet/chains", () => ({ viemChain: () => ({}) }));
vi.mock("../src/rewards/buyback", () => ({ simulateBuy: (...a: unknown[]) => simulateBuy(...a), buyOutcome: (...a: unknown[]) => buyOutcome(...a) }));

import { ProtocolCard } from "../src/ui/rewards/ProtocolCard";
import { StakingCard } from "../src/ui/rewards/StakingCard";

const E18 = 10n ** 18n;
const NOW = 9_200_000;
const base = {
  now: NOW,
  user: { claimed: 0n, hlo: 100n * E18, staked: 40n * E18, pending: 3n * E18, allowance: 0n },
  staking: { totalStaked: 1_000n * E18, undripped: 25n * E18 },
  protocol: {
    totalBurned: 900n * E18, totalSpent: 12_345_000_000n, totalBought: 1_000n * E18, poolOpen: true, openAt: NOW - 5_000, slice: 5_000_000n,
    lastBuy: 0, buyInterval: 600, usdcHeld: 720_000_000n, price: 0.0125,
  },
};
const chain = (o: { user?: unknown; protocol?: object } = {}): RewardsChain =>
  ({ ...base, ...("user" in o ? { user: o.user } : {}), protocol: { ...base.protocol, ...o.protocol } }) as never;

beforeEach(() => {
  session = { kind: "wallet" };
  cfg = { network: "testnet", contracts: { token: TOKEN, staking: STAKING, buyback: BUYBACK } } as unknown as AppConfig;
  simulateBuy.mockReset().mockResolvedValue(5n * 10n ** 18n); // a buy() would buy 5 HLO
  buyOutcome.mockReset().mockResolvedValue({ kind: "bought", hloOut: 5n * 10n ** 18n, burned: 0n, toStakers: 0n });
  write.mockReset().mockResolvedValue("0xhash");
  onDone.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const type = (v: string) => fireEvent.change(screen.getByLabelText(/Amount/), { target: { value: v } });
const STAKE = /^(Stake|Approve and stake)$/;
const btn = (name: string | RegExp) => screen.getByRole("button", { name }) as HTMLButtonElement;

describe("StakingCard", () => {
  it("shows the totals and the user's numbers, the drip as a tail, and no APR", () => {
    const { container } = render(<StakingCard chain={chain()} onDone={onDone} />);
    expect(screen.getByText("1,000.00 HLO")).toBeTruthy(); // total staked
    expect(screen.getByText("25.00 HLO")).toBeTruthy(); // undripped
    expect(screen.getByText("40.00 HLO")).toBeTruthy(); // your stake
    expect(screen.getByText("3.00 HLO")).toBeTruthy(); // your rewards
    expect(screen.getByText("100.00 HLO")).toBeTruthy(); // wallet
    expect(container.textContent).toMatch(/about 63% of each buyback's share reaches stakers within a day/);
    expect(container.textContent).not.toMatch(/APR|APY/i);
  });
  it("short allowance: approves the amount, then stakes it", async () => {
    render(<StakingCard chain={chain()} onDone={onDone} />);
    type("5");
    fireEvent.click(btn("Approve and stake"));
    await waitFor(() => expect(screen.getByText("Stake: done.")).toBeTruthy());
    expect(write.mock.calls.map((c) => [c[0], c[1].address, c[1].functionName, c[1].args])).toEqual([
      ["hyperEvm", TOKEN, "approve", [STAKING, 5n * E18]],
      ["hyperEvm", STAKING, "stake", [5n * E18]],
    ]);
    expect(onDone).toHaveBeenCalled();
    expect((screen.getByLabelText(/Amount/) as HTMLInputElement).value).toBe("");
  });
  it("enough allowance: stakes without an approve", async () => {
    render(<StakingCard chain={chain({ user: { ...base.user, allowance: 50n * E18 } })} onDone={onDone} />);
    type("5");
    fireEvent.click(btn("Stake"));
    await waitFor(() => expect(screen.getByText("Stake: done.")).toBeTruthy());
    expect(write.mock.calls.map((c) => c[1].functionName)).toEqual(["stake"]);
  });
  it("a rejected approve stops there: no stake is sent, and the reason is in plain words", async () => {
    write.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    render(<StakingCard chain={chain()} onDone={onDone} />);
    type("5");
    fireEvent.click(btn("Approve and stake"));
    await waitFor(() => expect(screen.getByText("You cancelled the request in your wallet.")).toBeTruthy());
    expect(write).toHaveBeenCalledTimes(1);
    expect(btn("Approve and stake").disabled).toBe(false);
  });
  it("an approve that went through and a stake that failed: reloads, so the new allowance is seen", async () => {
    write.mockResolvedValueOnce("0x1").mockRejectedValueOnce(new Error("execution reverted: TransferFailed"));
    render(<StakingCard chain={chain()} onDone={onDone} />);
    type("5");
    fireEvent.click(btn("Approve and stake"));
    await waitFor(() => expect(screen.getByText(/HLO transfer failed/)).toBeTruthy());
    expect(onDone).toHaveBeenCalled();
  });
  it("unstake and claim send no approve", async () => {
    render(<StakingCard chain={chain()} onDone={onDone} />);
    type("10");
    fireEvent.click(btn("Unstake"));
    await waitFor(() => expect(screen.getByText("Unstake: done.")).toBeTruthy());
    fireEvent.click(btn("Claim rewards"));
    await waitFor(() => expect(screen.getByText("Claim staking rewards: done.")).toBeTruthy());
    expect(write.mock.calls.map((c) => [c[1].address, c[1].functionName, c[1].args])).toEqual([
      [STAKING, "unstake", [10n * E18]],
      [STAKING, "claim", undefined],
    ]);
  });
  it("amount rules: stake above the wallet balance and unstake above the stake are disabled; zero rewards disables claim", () => {
    render(<StakingCard chain={chain({ user: { ...base.user, pending: 0n } })} onDone={onDone} />);
    expect(btn(STAKE).disabled).toBe(true); // empty
    type("101");
    expect(btn(STAKE).disabled).toBe(true);
    expect(btn("Unstake").disabled).toBe(true);
    type("41");
    expect(btn(STAKE).disabled).toBe(false);
    expect(btn("Unstake").disabled).toBe(true);
    expect(btn("Claim rewards").disabled).toBe(true);
    fireEvent.click(btn("All staked"));
    expect((screen.getByLabelText(/Amount/) as HTMLInputElement).value).toBe("40");
  });
  it("a double click sends one stake", async () => {
    let done: (h: string) => void = () => {};
    write.mockReturnValue(new Promise((r) => (done = r)));
    render(<StakingCard chain={chain({ user: { ...base.user, allowance: 50n * E18 } })} onDone={onDone} />);
    type("5");
    const b = btn("Stake");
    fireEvent.click(b);
    fireEvent.click(b);
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => done("0x1"));
  });
  it("paired phone: cannot stake, says to open on the device with the wallet", () => {
    session = { kind: "paired" };
    render(<StakingCard chain={chain()} onDone={onDone} />);
    expect(screen.getByText(PAIRED_BLOCKED_TEXT)).toBeTruthy();
    expect(screen.queryByRole("button", { name: STAKE })).toBeNull();
  });
  it("no account: totals still show, asks to connect", () => {
    session = { kind: "none" };
    render(<StakingCard chain={chain({ user: null })} onDone={onDone} />);
    expect(screen.getByText("1,000.00 HLO")).toBeTruthy();
    expect(screen.getByText("Connect a wallet to stake.")).toBeTruthy();
  });
});

const flush = () => act(async () => {});

describe("ProtocolCard", () => {
  it("shows burned, USDC spent, HLO bought and the pool price", async () => {
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    expect(screen.getByText("900.00 HLO")).toBeTruthy();
    expect(screen.getByText("$12,345.00")).toBeTruthy();
    expect(screen.getByText("1,000.00 HLO")).toBeTruthy();
    expect(screen.getByText("$0.0125 per HLO")).toBeTruthy();
  });
  it("before opening: counts down to Buyback's launch time + OPEN_DELAY, the clock ticks, and no buy is simulated", () => {
    vi.useFakeTimers();
    render(<ProtocolCard chain={chain({ protocol: { poolOpen: false, price: null, openAt: NOW + 3_700 } })} onDone={onDone} />);
    expect(screen.getByText("The pool opens in 1h 1m.")).toBeTruthy();
    expect(screen.getByText("pool not open")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(3_605_000));
    expect(screen.getByText("The pool opens in 1m 35s.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open pool/i })).toBeNull();
    expect(simulateBuy).not.toHaveBeenCalled();
  });
  it("due and Buyback holds USDC: anyone can open the pool", async () => {
    render(<ProtocolCard chain={chain({ protocol: { poolOpen: false, price: null, openAt: NOW - 1 } })} onDone={onDone} />);
    expect(screen.getByText("The pool can open now. Anyone can open it.")).toBeTruthy();
    fireEvent.click(btn("Open pool"));
    await waitFor(() => expect(screen.getByText("The pool is open.")).toBeTruthy());
    expect(write).toHaveBeenCalledWith("hyperEvm", { address: BUYBACK, abi: expect.anything(), functionName: "openPool" });
    expect(onDone).toHaveBeenCalled();
  });
  it("due but no USDC yet: waits for the first fee deposit, no button", () => {
    render(<ProtocolCard chain={chain({ protocol: { poolOpen: false, price: null, openAt: NOW - 1, usdcHeld: 0n } })} onDone={onDone} />);
    expect(screen.getByText("The pool opens with the first fee deposit.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open pool/i })).toBeNull();
  });
  it("open with slice 0: buying starts after the next fee deposit, no buyback button while a buy would not buy", async () => {
    simulateBuy.mockResolvedValue(0n);
    render(<ProtocolCard chain={chain({ protocol: { slice: 0n } })} onDone={onDone} />);
    await flush();
    expect(screen.getByText("Buying starts after the next fee deposit.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /run buyback/i })).toBeNull();
  });
  it("a buy is due and the simulation says it would buy: the button is on", async () => {
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    expect(screen.getByText("A buyback is due. Anyone can run it.")).toBeTruthy();
    expect(btn("Run buyback").disabled).toBe(false);
    expect(simulateBuy).toHaveBeenCalledWith(expect.anything(), BUYBACK);
  });
  it("while the simulation is still running the button is off", () => {
    simulateBuy.mockReturnValue(new Promise(() => {}));
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    expect(btn("Run buyback").disabled).toBe(true);
    expect(screen.getByText(/Checking whether a buyback would run/)).toBeTruthy();
  });
  it("the simulation says 0 (skipped, or nothing to spend): the button is off and the card says so", async () => {
    simulateBuy.mockResolvedValue(0n);
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    expect(btn("Run buyback").disabled).toBe(true);
    expect(screen.getByText(/would not buy anything right now/)).toBeTruthy();
  });
  it("the simulation could not be made (RPC error): unknown, so the button stays off", async () => {
    simulateBuy.mockResolvedValue(null);
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    expect(btn("Run buyback").disabled).toBe(true);
    expect(screen.getByText(/Could not check whether a buyback would run/)).toBeTruthy();
  });
  it("a buy not yet due (next in 8m 20s): the button is off", async () => {
    simulateBuy.mockResolvedValue(0n); // TooSoon reverts
    render(<ProtocolCard chain={chain({ protocol: { lastBuy: NOW - 100 } })} onDone={onDone} />);
    await flush();
    expect(screen.getByText("Next buyback in 8m 20s.")).toBeTruthy();
    expect(btn("Run buyback").disabled).toBe(true);
  });
  it("checks again when the local clock makes the buy due", async () => {
    vi.useFakeTimers();
    simulateBuy.mockResolvedValue(0n);
    render(<ProtocolCard chain={chain({ protocol: { lastBuy: NOW - 595 } })} onDone={onDone} />);
    await act(async () => {});
    expect(simulateBuy).toHaveBeenCalledTimes(1);
    simulateBuy.mockResolvedValue(5n * E18);
    await act(async () => void vi.advanceTimersByTime(6_000));
    expect(screen.getByText("A buyback is due. Anyone can run it.")).toBeTruthy();
    expect(simulateBuy).toHaveBeenCalledTimes(2);
    expect(btn("Run buyback").disabled).toBe(false);
  });
  it("run buyback: simulates again right before the wallet call, calls Buyback.buy, and says what the receipt shows", async () => {
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    simulateBuy.mockClear();
    fireEvent.click(btn("Run buyback"));
    await waitFor(() => expect(screen.getByText("Bought 5.00 HLO (90% burned, 10% to stakers).")).toBeTruthy());
    expect(simulateBuy).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("hyperEvm", { address: BUYBACK, abi: expect.anything(), functionName: "buy" });
    expect(buyOutcome).toHaveBeenCalledWith(expect.anything(), "0xhash", BUYBACK);
    expect(onDone).toHaveBeenCalled();
  });
  it("receipt with Skipped, with neither event, and an unreadable receipt", async () => {
    for (const [outcome, text] of [
      [{ kind: "skipped" }, "Skipped: price moved more than 2% from its 30-minute average."],
      [{ kind: "nothing" }, "Nothing to buy right now."],
      [null, /Check the result/],
    ] as const) {
      buyOutcome.mockResolvedValue(outcome);
      const { unmount } = render(<ProtocolCard chain={chain()} onDone={onDone} />);
      await flush();
      fireEvent.click(btn("Run buyback"));
      await waitFor(() => expect(screen.getByText(text)).toBeTruthy());
      unmount();
    }
  });
  it("the check right before the wallet call says 0: nothing is sent", async () => {
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    simulateBuy.mockResolvedValue(0n);
    fireEvent.click(btn("Run buyback"));
    await waitFor(() => expect(screen.getByText(/would not buy anything right now, so nothing was sent/)).toBeTruthy());
    expect(write).not.toHaveBeenCalled();
    expect(btn("Run buyback").disabled).toBe(true);
  });
  it("the check right before the wallet call could not be made: nothing is sent", async () => {
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    simulateBuy.mockResolvedValue(null);
    fireEvent.click(btn("Run buyback"));
    await waitFor(() => expect(screen.getByText(/nothing was sent/)).toBeTruthy());
    expect(write).not.toHaveBeenCalled();
  });
  it("a failed buy says why in plain words", async () => {
    write.mockRejectedValue(new Error("execution reverted: TooSoon"));
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    fireEvent.click(btn("Run buyback"));
    await waitFor(() => expect(screen.getByText(/less than 10 minutes ago/)).toBeTruthy());
    expect(onDone).not.toHaveBeenCalled();
  });
  it("paired phone: the buttons are off and the note says to use the device with the wallet", async () => {
    session = { kind: "paired" };
    render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    expect(btn("Run buyback").disabled).toBe(true);
    expect(screen.getByText(PAIRED_BLOCKED_TEXT)).toBeTruthy();
  });
  it("never uses the wording the project forbids", async () => {
    const { container } = render(<ProtocolCard chain={chain()} onDone={onDone} />);
    await flush();
    expect(container.textContent).not.toMatch(/jackpot|lottery|prize/i);
  });
});

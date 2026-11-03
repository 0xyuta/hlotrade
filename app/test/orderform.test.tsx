// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../src/hl/impact";

const BUILDER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"ab".repeat(32)}`;
const BTC = { index: 3, name: "BTC", szDecimals: 5, maxLeverage: 40 };

let account: { balances: { trade: number } | null; takerRate: number; refresh: () => void };
let trading: Record<string, unknown>;
let session: { kind: string };
const placeOrder = vi.fn();

vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet", builder: BUILDER }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => account }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => trading }));
vi.mock("../src/hl/HlProvider", () => ({ useHl: () => ({ market: (c: string) => (c === "BTC" ? BTC : undefined), price: () => 80000 }) }));
vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session }) }));
vi.mock("../src/hl/trade", () => ({ placeOrder: (...a: unknown[]) => placeOrder(...a) }));
let book: Book | null;
vi.mock("../src/hl/book", () => ({ useBook: (_n: string, _c: string, on: boolean) => (on ? book : null), fetchBook: async () => book }));

import { OrderForm } from "../src/ui/trade/OrderForm";

const type = (label: string, v: string) => fireEvent.change(screen.getByLabelText(label), { target: { value: v } });

beforeEach(() => {
  placeOrder.mockReset();
  account = { balances: { trade: 500 }, takerRate: 0.00045, refresh: vi.fn() };
  trading = { master: "0x1111111111111111111111111111111111111111", agent: { key: KEY, address: "0xa9e17" }, status: { builderOk: true, agentOk: true }, reSignNeeded: false, markReSign: vi.fn(), enable: vi.fn(), enabling: false, error: null };
  session = { kind: "wallet" };
  book = { bids: [{ px: 79999, sz: 50 }], asks: [{ px: 80001, sz: 50 }] };
});
afterEach(cleanup);

describe("OrderForm", () => {
  it("shows no fee line", () => {
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    expect(screen.queryByText(/fee/i)).toBeNull();
  });

  it("warns when the margin is more than what is available", () => {
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "600");
    expect(screen.getByText(/more than your available \$500\.00/)).toBeTruthy();
  });

  it("a filled entry with a rejected stop loss is shown in plain words, and the amounts are cleared so a second click cannot repeat it", async () => {
    placeOrder.mockResolvedValue([{ kind: "filled", totalSz: "0.00062", avgPx: "80010" }, { kind: "error", text: "Order must have minimum value of $10." }]);
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByLabelText("Take profit / stop loss"));
    type("Stop loss %", "25");
    fireEvent.click(screen.getByText("Long BTC"));
    await waitFor(() => expect(screen.getByText(/filled at 80010, but the stop loss was rejected: Orders must be worth at least \$10\. Your position has no stop loss: set one in Positions\./)).toBeTruthy());
    expect((screen.getByLabelText("Margin (USDC)") as HTMLInputElement).value).toBe("");
    expect((screen.getByText("Long BTC") as HTMLButtonElement).disabled).toBe(true);
    expect(account.refresh).toHaveBeenCalled();
    expect(placeOrder).toHaveBeenCalledOnce();
  });

  it("TP/SL are chosen as a % of margin: at 5x, +50% and -10% trigger 10% above and 2% below the price", async () => {
    placeOrder.mockResolvedValue([{ kind: "filled", totalSz: "0.00062", avgPx: "80000" }, { kind: "waiting" }, { kind: "waiting" }]);
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByLabelText("Take profit / stop loss"));
    fireEvent.click(screen.getByText("+50%"));
    fireEvent.click(screen.getByText("−10%"));
    expect((screen.getByLabelText("Take profit %") as HTMLInputElement).value).toBe("50");
    expect(screen.getByText("Triggers at 88,000")).toBeTruthy();
    expect(screen.getByText("Triggers at 78,400")).toBeTruthy();
    fireEvent.click(screen.getByText("Long BTC"));
    await waitFor(() => expect(placeOrder).toHaveBeenCalledOnce());
    const triggers = placeOrder.mock.calls[0][0].plan.orders.slice(1).map((o: { t: { trigger: { triggerPx: string; tpsl: string } } }) => [o.t.trigger.tpsl, o.t.trigger.triggerPx]);
    expect(triggers).toEqual([["tp", "88000"], ["sl", "78400"]]);
  });

  it("a TP/SL % that is not usable blocks the order instead of dropping the leg", () => {
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByLabelText("Take profit / stop loss"));
    type("Stop loss %", "abc");
    expect(screen.getByText("Not a usable %")).toBeTruthy();
    expect(screen.getByText("Enter a stop loss % above 0.")).toBeTruthy();
    expect((screen.getByText("Long BTC") as HTMLButtonElement).disabled).toBe(true);
  });

  it("a rejected order keeps the amounts so the user can fix and retry", async () => {
    placeOrder.mockResolvedValue([{ kind: "error", text: "Insufficient margin to place order." }]);
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByText("Long BTC"));
    await waitFor(() => expect(screen.getByText("Not enough margin for this order.")).toBeTruthy());
    expect((screen.getByLabelText("Margin (USDC)") as HTMLInputElement).value).toBe("10");
  });

  it("on load, while a stored key's status is read, it says so instead of offering Enable trading", () => {
    trading.status = null;
    render(<OrderForm coin="BTC" />);
    expect(screen.getByText("Checking your trading key…")).toBeTruthy();
    expect(screen.queryByText("Enable trading")).toBeNull();
  });

  it("no stored key, or a status read that failed, offers Enable trading", () => {
    trading.status = null;
    trading.agent = null;
    const { unmount } = render(<OrderForm coin="BTC" />);
    expect(screen.getByText("Enable trading")).toBeTruthy();
    unmount();
    trading.agent = { key: KEY, address: "0xa9e17" };
    trading.error = "Hyperliquid did not answer.";
    render(<OrderForm coin="BTC" />);
    expect(screen.getByText("Enable trading")).toBeTruthy();
  });

  it("a paired phone whose agent expired is told to pair again on load", () => {
    session = { kind: "paired" };
    trading.status = { builderOk: true, agentOk: false };
    render(<OrderForm coin="BTC" />);
    expect(screen.getByText(/Pair again from your desktop/)).toBeTruthy();
  });

  it("a new instance per market starts fresh, at the current price (TradeScreen keys the form by coin)", () => {
    const { rerender } = render(<OrderForm key="ETH" coin="BTC" />);
    fireEvent.click(screen.getByText("Limit"));
    type("Limit price", "3000");
    rerender(<OrderForm key="BTC" coin="BTC" />);
    fireEvent.click(screen.getByText("Limit"));
    expect((screen.getByLabelText("Limit price") as HTMLInputElement).value).toBe("80000");
  });

  it("Limit starts at the current price; the % buttons count from the current price, not from the last press", () => {
    render(<OrderForm coin="BTC" />);
    fireEvent.click(screen.getByText("Limit"));
    const px = () => (screen.getByLabelText("Limit price") as HTMLInputElement).value;
    expect(px()).toBe("80000");
    fireEvent.click(screen.getByText("−10%"));
    expect(px()).toBe("72000");
    fireEvent.click(screen.getByText("−10%"));
    expect(px()).toBe("72000");
    expect(screen.getByText("10.00% below the current price")).toBeTruthy();
    fireEvent.click(screen.getByText("+5%"));
    expect(px()).toBe("84000");
    fireEvent.click(screen.getByText("Price"));
    expect(px()).toBe("80000");
    expect(screen.getByText("at the current price")).toBeTruthy();
    type("Limit price", "79000");
    expect(screen.getByText("1.25% below the current price")).toBeTruthy();
  });

  it("a part-rejected batch clears the amounts even when nothing filled or rested (no blind re-submit)", async () => {
    placeOrder.mockResolvedValue([{ kind: "error", text: "Insufficient margin to place order." }, { kind: "waiting" }]);
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByLabelText("Take profit / stop loss"));
    type("Stop loss %", "25");
    fireEvent.click(screen.getByText("Long BTC"));
    await waitFor(() => expect(screen.getByText(/the entry was rejected/)).toBeTruthy());
    expect((screen.getByLabelText("Margin (USDC)") as HTMLInputElement).value).toBe("");
    expect((screen.getByLabelText("Stop loss %") as HTMLInputElement).value).toBe("");
    expect((screen.getByText("Long BTC") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an IOC entry that fills only part says how much filled and that the rest did not", async () => {
    placeOrder.mockResolvedValue([{ kind: "filled", totalSz: "0.0003", avgPx: "80010" }]);
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByText("Long BTC"));
    await waitFor(() => expect(screen.getByText("Filled 0.0003 of 0.00062 at 80010. The rest did not fill at your slippage limit. Check Positions before trying again.")).toBeTruthy());
  });

  it("an answer that arrives after the form is gone (market switched mid-order) goes to onResult", async () => {
    let done: (v: unknown) => void = () => {};
    placeOrder.mockReturnValue(new Promise((r) => (done = r)));
    const onResult = vi.fn();
    const { unmount } = render(<OrderForm coin="BTC" onResult={onResult} />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByText("Long BTC"));
    unmount();
    await act(async () => done([{ kind: "filled", totalSz: "0.00062", avgPx: "80010" }]));
    expect(onResult).toHaveBeenCalledWith({ coin: "BTC", ok: true, text: "Filled 0.00062 at 80010." });
    expect(account.refresh).toHaveBeenCalled();
  });

  it("while the form is still there the result stays in the form, not in onResult", async () => {
    placeOrder.mockResolvedValue([{ kind: "filled", totalSz: "0.00062", avgPx: "80010" }]);
    const onResult = vi.fn();
    render(<OrderForm coin="BTC" onResult={onResult} />);
    type("Margin (USDC)", "10");
    fireEvent.click(screen.getByText("Long BTC"));
    await waitFor(() => expect(screen.getByText("Filled 0.00062 at 80010.")).toBeTruthy());
    expect(onResult).not.toHaveBeenCalled();
  });

  it("a market order shows its price impact from the book", () => {
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    expect(screen.getByText("Price impact")).toBeTruthy();
    expect(screen.getByText("under 0.01%")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("an impact of 1% or more warns in dollars and blocks the order until it is accepted", async () => {
    placeOrder.mockResolvedValue([{ kind: "filled", totalSz: "0.06247", avgPx: "81000" }]);
    book = { bids: [{ px: 79999, sz: 1 }], asks: [{ px: 80001, sz: 0.01 }, { px: 81000, sz: 0.01 }, { px: 82000, sz: 1 }] };
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "1000");
    expect(screen.getByRole("alert").textContent).toMatch(/This order moves the price about \d\.\d\d%: about \$\d+\.\d\d worse than the current price, on top of fees\./);
    const btn = screen.getByText("Long BTC") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(btn);
    expect(placeOrder).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(/I accept about \d\.\d\d% price impact/));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    await waitFor(() => expect(placeOrder).toHaveBeenCalledOnce());
  });

  it("an acceptance does not carry over to a bigger order", () => {
    book = { bids: [{ px: 79999, sz: 1 }], asks: [{ px: 80001, sz: 0.01 }, { px: 81000, sz: 0.01 }, { px: 82000, sz: 1 }] };
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "1000");
    fireEvent.click(screen.getByLabelText(/I accept about/));
    expect((screen.getByText("Long BTC") as HTMLButtonElement).disabled).toBe(false);
    type("Margin (USDC)", "2000");
    expect((screen.getByText("Long BTC") as HTMLButtonElement).disabled).toBe(true);
  });

  it("an order bigger than the visible book says so", () => {
    book = { bids: [{ px: 79999, sz: 1 }], asks: [{ px: 80001, sz: 0.001 }] };
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "100");
    expect(screen.getByRole("alert").textContent).toMatch(/bigger than the visible order book/);
    expect(screen.getByRole("alert").textContent).toMatch(/Part of it may not fill within your max slippage/);
  });

  it("no book (loading or unreadable) shows a dash and does not block", () => {
    book = null;
    render(<OrderForm coin="BTC" />);
    type("Margin (USDC)", "10");
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByText("Long BTC") as HTMLButtonElement).disabled).toBe(false);
  });

  it("a limit order reads no book", () => {
    render(<OrderForm coin="BTC" />);
    fireEvent.click(screen.getByText("Limit"));
    type("Margin (USDC)", "10");
    expect(screen.queryByText("Price impact")).toBeNull();
  });
});

describe("OrderForm: the default referral code (spec referrals §3)", () => {
  it("names the code under Enable trading when one will be set", () => {
    trading.agent = null;
    trading.status = { builderOk: false, agentOk: false };
    trading.referralCode = "HLOCFG";
    render(<OrderForm coin="BTC" />);
    expect(screen.getByText("Enable trading")).toBeTruthy();
    expect(screen.getByText("Uses referral code HLOCFG on Hyperliquid: 4% off Hyperliquid's fees on your first $25M traded.")).toBeTruthy();
    fireEvent.click(screen.getByText("Enable trading"));
    expect(trading.enable).toHaveBeenCalledWith("HLOCFG"); // exactly the code the text shows
  });
  it("says nothing about referrals without one, and Enable passes no code", () => {
    trading.agent = null;
    trading.status = { builderOk: false, agentOk: false };
    render(<OrderForm coin="BTC" />);
    expect(screen.getByText("Enable trading")).toBeTruthy();
    expect(screen.queryByText(/referral code/)).toBeNull();
    fireEvent.click(screen.getByText("Enable trading"));
    expect(trading.enable).toHaveBeenCalledWith(undefined);
  });
});

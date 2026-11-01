// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Fill, OpenOrder, Position } from "../src/hl/account";
import type { Book } from "../src/hl/impact";

const BUILDER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"ab".repeat(32)}`;
const ETH = { index: 1, name: "ETH", szDecimals: 4, maxLeverage: 25 };

const long: Position = { coin: "ETH", szi: 0.0335, entryPx: 2986.3, positionValue: 100, unrealizedPnl: 0, returnOnEquity: 0, liquidationPx: 2866, leverage: { type: "isolated", value: 20 }, marginUsed: 5 };
const trigger = (x: Partial<OpenOrder>): OpenOrder => ({ coin: "ETH", side: "A", limitPx: 0, sz: 0.0335, oid: 1, timestamp: 0, isTrigger: true, triggerPx: 3300, orderType: "Take Profit Market", reduceOnly: true, isPositionTpsl: true, ...x });
const fill: Fill = { coin: "ETH", px: 3000, sz: 0.01, side: "B", time: 1_700_000_000_000, dir: "Open Long", closedPnl: -1.5, fee: 0.02, builderFee: 0.003, oid: 9, tid: 5 };

let account: { positions: Position[]; openOrders: OpenOrder[]; fills: Fill[]; error: string | null; refresh: () => void };
let trading: { agent: object | null; status: object | null; reSignNeeded: boolean; markReSign: () => void; enable: () => void };
let session: { kind: string };
let mid: number | null;
const submitPlan = vi.fn();
const cancelOrders = vi.fn();

vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet", builder: BUILDER }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => account }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => trading }));
vi.mock("../src/hl/HlProvider", () => ({ useHl: () => ({ market: (c: string) => (c === "ETH" ? ETH : undefined), price: () => mid }) }));
vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session }) }));
vi.mock("../src/hl/trade", () => ({ submitPlan: (...a: unknown[]) => submitPlan(...a), cancelOrders: (...a: unknown[]) => cancelOrders(...a) }));
let book: Book | null;
let fetchBook: () => Promise<Book | null>;
vi.mock("../src/hl/book", () => ({ useBook: (_n: string, _c: string, on: boolean) => (on ? book : null), fetchBook: () => fetchBook() }));

import { AccountTabs } from "../src/ui/trade/AccountTabs";

beforeEach(() => {
  submitPlan.mockReset().mockResolvedValue([{ kind: "filled", totalSz: "0.0335", avgPx: "3000" }]);
  cancelOrders.mockReset().mockImplementation(async (o: { cancels: unknown[] }) => o.cancels.map(() => ({ ok: true })));
  account = { positions: [long], openOrders: [trigger({ oid: 1 }), trigger({ oid: 2, orderType: "Stop Market", triggerPx: 2900 })], fills: [fill], error: null, refresh: vi.fn() };
  trading = { agent: { key: KEY, address: "0xa9e17" }, status: { agentOk: true }, reSignNeeded: false, markReSign: vi.fn(), enable: vi.fn() };
  session = { kind: "wallet" };
  mid = 3000;
  book = { bids: [{ px: 2999.9, sz: 100 }], asks: [{ px: 3000.1, sz: 100 }] };
  fetchBook = async () => book;
});
afterEach(cleanup);

const THIN: Book = { bids: [{ px: 2999, sz: 0.01 }, { px: 2900, sz: 1 }], asks: [{ px: 3001, sz: 0.01 }, { px: 3100, sz: 1 }] };

describe("Close and Reverse check the price impact", () => {
  it("a close that moves the price 1% or more asks first, in dollars; Cancel sends nothing", async () => {
    book = THIN;
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/^Closing it moves the price about 2\.\d\d%: about \$\d\.\d\d worse than the current price, on top of fees\.$/));
    expect(screen.getByText("Close 0.0335 ETH long anyway?")).toBeTruthy();
    expect(submitPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Yes, close")).toBeNull();
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("'Yes, close' sends the same reduce-only close", async () => {
    book = THIN;
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    fireEvent.click(await screen.findByText("Yes, close"));
    await waitFor(() => expect(submitPlan).toHaveBeenCalledOnce());
    expect(submitPlan.mock.calls[0][0].plan.orders[0]).toMatchObject({ b: false, s: "0.0335", r: true });
  });
  it("a book that cannot be read asks too, and still lets the user close", async () => {
    fetchBook = async () => { throw new Error("HTTP 500"); };
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    expect(await screen.findByText("Could not read the order book to check the price impact.")).toBeTruthy();
    fireEvent.click(screen.getByText("Yes, close"));
    await waitFor(() => expect(submitPlan).toHaveBeenCalledOnce());
  });
  it("the reverse question shows the impact of twice the size, and warns on a thin book", () => {
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Reverse"));
    expect(screen.getByText("Price impact: under 0.01%")).toBeTruthy();
    cleanup();
    book = THIN;
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Reverse"));
    expect(screen.getByRole("alert").textContent).toMatch(/^Reversing it moves the price about/);
  });
});

describe("AccountTabs", () => {
  it("shows live PnL from the mid (not the fetched one), liquidation and the TP/SL prices", () => {
    render(<AccountTabs />);
    expect(screen.getByText("+$0.46")).toBeTruthy(); // 0.0335 × (3000 − 2986.3)
    expect(screen.getByText("2,866")).toBeTruthy();
    expect(screen.getByText("3,300 / 2,900")).toBeTruthy();
  });
  it("writes a loss with the sign before the dollar sign", () => {
    mid = 2900;
    render(<AccountTabs />);
    expect(screen.getByText("-$2.89")).toBeTruthy();
  });
  it("close sends a reduce-only IOC with the builder-bearing submit", async () => {
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByText("Filled 0.0335 at 3000.")).toBeTruthy());
    expect(submitPlan).toHaveBeenCalledOnce();
    const arg = submitPlan.mock.calls[0][0];
    expect(arg).toMatchObject({ net: "testnet", agentKey: KEY, builder: BUILDER });
    expect(arg.plan.orders).toEqual([{ a: 1, b: false, p: "2850", s: "0.0335", r: true, t: { limit: { tif: "Ioc" } } }]);
    expect(account.refresh).toHaveBeenCalled();
  });
  it("reverse asks first, in words, and sends nothing until 'Yes, reverse'", async () => {
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Reverse"));
    expect(screen.getByText("Reverse 0.0335 ETH long into a 0.0335 ETH short?")).toBeTruthy();
    expect(submitPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Yes, reverse"));
    await waitFor(() => expect(submitPlan).toHaveBeenCalled());
    expect(submitPlan.mock.calls[0][0].plan.orders[0]).toMatchObject({ b: false, s: "0.067", r: false });
    expect(screen.queryByText("Yes, reverse")).toBeNull();
  });
  it("reverse of a short reads the other way round; Cancel sends nothing", () => {
    account.positions = [{ ...long, szi: -0.0335 }];
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Reverse"));
    expect(screen.getByText("Reverse 0.0335 ETH short into a 0.0335 ETH long?")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByText("Yes, reverse")).toBeNull();
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("the question goes away with its position: nothing can be sent for a position that is gone", () => {
    const { rerender } = render(<AccountTabs />);
    fireEvent.click(screen.getByText("Reverse"));
    account = { ...account, positions: [] };
    rerender(<AccountTabs />);
    expect(screen.queryByText("Yes, reverse")).toBeNull();
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("after a close the row stays off until the account refetches (no stale double click)", async () => {
    const { rerender } = render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByText("Filled 0.0335 at 3000.")).toBeTruthy());
    expect((screen.getByText("Close") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Reverse") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByText("Close"));
    expect(submitPlan).toHaveBeenCalledOnce();
    account = { ...account, positions: [{ ...long, szi: 0 + 0.0335 }] }; // a refetch: a new array
    rerender(<AccountTabs />);
    expect((screen.getByText("Close") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a close that throws (network failure, timeout) holds the row too: the order may have reached Hyperliquid (carry T12)", async () => {
    submitPlan.mockRejectedValue(new Error("Request timed out after 10000 ms"));
    const { rerender } = render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByText(/timed out/)).toBeTruthy());
    expect((screen.getByText("Close") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Reverse") as HTMLButtonElement).disabled).toBe(true);
    account = { ...account, positions: [{ ...long }] }; // the refetch lifts it
    rerender(<AccountTabs />);
    expect((screen.getByText("Close") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a partly filled close says what is left", async () => {
    submitPlan.mockResolvedValue([{ kind: "filled", totalSz: "0.01", avgPx: "3000" }]);
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByText(/Filled 0\.01 of 0\.0335 at 3000\. The rest did not fill/)).toBeTruthy());
  });
  it("no price → the plan's message, nothing sent", async () => {
    mid = null;
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByText("No price yet. Wait a moment.")).toBeTruthy());
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("buttons are off until trading is enabled", () => {
    trading.status = { agentOk: false };
    render(<AccountTabs />);
    expect((screen.getByText("Close") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("TP/SL") as HTMLButtonElement).disabled).toBe(true);
  });
  it("a 'does not exist' agent error asks for one re-sign; on a paired phone it says pair again", async () => {
    submitPlan.mockRejectedValue(new Error("User or API Wallet 0xa9e17 does not exist."));
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByText(/Sign once to enable trading again/)).toBeTruthy());
    expect(trading.markReSign).toHaveBeenCalled();
    cleanup();
    session = { kind: "paired" };
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Close"));
    await waitFor(() => expect(screen.getByText("Pair again from your desktop to keep trading on this phone.")).toBeTruthy());
  });
  it("open orders: trigger orders show Market, cancel sends the oid", async () => {
    render(<AccountTabs />);
    fireEvent.click(screen.getByText(/Open orders/));
    expect(screen.getAllByText("Market").length).toBe(3); // the header and the two trigger rows
    fireEvent.click(screen.getAllByText("Cancel")[1]);
    await waitFor(() => expect(screen.getByText("Order cancelled.")).toBeTruthy());
    expect(cancelOrders).toHaveBeenCalledWith({ net: "testnet", agentKey: KEY, cancels: [{ a: 1, o: 2 }] });
  });
  it("a cancel the exchange refuses is said in plain words", async () => {
    cancelOrders.mockResolvedValue([{ ok: false, text: "Order was never placed, already canceled, or filled. asset=1" }]);
    render(<AccountTabs />);
    fireEvent.click(screen.getByText(/Open orders/));
    fireEvent.click(screen.getAllByText("Cancel")[0]);
    await waitFor(() => expect(screen.getByText("That order is no longer open.")).toBeTruthy());
  });
  it("history lists fills with the HLO part of the fee", () => {
    render(<AccountTabs />);
    fireEvent.click(screen.getByText("Trade history"));
    expect(screen.getByText("Open Long")).toBeTruthy();
    expect(screen.getByText("$0.0030")).toBeTruthy();
    expect(screen.getByText("-$1.50")).toBeTruthy();
  });
  it("empty states", () => {
    account.positions = []; account.openOrders = []; account.fills = [];
    render(<AccountTabs />);
    expect(screen.getByText("No open positions.")).toBeTruthy();
    fireEvent.click(screen.getByText(/Open orders/));
    expect(screen.getByText("No open orders.")).toBeTruthy();
    fireEvent.click(screen.getByText("Trade history"));
    expect(screen.getByText("No trades yet.")).toBeTruthy();
  });
});

describe("TP/SL edit", () => {
  const open = () => { render(<AccountTabs />); fireEvent.click(screen.getByText("TP/SL")); };
  it("prefills the current triggers, cancels both old orders, then places the new ones as positionTpsl", async () => {
    open();
    // entry 2986.3 at 20x: 3300 is +210.1% on margin, 2900 is -57.8%
    expect((screen.getByLabelText("Take profit %") as HTMLInputElement).value).toBe("210.1");
    expect((screen.getByLabelText("Stop loss %") as HTMLInputElement).value).toBe("57.8");
    fireEvent.change(screen.getByLabelText("Take profit %"), { target: { value: "300" } }); // +15% on price
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(submitPlan).toHaveBeenCalled());
    expect(cancelOrders).toHaveBeenCalledWith({ net: "testnet", agentKey: KEY, cancels: [{ a: 1, o: 1 }, { a: 1, o: 2 }] });
    expect(cancelOrders.mock.invocationCallOrder[0]).toBeLessThan(submitPlan.mock.invocationCallOrder[0]);
    const arg = submitPlan.mock.calls[0][0];
    expect(arg.builder).toBe(BUILDER);
    expect(arg.plan.grouping).toBe("positionTpsl");
    expect(arg.plan.orders.map((o: { t: { trigger: { triggerPx: string } } }) => o.t.trigger.triggerPx)).toEqual(["3434.2", "2900"]); // the untouched stop loss keeps its exact price
  });
  it("a plan that does not validate cancels nothing", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Take profit %"), { target: { value: "0.1" } }); // 2986.45, below the 3000 mark
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("For a long, take profit must be above 3,000.")).toBeTruthy());
    expect(cancelOrders).not.toHaveBeenCalled();
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("says so when the old TP/SL was cancelled but the new one failed", async () => {
    submitPlan.mockRejectedValue(new Error("Insufficient margin"));
    open();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/Not enough margin for this order\. Your old TP\/SL was cancelled\./)).toBeTruthy());
  });
  it("Remove TP/SL only cancels", async () => {
    open();
    fireEvent.click(screen.getByText("Remove TP/SL"));
    await waitFor(() => expect(cancelOrders).toHaveBeenCalledWith({ net: "testnet", agentKey: KEY, cancels: [{ a: 1, o: 1 }, { a: 1, o: 2 }] }));
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("a position with no TP/SL starts blank and cancels nothing", async () => {
    account.openOrders = [];
    open();
    expect((screen.getByLabelText("Take profit %") as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText("Stop loss %"), { target: { value: "25" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(submitPlan).toHaveBeenCalled());
    expect(cancelOrders).not.toHaveBeenCalled();
  });
  const many = () => [
    trigger({ oid: 1, triggerPx: 3300 }),
    trigger({ oid: 2, triggerPx: 3400 }),
    trigger({ oid: 3, orderType: "Stop Market", triggerPx: 2900 }),
    trigger({ oid: 4, orderType: "Stop Market", triggerPx: 2800 }),
    trigger({ oid: 5, coin: "BTC", triggerPx: 90000 }),
    trigger({ oid: 6, isTrigger: false, orderType: "Limit", reduceOnly: false }),
  ];
  const all4 = [{ a: 1, o: 1 }, { a: 1, o: 2 }, { a: 1, o: 3 }, { a: 1, o: 4 }];
  it("two TPs and two SLs: Save cancels all four (and no other coin's), then places one pair", async () => {
    account.openOrders = many();
    open();
    expect(screen.getByText(/4 reduce-only trigger orders/)).toBeTruthy();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(submitPlan).toHaveBeenCalled());
    expect(cancelOrders).toHaveBeenCalledWith({ net: "testnet", agentKey: KEY, cancels: all4 });
    expect(submitPlan.mock.calls[0][0].plan.orders).toHaveLength(2);
  });
  it("two TPs and two SLs: Remove cancels all four", async () => {
    account.openOrders = many();
    open();
    fireEvent.click(screen.getByText("Remove TP/SL"));
    await waitFor(() => expect(cancelOrders).toHaveBeenCalledWith({ net: "testnet", agentKey: KEY, cancels: all4 }));
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("the table says there are more than one TP and SL", () => {
    account.openOrders = many();
    render(<AccountTabs />);
    expect(screen.getByText("3,300 / 2,900 +2")).toBeTruthy();
  });
  it("a cancel batch that partly fails says which were cancelled, and places nothing", async () => {
    account.openOrders = many();
    cancelOrders.mockResolvedValue([{ ok: true }, { ok: true }, { ok: false, text: "Order was never placed, already canceled, or filled. asset=1" }, { ok: true }]);
    open();
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText(/Cancelled: take profit 3,300, take profit 3,400, stop loss 2,800\. Not cancelled: stop loss 2,900 \(That order is no longer open\)\. No new TP\/SL was placed/)).toBeTruthy());
    expect(submitPlan).not.toHaveBeenCalled();
  });
  it("Remove with a partly failed cancel does not close the dialog", async () => {
    account.openOrders = many();
    cancelOrders.mockResolvedValue([{ ok: false, text: "Order was never placed, already canceled, or filled." }, { ok: true }, { ok: true }, { ok: true }]);
    open();
    fireEvent.click(screen.getByText("Remove TP/SL"));
    await waitFor(() => expect(screen.getByText(/Not cancelled: take profit 3,300/)).toBeTruthy());
    expect(screen.getByText("Save")).toBeTruthy();
  });
  it("a re-sign need shows its way out inside the dialog", () => {
    trading.reSignNeeded = true;
    open();
    expect(screen.getAllByText("Sign once to enable trading again").length).toBe(2); // the card's and the dialog's
    // It shows no referral text, so it passes no code to enable(): re-signing sets no referral code.
    fireEvent.click(screen.getAllByText("Sign once to enable trading again")[0]);
    expect(trading.enable).toHaveBeenCalledWith();
    cleanup();
    session = { kind: "paired" };
    render(<AccountTabs />);
    expect(screen.getAllByText("Pair again from your desktop to keep trading on this phone.").length).toBe(1);
  });
});

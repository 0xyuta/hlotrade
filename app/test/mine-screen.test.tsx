// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RewardsState } from "../src/rewards/useRewards";

const A = "0x00000000000000000000000000000000000000aa";
const BUILDER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"ab".repeat(32)}`;
const BTC = { index: 3, name: "BTC", szDecimals: 5, maxLeverage: 40 };
const ETH = { index: 4, name: "ETH", szDecimals: 4, maxLeverage: 25 };
const E18 = 10n ** 18n;

let state: RewardsState;
let session: { kind: string };
let account: { balances: { trade: number } | null; takerRate: number; positions: unknown[]; fills: unknown[]; openOrders: unknown[]; refresh: () => void };
let trading: Record<string, unknown>;
let book: unknown;
const placeOrder = vi.fn();
const submitPlan = vi.fn();
const claim = vi.fn();

vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet", builder: BUILDER, hyperEvmChainId: 998 }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => account }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => trading }));
vi.mock("../src/hl/HlProvider", () => ({
  useHl: () => ({ markets: [BTC, ETH], market: (c: string) => ({ BTC, ETH })[c], price: (c: string) => (c === "BTC" ? 80000 : 2000), error: null }),
}));
vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session }) }));
vi.mock("../src/hl/trade", () => ({ placeOrder: (...a: unknown[]) => placeOrder(...a), submitPlan: (...a: unknown[]) => submitPlan(...a) }));
vi.mock("../src/hl/book", () => ({ useBook: (_n: string, _c: string, on: boolean) => (on ? book : null), fetchBook: async () => book }));
vi.mock("../src/rewards/useRewards", () => ({ useRewards: () => ({ state, reload: vi.fn(), hold: vi.fn() }) }));
vi.mock("../src/rewards/useClaim", () => ({ useClaim: () => ({ busy: false, msg: null, claim }) }));
vi.mock("../src/rewards/useMinuteTables", () => ({ useMinuteTables: () => ({ tables: new Map(), failed: new Set() }) }));
vi.mock("../src/ui/trade/MarketPicker", () => ({ MarketPicker: ({ coin }: { coin: string }) => <div>picker {coin}</div> }));

import { MineScreen } from "../src/ui/mine/MineScreen";

const chain = { now: 1_800_000_018, launchTime: 1_800_000_000, paused: false, claimed: 0n, claimAvailable: 5000n * E18, latestValidMinute: 0 };
const latest = { throughMinute: 3, table: `minute,user,fee\n3,${A},300000000\n3,0x00000000000000000000000000000000000000bb,110000000`, vault: { amount: (742n * E18).toString(), pointsTotal: "0", odds: 60, lastPopMinute: -1 }, pops: [] };
const yours = { earned: 12n * E18, claimed: 0n, claimable: 12n * E18, claimNow: 12n * E18, youGet: 10n * E18, refined: 0n, points: 50_000_000n, vaultShare: 0n };
const plan = { kind: "settleAndClaim" };
const ready = (o: object = {}): RewardsState => ({ kind: "ready", data: { chain, full: null, extraError: null, latest, latestProblem: null, yours, yoursAt: 3, plan, ...o } } as never);
const position = { coin: "BTC", szi: 0.001, entryPx: 79_000, positionValue: 80, unrealizedPnl: 1, returnOnEquity: 0, liquidationPx: null, leverage: { type: "isolated", value: 1 }, marginUsed: 80 };

const stubStorage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
};

beforeEach(() => {
  stubStorage();
  state = ready();
  session = { kind: "wallet" };
  account = { balances: { trade: 500 }, takerRate: 0.00045, positions: [], fills: [], openOrders: [], refresh: vi.fn() };
  trading = { master: A, agent: { key: KEY, address: "0xa9e17" }, status: { builderOk: true, agentOk: true }, reSignNeeded: false, error: null, referralCode: null, enable: vi.fn() };
  book = { bids: [{ px: 79_999, sz: 50 }], asks: [{ px: 80_001, sz: 50 }] };
  placeOrder.mockReset().mockResolvedValue([{ kind: "filled", totalSz: "0.00125", avgPx: "80000" }]);
  submitPlan.mockReset().mockResolvedValue([{ kind: "filled", totalSz: "0.001", avgPx: "80000" }]);
  claim.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const start = () => screen.getByRole("button", { name: /^Start mining/ }) as HTMLButtonElement;

describe("MineScreen, nothing open", () => {
  it("shows the minute, the last counted minute, your HLO, the vault and its odds, from chain time and the files", () => {
    render(<MineScreen />);
    expect(screen.getByRole("timer").getAttribute("aria-label")).toBe("This minute: 0:42 left");
    expect(screen.getByText("Last counted minute: $4.10 in fees shared 1 HLO")).toBeTruthy();
    expect(screen.getByText("12.00")).toBeTruthy();
    expect(screen.getByText("742")).toBeTruthy();
    expect(screen.getByText("1 in 60 each minute")).toBeTruthy();
    expect(screen.getByText(/about 0\.02 HLO/)).toBeTruthy();
    expect(screen.getByText("You need 1 point to share in a pop: $500 more in trades.")).toBeTruthy();
  });

  it("sends one market order at 1x with nothing attached, and sends no close", async () => {
    render(<MineScreen />);
    expect(start().textContent).toBe("Start mining: long $100 BTC");
    expect(screen.getByText("Real position. Fee about $0.15. You can lose money.")).toBeTruthy();
    fireEvent.click(start());
    await waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(1));
    const arg = placeOrder.mock.calls[0][0];
    expect(arg.leverage).toBe(1);
    expect(arg.plan.orders).toHaveLength(1);
    expect(arg.plan.orders[0]).toMatchObject({ a: 3, b: true, r: false });
    await waitFor(() => expect(account.refresh).toHaveBeenCalled());
    expect(submitPlan).not.toHaveBeenCalled();
    expect(placeOrder).toHaveBeenCalledTimes(1);
  });

  it("starts at 1x, and sends the leverage and the size the user chose", async () => {
    render(<MineScreen />);
    const group = screen.getByRole("group", { name: "Leverage · isolated" });
    expect([...group.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["1×", "3×", "5×", "10×", "40×"]);
    expect(screen.getByRole("button", { name: "1×" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "5×" }));
    expect(start().textContent).toBe("Start mining: long $500 BTC at 5×");
    expect(screen.getByText(/Liquidation near .*: you could lose your \$100\./)).toBeTruthy();
    fireEvent.click(start());
    await waitFor(() => expect(placeOrder).toHaveBeenCalledTimes(1));
    const arg = placeOrder.mock.calls[0][0];
    expect(arg.leverage).toBe(5);
    expect(arg.plan.orders[0].s).toBe("0.00625");
  });

  it("the balance limits what goes in, not the position's value", () => {
    account.balances = { trade: 120 };
    render(<MineScreen />);
    fireEvent.click(screen.getByRole("button", { name: "10×" }));
    expect(start().textContent).toBe("Start mining: long $1,000 BTC at 10×");
    expect(start().disabled).toBe(false);
  });

  it("the estimate counts the whole position's fee", () => {
    render(<MineScreen />);
    const before = screen.getByText(/about .* HLO$/).textContent;
    fireEvent.click(screen.getByRole("button", { name: "10×" }));
    expect(screen.getByText(/about .* HLO$/).textContent).not.toBe(before);
  });

  it("a second press cannot send a second order before the account has read again", async () => {
    render(<MineScreen />);
    const button = start();
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(account.refresh).toHaveBeenCalled());
    expect(placeOrder).toHaveBeenCalledTimes(1);
    expect(start().disabled).toBe(true);
  });

  it("a network error keeps the button off too: the order may have reached Hyperliquid", async () => {
    placeOrder.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<MineScreen />);
    fireEvent.click(start());
    await waitFor(() => expect(account.refresh).toHaveBeenCalled());
    expect(start().disabled).toBe(true);
  });

  it("goes short when asked, and takes a chip", () => {
    render(<MineScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Short" }));
    fireEvent.click(screen.getByRole("button", { name: "$1,000" }));
    account = { ...account, balances: { trade: 5000 } };
    expect(start().textContent).toBe("Start mining: short $1,000 BTC");
  });

  it("refuses more than the balance", () => {
    account.balances = { trade: 50 };
    render(<MineScreen />);
    expect(start().disabled).toBe(true);
    expect(screen.getByText("That is more than your available $50.00.")).toBeTruthy();
  });

  it("points to a deposit under the floor", () => {
    account.balances = { trade: 2 };
    render(<MineScreen />);
    expect(screen.getByText(/Deposit USDC to start/)).toBeTruthy();
  });

  it("asks before a price impact, as the order form does", () => {
    book = { bids: [{ px: 79_999, sz: 50 }], asks: [{ px: 90_000, sz: 50 }] };
    render(<MineScreen />);
    expect(start().disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(start().disabled).toBe(false);
  });

  it("shows Enable trading while trading is not ready, and no start button", () => {
    trading = { ...trading, agent: null, status: null };
    render(<MineScreen />);
    expect(screen.getByRole("button", { name: "Enable trading" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start mining/ })).toBeNull();
  });

  it("asks for a wallet without one", () => {
    session = { kind: "none" };
    trading = { ...trading, master: null, agent: null, status: null };
    state = ready({ yours: null, plan: null, yoursAt: null });
    render(<MineScreen />);
    expect(screen.getByText("Connect a wallet to trade.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /claim/i })).toBeNull();
  });

  it("claims from the same screen, and offers no claim with nothing to claim", () => {
    const { unmount } = render(<MineScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Settle & claim" }));
    expect(claim).toHaveBeenCalledTimes(1);
    unmount();
    state = ready({ yours: { ...yours, claimable: 0n, claimNow: 0n }, plan: null });
    render(<MineScreen />);
    expect(screen.queryByRole("button", { name: /claim/i })).toBeNull();
  });

  it("says claims are paused and keeps the button off", () => {
    state = ready({ chain: { ...chain, paused: true } });
    render(<MineScreen />);
    expect((screen.getByRole("button", { name: "Settle & claim" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("still trades when the rewards numbers cannot load", () => {
    state = { kind: "down", error: "no answer" };
    render(<MineScreen />);
    expect(screen.getByText(/Trading still works/)).toBeTruthy();
    expect(screen.getByRole("timer").getAttribute("aria-label")).toBe("This minute: — left");
    expect(start().disabled).toBe(false);
  });
});

describe("MineScreen, a position open", () => {
  beforeEach(() => {
    account.positions = [position];
  });

  it("shows the position and its PnL, and the main button closes: nothing else can be sent", () => {
    render(<MineScreen />);
    expect(screen.getByText("Long $80 BTC")).toBeTruthy();
    expect(screen.getByText("+$1.00")).toBeTruthy();
    expect(screen.getByText("It stays open until you close it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Start mining/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Close position" })).toBeTruthy();
  });

  it("does not close by itself: however long it is open, only a press sends the close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout"] });
    render(<MineScreen />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(submitPlan).not.toHaveBeenCalled();
    expect(placeOrder).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("closes with one reduce-only order for the whole position", async () => {
    render(<MineScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Close position" }));
    await waitFor(() => expect(submitPlan).toHaveBeenCalledTimes(1));
    expect(submitPlan.mock.calls[0][0].plan.orders[0]).toMatchObject({ a: 3, b: false, s: "0.001", r: true });
    await waitFor(() => expect((screen.getByRole("button", { name: "Close position" }) as HTMLButtonElement).disabled).toBe(true));
  });

  it("asks first when the close would move the price, or the book cannot be read", async () => {
    book = null;
    render(<MineScreen />);
    fireEvent.click(screen.getByRole("button", { name: "Close position" }));
    expect(await screen.findByText(/Could not read the order book/)).toBeTruthy();
    expect(submitPlan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Yes, close" }));
    await waitFor(() => expect(submitPlan).toHaveBeenCalledTimes(1));
  });

  it("opens on a position in another coin once, and names the others", async () => {
    localStorage.setItem("hlo:coin", "ETH");
    account.positions = [position, { ...position, coin: "SOL" }];
    render(<MineScreen />);
    await waitFor(() => expect(screen.getByText("picker BTC")).toBeTruthy());
    expect(screen.getByText("You also have 1 other position. Switch to Trade to see it.")).toBeTruthy();
  });
});

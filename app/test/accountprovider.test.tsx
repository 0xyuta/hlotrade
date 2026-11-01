// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MASTER = "0x1111111111111111111111111111111111111111";
const info = {
  clearinghouseState: vi.fn(),
  spotClearinghouseState: vi.fn(),
  frontendOpenOrders: vi.fn(),
  userFills: vi.fn(),
  userFillsByTime: vi.fn(),
  userFees: vi.fn(),
};
const infoPost = vi.fn();
let onFills: (ev: { isSnapshot?: true }) => void = () => {};
let onOrders: () => void = () => {};
let master: string | null = MASTER;

vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet" }) }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => ({ master }) }));
vi.mock("../src/hl/clients", () => ({
  getHl: () => ({
    info,
    subs: () => ({
      userFills: async (_p: unknown, l: typeof onFills) => ((onFills = l), { unsubscribe: async () => {} }),
      orderUpdates: async (_p: unknown, l: typeof onOrders) => ((onOrders = l), { unsubscribe: async () => {} }),
    }),
  }),
  infoPost: (...a: unknown[]) => infoPost(...a),
}));

import { AccountProvider, DEBOUNCE_MS, MAX_WAIT_MS, useAccount, type AccountApi } from "../src/hl/AccountProvider";

let api: AccountApi;
function Probe() {
  api = useAccount();
  return null;
}
let rerender: (ui: React.ReactElement) => void;
const mount = async () => {
  ({ rerender } = render(<AccountProvider><Probe /></AccountProvider>));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const fill = (tid: number, time: number) => ({ coin: "ETH", px: "1", sz: "1", side: "B", time, dir: "Open Long", closedPnl: "0", fee: "0", oid: tid, tid });

beforeEach(() => {
  vi.useFakeTimers();
  master = MASTER;
  for (const f of Object.values(info)) f.mockReset();
  infoPost.mockReset().mockResolvedValue("unifiedAccount");
  info.clearinghouseState.mockResolvedValue({ assetPositions: [], withdrawable: "5" });
  info.spotClearinghouseState.mockResolvedValue({ balances: [{ coin: "USDC", total: "100", hold: "0" }] });
  info.frontendOpenOrders.mockResolvedValue([]);
  info.userFills.mockResolvedValue([fill(1, 1000), fill(2, 2000)]);
  info.userFillsByTime.mockResolvedValue([fill(2, 2000), fill(3, 3000)]);
  info.userFees.mockResolvedValue({ userCrossRate: "0.0003" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("AccountProvider requests", () => {
  it("reads everything once on mount (the WS snapshot does not trigger a second load)", async () => {
    await mount();
    for (const f of [info.clearinghouseState, info.spotClearinghouseState, info.frontendOpenOrders, info.userFills, info.userFees, infoPost]) expect(f).toHaveBeenCalledTimes(1);
    expect(api.balances).toEqual({ perps: 5, spot: 100, trade: 100, source: "spot" });
    expect(api.takerRate).toBe(0.0003);
    onFills({ isSnapshot: true });
    await tick(MAX_WAIT_MS + 1000);
    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
  });

  it("a burst of events is one refetch of only what changed; fees and abstraction are not read again", async () => {
    await mount();
    onFills({});
    onFills({});
    onOrders();
    await tick(DEBOUNCE_MS - 1);
    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
    await tick(2);
    expect(info.clearinghouseState).toHaveBeenCalledTimes(2);
    expect(info.frontendOpenOrders).toHaveBeenCalledTimes(2);
    expect(info.userFills).toHaveBeenCalledTimes(1);
    expect(info.userFillsByTime).toHaveBeenCalledWith({ user: MASTER, startTime: 2000 });
    expect(info.userFees).toHaveBeenCalledTimes(1);
    expect(infoPost).toHaveBeenCalledTimes(1);
    expect(api.fills.map((f) => f.tid)).toEqual([3, 2, 1]); // merged by tid, newest first
  });

  it("a fill event alone skips open orders; an order event alone skips fills", async () => {
    await mount();
    onFills({});
    await tick(DEBOUNCE_MS + 1);
    expect(info.frontendOpenOrders).toHaveBeenCalledTimes(1);
    expect(info.userFillsByTime).toHaveBeenCalledTimes(1);
    onOrders();
    await tick(DEBOUNCE_MS + 1);
    expect(info.frontendOpenOrders).toHaveBeenCalledTimes(2);
    expect(info.userFillsByTime).toHaveBeenCalledTimes(1);
  });

  it("a steady stream cannot postpone the refetch past the maximum wait", async () => {
    await mount();
    for (let t = 0; t < MAX_WAIT_MS; t += 500) {
      onOrders();
      await tick(500);
    }
    expect(info.clearinghouseState.mock.calls.length).toBeLessThanOrEqual(2);
    await tick(10);
    expect(info.clearinghouseState).toHaveBeenCalledTimes(2);
  });

  it("an A → B switch while A's first fetch is still in flight drops A's late answer (carry T11)", async () => {
    const B = "0x2222222222222222222222222222222222222222";
    let releaseA!: (v: unknown) => void;
    info.clearinghouseState.mockImplementation(({ user }: { user: string }) =>
      user === MASTER ? new Promise((r) => (releaseA = r)) : Promise.resolve({ assetPositions: [], withdrawable: "7" }),
    );
    info.spotClearinghouseState.mockImplementation(({ user }: { user: string }) =>
      Promise.resolve({ balances: [{ coin: "USDC", total: user === MASTER ? "100" : "70", hold: "0" }] }),
    );
    await mount(); // A's fetch is waiting on clearinghouseState
    expect(api.balances).toBeNull();
    master = B;
    rerender(<AccountProvider><Probe /></AccountProvider>);
    await tick(0);
    expect(api.balances).toEqual({ perps: 7, spot: 70, trade: 70, source: "spot" });
    releaseA({ assetPositions: [], withdrawable: "5" }); // A answers late
    await tick(0);
    expect(api.balances).toEqual({ perps: 7, spot: 70, trade: 70, source: "spot" }); // still B's
    await tick(DEBOUNCE_MS + MAX_WAIT_MS);
    expect(api.balances).toEqual({ perps: 7, spot: 70, trade: 70, source: "spot" });
  });

  it("refresh() from before an account switch reaches the new account, and the old account's data is cleared", async () => {
    await mount();
    const oldRefresh = api.refresh;
    expect(api.balances).not.toBeNull();
    master = null;
    rerender(<AccountProvider><Probe /></AccountProvider>);
    await tick(0);
    expect(api.balances).toBeNull();
    oldRefresh(); // must not throw or fetch for a missing account
    await tick(DEBOUNCE_MS + 1);
    expect(info.clearinghouseState).toHaveBeenCalledTimes(1);
  });
});

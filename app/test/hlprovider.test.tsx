// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";

const metaAndAssetCtxs = vi.fn();
const allMids = vi.fn();
vi.mock("../src/hl/clients", () => ({ getHl: () => ({ info: { metaAndAssetCtxs }, subs: () => ({ allMids }) }) }));
vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet" }) as AppConfig }));
vi.mock("../src/hl/markets", async (orig) => ({
  ...(await orig<typeof import("../src/hl/markets")>()),
  toMarkets: () => [{ name: "BTC", markPx: 1, midPx: null, prevDayPx: 1, szDecimals: 5, maxLeverage: 40 }],
}));

import { HlProvider, useHl } from "../src/hl/HlProvider";

function Probe() {
  const { markets, error } = useHl();
  return <p>{`markets=${markets.length} error=${error ?? "none"}`}</p>;
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers();
  metaAndAssetCtxs.mockReset();
  allMids.mockReset();
  allMids.mockResolvedValue({ unsubscribe: async () => {} });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HlProvider markets: a failed first load is retried soon, with a growing delay (carry T10)", () => {
  it("retries after 1 s and 2 s, not after the 60 s refresh, then shows the markets and clears the error", async () => {
    metaAndAssetCtxs.mockRejectedValueOnce(new Error("down")).mockRejectedValueOnce(new Error("down")).mockResolvedValue([]);
    render(<HlProvider><Probe /></HlProvider>);
    await flush();
    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(1);
    expect(screen.getByText("markets=0 error=down")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(999); });
    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(2_000); });
    await flush();
    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(3);
    expect(screen.getByText("markets=1 error=none")).toBeTruthy();
  });
  it("after a first success, a failed refresh waits for the next 60 s tick (no fast retries)", async () => {
    metaAndAssetCtxs.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("blip")).mockResolvedValue([]);
    render(<HlProvider><Probe /></HlProvider>);
    await flush();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    await flush();
    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(2);
    expect(screen.getByText("markets=1 error=blip")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(2);
  });
  it("unmounting stops a pending retry", async () => {
    metaAndAssetCtxs.mockRejectedValue(new Error("down"));
    const { unmount } = render(<HlProvider><Probe /></HlProvider>);
    await flush();
    unmount();
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(metaAndAssetCtxs).toHaveBeenCalledTimes(1);
  });
});

describe("HlProvider allMids: a failed subscribe is retried with a growing delay and stops on unmount (carry T10)", () => {
  it("retries after 1 s, then 2 s; success clears the error", async () => {
    metaAndAssetCtxs.mockResolvedValue([]);
    allMids.mockReset();
    allMids.mockRejectedValueOnce(new Error("ws down")).mockRejectedValueOnce(new Error("ws down")).mockResolvedValue({ unsubscribe: async () => {} });
    render(<HlProvider><Probe /></HlProvider>);
    await flush();
    expect(allMids).toHaveBeenCalledTimes(1);
    expect(screen.getByText("markets=1 error=ws down")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(1_000); });
    await flush();
    expect(allMids).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1_999); });
    expect(allMids).toHaveBeenCalledTimes(2);
    await act(async () => { vi.advanceTimersByTime(1); });
    await flush();
    expect(allMids).toHaveBeenCalledTimes(3);
    expect(screen.getByText("markets=1 error=none")).toBeTruthy();
  });
  it("no retry fires after unmount", async () => {
    metaAndAssetCtxs.mockResolvedValue([]);
    allMids.mockReset();
    allMids.mockRejectedValue(new Error("ws down"));
    const { unmount } = render(<HlProvider><Probe /></HlProvider>);
    await flush();
    unmount();
    await act(async () => { vi.advanceTimersByTime(120_000); });
    expect(allMids).toHaveBeenCalledTimes(1);
  });
});

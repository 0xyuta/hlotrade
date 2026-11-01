// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";

const series = { setData: vi.fn(), update: vi.fn(), applyOptions: vi.fn() };
const fitContent = vi.fn();
vi.mock("lightweight-charts", () => ({
  CandlestickSeries: {},
  createChart: () => ({ addSeries: () => series, timeScale: () => ({ fitContent }), remove: () => {} }),
}));
const candleSnapshot = vi.fn();
let onCandle: ((c: unknown) => void) | null = null;
let onOpen: (() => void) | null = null;
const offSocket = vi.fn();
vi.mock("../src/hl/clients", () => ({
  getHl: () => ({
    info: { candleSnapshot },
    subs: () => ({ candle: async (_p: unknown, cb: (c: unknown) => void) => { onCandle = cb; return { unsubscribe: async () => {} }; } }),
    onSocketOpen: (cb: () => void) => { onOpen = cb; return offSocket; },
  }),
}));
vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet" }) as AppConfig }));
vi.mock("../src/hl/HlProvider", () => ({ useHl: () => ({ market: () => undefined }) }));

import { Chart } from "../src/ui/trade/Chart";

const row = (tSec: number, c: number) => ({ t: tSec * 1000, o: c, h: c, l: c, c });
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  for (const f of [series.setData, series.update, series.applyOptions, fitContent, candleSnapshot, offSocket]) f.mockReset();
  onCandle = null;
  onOpen = null;
});
afterEach(() => cleanup());

describe("Chart: a socket reconnect backfills the missed bars from a fresh snapshot (carry T10)", () => {
  it("re-reads the snapshot on reopen and replaces the series without refitting the user's zoom", async () => {
    candleSnapshot.mockResolvedValueOnce([row(60, 1), row(120, 2)]);
    render(<Chart coin="BTC" />);
    await flush();
    expect(series.setData).toHaveBeenLastCalledWith([expect.objectContaining({ time: 60, close: 1 }), expect.objectContaining({ time: 120, close: 2 })]);
    expect(fitContent).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toBeNull();

    // the socket dropped and came back: the bars at 180 and 240 were missed
    candleSnapshot.mockResolvedValueOnce([row(60, 1), row(120, 2), row(180, 3), row(240, 4), row(240, 4.5)]);
    await act(async () => onOpen!());
    await flush();
    expect(candleSnapshot).toHaveBeenCalledTimes(2);
    const last = series.setData.mock.calls[series.setData.mock.calls.length - 1][0] as { time: number; close: number }[];
    expect(last.map((b) => b.time)).toEqual([60, 120, 180, 240]); // sorted, one bar per time (the last row wins)
    expect(last[3].close).toBe(4.5);
    expect(fitContent).toHaveBeenCalledTimes(1); // the backfill keeps the zoom

    // a live update older than the backfilled data is ignored; the open bar is replaced
    act(() => onCandle!(row(180, 9)));
    expect(series.update).not.toHaveBeenCalled();
    act(() => onCandle!(row(240, 5)));
    expect(series.update).toHaveBeenCalledWith(expect.objectContaining({ time: 240, close: 5 }));
  });
  it("a failed backfill is swallowed and the chart keeps its bars", async () => {
    candleSnapshot.mockResolvedValueOnce([row(60, 1)]);
    render(<Chart coin="BTC" />);
    await flush();
    const calls = series.setData.mock.calls.length;
    candleSnapshot.mockRejectedValueOnce(new Error("down"));
    await act(async () => onOpen!());
    await flush();
    expect(series.setData.mock.calls.length).toBe(calls);
  });
  it("unmounting removes the reopen listener", async () => {
    candleSnapshot.mockResolvedValueOnce([row(60, 1)]);
    const { unmount } = render(<Chart coin="BTC" />);
    await flush();
    unmount();
    expect(offSocket).toHaveBeenCalledTimes(1);
  });
});

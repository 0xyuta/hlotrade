// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreChain } from "../src/rewards/chain";
import type { CheckpointFile, LatestFile } from "../src/rewards/files";

const ME = "0x517b22f40b1b9bebf1776fa9d732e2c27fdeb590";
const { loadCheckpoint, checkSigned } = vi.hoisted(() => ({ loadCheckpoint: vi.fn(), checkSigned: vi.fn() }));
vi.mock("../src/config/context", () => ({ useConfig: () => ({ hyperEvmChainId: 998, contracts: { checkpoints: "0x00000000000000000000000000000000000000c1" } }) }));
vi.mock("../src/config/load", () => ({ rewardsBase: "https://files.example/998/" }));
vi.mock("../src/rewards/files", async (orig) => ({ ...(await orig<typeof import("../src/rewards/files")>()), loadCheckpoint }));
vi.mock("../src/rewards/model", async (orig) => ({ ...(await orig<typeof import("../src/rewards/model")>()), checkSigned }));

import { clearMinuteTables, useMinuteTables } from "../src/rewards/useMinuteTables";

const chain = (now = 1000) => ({ now }) as CoreChain;
const file = (m: number, fee = 5n): CheckpointFile => ({ throughMinute: m, table: `minute,user,fee\n${m},${ME},${fee}` }) as CheckpointFile;

beforeEach(() => {
  clearMinuteTables();
  loadCheckpoint.mockReset();
  checkSigned.mockReset();
  checkSigned.mockResolvedValue({ ok: true });
});
afterEach(cleanup);

describe("useMinuteTables", () => {
  it("reads each wanted minute's table", async () => {
    loadCheckpoint.mockImplementation(async (_b: string, m: number) => file(m));
    const { result } = renderHook(() => useMinuteTables([3, 2], chain(), null));
    await waitFor(() => expect(result.current.tables.size).toBe(2));
    expect(result.current.tables.get(3)).toEqual(new Map([[ME, 5n]]));
    expect(result.current.failed.size).toBe(0);
  });
  it("a minute older than the chain's newest reads as updating: its signature passed, so it is kept", async () => {
    loadCheckpoint.mockImplementation(async (_b: string, m: number) => file(m));
    checkSigned.mockResolvedValue({ ok: false, reason: "Rewards are updating…" });
    const { result } = renderHook(() => useMinuteTables([3], chain(), null));
    await waitFor(() => expect(result.current.tables.has(3)).toBe(true));
  });
  it.each([
    ["missing", async () => null],
    ["for another minute", async () => file(9)],
    ["unreadable", async () => { throw new Error("HTTP 500"); }],
    ["with a bad table", async () => ({ ...file(3), table: "nope" })],
  ])("a file that is %s is failed, not an empty minute", async (_n, impl) => {
    loadCheckpoint.mockImplementation(impl);
    const { result } = renderHook(() => useMinuteTables([3], chain(), null));
    await waitFor(() => expect(result.current.failed.has(3)).toBe(true));
    expect(result.current.tables.has(3)).toBe(false);
  });
  it("a file not signed by the rewards poster is failed", async () => {
    loadCheckpoint.mockImplementation(async (_b: string, m: number) => file(m));
    checkSigned.mockResolvedValue({ ok: false, reason: "The reward file was not signed by the rewards poster, so it was ignored." });
    const { result } = renderHook(() => useMinuteTables([3], chain(), null));
    await waitFor(() => expect(result.current.failed.has(3)).toBe(true));
  });
  it("a failed minute is asked for again on the next poll; a read one never is", async () => {
    loadCheckpoint.mockImplementation(async (_b: string, m: number) => (m === 3 ? null : file(m)));
    const { result, rerender } = renderHook(({ c }) => useMinuteTables([3, 2], c, null), { initialProps: { c: chain(1000) } });
    await waitFor(() => expect(result.current.failed.has(3)).toBe(true));
    loadCheckpoint.mockClear();
    loadCheckpoint.mockImplementation(async (_b: string, m: number) => file(m));
    rerender({ c: chain(1030) });
    await waitFor(() => expect(result.current.tables.has(3)).toBe(true));
    expect(loadCheckpoint.mock.calls.map((c) => c[1])).toEqual([3]);
    expect(result.current.failed.size).toBe(0);
  });
  it("the newest minute comes from latest.json, with no fetch", async () => {
    const latest = { throughMinute: 7, table: `minute,user,fee\n7,${ME},9` } as LatestFile;
    const { result } = renderHook(() => useMinuteTables([7], chain(), latest));
    await waitFor(() => expect(result.current.tables.get(7)).toEqual(new Map([[ME, 9n]])));
    expect(loadCheckpoint).not.toHaveBeenCalled();
  });
  it("reads at most six at a time", async () => {
    let running = 0;
    let peak = 0;
    loadCheckpoint.mockImplementation(async (_b: string, m: number) => {
      peak = Math.max(peak, ++running);
      await new Promise((r) => setTimeout(r, 1));
      running--;
      return file(m);
    });
    const minutes = Array.from({ length: 20 }, (_, i) => i);
    const { result } = renderHook(() => useMinuteTables(minutes, chain(), null));
    await waitFor(() => expect(result.current.tables.size).toBe(20));
    expect(peak).toBe(6);
  });
  it("nothing wanted, nothing read", () => {
    renderHook(() => useMinuteTables([], chain(), null));
    expect(loadCheckpoint).not.toHaveBeenCalled();
  });
});

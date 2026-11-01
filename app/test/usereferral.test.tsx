// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address } from "../src/config/validate";
import type { ReferralView } from "../src/hl/referral";

const readReferral = vi.fn();
vi.mock("../src/hl/referralActions", () => ({ readReferral: (...a: unknown[]) => readReferral(...a) }));

import { useReferral } from "../src/ui/referrals/useReferral";

const A = "0x00000000000000000000000000000000000000aa" as Address;
const B = "0x00000000000000000000000000000000000000bb" as Address;
const view = (code: string): ReferralView => ({ referredBy: { referrer: B, code }, cumVlm: 0, unclaimed: 0, claimed: 0, referrer: { stage: "needToCreateCode" } });

beforeEach(() => {
  readReferral.mockReset(); // in braces: a function returned from beforeEach runs as its teardown
});

describe("useReferral", () => {
  it("reads when mounted and on reload", async () => {
    readReferral.mockResolvedValue(view("A1"));
    const { result } = renderHook(() => useReferral("testnet", A));
    expect(result.current.state).toEqual({ kind: "loading" });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", view: view("A1") }));
    expect(readReferral).toHaveBeenCalledWith("testnet", A);
    readReferral.mockResolvedValue(view("B2"));
    act(() => result.current.reload());
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", view: view("B2") }));
  });
  it("a failed read is 'down' with plain words", async () => {
    readReferral.mockRejectedValue(new Error("Hyperliquid info: HTTP 500"));
    const { result } = renderHook(() => useReferral("testnet", A));
    await waitFor(() => expect(result.current.state).toEqual({ kind: "down", error: "Hyperliquid info: HTTP 500" }));
  });
  it("another account never sees the previous account's answer", async () => {
    let release: (v: unknown) => void = () => {};
    readReferral.mockImplementationOnce(() => new Promise((r) => { release = r; })).mockResolvedValueOnce(view("B2"));
    const { result, rerender } = renderHook(({ u }: { u: Address }) => useReferral("testnet", u), { initialProps: { u: A } });
    rerender({ u: B });
    await waitFor(() => expect(result.current.state).toEqual({ kind: "ready", view: view("B2") }));
    await act(async () => release(view("A1")));
    expect(result.current.state).toEqual({ kind: "ready", view: view("B2") });
  });
  it("without an account it reads nothing", () => {
    const { result } = renderHook(() => useReferral("testnet", null));
    expect(result.current.state).toEqual({ kind: "loading" });
    expect(readReferral).not.toHaveBeenCalled();
  });
});

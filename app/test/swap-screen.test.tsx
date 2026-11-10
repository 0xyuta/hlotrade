// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { COIN_ICONS_ORIGIN } from "../src/config/csp";
import { SWAP_CONNECT, SWAP_MAINNET_ONLY, SWAP_PAIR, SWAP_QUOTE_CHANGED } from "../src/swap/copy";
import { amountOutMin, fmtAmount, quoteExactIn } from "../src/swap/quote";
import { V2_ROUTER_999 } from "../src/swap/market";
import { PAIRED_BLOCKED_TEXT } from "../src/wallet/permissions";

const HLO = "0xa4Bb42d6D7F36b6EA0C4A0890691826C9C077005";
const USDC = "0xb88339CB7199b77E23DB6E890353E22632Ba630f";
const PAIR = "0x0Bc15fd6432bc63c89E2c6623fbCB9a86bA427db";
const USER = "0x00000000000000000000000000000000000000Ab";
const E18 = 10n ** 18n;

let cfg: AppConfig;
let session: { kind: "none" | "wallet" | "paired"; address?: string };
const write = vi.fn();
const readSwapSnapshot = vi.fn();

vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, write }) }));
vi.mock("../src/evm/clients", () => ({ publicClient: () => ({}) }));
vi.mock("../src/wallet/chains", () => ({ viemChain: () => ({}) }));
vi.mock("../src/swap/read", () => ({ readSwapSnapshot: (...a: unknown[]) => readSwapSnapshot(...a) }));

import { SwapScreen } from "../src/ui/swap/SwapScreen";

const snap = (over: Record<string, bigint | boolean> = {}) => ({
  reserve0: 10_000n * E18,
  reserve1: 7_410_157n,
  hloIsToken0: true,
  blockTime: 1_700_000_000n,
  hloBalance: 5n * E18,
  usdcBalance: 20_000_000n,
  hloAllowance: 0n,
  usdcAllowance: 0n,
  ...over,
});

const quotedBuy = quoteExactIn(1_000_000n, 7_410_157n, 10_000n * E18)!;
const minBuy = amountOutMin(quotedBuy, 50n)!;

beforeEach(() => {
  cfg = { network: "mainnet", hyperEvmChainId: 999, contracts: { token: HLO, pair: PAIR } } as unknown as AppConfig;
  session = { kind: "wallet", address: USER };
  write.mockReset().mockResolvedValue("0xhash");
  readSwapSnapshot.mockReset().mockResolvedValue({ ok: true, snap: snap() });
});
afterEach(cleanup);

async function typePay(value: string) {
  fireEvent.change(await screen.findByLabelText("You pay"), { target: { value } });
}

/** The direction toggle uses the same words as the submit button, so the action is the form's submit. */
function submitButton(): HTMLButtonElement {
  const b = document.querySelector("button[type=submit]");
  if (!b) throw new Error("no submit");
  return b as HTMLButtonElement;
}

describe("SwapScreen", () => {
  it("on testnet says swaps are on mainnet and reads nothing", async () => {
    cfg = { network: "testnet", hyperEvmChainId: 998, contracts: { token: HLO, pair: PAIR } } as unknown as AppConfig;
    render(<SwapScreen />);
    expect(screen.getByText(SWAP_MAINNET_ONLY)).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(readSwapSnapshot).not.toHaveBeenCalled();
  });

  it("quotes a buy from the pair, shows wallet balances, and does not show the pool's reserves", async () => {
    render(<SwapScreen />);
    await typePay("1");
    expect(screen.getByText(fmtAmount(quotedBuy, 18))).toBeTruthy();
    expect(screen.getByText(`Minimum received ${fmtAmount(minBuy, 18)} HLO`)).toBeTruthy();
    expect(screen.getByText("Balance 20")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve and buy" })).toBeTruthy();
    expect(document.querySelectorAll(`img[src="${COIN_ICONS_ORIGIN}/coins/USDC.svg"]`).length).toBeGreaterThan(0);
    expect(document.querySelectorAll(".swap-token svg").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("7.410157");
    expect(document.body.textContent).not.toContain("10,000");
  });

  it("approves USDC and swaps with the minimum that was on screen", async () => {
    render(<SwapScreen />);
    await typePay("1");
    fireEvent.click(screen.getByRole("button", { name: "Approve and buy" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[0][1]).toMatchObject({ address: USDC, functionName: "approve", args: [V2_ROUTER_999, 1_000_000n] });
    expect(write.mock.calls[1][1]).toMatchObject({
      address: V2_ROUTER_999,
      functionName: "swapExactTokensForTokens",
      args: [1_000_000n, minBuy, [USDC, HLO], USER, 1_700_001_200n],
    });
    expect(await screen.findByText("Swapped.")).toBeTruthy();
  });

  it("skips the approval when the allowance already covers the amount", async () => {
    readSwapSnapshot.mockResolvedValue({ ok: true, snap: snap({ usdcAllowance: 1_000_000n }) });
    render(<SwapScreen />);
    await typePay("1");
    expect(submitButton().textContent).toBe("Buy HLO");
    fireEvent.click(submitButton());
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect(write.mock.calls[0][1].functionName).toBe("swapExactTokensForTokens");
  });

  it("does not send when a fresh quote falls through the minimum on screen", async () => {
    let current = snap();
    readSwapSnapshot.mockImplementation(async () => ({ ok: true, snap: current }));
    render(<SwapScreen />);
    await typePay("1");
    expect(screen.getByText(fmtAmount(quotedBuy, 18))).toBeTruthy();
    current = snap({ reserve0: 1n, reserve1: 10n ** 24n });
    fireEvent.click(screen.getByRole("button", { name: "Approve and buy" }));
    expect(await screen.findByText(SWAP_QUOTE_CHANGED)).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps the minimum on screen when the fresh quote is better", async () => {
    let current = snap();
    readSwapSnapshot.mockImplementation(async () => ({ ok: true, snap: current }));
    render(<SwapScreen />);
    await typePay("1");
    current = snap({ reserve0: 20_000n * E18 });
    fireEvent.click(screen.getByRole("button", { name: "Approve and buy" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[1][1].args[1]).toBe(minBuy);
  });

  it("swaps HLO back to USDC", async () => {
    render(<SwapScreen />);
    await screen.findByLabelText("You pay");
    fireEvent.click(screen.getByRole("button", { name: "Swap to USDC" }));
    await typePay("1");
    expect(screen.getByText("0.000738")).toBeTruthy();
    expect(screen.getByText("Balance 5")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve and swap" }));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(write.mock.calls[0][1]).toMatchObject({ address: HLO, functionName: "approve", args: [V2_ROUTER_999, E18] });
    expect(write.mock.calls[1][1].args[2]).toEqual([HLO, USDC]);
    expect(write.mock.calls[1][1].args[1]).toBe(amountOutMin(738n, 50n));
  });

  it("refuses more than the balance", async () => {
    render(<SwapScreen />);
    await typePay("100");
    expect(screen.getByText("That is more than your balance.")).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
    expect(submitButton().textContent).toBe("Buy HLO");
    expect(write).not.toHaveBeenCalled();
  });

  it("a paired phone can read the quote but not send", async () => {
    session = { kind: "paired", address: USER };
    render(<SwapScreen />);
    await typePay("1");
    expect(screen.getByText(PAIRED_BLOCKED_TEXT)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("asks a disconnected visitor to connect, and still quotes", async () => {
    session = { kind: "none" };
    render(<SwapScreen />);
    await typePay("1");
    expect(screen.getByText(SWAP_CONNECT)).toBeTruthy();
    expect(screen.getByText(fmtAmount(quotedBuy, 18))).toBeTruthy();
    expect(screen.queryByText(/Balance/)).toBeNull();
    expect(submitButton().disabled).toBe(true);
  });

  it("a pair that is not this market is not offered", async () => {
    readSwapSnapshot.mockResolvedValue({ ok: false, reason: "pair" });
    render(<SwapScreen />);
    expect(await screen.findByText(SWAP_PAIR)).toBeTruthy();
    expect(screen.queryByLabelText("You pay")).toBeNull();
  });

  it("a failed read offers Try again", async () => {
    readSwapSnapshot.mockRejectedValueOnce(new Error("HyperEVM down"));
    render(<SwapScreen />);
    expect(await screen.findByText("HyperEVM down")).toBeTruthy();
    readSwapSnapshot.mockResolvedValue({ ok: true, snap: snap() });
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("You pay")).toBeTruthy();
  });
});

describe("swap copy", () => {
  it("does not use the banned words", () => {
    const banned = /\b(jackpot|lottery|prize|motherlode|ore)\b|\bwin\b/i;
    for (const dir of ["../src/swap", "../src/ui/swap"]) {
      for (const name of readdirSync(join(__dirname, dir))) {
        if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
        const text = readFileSync(join(__dirname, dir, name), "utf8");
        expect(text, name).not.toMatch(banned);
      }
    }
  });
});

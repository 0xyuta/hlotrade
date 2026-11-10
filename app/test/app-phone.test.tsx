// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";

const { pass } = vi.hoisted(() => ({ pass: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/wallet/session", () => ({ SessionProvider: pass }));
vi.mock("../src/hl/HlProvider", () => ({ HlProvider: pass }));
vi.mock("../src/hl/TradingProvider", () => ({ TradingProvider: pass }));
vi.mock("../src/hl/AccountProvider", () => ({ AccountProvider: pass }));
vi.mock("../src/hl/agent", () => ({ browserKV: { getItem: () => null, setItem: () => {} } }));
vi.mock("../src/ui/Footer", () => ({ Footer: () => null }));
vi.mock("../src/ui/TopBar", () => ({ TopBar: () => null }));
vi.mock("../src/ui/trade/TradeScreen", () => ({ TradeScreen: ({ view }: { view: string }) => <p>trade screen: {view}</p> }));
vi.mock("../src/ui/bots/BotsScreen", () => ({ BotsScreen: () => <p>the bots screen</p> }));
vi.mock("../src/ui/rewards/RewardsScreen", () => ({ RewardsScreen: () => <p>the rewards screen</p> }));
vi.mock("../src/ui/swap/SwapScreen", () => ({ SwapScreen: () => <p>the swap screen</p> }));
vi.mock("../src/ui/tokenomics/TokenomicsScreen", () => ({ TokenomicsScreen: () => <p>the tokenomics</p> }));

import { App } from "../src/App";

let listeners: (() => void)[] = [];
function setWidth(narrow: boolean) {
  window.matchMedia = ((q: string) => ({
    media: q,
    matches: narrow,
    addEventListener: (_: string, f: () => void) => listeners.push(f),
    removeEventListener: (_: string, f: () => void) => { listeners = listeners.filter((x) => x !== f); },
  })) as unknown as typeof window.matchMedia;
}
afterEach(() => {
  cleanup();
  listeners = [];
  delete (window as { matchMedia?: unknown }).matchMedia;
});
const config = { network: "testnet" } as AppConfig;

describe("the App on a phone", () => {
  it("opens on Markets with the bottom bar; More leads to Tokenomics and keeps its tab lit", async () => {
    setWidth(true);
    render(<App config={config} />);
    expect(screen.getByText("trade screen: markets")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Positions" }));
    expect(screen.getByText("trade screen: positions")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    fireEvent.click(screen.getByRole("button", { name: /Tokenomics/ }));
    expect(await screen.findByText("the tokenomics")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-current")).toBe("page");
  });
  it("the public link /swap opens Rewards with the swap card; closing the card leaves Rewards", async () => {
    window.history.pushState(null, "", "/swap");
    setWidth(true);
    render(<App config={config} />);
    expect(await screen.findByRole("dialog", { name: "Swap" })).toBeTruthy();
    expect(screen.getByText("the swap screen")).toBeTruthy();
    expect(await screen.findByText("the rewards screen")).toBeTruthy();
    expect(window.location.pathname).toBe("/swap");
    expect(screen.getByRole("button", { name: "Rewards" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Swap" })).toBeNull();
    expect(screen.getByText("the rewards screen")).toBeTruthy();
    window.history.pushState(null, "", "/");
  });
  it("the public link /bots opens the Bots tab; the address bar stays", async () => {
    window.history.pushState(null, "", "/bots");
    setWidth(true);
    render(<App config={config} />);
    expect(await screen.findByText("the bots screen")).toBeTruthy();
    expect(window.location.pathname).toBe("/bots");
    window.history.pushState(null, "", "/");
  });
  it("a phone screen left open shows as Trade when the window widens, with no bottom bar", () => {
    setWidth(true);
    render(<App config={config} />);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    setWidth(false);
    act(() => listeners.forEach((f) => f()));
    expect(screen.getByText("trade screen: trade")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });
  it("a wide screen opens on Trade", () => {
    setWidth(false);
    render(<App config={config} />);
    expect(screen.getByText("trade screen: trade")).toBeTruthy();
  });
});

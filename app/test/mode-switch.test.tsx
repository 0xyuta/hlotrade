// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";

const { pass, narrow } = vi.hoisted(() => ({ pass: ({ children }: { children: ReactNode }) => children, narrow: { value: false } }));
vi.mock("../src/wallet/session", () => ({ SessionProvider: pass }));
vi.mock("../src/hl/HlProvider", () => ({ HlProvider: pass }));
vi.mock("../src/hl/TradingProvider", () => ({ TradingProvider: pass }));
vi.mock("../src/hl/AccountProvider", () => ({ AccountProvider: pass }));
vi.mock("../src/ui/Footer", () => ({ Footer: () => null }));
vi.mock("../src/ui/useNarrow", () => ({ useNarrow: () => narrow.value }));
vi.mock("../src/ui/trade/TradeScreen", () => ({ TradeScreen: () => <p>the trade screen</p> }));
vi.mock("../src/ui/mine/MineScreen", () => ({ MineScreen: () => <p>the mine screen</p> }));
vi.mock("../src/ui/BottomNav", () => ({ BottomNav: () => <nav>the bottom bar</nav> }));
vi.mock("../src/ui/TopBar", () => ({
  TopBar: ({ mode, onMode }: { mode: string; onMode(m: string): void }) => <button onClick={() => onMode(mode === "mine" ? "full" : "mine")}>switch from {mode}</button>,
}));

import { App } from "../src/App";

const config = { network: "testnet" } as AppConfig;

const stubStorage = () => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
};

beforeEach(() => {
  stubStorage();
  narrow.value = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the Trade | Mine switch", () => {
  it("starts on the full app, switches to mine and back, and remembers it", async () => {
    const { unmount } = render(<App config={config} />);
    expect(screen.getByText("the trade screen")).toBeTruthy();
    fireEvent.click(screen.getByText("switch from full"));
    expect(await screen.findByText("the mine screen")).toBeTruthy();
    expect(screen.queryByText("the trade screen")).toBeNull();
    expect(localStorage.getItem("hlo:mode")).toBe("mine");
    unmount();
    render(<App config={config} />);
    expect(await screen.findByText("the mine screen")).toBeTruthy();
    fireEvent.click(screen.getByText("switch from mine"));
    expect(await screen.findByText("the trade screen")).toBeTruthy();
    expect(localStorage.getItem("hlo:mode")).toBe("full");
  });

  it("has no bottom bar on a phone in mine mode", async () => {
    narrow.value = true;
    render(<App config={config} />);
    expect(screen.getByText("the bottom bar")).toBeTruthy();
    fireEvent.click(screen.getByText("switch from full"));
    expect(await screen.findByText("the mine screen")).toBeTruthy();
    expect(screen.queryByText("the bottom bar")).toBeNull();
  });

  it("the public /bots link opens the full app even after mine was chosen", () => {
    localStorage.setItem("hlo:mode", "mine");
    vi.stubGlobal("location", { ...window.location, pathname: "/bots", search: "" });
    render(<App config={config} />);
    expect(screen.getByText("switch from full")).toBeTruthy();
  });
});

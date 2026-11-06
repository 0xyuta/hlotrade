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
vi.mock("../src/ui/trade/TradeScreen", () => ({
  TradeScreen: ({ view, linkCoin }: { view: string; linkCoin: string | null }) => (
    <>
      <p>the trade screen</p>
      <p>view {view}, link coin {linkCoin ?? "none"}</p>
    </>
  ),
}));
vi.mock("../src/ui/BottomNav", () => ({ BottomNav: () => <nav>the bottom bar</nav> }));
vi.mock("../src/ui/intro/IntroModal", () => ({ IntroModal: ({ onClose }: { onClose(): void }) => <button onClick={onClose}>the intro</button> }));
vi.mock("../src/ui/TopBar", () => ({ TopBar: () => <header>the top bar</header> }));

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

describe("a ?coin= link (the chart site's Trade on HLO button)", () => {
  const at = (search: string) => vi.stubGlobal("location", { ...window.location, pathname: "/", search });
  it("opens Trade on that market, on a phone too rather than Markets", () => {
    narrow.value = true;
    at("?coin=HYPE");
    render(<App config={config} />);
    expect(screen.getByText("view trade, link coin HYPE")).toBeTruthy();
  });
  it("is ignored when it is not a plain market name", () => {
    narrow.value = true;
    at("?coin=xyz:TSLA");
    render(<App config={config} />);
    expect(screen.getByText("view markets, link coin none")).toBeTruthy();
  });
});

describe("Mine mode is gone", () => {
  it("a browser that had chosen Mine before opens the full app with its bottom bar", () => {
    localStorage.setItem("hlo:mode", "mine");
    narrow.value = true;
    render(<App config={config} />);
    expect(screen.getByText("the trade screen")).toBeTruthy();
    expect(screen.getByText("the bottom bar")).toBeTruthy();
  });
});

describe("the first-visit intro", () => {
  const mainnet = { network: "mainnet" } as AppConfig;
  it("shows on a first mainnet visit; closing it is kept, so it never shows again", async () => {
    const { unmount } = render(<App config={mainnet} />);
    fireEvent.click(await screen.findByText("the intro"));
    expect(screen.queryByText("the intro")).toBeNull();
    expect(localStorage.getItem("hlo:intro")).toBe("seen");
    unmount();
    render(<App config={mainnet} />);
    expect(screen.getByText("the trade screen")).toBeTruthy();
    expect(screen.queryByText("the intro")).toBeNull();
  });
  it("not on testnet", async () => {
    render(<App config={config} />);
    await new Promise((r) => setTimeout(r, 50)); // time for a lazy intro to have loaded, had it been asked for
    expect(screen.queryByText("the intro")).toBeNull();
    expect(localStorage.getItem("hlo:intro")).toBeNull();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";

const { pass } = vi.hoisted(() => ({ pass: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/wallet/session", () => ({ SessionProvider: pass }));
vi.mock("../src/hl/HlProvider", () => ({ HlProvider: pass }));
vi.mock("../src/hl/TradingProvider", () => ({ TradingProvider: pass }));
vi.mock("../src/hl/AccountProvider", () => ({ AccountProvider: pass }));
vi.mock("../src/ui/Footer", () => ({ Footer: () => null }));
vi.mock("../src/ui/TopBar", () => ({ TopBar: () => null }));
vi.mock("../src/ui/trade/TradeScreen", () => ({ TradeScreen: () => <p>the trade screen</p> }));

import { App } from "../src/App";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("a ?ref= link (spec referrals §3)", () => {
  it("keeps a valid code for this network and leaves the address bar as it was", async () => {
    window.history.replaceState(null, "", "/?ref=FRIEND1&utm_source=x");
    render(<App config={{ network: "testnet" } as AppConfig} />);
    expect(await screen.findByText("the trade screen")).toBeTruthy();
    expect(store.get("hlo.ref.testnet")).toBe("FRIEND1");
    expect(window.location.search).toBe("?ref=FRIEND1&utm_source=x");
  });
  it("ignores an invalid code", async () => {
    window.history.replaceState(null, "", "/?ref=not-valid");
    render(<App config={{ network: "testnet" } as AppConfig} />);
    await screen.findByText("the trade screen");
    expect(store.has("hlo.ref.testnet")).toBe(false);
  });
});

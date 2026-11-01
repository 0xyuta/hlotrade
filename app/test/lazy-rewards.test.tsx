// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";

const { pass } = vi.hoisted(() => ({ pass: ({ children }: { children: ReactNode }) => children }));
vi.mock("../src/wallet/session", () => ({ SessionProvider: pass }));
vi.mock("../src/hl/HlProvider", () => ({ HlProvider: pass }));
vi.mock("../src/hl/TradingProvider", () => ({ TradingProvider: pass }));
vi.mock("../src/hl/AccountProvider", () => ({ AccountProvider: pass }));
vi.mock("../src/ui/Footer", () => ({ Footer: () => null }));
vi.mock("../src/ui/trade/TradeScreen", () => ({ TradeScreen: () => <p>the trade screen</p> }));
vi.mock("../src/ui/TopBar", () => ({
  TopBar: ({ onTab }: { onTab(t: "trade" | "rewards"): void }) => (
    <nav>
      <button onClick={() => onTab("trade")}>Trade</button>
      <button onClick={() => onTab("rewards")}>Rewards</button>
    </nav>
  ),
}));
// The Rewards chunk: the first load fails (after a redeploy the old hashed file is gone), the second works.
let loads = 0;
vi.mock("../src/ui/rewards/RewardsScreen", () => {
  loads++;
  if (loads === 1) throw new Error("Failed to fetch dynamically imported module");
  return { RewardsScreen: () => <p>the rewards screen</p> };
});

import { App } from "../src/App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a Rewards chunk that fails to load (final review M5)", () => {
  it("offers Try again in the screen's place, which loads it afresh without a reload; the top bar stays", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<App config={{ network: "testnet" } as AppConfig} />);
    fireEvent.click(screen.getByText("Rewards"));
    expect(await screen.findByText(/did not load/)).toBeTruthy();
    expect(screen.getByText("Trade")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("the rewards screen")).toBeTruthy();
    expect(loads).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    // the Trade screen's boundary keeps the reload fallback (positions text), not Try again
    fireEvent.click(screen.getByText("Trade"));
    expect(screen.getByText("the trade screen")).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

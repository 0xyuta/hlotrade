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
  TopBar: ({ onTab }: { onTab(t: string): void }) => (
    <nav>
      <button onClick={() => onTab("trade")}>Trade</button>
      <button onClick={() => onTab("tokenomics")}>Tokenomics</button>
      <button onClick={() => onTab("referrals")}>Referrals</button>
    </nav>
  ),
}));
// Each chunk: the first load fails (after a redeploy the old hashed file is gone), the second works.
let referralLoads = 0;
vi.mock("../src/ui/referrals/ReferralsScreen", () => {
  referralLoads++;
  if (referralLoads === 1) throw new Error("Failed to fetch dynamically imported module");
  return { ReferralsScreen: () => <p>the referrals screen</p> };
});
let tokenomicsLoads = 0;
vi.mock("../src/ui/tokenomics/TokenomicsScreen", () => {
  tokenomicsLoads++;
  if (tokenomicsLoads === 1) throw new Error("Failed to fetch dynamically imported module");
  return { TokenomicsScreen: () => <p>the tokenomics screen</p> };
});

import { App } from "../src/App";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("a lazy screen whose chunk fails to load (Plan 10: Referrals and Tokenomics)", () => {
  for (const [tab, text, loads] of [
    ["Referrals", "the referrals screen", () => referralLoads],
    ["Tokenomics", "the tokenomics screen", () => tokenomicsLoads],
  ] as const) {
    it(`${tab} offers Try again in place, which loads it afresh without a reload; the top bar stays`, async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const reload = vi.fn();
      vi.stubGlobal("location", { ...window.location, reload });
      render(<App config={{ network: "testnet" } as AppConfig} />);
      fireEvent.click(screen.getByText(tab));
      expect(await screen.findByText(/did not load/)).toBeTruthy();
      expect(screen.getByText("Trade")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByText(text)).toBeTruthy();
      expect(loads()).toBe(2);
      expect(reload).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    });
  }
});

// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";

let cfg: Partial<AppConfig>;
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));

import { BotsScreen } from "../src/ui/bots/BotsScreen";

const B = "0xe6aa440e01bfeffb8914fd9861c6daf57cc4ee14";
afterEach(cleanup);

describe("BotsScreen", () => {
  it("shows the builder, the steps, the sample and the rules, with the network's API page", () => {
    cfg = { network: "testnet", builder: B as AppConfig["builder"] };
    const { container } = render(<BotsScreen />);
    expect(screen.getByText(B)).toBeTruthy();
    expect(screen.getByText(`builder: { b: "${B}", f: 100 }`)).toBeTruthy();
    for (const h of ["Register your wallet", "Make an API wallet", "Send orders with the builder field", "Check it counted"]) expect(screen.getByText(h)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Hyperliquid's API page" }).getAttribute("href")).toBe("https://app.hyperliquid-testnet.xyz/API");
    expect(screen.getByRole("link", { name: "Download hlo-bot.mjs" }).getAttribute("href")).toBe("/bots/hlo-bot.mjs");
    expect(screen.getByText(/ban wash trading/)).toBeTruthy();
    expect(container.textContent).not.toMatch(/jackpot|lottery|prize|motherlode|\bwin\b/i);
  });
  it("mainnet links to mainnet's API page", () => {
    cfg = { network: "mainnet", builder: B as AppConfig["builder"] };
    render(<BotsScreen />);
    expect(screen.getByRole("link", { name: "Hyperliquid's API page" }).getAttribute("href")).toBe("https://app.hyperliquid.xyz/API");
  });
  it("with no builder on the network it says bots open later, and shows no instructions", () => {
    cfg = { network: "mainnet", builder: null };
    render(<BotsScreen />);
    expect(screen.getByText(/Bots open once HLO is live/)).toBeTruthy();
    expect(screen.queryByText("Set up")).toBeNull();
  });
});

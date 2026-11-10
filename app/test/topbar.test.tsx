// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const cfg = vi.hoisted(() => ({
  current: { network: "testnet", hyperEvmChainId: 998, contracts: null as { token: string; pair: string } | null },
}));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg.current }));
vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session: { kind: "none" } }) }));
vi.mock("../src/ui/WalletButton", () => ({ WalletButton: () => null }));

import { TopBar } from "../src/ui/TopBar";

afterEach(() => {
  cleanup();
  cfg.current = { network: "testnet", hyperEvmChainId: 998, contracts: null };
});

describe("the top bar stays one row wherever it has tabs", () => {
  const css = readFileSync(join(__dirname, "../src/styles.css"), "utf8");
  it("does not wrap above the phone width, and the tabs can scroll rather than push the actions down", () => {
    const wide = /@media \(min-width: 861px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(wide).toMatch(/\.topbar \{ flex-wrap: nowrap; \}/);
    expect(wide).toMatch(/\.nav \{ min-width: 0; overflow-x: auto;/);
    expect(wide).toMatch(/\.topbar-actions \{ flex-wrap: nowrap; \}/);
  });
  it("Deposit and Withdraw leave the bar only where the account menu still offers them", () => {
    expect(css).toMatch(/@media \(max-width: 1100px\) \{ \.hide-narrow \{/);
    expect(readFileSync(join(__dirname, "../src/ui/AccountMenu.tsx"), "utf8")).toMatch(/onTransfer\("deposit"\)/);
  });
});

describe("no Trade | Mine switch", () => {
  it("is gone from the top bar; the tabs always show on a wide screen", () => {
    render(<TopBar tab="trade" onTab={() => {}} />);
    expect(screen.queryByRole("group", { name: "App mode" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Mine" })).toBeNull();
    expect(screen.getByRole("navigation")).toBeTruthy();
  });
});

describe("TopBar tabs", () => {
  it("lists the tabs in order, marks the open one and switches on click", () => {
    const onTab = vi.fn();
    render(<TopBar tab="referrals" onTab={onTab} />);
    const nav = screen.getByRole("navigation");
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Trade", "Rewards", "Explore", "Bots", "Tokenomics", "Referrals"]);
    expect(screen.getByText("Referrals").className).toContain("on");
    expect(within(nav).getByText("Trade").className).not.toContain("on");
    fireEvent.click(screen.getByText("Rewards"));
    expect(onTab).toHaveBeenCalledWith("rewards");
    fireEvent.click(screen.getByText("Tokenomics"));
    expect(onTab).toHaveBeenCalledWith("tokenomics");
    expect(screen.queryByRole("button", { name: "Buy HLO" })).toBeNull();
  });
  it("on mainnet, Buy HLO stays off the tab list and opens the swap card", () => {
    cfg.current = {
      network: "mainnet",
      hyperEvmChainId: 999,
      contracts: { token: "0xa4Bb42d6D7F36b6EA0C4A0890691826C9C077005", pair: "0x0Bc15fd6432bc63c89E2c6623fbCB9a86bA427db" },
    };
    const onTab = vi.fn();
    const seen = vi.fn();
    window.addEventListener("hlo-buy-hlo", seen);
    render(<TopBar tab="trade" onTab={onTab} />);
    const nav = screen.getByRole("navigation");
    expect([...nav.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Trade", "Rewards", "Explore", "Bots", "Tokenomics", "Referrals"]);
    const buy = screen.getByRole("button", { name: "Buy HLO" });
    expect(buy.querySelector("svg")).toBeTruthy();
    fireEvent.click(buy);
    expect(onTab).not.toHaveBeenCalled();
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener("hlo-buy-hlo", seen);
  });
  it("nothing on the bar traps the transfer dialogs: a filter or transform would make their position: fixed relative to the bar and cut them off", () => {
    const css = readFileSync(join(__dirname, "../src/styles.css"), "utf8");
    const rules = [...css.matchAll(/(^|\n)\s*\.topbar\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(rules.length).toBeGreaterThan(0);
    for (const r of rules) expect(r).not.toMatch(/backdrop-filter|filter:|transform|perspective|contain:|will-change/);
  });
  it("the phone's bottom bar stays under the top bar, whose dialogs must cover it", () => {
    const css = readFileSync(join(__dirname, "../src/styles.css"), "utf8");
    const z = (sel: string) => Number(css.match(new RegExp(`\\.${sel} \\{[^}]*z-index: (\\d+)`))?.[1]);
    expect(z("bottom-nav")).toBeLessThan(z("topbar"));
  });
});

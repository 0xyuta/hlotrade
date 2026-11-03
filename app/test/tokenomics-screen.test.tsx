// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { tokenomicsFlows, tokenomicsSections } from "../src/rewards/tokenomics";
import type { RewardsState } from "../src/rewards/useRewards";

let state: RewardsState;
let cfg: AppConfig;
const useRewards = vi.fn();
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/rewards/useRewards", () => ({
  useRewards: (...a: unknown[]) => {
    useRewards(...a);
    return { state, reload: vi.fn(), hold: vi.fn() };
  },
}));

import { TokenomicsScreen } from "../src/ui/tokenomics/TokenomicsScreen";

const E18 = 10n ** 18n;
beforeEach(() => {
  cfg = { network: "mainnet", hyperEvmChainId: 999 } as unknown as AppConfig;
  state = { kind: "off" };
  useRewards.mockReset();
});
afterEach(cleanup);

describe("TokenomicsScreen", () => {
  it("states every rule with this network's odds, from the shared texts, and reads without an account", () => {
    render(<TokenomicsScreen />);
    for (const s of tokenomicsSections(1250)) {
      expect(screen.getByText(s.title)).toBeTruthy();
      for (const l of s.lines) expect(screen.getByText(l)).toBeTruthy();
    }
    expect(screen.getByText("Each minute it has a 1 in 1,250 chance to pop (about once every 21 hours).")).toBeTruthy();
    expect(useRewards).toHaveBeenCalledWith(null);
  });
  it("testnet: 1 in 60", () => {
    cfg = { network: "testnet", hyperEvmChainId: 998 } as unknown as AppConfig;
    render(<TokenomicsScreen />);
    expect(screen.getByText("Each minute it has a 1 in 60 chance to pop (about once an hour).")).toBeTruthy();
  });
  it("draws both flows", () => {
    render(<TokenomicsScreen />);
    for (const f of tokenomicsFlows()) {
      expect(screen.getByRole("group", { name: f.label })).toBeTruthy();
      for (const s of f.steps) expect(screen.getByText(s)).toBeTruthy();
    }
  });
  it("live figures from the rewards reads", () => {
    state = {
      kind: "ready",
      data: {
        full: { protocol: { totalBurned: 1234n * E18 + E18 / 2n, totalBought: 2000n * E18 }, staking: { totalStaked: 300n * E18 } },
        latest: { vault: { amount: (50n * E18).toString() } },
      },
    } as never;
    render(<TokenomicsScreen />);
    for (const v of ["1,234.50 HLO", "2,000.00 HLO", "300.00 HLO", "50.00 HLO"]) expect(screen.getByText(v)).toBeTruthy();
  });
  it("a failed Staking/Buyback read or a refused rewards file: a muted note, not silent dashes", () => {
    state = {
      kind: "ready",
      data: { full: null, extraError: "HTTP 500", latest: null, latestProblem: "The poster's signature does not match." },
    } as never;
    render(<TokenomicsScreen />);
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.getByText("Not available right now: HTTP 500")).toBeTruthy();
    expect(screen.getByText("The poster's signature does not match.")).toBeTruthy();
  });
  it("not deployed: dashes and a note", () => {
    render(<TokenomicsScreen />);
    expect(screen.getAllByText("—")).toHaveLength(4);
    expect(screen.getByText(/not deployed on this network yet/)).toBeTruthy();
    expect(screen.queryByText("HLO token contract")).toBeNull();
  });
  it("shows the token contract at the top, copies it, and links to HyperEVMScan", async () => {
    const token = "0xa4Bb42d6D7F36b6EA0C4A0890691826C9C077005";
    cfg = { network: "mainnet", hyperEvmChainId: 999, contracts: { token } } as unknown as AppConfig;
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<TokenomicsScreen />);
    expect(screen.getByText("HLO token contract")).toBeTruthy();
    expect(screen.getByText(token)).toBeTruthy();
    expect(screen.getByRole("link", { name: "HyperEVMScan" }).getAttribute("href")).toBe(`https://hyperevmscan.io/token/${token}`);
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(token);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeTruthy();
  });
});

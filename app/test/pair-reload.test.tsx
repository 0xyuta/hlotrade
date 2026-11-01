// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { pairQrText } from "../src/hl/pairCode";
import type { ScannerProps } from "../src/ui/pair/Scanner";

// The heavy screens are out of scope here: this checks what a reload after pairing shows.
vi.mock("../src/ui/trade/TradeScreen", () => ({ TradeScreen: () => <div>trade screen</div> }));
vi.mock("../src/ui/rewards/RewardsScreen", () => ({ RewardsScreen: () => <div>rewards screen</div> }));
vi.mock("../src/hl/HlProvider", () => ({ HlProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../src/hl/AccountProvider", () => ({ AccountProvider: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../src/hl/enable", async (orig) => ({ ...(await orig<typeof import("../src/hl/enable")>()), readTradingStatus: vi.fn(async () => ({ builderOk: true, maxBuilderFee: 100, agentOk: true, agentValidUntil: null })) }));
const MASTER = "0x00000000000000000000000000000000000000aa";
vi.mock("../src/hl/role", () => ({ fetchAgentMaster: async () => MASTER }));

import { App } from "../src/App";
import { cancelPairing, confirmPairing } from "../src/hl/pairing";
import { PairPage } from "../src/ui/pair/PairPage";

const config: AppConfig = {
  network: "testnet", hyperEvmChainId: 998, hyperEvmRpc: "http://x", arbitrumRpc: "http://x", ethereumRpc: "http://x",
  withdrawEnabled: true, solanaEnabled: false, solanaRpc: null, rewardsBase: null, builder: "0x2222222222222222222222222222222222222222", contracts: null, deployBlock: null, referralCode: null,
};
const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const Fake = ({ onText }: ScannerProps) => <button onClick={() => onText(pairQrText("testnet", `0x${"cd".repeat(32)}`))}>fake scan</button>;
beforeEach(() => {
  store.clear();
  cancelPairing();
  vi.stubGlobal("localStorage", fake);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("reloading after pairing", () => {
  it("the pair page asks; after confirming, the app at / opens the paired trade view", async () => {
    const { unmount } = render(<PairPage net="testnet" legacyLink={false} Scanner={Fake} />);
    fireEvent.click(screen.getByText("Scan the code"));
    fireEvent.click(screen.getByText("fake scan"));
    fireEvent.click(await screen.findByText("Pair this phone"));
    expect(screen.getByText(/can now trade for/)).toBeTruthy();
    unmount();

    render(<App config={config} />);
    expect(screen.getByText("trade screen")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Account"));
    await waitFor(() => expect(screen.getByText(/paired phone/)).toBeTruthy());
    expect(screen.getByText("Unpair this phone")).toBeTruthy();
    expect(confirmPairing()).toBeNull();
  });
});

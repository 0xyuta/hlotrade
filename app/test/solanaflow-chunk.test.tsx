// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { resetTransferState } from "../src/routes/unconfirmed";

const USER = "0x00000000000000000000000000000000000000aa";
let cfg: AppConfig;
let loads = 0;
const mem = new Map<string, string>();
const fake = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session: { kind: "wallet", address: USER }, write: vi.fn(), hlWallet: () => ({ id: "hl" }) }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => ({ balances: { trade: 100, perps: 100, spot: 0 }, abstraction: "disabled", refresh: vi.fn() }) }));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/routes/useBalances", () => ({ useBalances: () => ({ balances: null, reload: vi.fn() }), readUsdc: vi.fn() }));
// The Solana form's chunk: the first load fails (a redeploy removed it, or the network dropped), the second works.
vi.mock("../src/ui/transfer/SolanaFlow", () => {
  loads++;
  if (loads === 1) throw new Error("Failed to fetch dynamically imported module");
  return { SolanaFlow: () => <p>the Solana form</p> };
});

import { TransferModal } from "../src/ui/transfer/TransferModal";

beforeEach(() => {
  mem.clear();
  resetTransferState();
  vi.stubGlobal("localStorage", fake);
  cfg = { network: "testnet", withdrawEnabled: true, solanaEnabled: true, solanaRpc: "https://api.devnet.solana.com" } as AppConfig;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a Solana form chunk that fails to load (Plan 4 C)", () => {
  it("leaves the modal on screen with a Try again that loads it afresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<TransferModal dir="deposit" onClose={() => {}} />);
    fireEvent.click(screen.getByText("Solana"));
    expect(await screen.findByText(/did not load/)).toBeTruthy();
    expect(screen.getByText("Deposit USDC")).toBeTruthy(); // the modal itself is still there
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("the Solana form")).toBeTruthy();
    expect(loads).toBe(2);
  });
});

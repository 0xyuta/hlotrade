// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { resetTransferState } from "../src/routes/unconfirmed";

const USER = "0x00000000000000000000000000000000000000aa";
let cfg: AppConfig;
const mem = new Map<string, string>();
const fake = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session: { kind: "wallet", address: USER }, write: vi.fn(), hlWallet: () => ({ id: "hl" }), disconnect: vi.fn() }) }));
vi.mock("../src/hl/AccountProvider", () => ({ useAccount: () => ({ balances: { trade: 100, perps: 100, spot: 0 }, abstraction: "disabled", refresh: vi.fn() }) }));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/routes/useBalances", () => ({ useBalances: () => ({ balances: null, reload: vi.fn() }), readUsdc: vi.fn() }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => ({ master: USER, status: { builderOk: true, agentOk: true, agentValidUntil: null }, error: null, enabling: false, canEnable: true, enable: vi.fn() }) }));
vi.mock("../src/profile/useProfile", () => ({ useProfile: () => ({ available: false, name: "", avatar: 0, reload: vi.fn() }) }));

// The transfer modal's chunk: the first load fails (a redeploy removed the hashed file); the second waits on `gate`,
// so the loading state can be seen, then loads the real modal.
const chunk = vi.hoisted(() => ({ transferLoads: 0, pairLoads: 0, open: () => {}, gate: Promise.resolve() }));
vi.mock("../src/ui/transfer/TransferModal", async (orig) => {
  chunk.transferLoads++;
  if (chunk.transferLoads === 1) throw new Error("Failed to fetch dynamically imported module");
  await chunk.gate;
  return orig();
});
vi.mock("../src/ui/PairModal", () => {
  chunk.pairLoads++;
  if (chunk.pairLoads === 1) throw new Error("Failed to fetch dynamically imported module");
  return { PairModal: () => <p>the pair form</p> };
});

import { TopBar } from "../src/ui/TopBar";

beforeEach(() => {
  mem.clear();
  resetTransferState();
  vi.stubGlobal("localStorage", fake);
  cfg = { network: "testnet", withdrawEnabled: true, solanaEnabled: false, solanaRpc: null, builder: "0x2222222222222222222222222222222222222222" } as unknown as AppConfig;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("lazily loaded dialogs (Task 3 review)", () => {
  it("the transfer modal: a failed chunk stays in a dialog with Try again, shows Loading while it loads again, then the real modal renders; the top bar stays", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(<TopBar tab="trade" onTab={() => {}} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Deposit" })[0]);
    const failed = (await screen.findByText(/did not load/)).closest("[role=dialog]") as HTMLElement;
    expect(failed.getAttribute("aria-label")).toBe("Deposit USDC");
    expect(screen.getByRole("button", { name: "Rewards" })).toBeTruthy(); // the top bar is still there: not the page-wide fallback
    let open!: () => void;
    chunk.gate = new Promise<void>((r) => (open = r));
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    // loading feedback, inside a dialog that can be closed
    const loading = await screen.findByRole("dialog", { name: "Deposit USDC" });
    expect(within(loading).getByRole("status").textContent).toBe("Loading…");
    await act(async () => open());
    expect(await screen.findByText(/Where is the USDC now/)).toBeTruthy(); // the real TransferModal, loaded lazily
    expect(chunk.transferLoads).toBe(2);
    expect(reload).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("the pair modal: a failed chunk stays in a closable dialog with Try again, not the page-wide fallback", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<TopBar tab="trade" onTab={() => {}} />);
    fireEvent.click(screen.getByLabelText("Account"));
    fireEvent.click(screen.getByRole("button", { name: "Pair phone…" }));
    const failed = (await screen.findByText(/did not load/)).closest("[role=dialog]") as HTMLElement;
    expect(failed.getAttribute("aria-label")).toBe("Pair phone");
    fireEvent.click(within(failed).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("the pair form")).toBeTruthy();
    expect(chunk.pairLoads).toBe(2);
  });
});

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { CutOffUnconfirmedError } from "../src/hl/enable";
import { allowed, PAIRED_BLOCKED_TEXT, type GatedAction } from "../src/wallet/permissions";

const A = "0x00000000000000000000000000000000000000aa";
const PROFILES = "0x4444444444444444444444444444444444444444";
let session: { kind: "wallet" | "paired"; address: string };
let trading: Record<string, unknown>;
let profile: { available: boolean; name: string; avatar: number; reload(): void };
const disconnect = vi.fn();
const write = vi.fn();
const readContract = vi.fn();
const enable = vi.fn();
let cfg: AppConfig;

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, disconnect, write, hlWallet: () => ({ id: "w" }) }) }));
const cutOffPhone = vi.fn();
vi.mock("../src/hl/enable", async (orig) => ({ ...(await orig<typeof import("../src/hl/enable")>()), cutOffPhone: (...a: unknown[]) => cutOffPhone(...a) }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => trading }));
vi.mock("../src/profile/useProfile", () => ({ useProfile: () => profile }));
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/evm/clients", () => ({ publicClient: () => ({ readContract }) }));
vi.mock("../src/wallet/chains", () => ({ viemChain: () => ({}) }));
let lateApproval: () => void = () => {};
vi.mock("../src/ui/PairModal", () => ({
  PairModal: ({ onClose, onLateApproval }: { onClose(): void; onLateApproval(): void }) => {
    lateApproval = onLateApproval; // the real modal keeps calling this after it is closed
    return (
      <div role="dialog">
        pair dialog
        <button onClick={onClose}>close pair</button>
      </div>
    );
  },
}));

import { AccountMenu } from "../src/ui/AccountMenu";

const live = { builderOk: true, maxBuilderFee: 100, agentOk: true, agentValidUntil: null };
const BLOCKED = new RegExp(PAIRED_BLOCKED_TEXT.replace(/[.]/g, "\\."));
const store = new Map<string, string>();
const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const openMenu = () => fireEvent.click(screen.getByLabelText("Account"));
const editProfile = () => fireEvent.click(screen.getByText("Change username or picture"));

beforeEach(() => {
  session = { kind: "wallet", address: A };
  trading = { master: A, agent: {}, status: live, error: null, enabling: false, canEnable: true, enable };
  profile = { available: true, name: "alice", avatar: 3, reload: vi.fn() };
  cfg = { network: "testnet", builder: "0x2222222222222222222222222222222222222222", contracts: { profiles: PROFILES } } as unknown as AppConfig;
  disconnect.mockReset();
  write.mockReset().mockResolvedValue("0xhash");
  readContract.mockReset().mockResolvedValue("0x0000000000000000000000000000000000000000");
  enable.mockReset();
  store.clear();
  vi.stubGlobal("localStorage", fake);
  cutOffPhone.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what a paired phone may do", () => {
  it("the permission table: a paired phone only trades; the wallet device does everything", () => {
    const actions: GatedAction[] = ["enable", "pair", "claim", "stake", "transfer", "profile", "protocol"]; // transfer = deposit and withdraw
    for (const a of actions) {
      expect(allowed("paired", a), `paired ${a}`).toBe(false);
      expect(allowed("wallet", a), `wallet ${a}`).toBe(true);
    }
    expect(allowed("paired", "trade")).toBe(true);
    expect(allowed("none", "trade")).toBe(false);
    expect(PAIRED_BLOCKED_TEXT).toMatch(/on the device with your wallet/);
  });
  it("the paired menu says 'paired phone', blocks enable and profile with the wallet-device text, and offers no pair button", () => {
    session = { kind: "paired", address: A };
    trading = { ...trading, canEnable: false };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText(/paired phone/)).toBeTruthy();
    expect(screen.getAllByText(BLOCKED)).toHaveLength(2); // enable trading, profile
    expect(screen.queryByText(/^Enable trading/)).toBeNull();
    expect(screen.queryByText("Pair phone…")).toBeNull();
    expect(screen.queryByLabelText(/Username/)).toBeNull();
    expect(screen.queryByLabelText("Avatar 0")).toBeNull();
    expect(screen.getByText("Unpair this phone")).toBeTruthy();
  });
  it("a paired phone whose key is no longer approved is told to pair again", () => {
    session = { kind: "paired", address: A };
    trading = { ...trading, canEnable: false, status: { ...live, agentOk: false } };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText(/Pair it again from the device with your wallet/)).toBeTruthy();
  });
  it("Unpair calls disconnect", () => {
    session = { kind: "paired", address: A };
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Unpair this phone"));
    expect(disconnect).toHaveBeenCalled();
  });
});

describe("trading on a desktop wallet", () => {
  it("live agent and builder fee: shows enabled and offers no Enable trading button", () => {
    trading = { ...trading, status: { ...live, agentValidUntil: Date.UTC(2027, 3, 1) } };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText(/enabled until/)).toBeTruthy();
    expect(screen.queryByText(/Enable trading/)).toBeNull();
    expect((screen.getByText("Pair phone…") as HTMLButtonElement).disabled).toBe(false);
  });
  it("while the status is being read for a stored key: says checking, with no Enable trading button", () => {
    trading = { ...trading, status: null };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText("checking…")).toBeTruthy();
    expect(screen.queryByText(/Enable trading/)).toBeNull();
  });
  it("a status read that failed still offers Enable trading, with the error", () => {
    trading = { ...trading, status: null, error: "Hyperliquid did not answer." };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText("Enable trading")).toBeTruthy();
    expect(screen.getByText("Hyperliquid did not answer.")).toBeTruthy();
  });
  it("nothing approved yet: 'Enable trading' calls enable, and Pair phone is off", () => {
    trading = { ...trading, agent: null, status: { builderOk: false, maxBuilderFee: 0, agentOk: false, agentValidUntil: null } };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText("not enabled")).toBeTruthy();
    fireEvent.click(screen.getByText("Enable trading"));
    expect(enable).toHaveBeenCalled();
    expect((screen.getByText("Pair phone…") as HTMLButtonElement).disabled).toBe(true);
  });
  it("builder fee approved but no local agent: Pair phone is still available", () => {
    trading = { ...trading, agent: null, status: { ...live, agentOk: false } };
    render(<AccountMenu />);
    openMenu();
    expect((screen.getByText("Pair phone…") as HTMLButtonElement).disabled).toBe(false);
  });
  it("a build without a builder says so and has nothing to enable", () => {
    cfg = { ...cfg, builder: null };
    trading = { ...trading, status: null, canEnable: false };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText("not available on this build")).toBeTruthy();
    expect((screen.getByText("Enable trading") as HTMLButtonElement).disabled).toBe(true);
  });
  it("the pair dialog: a late approval, after the dialog and the menu are closed, reopens the menu with a notice", async () => {
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Pair phone…"));
    expect(await screen.findByText("pair dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" }); // the dialog owns Escape: the menu stays
    expect(screen.getByText("Disconnect")).toBeTruthy();
    fireEvent.click(screen.getByText("close pair"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Disconnect")).toBeNull();
    act(() => lateApproval());
    expect(screen.getByText(/phone that was paired before no longer works/)).toBeTruthy();
    // pairing again clears the warning (carry T9 N1)
    fireEvent.click(screen.getByText("Pair phone…"));
    expect(screen.queryByText(/phone that was paired before no longer works/)).toBeNull();
  });
});

describe("Deposit and Withdraw in the menu (the phone has no room for them in the top bar)", () => {
  it("a wallet session sees both; each closes the menu and calls onTransfer with its direction", () => {
    const onTransfer = vi.fn();
    render(<AccountMenu onTransfer={onTransfer} />);
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Deposit" }));
    expect(onTransfer).toHaveBeenLastCalledWith("deposit");
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull(); // the menu closed
    openMenu();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    expect(onTransfer).toHaveBeenLastCalledWith("withdraw");
    expect(onTransfer).toHaveBeenCalledTimes(2);
  });
  it("a paired phone sees neither, even when onTransfer is passed", () => {
    session = { kind: "paired", address: A };
    render(<AccountMenu onTransfer={vi.fn()} />);
    openMenu();
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Withdraw" })).toBeNull();
  });
  it("without onTransfer the menu offers nothing to open", () => {
    render(<AccountMenu />);
    openMenu();
    expect(screen.queryByRole("button", { name: "Deposit" })).toBeNull();
  });
});

describe("profile", () => {
  it("is not offered when HyperEVM or the contracts are unavailable", () => {
    profile = { ...profile, available: false };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText(/Profiles open when the contracts are deployed/)).toBeTruthy();
    expect(screen.queryByLabelText(/Username/)).toBeNull();
  });
  it("with a username set, the editor is folded away until asked for", () => {
    render(<AccountMenu />);
    openMenu();
    expect(screen.queryByLabelText(/Username/)).toBeNull();
    expect(screen.queryByLabelText("Avatar 0")).toBeNull();
    editProfile();
    expect(screen.getByLabelText(/Username/)).toBeTruthy();
    expect(screen.getByLabelText("Avatar 0")).toBeTruthy();
  });
  it("with no username yet, the editor is open", () => {
    profile = { ...profile, name: "" };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByLabelText(/Username/)).toBeTruthy();
    expect(screen.queryByText("Change username or picture")).toBeNull();
  });
  it("a saved name folds the editor away again", async () => {
    render(<AccountMenu />);
    openMenu();
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "bob" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(screen.queryByLabelText(/Username/)).toBeNull();
  });
  it("a bad name is refused before the wallet is asked", async () => {
    render(<AccountMenu />);
    openMenu();
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "ab" } });
    fireEvent.click(screen.getByText("Save"));
    expect(screen.getByText("Use 3 to 16 characters.")).toBeTruthy();
    expect(write).not.toHaveBeenCalled();
  });
  it("saving the name you already have does nothing", async () => {
    render(<AccountMenu />);
    openMenu();
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "alice" } });
    fireEvent.click(screen.getByText("Save"));
    expect(screen.getByText("That is already your username.")).toBeTruthy();
    expect(readContract).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });
  it("a name owned by someone else is refused before the wallet is asked", async () => {
    readContract.mockResolvedValue("0x00000000000000000000000000000000000000bb");
    render(<AccountMenu />);
    openMenu();
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "bob" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("That name is taken.")).toBeTruthy());
    expect(write).not.toHaveBeenCalled();
  });
  it("a free name goes to Profiles.setName on HyperEVM, and the profile is reloaded", async () => {
    render(<AccountMenu />);
    openMenu();
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "BoB_1" } }); // lowercased as typed
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("Saved.")).toBeTruthy());
    expect(write).toHaveBeenCalledWith("hyperEvm", expect.objectContaining({ address: PROFILES, functionName: "setName", args: ["bob_1"] }));
    expect(profile.reload).toHaveBeenCalled();
  });
  it("a revert from the chain (a race for the name) is shown in plain words", async () => {
    write.mockRejectedValue(new Error('The contract function "setName" reverted with the following reason:\nNameTaken()'));
    render(<AccountMenu />);
    openMenu();
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "bob" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(screen.getByText("That name is taken. Pick another one.")).toBeTruthy());
  });
  it("a double click on Save opens only one wallet prompt", async () => {
    let release: (v: unknown) => void = () => {};
    write.mockImplementation(() => new Promise((r) => { release = r; }));
    render(<AccountMenu />);
    openMenu();
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "bob" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByText("Save"));
    fireEvent.click(screen.getByLabelText("Avatar 5"));
    expect(write).toHaveBeenCalledTimes(1);
    await act(async () => release("0xhash"));
  });
  it("a different avatar goes to setAvatar; the current one does nothing", async () => {
    render(<AccountMenu />);
    openMenu();
    editProfile();
    expect(screen.getByLabelText("Avatar 3").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("Avatar 3"));
    expect(write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Avatar 7"));
    await waitFor(() => expect(write).toHaveBeenCalledWith("hyperEvm", expect.objectContaining({ functionName: "setAvatar", args: [7] })));
  });
});

describe("menu behaviour", () => {
  it("Escape and a click outside close it", () => {
    render(<div><span>elsewhere</span><AccountMenu /></div>);
    openMenu();
    expect(screen.getByText("Disconnect")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByText("Disconnect")).toBeNull();
    openMenu();
    expect(screen.getByText("Disconnect")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("elsewhere"));
    expect(screen.queryByText("Disconnect")).toBeNull();
  });
  it("a click inside the menu keeps it open", () => {
    render(<AccountMenu />);
    openMenu();
    fireEvent.mouseDown(screen.getByText("Trading"));
    expect(screen.getByText("Disconnect")).toBeTruthy();
  });
  it("a refused clipboard shows a message instead of an unhandled rejection", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) }, configurable: true });
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => expect(screen.getByText(/Could not copy/)).toBeTruthy());
  });
  it("no clipboard at all (an insecure context), or a writeText that throws at once, shows the same message (carry T9 N2)", async () => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Copy"));
    expect(screen.getByText(/Could not copy/)).toBeTruthy();
    cleanup();
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => { throw new Error("sync"); } }, configurable: true });
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Copy"));
    expect(screen.getByText(/Could not copy/)).toBeTruthy();
  });
  it("a copied address says so", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
  });
});

describe("cut off paired phone (Plan 4 B)", () => {
  const PHONE = "0x2c581a028cedc657fd1b754ab9de4eaaf9c6ca5d";
  const record = () => store.get(`hlo:phone:testnet:${A}`);
  const ask = () => {
    fireEvent.click(screen.getByText("Cut off paired phone…"));
    fireEvent.click(screen.getByRole("button", { name: "Cut off the phone" }));
  };
  it("asks first; Cancel signs nothing", () => {
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Cut off paired phone…"));
    expect(screen.getByText(/replaces the phone.s trading key with a new key nobody holds/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cutOffPhone).not.toHaveBeenCalled();
    expect(screen.getByText("Cut off paired phone…")).toBeTruthy(); // back to the plain button
  });
  it("confirm signs once with the main wallet, clears the computer's record of the phone, and says it is done", async () => {
    store.set(`hlo:phone:testnet:${A}`, JSON.stringify({ address: PHONE, validUntil: Date.now() + 86_400_000 }));
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText(/Paired phone: its key works until/)).toBeTruthy();
    ask();
    expect(await screen.findByText(/The paired phone is cut off/)).toBeTruthy();
    expect(cutOffPhone).toHaveBeenCalledTimes(1);
    expect(cutOffPhone).toHaveBeenCalledWith({ net: "testnet", wallet: { id: "w" }, nowMs: expect.any(Number) });
    expect(record()).toBeUndefined();
    expect(screen.queryByText(/Paired phone: its key works until/)).toBeNull();
  });
  it("the confirm button is off while another wallet prompt from the menu is open (Task 9 review m2)", async () => {
    let release: (v: unknown) => void = () => {};
    write.mockImplementation(() => new Promise((r) => { release = r; }));
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Cut off paired phone…"));
    editProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "bob" } });
    fireEvent.click(screen.getByText("Save"));
    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: "Cut off the phone" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => release("0xhash"));
    expect((screen.getByRole("button", { name: "Cut off the phone" }) as HTMLButtonElement).disabled).toBe(false);
  });
  it("an old cut-off result does not come back when the menu is closed and opened again (Task 9 review m3)", async () => {
    store.set(`hlo:phone:testnet:${A}`, JSON.stringify({ address: PHONE, validUntil: Date.now() + 86_400_000 }));
    render(<AccountMenu />);
    openMenu();
    ask();
    expect(await screen.findByText(/The paired phone is cut off/)).toBeTruthy();
    openMenu(); // closes
    openMenu(); // opens again
    expect(screen.queryByText(/The paired phone is cut off/)).toBeNull();
    // a confirmation left open is not left open either
    fireEvent.click(screen.getByText("Cut off paired phone…"));
    openMenu();
    openMenu();
    expect(screen.getByText("Cut off paired phone…")).toBeTruthy();
  });
  it("a refused signature keeps the record and shows the reason", async () => {
    store.set(`hlo:phone:testnet:${A}`, JSON.stringify({ address: PHONE, validUntil: Date.now() + 1e6 }));
    cutOffPhone.mockRejectedValueOnce(Object.assign(new Error("User rejected the request."), { code: 4001 }));
    render(<AccountMenu />);
    openMenu();
    ask();
    expect(await screen.findByText(/cancelled the request/)).toBeTruthy();
    expect(record()).toBeDefined();
    expect(screen.queryByText(/The paired phone is cut off/)).toBeNull();
  });
  it("an unconfirmed answer says the phone may already be cut off, keeps the record, and the button works again", async () => {
    store.set(`hlo:phone:testnet:${A}`, JSON.stringify({ address: PHONE, validUntil: Date.now() + 1e6 }));
    cutOffPhone.mockRejectedValueOnce(new CutOffUnconfirmedError());
    render(<AccountMenu />);
    openMenu();
    ask();
    expect(await screen.findByText(/the phone may already be cut off\. Cutting it off again is safe\./)).toBeTruthy();
    expect(record()).toBeDefined();
    expect(screen.queryByText(/The paired phone is cut off/)).toBeNull();
    expect(screen.getByText(/Paired phone: its key works until/)).toBeTruthy();
    expect((screen.getByText("Cut off paired phone…") as HTMLButtonElement).disabled).toBe(false);
  });
  it("two clicks in the same tick sign once; a second click while the wallet is open does not sign twice", async () => {
    let release: () => void = () => {};
    cutOffPhone.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    render(<AccountMenu />);
    openMenu();
    fireEvent.click(screen.getByText("Cut off paired phone…"));
    const go = screen.getByRole("button", { name: "Cut off the phone" });
    fireEvent.click(go);
    fireEvent.click(go); // the same element, before React re-renders it away
    fireEvent.click(screen.getByRole("button", { name: "Confirm in your wallet…" }));
    expect(cutOffPhone).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByText("Pair phone…") as HTMLButtonElement).disabled).toBe(true); // no second approval racing the cut-off
    await act(async () => release());
  });
  it("a paired phone, or a build without a builder, has no cut-off button", () => {
    session = { kind: "paired", address: A };
    render(<AccountMenu />);
    openMenu();
    expect(screen.queryByText("Cut off paired phone…")).toBeNull();
    cleanup();
    session = { kind: "wallet", address: A };
    cfg = { ...cfg, builder: null };
    render(<AccountMenu />);
    openMenu();
    expect(screen.queryByText("Cut off paired phone…")).toBeNull();
  });
  it("an expired phone record shows no 'key works until' line", () => {
    store.set(`hlo:phone:testnet:${A}`, JSON.stringify({ address: PHONE, validUntil: Date.now() - 1 }));
    render(<AccountMenu />);
    openMenu();
    expect(screen.queryByText(/Paired phone: its key works until/)).toBeNull();
    expect(screen.getByText("Cut off paired phone…")).toBeTruthy(); // still offered: an unconfirmed pairing may be live
  });
});

describe("the default referral code at Enable trading (spec referrals §3)", () => {
  const off = { builderOk: false, maxBuilderFee: 0, agentOk: false, agentValidUntil: null };
  it("names the code under Enable trading when one will be set", () => {
    trading = { ...trading, agent: null, status: off, referralCode: "HLOCFG" };
    render(<AccountMenu />);
    openMenu();
    expect(screen.getByText("Enable trading")).toBeTruthy();
    expect(screen.getByText("Uses referral code HLOCFG on Hyperliquid: 4% off Hyperliquid's fees on your first $25M traded.")).toBeTruthy();
    fireEvent.click(screen.getByText("Enable trading"));
    expect(trading.enable).toHaveBeenCalledWith("HLOCFG"); // exactly the code the text shows
  });
  it("says nothing about referrals when no code will be set, and Enable passes no code", () => {
    trading = { ...trading, agent: null, status: off, referralCode: null };
    render(<AccountMenu />);
    openMenu();
    expect(screen.queryByText(/referral code/)).toBeNull();
    fireEvent.click(screen.getByText("Enable trading"));
    expect(trading.enable).toHaveBeenCalledWith(null);
  });
});

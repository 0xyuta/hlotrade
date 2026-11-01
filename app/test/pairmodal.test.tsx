// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { browserKV, loadPhoneRecord } from "../src/hl/agent";
import { groupPairCode, pairCodeHex, pairQrText, parsePairCode } from "../src/hl/pairCode";
import { cancelPairing, stagePairCode } from "../src/hl/pairing";
import { privateKeyToAccount } from "viem/accounts";

const MASTER = "0x00000000000000000000000000000000000000aa";
const PHONE_KEY = `0x${"ef".repeat(32)}` as const;
const PHONE_ADDR = privateKeyToAccount(PHONE_KEY).address; // the approved address is the key's own (Task 8 review m6)
const calls: string[] = [];
let trading: { master: string | null; agent: object | null; status: object | null };
let session: { kind: string };
let approve: () => Promise<unknown>;
let pairQrGate: Promise<void> = Promise.resolve(); // holds back the pairing code's image (not the link's)

vi.mock("../src/hl/enable", () => ({
  approvePhoneAgent: vi.fn(() => {
    calls.push("approve");
    return approve();
  }),
}));
vi.mock("qrcode", () => ({
  default: {
    toDataURL: vi.fn(async (text: string) => {
      calls.push(`qr:${text}`);
      if (text.startsWith("hlo pairing code")) await pairQrGate;
      return `data:image/png;base64,${calls.length}`;
    }),
  },
}));
vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, hlWallet: () => ({}) }) }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => trading }));
vi.mock("../src/config/context", () => ({ useConfig: () => ({ network: "testnet" }) as AppConfig }));

import { PairModal, QR_VISIBLE_MS } from "../src/ui/PairModal";

const ok = { builderOk: true, agentOk: true, agentValidUntil: null, maxBuilderFee: 100 };
const BTN = "Approve phone and show pairing code";
const store = new Map<string, string>();
const fake = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
const qrTexts = () => calls.filter((c) => c.startsWith("qr:")).map((c) => c.slice(3));

beforeEach(() => {
  calls.length = 0;
  store.clear();
  pairQrGate = Promise.resolve();
  vi.stubGlobal("localStorage", fake);
  session = { kind: "wallet" };
  trading = { master: MASTER, agent: {}, status: ok };
  approve = async () => ({ key: PHONE_KEY, address: PHONE_ADDR, validUntil: 1_900_000_000_000 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PairModal (computer)", () => {
  it("shows the link code for /pair at once: the plain URL, nothing secret", async () => {
    render(<PairModal onClose={() => {}} />);
    expect(await screen.findByAltText("Link to the pairing page")).toBeTruthy();
    expect(qrTexts()).toEqual([`${window.location.origin}/pair`]);
    expect(screen.getByText(`${window.location.host}/pair`)).toBeTruthy();
    expect(calls).not.toContain("approve");
  });
  it("after the wallet signs the phone's own key: a pairing code (plain text, not a URL) and the same code to type", async () => {
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    expect(await screen.findByAltText("Pairing code")).toBeTruthy();
    const text = qrTexts().at(-1)!;
    expect(text).toBe(pairQrText("testnet", PHONE_KEY));
    expect(text).not.toMatch(/https?:|\/pair|#/);
    expect(parsePairCode(text, "testnet")).toMatchObject({ ok: true, key: PHONE_KEY });
    expect(screen.getByText(groupPairCode(pairCodeHex(PHONE_KEY)).join(" "))).toBeTruthy();
    expect(screen.getByText(/not with the camera app/)).toBeTruthy();
  });
  it("what the modal shows is what the phone's page accepts: the QR text and the typed groups both stage the same key", async () => {
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    await screen.findByAltText("Pairing code");
    const fromQr = stagePairCode(qrTexts().at(-1)!, "testnet");
    const typed = screen.getByText(groupPairCode(pairCodeHex(PHONE_KEY)).join(" ")).textContent!;
    const fromTyped = stagePairCode(typed, "testnet");
    cancelPairing();
    expect(fromQr).toEqual(fromTyped);
    expect(fromQr).toMatchObject({ ok: true });
    // and the key the phone stages is the one whose address the computer recorded (Task 8 review m6)
    expect(fromQr.ok && fromQr.agent.toLowerCase()).toBe(loadPhoneRecord(browserKV, "testnet", MASTER)?.address);
    expect(stagePairCode(qrTexts().at(-1)!, "mainnet")).toMatchObject({ ok: false }); // the other network's page refuses it
    cancelPairing();
  });
  it("never puts the key in the title or the images' alt text, and the link code stays secret-free", async () => {
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    await screen.findByAltText("Pairing code");
    const attrs = [...document.querySelectorAll("[alt],[title],[aria-label]")].map((e) => `${e.getAttribute("alt")}${e.getAttribute("title")}${e.getAttribute("aria-label")}`).join();
    expect(attrs).not.toContain("efef");
    expect(qrTexts()[0]).toBe(`${window.location.origin}/pair`);
  });
  it("records the phone's address and expiry for the account menu, never its key", async () => {
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    await screen.findByAltText("Pairing code");
    expect(loadPhoneRecord(browserKV, "testnet", MASTER)).toEqual({ address: PHONE_ADDR.toLowerCase(), validUntil: 1_900_000_000_000 });
    expect([...store.values()].join()).not.toContain("efef");
  });
  it("says the phone's key lasts 30 days and anyone who sees the code can trade, never withdraw; no browser-history warning", async () => {
    render(<PairModal onClose={() => {}} />);
    expect(screen.getByText(/key works for 30 days/)).toBeTruthy();
    expect(screen.getAllByText(/never withdraw/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(BTN));
    await screen.findByAltText("Pairing code");
    expect(screen.queryByText(/history/)).toBeNull();
  });
  it("needs the builder fee and a wallet session", () => {
    trading = { master: MASTER, agent: {}, status: { ...ok, builderOk: false } };
    render(<PairModal onClose={() => {}} />);
    expect(screen.getByText("Enable trading first.")).toBeTruthy();
    expect(screen.queryByText(BTN)).toBeNull();
    cleanup();
    session = { kind: "paired" };
    render(<PairModal onClose={() => {}} />);
    expect(screen.getByText("Connect your wallet to pair a phone.")).toBeTruthy();
  });
  it("a refused signature shows no pairing code and records nothing", async () => {
    approve = async () => { throw Object.assign(new Error("denied"), { code: 4001 }); };
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    await waitFor(() => expect(screen.getByText(/cancelled the request/)).toBeTruthy());
    expect(screen.queryByAltText("Pairing code")).toBeNull();
    expect(loadPhoneRecord(browserKV, "testnet", MASTER)).toBeNull();
  });
  it("a second click while the wallet prompt is open does not start a second approval", async () => {
    let release: (v: unknown) => void = () => {};
    approve = () => new Promise((r) => { release = r; });
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    fireEvent.click(screen.getByText("Confirm in your wallet…"));
    expect(calls.filter((c) => c === "approve")).toHaveLength(1);
    await act(async () => release({ key: PHONE_KEY, address: PHONE_ADDR, validUntil: 1 }));
    await screen.findByAltText("Pairing code");
  });
  it("closed during the wallet prompt: no pairing code, the record is cleared (that key was thrown away), and the owner is told", async () => {
    store.set(`hlo:phone:testnet:${MASTER}`, JSON.stringify({ address: "0x1111111111111111111111111111111111111111", validUntil: 5 }));
    let release: (v: unknown) => void = () => {};
    approve = () => new Promise((r) => { release = r; });
    const onLate = vi.fn();
    const { unmount } = render(<PairModal onClose={() => {}} onLateApproval={onLate} />);
    fireEvent.click(screen.getByText(BTN));
    unmount();
    await act(async () => release({ key: PHONE_KEY, address: PHONE_ADDR, validUntil: 1 }));
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(qrTexts().some((t) => t.startsWith("hlo pairing code"))).toBe(false);
    expect(loadPhoneRecord(browserKV, "testnet", MASTER)).toBeNull();
  });
  it("hides the pairing code and the typed code after 60 seconds, and shows them again without a second approval", async () => {
    vi.useFakeTimers();
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByAltText("Pairing code")).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(QR_VISIBLE_MS + 1); });
    expect(screen.queryByAltText("Pairing code")).toBeNull();
    expect(screen.queryByText(groupPairCode(pairCodeHex(PHONE_KEY)).join(" "))).toBeNull();
    fireEvent.click(screen.getByText("Show again"));
    expect(screen.getByAltText("Pairing code")).toBeTruthy();
    expect(calls.filter((c) => c === "approve")).toHaveLength(1);
  });
  it("drops the codes when closed", async () => {
    const onClose = vi.fn(); // the parent has not unmounted it yet: what it renders now must hold no code (Task 8 review m1)
    render(<PairModal onClose={onClose} />);
    fireEvent.click(screen.getByText(BTN));
    await screen.findByAltText("Pairing code");
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByAltText("Pairing code")).toBeNull();
    expect(screen.queryByText(groupPairCode(pairCodeHex(PHONE_KEY)).join(" "))).toBeNull();
    expect(screen.queryByText("Show again")).toBeNull(); // nothing is held to show again
  });
  it("closed after the approval but before the code is drawn: no record for a key nobody has, and the owner is told (Task 8 review m2)", async () => {
    store.set(`hlo:phone:testnet:${MASTER}`, JSON.stringify({ address: "0x1111111111111111111111111111111111111111", validUntil: 5 }));
    let draw!: () => void;
    pairQrGate = new Promise<void>((r) => (draw = r));
    const onLate = vi.fn();
    const { unmount } = render(<PairModal onClose={() => {}} onLateApproval={onLate} />);
    fireEvent.click(screen.getByText(BTN));
    await waitFor(() => expect(qrTexts().some((t) => t.startsWith("hlo pairing code"))).toBe(true));
    unmount();
    await act(async () => draw());
    expect(onLate).toHaveBeenCalledTimes(1);
    expect(loadPhoneRecord(browserKV, "testnet", MASTER)).toBeNull();
  });
  it("the pairing code's image cannot be dragged out of the dialog, and its typed text is not select-all (final review M7)", async () => {
    render(<PairModal onClose={() => {}} />);
    fireEvent.click(screen.getByText(BTN));
    const img = await screen.findByAltText("Pairing code");
    expect(img.getAttribute("draggable")).toBe("false");
    // the code is read and typed on the phone, never pasted: one click must not select the whole key for copying
    const css = readFileSync(join(__dirname, "../src/styles.css"), "utf8");
    const rule = css.match(/\.pair-code\s*\{[^}]*\}/)?.[0] ?? "";
    expect(rule).not.toBe("");
    expect(rule).not.toMatch(/user-select:\s*all/);
  });
});

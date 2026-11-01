// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PHONE_AGENT_NAME, browserKV, loadAgent, loadPaired } from "../src/hl/agent";
import { NOT_A_CODE, groupPairCode, pairCodeHex, pairQrText } from "../src/hl/pairCode";
import { cancelPairing } from "../src/hl/pairing";
import type { CameraProblem } from "../src/ui/pair/scan";
import type { ScannerProps } from "../src/ui/pair/Scanner";

const MASTER = "0x00000000000000000000000000000000000000aa";
const KEY = `0x${"cd".repeat(32)}` as const;
const AGENT = "0x89AEF553A06ab0C3173e79DE1Ce241A9ed3b992C";
const lookup = vi.fn();
vi.mock("../src/hl/role", () => ({ fetchAgentMaster: (...a: unknown[]) => lookup(...a) }));

import { LEGACY_LINK_TEXT, PairPage } from "../src/ui/pair/PairPage";

// jsdom here has no usable localStorage: a Map-backed stand-in.
const store = new Map<string, string>();
let blocked = false;
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (blocked) throw new DOMException("quota", "QuotaExceededError");
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
};
let scanTexts: string[] = [];
let camera: CameraProblem | null = null;
function FakeScanner({ onText, onProblem }: ScannerProps) {
  return (
    <button
      onClick={() => {
        if (camera) return onProblem(camera);
        for (const t of scanTexts) if (onText(t)) break;
      }}
    >
      fake scan
    </button>
  );
}
const page = (legacyLink = false) => render(<PairPage net="testnet" legacyLink={legacyLink} Scanner={FakeScanner} />);
const click = (t: string | RegExp) => fireEvent.click(screen.getByRole("button", { name: t }));

beforeEach(() => {
  store.clear();
  blocked = false;
  camera = null;
  scanTexts = [pairQrText("testnet", KEY)];
  cancelPairing();
  lookup.mockReset().mockResolvedValue(MASTER);
  vi.stubGlobal("localStorage", fake);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PairPage (phone)", () => {
  it("an old /pair#… link: says it is no longer used; nothing is stored", () => {
    page(true);
    expect(screen.getByText(LEGACY_LINK_TEXT)).toBeTruthy();
    expect(store.size).toBe(0);
  });
  it("scan → Hyperliquid names the master → ask → store the phone's key; nothing before the confirmation", async () => {
    page();
    click("Scan the code");
    click("fake scan");
    expect(await screen.findByText(/Pair this phone with/)).toBeTruthy();
    expect(screen.getByText("0x0000…00aa")).toBeTruthy();
    expect(screen.getByText(MASTER)).toBeTruthy(); // the whole address too (Task 7 review m7)
    expect(lookup).toHaveBeenCalledWith("testnet", AGENT);
    expect(store.size).toBe(0);
    click("Pair this phone");
    expect(screen.getByText(/can now trade for/)).toBeTruthy();
    expect(loadAgent(browserKV, "testnet", MASTER, PHONE_AGENT_NAME)?.key).toBe(KEY);
    expect(loadPaired(browserKV, "testnet")).toBe(MASTER);
    expect(screen.getByText(/works for 30 days/)).toBeTruthy();
    expect(screen.queryByText(/history/)).toBeNull(); // the old warnings are gone
  });
  it("another QR (the computer's link code) keeps the camera on and says what to scan", async () => {
    scanTexts = ["https://hlo.example/pair"];
    page();
    click("Scan the code");
    click("fake scan");
    expect(screen.getByText(NOT_A_CODE)).toBeTruthy();
    scanTexts = [pairQrText("testnet", KEY)];
    click("fake scan");
    expect(await screen.findByText(/Pair this phone with/)).toBeTruthy();
  });
  it("typing: spaces and capitals are fine", async () => {
    page();
    click("Type the code instead");
    const input = screen.getByLabelText(/Pairing code/) as HTMLInputElement;
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: groupPairCode(pairCodeHex(KEY)).join(" ").toUpperCase() } });
    click("Check code");
    expect(await screen.findByText(/Pair this phone with/)).toBeTruthy();
  });
  it("a code read from the field is gone from it: after a refusal by Hyperliquid and Start over, Type shows an empty field (Task 7 review m4)", async () => {
    lookup.mockResolvedValueOnce(null);
    page();
    click("Type the code instead");
    fireEvent.change(screen.getByLabelText(/Pairing code/), { target: { value: pairCodeHex(KEY) } });
    click("Check code");
    expect(await screen.findByText(/does not know this code/)).toBeTruthy();
    click("Start over");
    click("Type the code instead");
    expect((screen.getByLabelText(/Pairing code/) as HTMLInputElement).value).toBe("");
  });
  it("a typed code for the other network is dropped from the field; a typo stays to be corrected (Task 7 review m3)", () => {
    page();
    click("Type the code instead");
    const input = () => screen.getByLabelText(/Pairing code/) as HTMLInputElement;
    fireEvent.change(input(), { target: { value: pairQrText("mainnet", KEY) } });
    click("Check code");
    expect(screen.getByText("This code is for mainnet, but this is the testnet app.")).toBeTruthy();
    expect(input().value).toBe("");
    const typo = pairCodeHex(KEY).replace(/^c/, "d");
    fireEvent.change(input(), { target: { value: typo } });
    click("Check code");
    expect(screen.getByText(/typo/)).toBeTruthy();
    expect(input().value).toBe(typo);
    expect(store.size).toBe(0);
  });
  it("typing can go back to scanning, and a scan's hint does not follow into the typed step (Task 7 review m3)", () => {
    scanTexts = ["https://hlo.example/pair"];
    page();
    click("Scan the code");
    click("fake scan");
    expect(screen.getByText(NOT_A_CODE)).toBeTruthy();
    click("Type the code instead");
    expect(screen.queryByText(NOT_A_CODE)).toBeNull();
    click("Scan the code instead");
    expect(screen.getByRole("button", { name: "fake scan" })).toBeTruthy();
  });
  it("a typo is caught before anything is asked or stored", () => {
    page();
    click("Type the code instead");
    fireEvent.change(screen.getByLabelText(/Pairing code/), { target: { value: pairCodeHex(KEY).replace(/^c/, "d") } });
    click("Check code");
    expect(screen.getByText(/typo/)).toBeTruthy();
    expect(lookup).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
  });
  it("a code for the other network is refused", () => {
    scanTexts = [pairQrText("mainnet", KEY)];
    page();
    click("Scan the code");
    click("fake scan");
    expect(screen.getByText("This code is for mainnet, but this is the testnet app.")).toBeTruthy();
  });
  it("a code Hyperliquid does not know: says so, stores nothing, and offers to start over", async () => {
    lookup.mockResolvedValueOnce(null);
    page();
    click("Scan the code");
    click("fake scan");
    expect(await screen.findByText(/does not know this code/)).toBeTruthy();
    click("Start over");
    expect(screen.getByRole("button", { name: "Scan the code" })).toBeTruthy();
    expect(store.size).toBe(0);
  });
  it("Hyperliquid unreachable: Try again asks again with the same code", async () => {
    lookup.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    page();
    click("Scan the code");
    click("fake scan");
    expect(await screen.findByText(/Could not reach Hyperliquid/)).toBeTruthy();
    click("Try again");
    expect(await screen.findByText(/Pair this phone with/)).toBeTruthy();
  });
  it("'Not now' stores nothing", async () => {
    page();
    click("Scan the code");
    click("fake scan");
    await screen.findByText(/Pair this phone with/);
    click("Not now");
    expect(screen.getByText("This phone was not paired.")).toBeTruthy();
    expect(store.size).toBe(0);
  });
  it("blocked storage says the browser did not save it", async () => {
    page();
    click("Scan the code");
    click("fake scan");
    await screen.findByText(/Pair this phone with/);
    blocked = true;
    click("Pair this phone");
    expect(screen.getByText(/did not save the pairing/)).toBeTruthy();
  });
  it("leaving the page (pagehide) forgets the staged key", async () => {
    page();
    click("Scan the code");
    click("fake scan");
    await screen.findByText(/Pair this phone with/);
    window.dispatchEvent(new Event("pagehide"));
    click("Pair this phone");
    expect(screen.getByText(/no longer held on this page/)).toBeTruthy();
    expect(store.size).toBe(0);
  });
  it("a refused or missing camera switches to typing and says why", () => {
    camera = "denied";
    page();
    click("Scan the code");
    click("fake scan");
    expect(screen.getByText(/camera is blocked/)).toBeTruthy();
    expect(screen.getByLabelText(/Pairing code/)).toBeTruthy();
  });
  it("the staged key is never in the page text, the title or the address", async () => {
    const before = { title: document.title, href: window.location.href };
    page();
    click("Type the code instead");
    fireEvent.change(screen.getByLabelText(/Pairing code/), { target: { value: pairCodeHex(KEY) } });
    click("Check code");
    await screen.findByText(/Pair this phone with/);
    const hex = KEY.slice(2);
    expect(document.body.innerHTML).not.toContain(hex);
    expect((screen.queryByLabelText(/Pairing code/) as HTMLInputElement | null)?.value ?? "").not.toContain(hex);
    expect(document.title).toBe(before.title);
    expect(window.location.href).toBe(before.href);
  });
  it("an old link's notice goes once the user moves on to scanning, and the page still pairs normally", async () => {
    page(true);
    click("Scan the code");
    click("fake scan");
    expect(await screen.findByText(/Pair this phone with/)).toBeTruthy();
    expect(screen.queryByText(LEGACY_LINK_TEXT)).toBeNull();
  });
});

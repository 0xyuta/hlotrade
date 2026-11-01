// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { CHECKING_KEY_TEXT, CODE_RULE_TEXT, NO_AGENT_TEXT, NO_LINK_TEXT, REFERRAL_INTRO_TEXT, REFERRAL_REWARDS_TEXT, type ReferralView } from "../src/hl/referral";
import type { ReferralState } from "../src/ui/referrals/useReferral";
import { PAIRED_BLOCKED_TEXT } from "../src/wallet/permissions";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const AGENT = { key: `0x${"ab".repeat(32)}`, address: "0x00000000000000000000000000000000000000cc" };
let session: { kind: "none" | "wallet" | "paired"; address?: string };
let trading: Record<string, unknown>;
let state: ReferralState;
let cfg: AppConfig;
const reload = vi.fn();
const hlWallet = vi.fn();
const sendSetReferrer = vi.fn();
const sendRegisterReferrer = vi.fn();
const sendClaimRewards = vi.fn();

vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));
vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, hlWallet }) }));
vi.mock("../src/hl/TradingProvider", () => ({ useTrading: () => trading }));
vi.mock("../src/ui/referrals/useReferral", () => ({ useReferral: () => ({ state, reload }) }));
vi.mock("../src/ui/WalletButton", () => ({ WalletButton: () => <button>Connect</button> }));
vi.mock("../src/hl/referralActions", async (orig) => ({
  ...(await orig<typeof import("../src/hl/referralActions")>()),
  sendSetReferrer: (...a: unknown[]) => sendSetReferrer(...a),
  sendRegisterReferrer: (...a: unknown[]) => sendRegisterReferrer(...a),
  sendClaimRewards: (...a: unknown[]) => sendClaimRewards(...a),
}));

import { ReferralsScreen } from "../src/ui/referrals/ReferralsScreen";

const view = (o: Partial<ReferralView> = {}): ReferralView => ({ referredBy: null, cumVlm: 2500, unclaimed: 0, claimed: 0, referrer: { stage: "needToTrade", required: 10000 }, ...o });
const ready = (o: Partial<ReferralView> = {}): ReferralState => ({ kind: "ready", view: view(o) });
const signer = { net: "testnet", agentKey: AGENT.key, wallet: hlWallet };
const store = new Map<string, string>();
const button = (text: string) => screen.getByText(text) as HTMLButtonElement;

beforeEach(() => {
  session = { kind: "wallet", address: A };
  trading = { master: A, agent: AGENT, status: { builderOk: true, agentOk: true }, markReSign: vi.fn() };
  state = ready();
  cfg = { network: "testnet", referralCode: "HLOCFG" } as unknown as AppConfig;
  reload.mockReset();
  for (const f of [sendSetReferrer, sendRegisterReferrer, sendClaimRewards]) f.mockReset().mockResolvedValue(undefined);
  store.clear();
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ReferralsScreen", () => {
  it("without a wallet: explains Hyperliquid's program and offers Connect", () => {
    session = { kind: "none" };
    trading = { ...trading, master: null };
    render(<ReferralsScreen />);
    expect(screen.getByText(REFERRAL_INTRO_TEXT)).toBeTruthy();
    expect(screen.getByText("Connect")).toBeTruthy();
  });
  it("a successful action whose reload then fails keeps the success message, with the error", async () => {
    state = ready({ unclaimed: 5 });
    const { rerender } = render(<ReferralsScreen />);
    fireEvent.click(screen.getByText("Claim"));
    await waitFor(() => expect(screen.getByText("Referral rewards claimed.")).toBeTruthy());
    state = { kind: "down", error: "Hyperliquid info: HTTP 500" }; // the reload after the claim failed
    rerender(<ReferralsScreen />);
    expect(screen.getByText("Referral rewards claimed.")).toBeTruthy();
    expect(screen.getByText("Hyperliquid info: HTTP 500")).toBeTruthy();
  });
  it("Hyperliquid not answering: says so; Try again reads again", () => {
    state = { kind: "down", error: "Hyperliquid info: HTTP 500" };
    render(<ReferralsScreen />);
    expect(screen.getByText("Hyperliquid info: HTTP 500")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    expect(reload).toHaveBeenCalled();
  });
});

describe("Referred by", () => {
  it("no referrer: the field holds the config's code; Use code sends it with the agent, then reads again", async () => {
    render(<ReferralsScreen />);
    expect((screen.getByLabelText("Referral code") as HTMLInputElement).value).toBe("HLOCFG");
    fireEvent.click(screen.getByText("Use code"));
    await waitFor(() => expect(screen.getByText("Referral code HLOCFG is set.")).toBeTruthy());
    expect(sendSetReferrer).toHaveBeenCalledWith(signer, "HLOCFG");
    expect(reload).toHaveBeenCalled();
  });
  it("a ?ref= code the app kept wins over the config's", () => {
    store.set("hlo.ref.testnet", "FRIEND1");
    render(<ReferralsScreen />);
    expect((screen.getByLabelText("Referral code") as HTMLInputElement).value).toBe("FRIEND1");
  });
  it("a typed code that is not 1–20 letters and digits cannot be sent", () => {
    render(<ReferralsScreen />);
    fireEvent.change(screen.getByLabelText("Referral code"), { target: { value: "bad code" } });
    expect(button("Use code").disabled).toBe(true);
    expect(screen.getByText(CODE_RULE_TEXT)).toBeTruthy();
  });
  it("referred: shows the code and no field", () => {
    state = ready({ referredBy: { referrer: B, code: "HLOCFG" } });
    render(<ReferralsScreen />);
    expect(screen.getByText("HLOCFG")).toBeTruthy();
    expect(screen.queryByText("Use code")).toBeNull();
  });
});

describe("Your code", () => {
  it("needToTrade: says how much more to trade", () => {
    render(<ReferralsScreen />);
    expect(screen.getByText("Trade $7,500 more to create a code.")).toBeTruthy();
  });
  it("needToCreateCode: Create code registers the typed code; Hyperliquid's refusal shows as its message", async () => {
    state = ready({ referrer: { stage: "needToCreateCode" } });
    sendRegisterReferrer.mockRejectedValueOnce(new Error("Referral code already registered"));
    render(<ReferralsScreen />);
    fireEvent.change(screen.getByLabelText("New code"), { target: { value: "MYCODE" } });
    fireEvent.click(screen.getByText("Create code"));
    await waitFor(() => expect(screen.getByText("Referral code already registered")).toBeTruthy());
    expect(sendRegisterReferrer).toHaveBeenCalledWith(signer, "MYCODE");
    fireEvent.click(screen.getByText("Create code"));
    await waitFor(() => expect(screen.getByText("Your code MYCODE is created.")).toBeTruthy());
  });
  it("ready: the code, the share link with Copy, the count and the referred accounts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    state = ready({
      referrer: {
        stage: "ready", code: "MYCODE", count: 2,
        referrals: [
          { user: B, volume: 50000, rewarded: 3.5, joined: Date.UTC(2026, 9, 29) },
          { user: A, volume: 1000, rewarded: 0.25, joined: Date.UTC(2026, 9, 28) },
        ],
      },
    });
    render(<ReferralsScreen />);
    const link = `${window.location.origin}/?ref=MYCODE`;
    expect((screen.getByLabelText("Share link") as HTMLInputElement).value).toBe(link);
    fireEvent.click(screen.getByText("Copy"));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(writeText).toHaveBeenCalledWith(link);
    expect(screen.getByText("MYCODE")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("0x0000…00bb")).toBeTruthy();
    expect(screen.getByText("$50,000")).toBeTruthy();
    expect(screen.getByText("$3.50")).toBeTruthy();
    expect(screen.getByText("2026-10-29")).toBeTruthy();
  });
  it("ready with a code HLO's ?ref= link would drop: the code, no share link, a short note", () => {
    state = ready({ referrer: { stage: "ready", code: "my-code", count: 0, referrals: [] } });
    render(<ReferralsScreen />);
    expect(screen.getByText("my-code")).toBeTruthy();
    expect(screen.queryByLabelText("Share link")).toBeNull();
    expect(screen.queryByText("Copy")).toBeNull();
    expect(screen.getByText(NO_LINK_TEXT)).toBeTruthy();
  });
});

describe("Referral rewards", () => {
  it("unclaimed above 0: Claim sends claimRewards with the agent", async () => {
    state = ready({ unclaimed: 12.5, claimed: 3 });
    render(<ReferralsScreen />);
    expect(screen.getByText("$12.50")).toBeTruthy();
    expect(screen.getByText("$3.00")).toBeTruthy();
    expect(screen.getByText(REFERRAL_REWARDS_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByText("Claim"));
    await waitFor(() => expect(screen.getByText("Referral rewards claimed.")).toBeTruthy());
    expect(sendClaimRewards).toHaveBeenCalledWith(signer);
  });
  it("under $1 unclaimed: no Claim button, because Hyperliquid refuses it; it says so", () => {
    state = ready({ unclaimed: 0.07 });
    render(<ReferralsScreen />);
    expect(screen.queryByText("Claim")).toBeNull();
    expect(screen.getByText("You can claim once you have $1 or more.")).toBeTruthy();
  });
  it("exactly $1 unclaimed: Claim is offered", () => {
    state = ready({ unclaimed: 1 });
    render(<ReferralsScreen />);
    expect(screen.getByText("Claim")).toBeTruthy();
    expect(screen.queryByText("You can claim once you have $1 or more.")).toBeNull();
  });
  it("the account's own code is not offered as the code to use, whatever its case", () => {
    cfg = { ...cfg, referralCode: "hlo" } as AppConfig;
    state = ready({ referrer: { stage: "ready", code: "HLO", count: 0, referrals: [] } });
    render(<ReferralsScreen />);
    expect((screen.getByLabelText("Referral code") as HTMLInputElement).value).toBe("");
    expect(button("Use code").disabled).toBe(true);
  });
  it("nothing unclaimed: no Claim button", () => {
    render(<ReferralsScreen />);
    expect(screen.queryByText("Claim")).toBeNull();
  });
  it("an amount under a cent reads <$0.01", () => {
    state = ready({ unclaimed: 0.004 });
    render(<ReferralsScreen />);
    expect(screen.getByText("<$0.01")).toBeTruthy();
  });
});

describe("who may act", () => {
  it("a paired phone sees the page but cannot act", () => {
    session = { kind: "paired", address: A };
    state = ready({ unclaimed: 1 });
    render(<ReferralsScreen />);
    expect(screen.getByText(PAIRED_BLOCKED_TEXT)).toBeTruthy();
    expect(button("Use code").disabled).toBe(true);
    expect(button("Claim").disabled).toBe(true);
  });
  it("a wallet without a live trading key is asked to enable trading first, with Enable trading on the tab", () => {
    const enable = vi.fn();
    trading = { ...trading, agent: null, status: { builderOk: true, agentOk: false }, canEnable: true, enable, referralCode: null };
    render(<ReferralsScreen />);
    expect(screen.getByText(NO_AGENT_TEXT)).toBeTruthy();
    expect(button("Use code").disabled).toBe(true);
    expect(screen.queryByText(/^Uses referral code/)).toBeNull(); // no code shown, so none is passed
    fireEvent.click(screen.getByText("Enable trading"));
    expect(enable).toHaveBeenCalledWith(null);
  });
  it("the tab's Enable trading follows the Enable text rule: it names the code and passes exactly that code", () => {
    const enable = vi.fn();
    trading = { ...trading, agent: null, status: { builderOk: false, agentOk: false }, canEnable: true, enable, referralCode: "HLOCFG" };
    render(<ReferralsScreen />);
    expect(screen.getByText("Uses referral code HLOCFG on Hyperliquid: 4% off Hyperliquid's fees on your first $25M traded.")).toBeTruthy();
    fireEvent.click(screen.getByText("Enable trading"));
    expect(enable).toHaveBeenCalledWith("HLOCFG");
  });
  it("while the trading status is still loading: 'Checking…', not 'Enable trading first', and no Enable button", () => {
    cfg = { ...cfg, builder: "0x2222222222222222222222222222222222222222" } as AppConfig;
    trading = { ...trading, agent: null, status: null, error: null, canEnable: true, enable: vi.fn() };
    render(<ReferralsScreen />);
    expect(screen.getByText(CHECKING_KEY_TEXT)).toBeTruthy();
    expect(screen.queryByText(NO_AGENT_TEXT)).toBeNull();
    expect(screen.queryByText("Enable trading")).toBeNull();
    expect(button("Use code").disabled).toBe(true);
  });
  it("a paired phone gets no Enable trading button", () => {
    session = { kind: "paired", address: A };
    trading = { ...trading, agent: null, status: { builderOk: true, agentOk: false }, canEnable: false, enable: vi.fn() };
    render(<ReferralsScreen />);
    expect(screen.queryByText("Enable trading")).toBeNull();
  });
  it("a trading key Hyperliquid no longer knows asks for one re-sign", async () => {
    sendSetReferrer.mockRejectedValueOnce(new Error(`User or API Wallet ${AGENT.address} does not exist.`));
    render(<ReferralsScreen />);
    fireEvent.click(screen.getByText("Use code"));
    await waitFor(() => expect(trading.markReSign).toHaveBeenCalled());
    expect(screen.getByText(/no longer approved/)).toBeTruthy();
  });
});

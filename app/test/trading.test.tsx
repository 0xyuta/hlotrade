// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config/validate";
import { PHONE_AGENT_NAME, agentStorageKey } from "../src/hl/agent";
import type { TradingApi } from "../src/hl/TradingProvider";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const DESK_KEY = `0x${"11".repeat(32)}` as const;
const PHONE_KEY = `0x${"22".repeat(32)}` as const;
const deskAddr = privateKeyToAccount(DESK_KEY).address;
const phoneAddr = privateKeyToAccount(PHONE_KEY).address;

type Sess = { kind: "none" } | { kind: "wallet"; address: string } | { kind: "paired"; address: string };
let session: Sess;
const readTradingStatus = vi.fn();
const enableTrading = vi.fn();

vi.mock("../src/wallet/session", () => ({ useSession: () => ({ session, hlWallet: () => ({}) }) }));
vi.mock("../src/hl/enable", () => ({ readTradingStatus: (...a: unknown[]) => readTradingStatus(...a), enableTrading: (...a: unknown[]) => enableTrading(...a) }));
const registerWallet = vi.fn();
vi.mock("../src/hl/register", () => ({ registerWallet: (...a: unknown[]) => registerWallet(...a) }));
vi.mock("../src/hl/clients", () => ({ agentExchange: (_net: string, key: string) => ({ fakeExchangeFor: key }) }));
const readReferral = vi.fn();
const applyDefaultReferrer = vi.fn();
vi.mock("../src/hl/referralActions", () => ({
  readReferral: (...a: unknown[]) => readReferral(...a),
  applyDefaultReferrer: (...a: unknown[]) => applyDefaultReferrer(...a),
}));

const config = { network: "testnet", builder: "0x2222222222222222222222222222222222222222" } as unknown as AppConfig;
let cfg: AppConfig = config;
vi.mock("../src/config/context", () => ({ useConfig: () => cfg }));

import { TradingProvider, useTrading } from "../src/hl/TradingProvider";

const store = new Map<string, string>();
const fake = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
const putKey = (master: string, key: string, slot?: typeof PHONE_AGENT_NAME) =>
  store.set(agentStorageKey("testnet", master, slot), JSON.stringify({ key, validUntil: 0 }));

let api: TradingApi;
function Probe() {
  api = useTrading();
  return null;
}
const mount = () => render(<TradingProvider><Probe /></TradingProvider>);
const live = { builderOk: true, maxBuilderFee: 100, agentOk: true, agentValidUntil: null };

beforeEach(() => {
  store.clear();
  cfg = config;
  session = { kind: "none" };
  readTradingStatus.mockReset().mockResolvedValue(live);
  enableTrading.mockReset();
  registerWallet.mockReset().mockResolvedValue(undefined);
  readReferral.mockReset().mockResolvedValue({ referredBy: null });
  applyDefaultReferrer.mockReset().mockResolvedValue("set");
  vi.stubGlobal("localStorage", fake);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TradingProvider", () => {
  it("registers the master once builderOk is true, and not before", async () => {
    let release: (v: unknown) => void = () => {};
    readTradingStatus.mockImplementation(() => new Promise((r) => { release = r; }));
    session = { kind: "wallet", address: A };
    mount();
    await waitFor(() => expect(readTradingStatus).toHaveBeenCalled());
    expect(registerWallet).not.toHaveBeenCalled(); // status still unknown
    await act(async () => release({ ...live, builderOk: false }));
    await waitFor(() => expect(api.status?.builderOk).toBe(false));
    expect(registerWallet).not.toHaveBeenCalled(); // fee not approved
    readTradingStatus.mockResolvedValue(live);
    await act(async () => api.refresh());
    await waitFor(() => expect(registerWallet).toHaveBeenCalledTimes(1));
    expect(registerWallet).toHaveBeenCalledWith(A);
    await act(async () => api.refresh()); // later reads do not re-trigger it
    expect(registerWallet).toHaveBeenCalledTimes(1);
  });
  it("a paired phone registers its master (the main wallet)", async () => {
    putKey(A, PHONE_KEY, PHONE_AGENT_NAME);
    session = { kind: "paired", address: A };
    mount();
    await waitFor(() => expect(registerWallet).toHaveBeenCalledWith(A));
  });
  it("a failing status read registers nobody", async () => {
    readTradingStatus.mockRejectedValue(new Error("Hyperliquid info: HTTP 500"));
    session = { kind: "wallet", address: A };
    mount();
    await waitFor(() => expect(readTradingStatus).toHaveBeenCalled());
    expect(registerWallet).not.toHaveBeenCalled();
  });
  it("a paired session reads the 'hlo phone' slot, never the desktop's 'hlo' slot", async () => {
    putKey(A, DESK_KEY);
    putKey(A, PHONE_KEY, PHONE_AGENT_NAME);
    session = { kind: "paired", address: A };
    mount();
    await waitFor(() => expect(api.agent?.address).toBe(phoneAddr));
    await waitFor(() => expect(readTradingStatus).toHaveBeenCalled());
    expect(readTradingStatus.mock.calls.at(-1)![3]).toMatchObject({ address: phoneAddr });
    expect(api.exchange).toEqual({ fakeExchangeFor: PHONE_KEY });
  });
  it("a paired phone without its own key has no agent, even when an 'hlo' key exists for that master", async () => {
    putKey(A, DESK_KEY);
    session = { kind: "paired", address: A };
    mount();
    await waitFor(() => expect(readTradingStatus).toHaveBeenCalled());
    expect(api.agent).toBeNull();
    expect(api.exchange).toBeNull();
  });
  it("a paired phone cannot enable trading: canEnable is false and enable() signs nothing", async () => {
    putKey(A, PHONE_KEY, PHONE_AGENT_NAME);
    session = { kind: "paired", address: A };
    mount();
    await waitFor(() => expect(api.status).not.toBeNull());
    expect(api.canEnable).toBe(false);
    await act(async () => api.enable());
    expect(enableTrading).not.toHaveBeenCalled();
  });
  it("a desktop wallet with a live agent and the builder fee approved shows trading enabled", async () => {
    putKey(A, DESK_KEY);
    session = { kind: "wallet", address: A };
    mount();
    await waitFor(() => expect(api.status).toEqual(live));
    expect(api.agent?.address).toBe(deskAddr);
    expect(api.canEnable).toBe(true);
    expect(api.exchange).toEqual({ fakeExchangeFor: DESK_KEY });
  });
  it("a build without a builder reads no status and cannot enable", async () => {
    cfg = { ...config, builder: null };
    session = { kind: "wallet", address: A };
    mount();
    await waitFor(() => expect(api.master).toBe(A));
    expect(readTradingStatus).not.toHaveBeenCalled();
    expect(api.status).toBeNull();
    expect(api.canEnable).toBe(false);
  });
  it("switching account drops the old account's status at once, before the new one is read", async () => {
    session = { kind: "wallet", address: A };
    const { rerender } = mount();
    await waitFor(() => expect(api.status).toEqual(live));
    let release: (v: unknown) => void = () => {};
    readTradingStatus.mockImplementation(() => new Promise((r) => { release = r; }));
    session = { kind: "wallet", address: B };
    rerender(<TradingProvider><Probe /></TradingProvider>);
    expect(api.master).toBe(B);
    expect(api.status).toBeNull(); // A's "enabled" must not decide anything for B
    await act(async () => release({ ...live, builderOk: false }));
    await waitFor(() => expect(api.status?.builderOk).toBe(false));
  });
  it("a failed status read leaves the status unknown, not 'enabled'", async () => {
    session = { kind: "wallet", address: A };
    mount();
    await waitFor(() => expect(api.status).toEqual(live));
    readTradingStatus.mockRejectedValue(new Error("Hyperliquid info: HTTP 500"));
    await act(async () => api.refresh());
    expect(api.status).toBeNull();
    expect(api.error).toMatch(/HTTP 500/);
  });
  it("after a failed enable the status is read again (the builder fee may have gone through), and the error stays", async () => {
    session = { kind: "wallet", address: A };
    readTradingStatus.mockResolvedValue({ builderOk: false, maxBuilderFee: 0, agentOk: false, agentValidUntil: null });
    mount();
    await waitFor(() => expect(api.status?.builderOk).toBe(false));
    // The builder step succeeded on chain, the agent step was refused in the wallet.
    enableTrading.mockRejectedValue(Object.assign(new Error("denied"), { code: 4001 }));
    readTradingStatus.mockResolvedValue({ builderOk: true, maxBuilderFee: 100, agentOk: false, agentValidUntil: null });
    await act(async () => api.enable());
    expect(enableTrading).toHaveBeenCalledTimes(1);
    expect(enableTrading.mock.calls[0][0]).toMatchObject({ builderOk: false });
    await waitFor(() => expect(api.status?.builderOk).toBe(true));
    expect(api.error).toMatch(/cancelled/);
    // The next try skips the builder step.
    enableTrading.mockResolvedValue({ key: DESK_KEY, address: deskAddr, validUntil: 1 });
    await act(async () => api.enable());
    expect(enableTrading.mock.calls[1][0]).toMatchObject({ builderOk: true });
    expect(api.agent?.address).toBe(deskAddr);
    expect(api.error).toBeNull();
  });
});

describe("the default referral code (spec referrals §3)", () => {
  const off = { builderOk: false, maxBuilderFee: 0, agentOk: false, agentValidUntil: null };
  const fresh = { key: DESK_KEY, address: deskAddr, validUntil: 1 };
  beforeEach(() => {
    cfg = { ...config, referralCode: "HLOCFG" } as AppConfig;
    readTradingStatus.mockResolvedValue(off);
    enableTrading.mockResolvedValue(fresh);
    session = { kind: "wallet", address: A };
  });

  it("after Enable trading the new agent sets the code the Enable text showed: a ?ref= code wins over the config's", async () => {
    store.set("hlo.ref.testnet", "FRIEND1");
    mount();
    await waitFor(() => expect(api.referralCode).toBe("FRIEND1"));
    await act(async () => api.enable(api.referralCode));
    expect(applyDefaultReferrer).toHaveBeenCalledTimes(1);
    expect(applyDefaultReferrer.mock.calls[0][0]).toMatchObject({ net: "testnet", master: A, code: "FRIEND1", signer: { net: "testnet", agentKey: DESK_KEY } });
  });
  it("without a ?ref= code the config's code is shown and set; with neither, no text and nothing is sent", async () => {
    mount();
    await waitFor(() => expect(api.referralCode).toBe("HLOCFG"));
    await act(async () => api.enable(api.referralCode));
    expect(applyDefaultReferrer.mock.calls[0][0]).toMatchObject({ code: "HLOCFG" });
    cleanup();
    applyDefaultReferrer.mockClear();
    cfg = { ...config, referralCode: null } as AppConfig;
    mount();
    await waitFor(() => expect(api.status).toEqual(off));
    await act(async () => {});
    expect(api.referralCode).toBeNull();
    await act(async () => api.enable(api.referralCode));
    expect(enableTrading).toHaveBeenCalled();
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
  it("a refused setReferrer is only logged, without the key: trading is enabled and no error shows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyDefaultReferrer.mockRejectedValue(new Error("Referral code does not exist"));
    mount();
    await waitFor(() => expect(api.referralCode).toBe("HLOCFG"));
    await act(async () => api.enable(api.referralCode));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    const logged = warn.mock.calls[0].map(String).join(" ");
    expect(logged).toContain("Referral code does not exist");
    expect(logged).not.toContain(DESK_KEY.slice(2));
    expect(api.agent?.key).toBe(DESK_KEY);
    expect(api.error).toBeNull();
    warn.mockRestore();
  });
  it("a failed Enable trading sends no referral code", async () => {
    enableTrading.mockRejectedValue(new Error("You cancelled the request in your wallet."));
    mount();
    await waitFor(() => expect(api.referralCode).toBe("HLOCFG"));
    await act(async () => api.enable(api.referralCode));
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
  it("referralCode names the code while Enable trading is offered and the account has no referrer", async () => {
    mount();
    await waitFor(() => expect(api.referralCode).toBe("HLOCFG"));
    expect(readReferral).toHaveBeenCalledWith("testnet", A);
  });
  it("referralCode is null when the account has a referrer, when the read fails, and when trading is on", async () => {
    readReferral.mockResolvedValue({ referredBy: { referrer: B, code: "OTHER" } });
    mount();
    await waitFor(() => expect(readReferral).toHaveBeenCalled());
    await act(async () => {});
    expect(api.referralCode).toBeNull();
    cleanup();
    readReferral.mockReset().mockRejectedValue(new Error("Hyperliquid info: HTTP 500"));
    mount();
    await waitFor(() => expect(readReferral).toHaveBeenCalled());
    await act(async () => {});
    expect(api.referralCode).toBeNull();
    cleanup();
    readReferral.mockReset().mockResolvedValue({ referredBy: null });
    readTradingStatus.mockResolvedValue(live);
    putKey(A, DESK_KEY);
    mount();
    await waitFor(() => expect(api.status).toEqual(live));
    expect(readReferral).not.toHaveBeenCalled();
    expect(api.referralCode).toBeNull();
  });
  it("a paired phone never reads referral, shows no code, and its enable() signs and sets nothing", async () => {
    putKey(A, PHONE_KEY, PHONE_AGENT_NAME);
    session = { kind: "paired", address: A };
    mount();
    await waitFor(() => expect(api.status).toEqual(off));
    await act(async () => {});
    expect(readReferral).not.toHaveBeenCalled();
    expect(api.referralCode).toBeNull();
    await act(async () => api.enable("HLOCFG"));
    expect(enableTrading).not.toHaveBeenCalled();
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
});

describe("Enable trading sets only the code its text showed (final review I1)", () => {
  const off = { builderOk: false, maxBuilderFee: 0, agentOk: false, agentValidUntil: null };
  const fresh = { key: DESK_KEY, address: deskAddr, validUntil: 1 };
  beforeEach(() => {
    cfg = { ...config, referralCode: "HLOCFG" } as AppConfig;
    readTradingStatus.mockResolvedValue(off);
    enableTrading.mockResolvedValue(fresh);
    session = { kind: "wallet", address: A };
  });
  const enableWith = async (code: string | null | undefined) => {
    await act(async () => api.enable(code));
    expect(enableTrading).toHaveBeenCalled();
  };

  it("the status read failed: no text, and Enable (even handed a code) sends no setReferrer", async () => {
    readTradingStatus.mockRejectedValue(new Error("Hyperliquid info: HTTP 500"));
    mount();
    await waitFor(() => expect(api.error).toMatch(/HTTP 500/));
    expect(api.referralCode).toBeNull();
    expect(readReferral).not.toHaveBeenCalled();
    await enableWith(api.referralCode);
    await enableWith("HLOCFG");
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
  it("a click while the status is still loading sends no setReferrer", async () => {
    readTradingStatus.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(() => expect(readTradingStatus).toHaveBeenCalled());
    expect(api.referralCode).toBeNull();
    await enableWith(api.referralCode);
    await enableWith("HLOCFG");
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
  it("a click before the referral read answers sends no setReferrer", async () => {
    readReferral.mockImplementation(() => new Promise(() => {}));
    mount();
    await waitFor(() => expect(readReferral).toHaveBeenCalled());
    expect(api.referralCode).toBeNull();
    await enableWith(api.referralCode);
    await enableWith("HLOCFG");
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
  it("the referral read failed: no text, and Enable sends no setReferrer", async () => {
    readReferral.mockRejectedValue(new Error("Hyperliquid info: HTTP 500"));
    mount();
    await waitFor(() => expect(readReferral).toHaveBeenCalled());
    await act(async () => {});
    expect(api.referralCode).toBeNull();
    await enableWith(api.referralCode);
    await enableWith("HLOCFG");
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
  it("the re-sign path (the status still says enabled, Sign once calls enable()) sends no setReferrer", async () => {
    putKey(A, DESK_KEY);
    readTradingStatus.mockResolvedValue(live);
    mount();
    await waitFor(() => expect(api.status).toEqual(live));
    act(() => api.markReSign());
    expect(api.reSignNeeded).toBe(true);
    expect(api.referralCode).toBeNull();
    await enableWith(undefined); // what ReSignPrompt calls
    await enableWith("HLOCFG");
    expect(readReferral).not.toHaveBeenCalled();
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
  });
  it("a newer ?ref= from another tab: the code the text showed is sent, not the new one", async () => {
    mount();
    await waitFor(() => expect(api.referralCode).toBe("HLOCFG"));
    store.set("hlo.ref.testnet", "FRIEND2"); // another tab opened a ?ref= link
    await enableWith("FRIEND2"); // a code that was never shown is refused
    expect(applyDefaultReferrer).not.toHaveBeenCalled();
    await enableWith(api.referralCode);
    expect(applyDefaultReferrer).toHaveBeenCalledTimes(1);
    expect(applyDefaultReferrer.mock.calls[0][0]).toMatchObject({ code: "HLOCFG" });
  });
  it("a new read clears the previous code at once: no stale text while it is pending", async () => {
    mount();
    await waitFor(() => expect(api.referralCode).toBe("HLOCFG"));
    readTradingStatus.mockResolvedValue(live); // trading turns on: no text
    await act(async () => api.refresh());
    expect(api.referralCode).toBeNull();
    readReferral.mockImplementation(() => new Promise(() => {})); // the next read hangs
    readTradingStatus.mockResolvedValue(off); // and Enable is offered again
    await act(async () => api.refresh());
    expect(api.status).toEqual(off);
    expect(readReferral).toHaveBeenCalledTimes(2);
    expect(api.referralCode).toBeNull();
  });
});

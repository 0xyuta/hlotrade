import { describe, expect, it } from "vitest";
import {
  CHECKING_KEY_TEXT, NO_AGENT_TEXT, captureRef, chooseCode, enableReferralText, joinedText, loadRef, parseReferral, refLink, refStorageKey,
  referralGate, remainingToCreateText, usdText, validCode,
} from "../src/hl/referral";
import { PAIRED_BLOCKED_TEXT } from "../src/wallet/permissions";

const U = "0x00000000000000000000000000000000000000aa";
const R = "0x00000000000000000000000000000000000000BB";
const mem = () => {
  const m = new Map<string, string>();
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
/** Hyperliquid's `referral` answer, as nktkas types it (ReferralResponse). */
const answer = (o: Record<string, unknown> = {}) => ({
  referredBy: null, cumVlm: "2500.5", unclaimedRewards: "0.0", claimedRewards: "1.25", builderRewards: "0.0",
  referrerState: { stage: "needToTrade", data: { required: "10000.0" } }, rewardHistory: [], tokenToState: [], ...o,
});
const row = (user: string, timeJoined: number, cumVlm: string, fees: string) => ({
  cumVlm, cumRewardedFeesSinceReferred: "0.5", cumFeesRewardedToReferrer: fees, timeJoined, user, tokenToState: [],
});

describe("validCode (Hyperliquid codes: 1–20 characters; HLO allows letters and digits)", () => {
  it("takes 1–20 letters and digits only", () => {
    for (const ok of ["A", "HLO", "abc123XYZ", "A".repeat(20)]) expect(validCode(ok), ok).toBe(true);
    for (const bad of ["", "A".repeat(21), "a b", "a-b", "a_b", "é", null, undefined, 7]) expect(validCode(bad), String(bad)).toBe(false);
  });
});

describe("the ?ref= link and the chosen code", () => {
  it("keeps a valid ?ref= code under hlo.ref.<network>, per network", () => {
    const kv = mem();
    expect(captureRef("?ref=FRIEND1", kv, "testnet")).toBe("FRIEND1");
    expect(kv.m.get("hlo.ref.testnet")).toBe("FRIEND1");
    expect(refStorageKey("mainnet")).toBe("hlo.ref.mainnet");
    expect(loadRef(kv, "mainnet")).toBeNull();
  });
  it("ignores a missing or invalid ref and keeps what was stored", () => {
    const kv = mem();
    captureRef("?ref=GOOD", kv, "testnet");
    for (const s of ["", "?x=1", "?ref=", "?ref=bad-code", `?ref=${"A".repeat(21)}`, "?ref=a%20b"]) expect(captureRef(s, kv, "testnet"), s).toBe("GOOD");
  });
  it("a later valid link replaces the stored code", () => {
    const kv = mem();
    captureRef("?ref=FIRST", kv, "testnet");
    expect(captureRef("?utm_source=x&ref=SECOND", kv, "testnet")).toBe("SECOND");
  });
  it("a stored value that is not a valid code reads as none", () => {
    const kv = mem();
    kv.m.set("hlo.ref.testnet", "bad code");
    expect(loadRef(kv, "testnet")).toBeNull();
  });
  it("chooseCode: the link's code wins over the config's; invalid ones are skipped", () => {
    expect(chooseCode("FRIEND1", "HLOCFG")).toBe("FRIEND1");
    expect(chooseCode(null, "HLOCFG")).toBe("HLOCFG");
    expect(chooseCode("bad code", "HLOCFG")).toBe("HLOCFG");
    expect(chooseCode(null, null)).toBeNull();
    expect(chooseCode(null, undefined)).toBeNull();
  });
});

describe("texts", () => {
  it("the Enable trading text (spec §3, exact)", () => {
    expect(enableReferralText("HLOCFG")).toBe("Uses referral code HLOCFG on Hyperliquid: 4% off Hyperliquid's fees on your first $25M traded.");
  });
  it("how much more to trade before a code can be created", () => {
    expect(remainingToCreateText(10000, 2500.5)).toBe("Trade $7,500 more to create a code.");
    expect(remainingToCreateText(10000, 0)).toBe("Trade $10,000 more to create a code.");
    expect(remainingToCreateText(10000, 10000)).toMatch(/check again later/);
  });
  it("the share link", () => {
    expect(refLink("https://hlotrade.xyz", "MYCODE")).toBe("https://hlotrade.xyz/?ref=MYCODE");
    expect(refLink("https://hlotrade.xyz/", "MYCODE")).toBe("https://hlotrade.xyz/?ref=MYCODE");
  });
  it("USDC amounts and join dates", () => {
    expect(usdText(12.5)).toBe("$12.50");
    expect(usdText(0)).toBe("$0.00");
    expect(usdText(0.004)).toBe("<$0.01");
    expect(joinedText(Date.UTC(2026, 9, 29, 23, 59))).toBe("2026-10-29");
  });
});

describe("parseReferral", () => {
  it("needToTrade and not referred", () => {
    expect(parseReferral(answer())).toEqual({ referredBy: null, cumVlm: 2500.5, unclaimed: 0, claimed: 1.25, referrer: { stage: "needToTrade", required: 10000 } });
  });
  it("referred: the code and the referrer (lowercase)", () => {
    expect(parseReferral(answer({ referredBy: { referrer: R, code: "HLOCFG" } }))?.referredBy).toEqual({ referrer: R.toLowerCase(), code: "HLOCFG" });
  });
  it("needToCreateCode", () => {
    expect(parseReferral(answer({ referrerState: { stage: "needToCreateCode" } }))?.referrer).toEqual({ stage: "needToCreateCode" });
  });
  it("ready: the code, the count and the referred accounts, newest first", () => {
    const v = parseReferral(answer({
      referrerState: { stage: "ready", data: { code: "MYCODE", nReferrals: 2, referralStates: [row(U, 1_700_000_000_000, "1000.0", "0.25"), row(R, 1_800_000_000_000, "50000.5", "3.5")] } },
    }));
    expect(v?.referrer).toEqual({
      stage: "ready", code: "MYCODE", count: 2,
      referrals: [
        { user: R.toLowerCase(), volume: 50000.5, rewarded: 3.5, joined: 1_800_000_000_000 },
        { user: U, volume: 1000, rewarded: 0.25, joined: 1_700_000_000_000 },
      ],
    });
  });
  it("drops malformed referred rows; an unknown or malformed stage reads as unknown", () => {
    const v = parseReferral(answer({ referrerState: { stage: "ready", data: { code: "MYCODE", nReferrals: 1, referralStates: [row("0x12", 1, "1", "1"), { user: U }] } } }));
    expect(v?.referrer).toEqual({ stage: "ready", code: "MYCODE", count: 1, referrals: [] });
    // A join time that is not a real date is dropped, so the Joined column cannot throw while rendering.
    const badTimes = [9e15, Number.MAX_SAFE_INTEGER, Infinity, NaN, -1].map((t) => row(U, t, "1", "1"));
    const w = parseReferral(answer({ referrerState: { stage: "ready", data: { code: "MYCODE", nReferrals: 5, referralStates: [...badTimes, row(R, 0, "1", "1")] } } }));
    expect(w?.referrer.stage === "ready" && w.referrer.referrals.map((r) => r.user)).toEqual([R.toLowerCase()]);
    for (const r of w?.referrer.stage === "ready" ? w.referrer.referrals : []) expect(() => joinedText(r.joined)).not.toThrow();
    expect(parseReferral(answer({ referrerState: { stage: "somethingNew" } }))?.referrer).toEqual({ stage: "unknown" });
    expect(parseReferral(answer({ referrerState: { stage: "needToTrade", data: {} } }))?.referrer).toEqual({ stage: "unknown" });
  });
  it("refuses an answer it cannot read (never reads it as 'no referrer')", () => {
    for (const bad of [null, "x", [], answer({ cumVlm: "lots" }), answer({ unclaimedRewards: -1 }), answer({ referredBy: { code: "X" } }), answer({ referredBy: undefined, claimedRewards: undefined })]) {
      expect(parseReferral(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("referralGate (who may use, create and claim)", () => {
  it("a wallet with a live agent may act", () => {
    expect(referralGate({ kind: "wallet", needsAgent: true, agentReady: true })).toEqual({ allowed: true });
    expect(referralGate({ kind: "wallet", needsAgent: false, agentReady: false })).toEqual({ allowed: true });
  });
  it("a wallet without a live agent is asked to enable trading first (the agent signs), and the tab offers Enable", () => {
    expect(referralGate({ kind: "wallet", needsAgent: true, agentReady: false })).toEqual({ allowed: false, blockedText: NO_AGENT_TEXT, offerEnable: true });
  });
  it("while the trading status is still read: 'Checking…', not 'Enable trading first', and no Enable offer", () => {
    expect(referralGate({ kind: "wallet", needsAgent: true, agentReady: false, checking: true })).toEqual({ allowed: false, blockedText: CHECKING_KEY_TEXT });
    expect(referralGate({ kind: "wallet", needsAgent: true, agentReady: true, checking: true })).toEqual({ allowed: true });
  });
  it("a paired phone and no session cannot act", () => {
    expect(referralGate({ kind: "paired", needsAgent: true, agentReady: true })).toEqual({ allowed: false, blockedText: PAIRED_BLOCKED_TEXT });
    expect(referralGate({ kind: "none", needsAgent: true, agentReady: false })).toEqual({ allowed: false, blockedText: "Connect a wallet to do this." });
  });
});

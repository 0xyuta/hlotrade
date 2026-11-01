import { afterEach, describe, expect, it, vi } from "vitest";
import { messageOf } from "../src/hl/errors";
import { CODE_RULE_TEXT, NO_AGENT_TEXT } from "../src/hl/referral";
import {
  REFERRAL_SIGNER, applyDefaultReferrer, readReferral, sendClaimRewards, sendRegisterReferrer, sendSetReferrer, type ReferralSigner,
} from "../src/hl/referralActions";

const MASTER = "0x1111111111111111111111111111111111111111";
const REFERRER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"ab".repeat(32)}` as const;
const wallet = vi.fn(() => {
  throw new Error("the main wallet must not be asked");
});
const signer: ReferralSigner = { net: "testnet", agentKey: KEY, wallet };
const answer = (referredBy: unknown) => ({
  referredBy, cumVlm: "0.0", unclaimedRewards: "0.0", claimedRewards: "0.0", builderRewards: "0.0",
  referrerState: { stage: "needToCreateCode" }, rewardHistory: [], tokenToState: [],
});

/** Answers Hyperliquid's /info (referral) and /exchange; records every body posted. */
function stub(o: { info?: unknown; exchange?: unknown } = {}) {
  const posted: Record<string, any>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(init?.body ? String(init.body) : await (input as Request).clone().text());
    posted.push(body);
    const out = body.type === "referral" ? (o.info ?? answer(null)) : (o.exchange ?? { status: "ok", response: { type: "default" } });
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json" } });
  }));
  return posted;
}
const kind = (b: Record<string, any>) => b.type ?? b.action?.type;

afterEach(() => {
  vi.unstubAllGlobals();
  wallet.mockClear();
});

describe("REFERRAL_SIGNER", () => {
  it("is the agent until RF1 says otherwise (docs/APP.md §6)", () => {
    expect(REFERRAL_SIGNER).toBe("agent");
  });
});

describe("readReferral", () => {
  it("asks Hyperliquid's referral info for the user and parses the answer", async () => {
    const posted = stub({ info: answer({ referrer: REFERRER, code: "HLOCFG" }) });
    const v = await readReferral("testnet", MASTER);
    expect(posted[0]).toMatchObject({ type: "referral" });
    expect(String(posted[0].user).toLowerCase()).toBe(MASTER);
    expect(v.referredBy).toEqual({ referrer: REFERRER, code: "HLOCFG" });
  });
  it("an answer it cannot read is an error, never 'no referrer'", async () => {
    stub({ info: { referredBy: null } });
    await expect(readReferral("testnet", MASTER)).rejects.toThrow("Hyperliquid's referral answer could not be read.");
  });
});

describe("applyDefaultReferrer (after Enable trading)", () => {
  it("sends setReferrer with the code, signed by the agent, when the account has no referrer", async () => {
    const posted = stub();
    await expect(applyDefaultReferrer({ net: "testnet", master: MASTER, code: "HLOCFG", signer })).resolves.toBe("set");
    expect(posted.map(kind)).toEqual(["referral", "setReferrer"]);
    expect(posted[1].action).toEqual({ type: "setReferrer", code: "HLOCFG" });
    expect(posted[1].signature).toMatchObject({ r: expect.stringMatching(/^0x/), s: expect.stringMatching(/^0x/) });
    expect(wallet).not.toHaveBeenCalled();
  });
  it("leaves an account that already has a referrer alone (Hyperliquid keeps the first)", async () => {
    const posted = stub({ info: answer({ referrer: REFERRER, code: "OTHER" }) });
    await expect(applyDefaultReferrer({ net: "testnet", master: MASTER, code: "HLOCFG", signer })).resolves.toBe("skipped");
    expect(posted.map(kind)).toEqual(["referral"]);
  });
  it("an unreadable referral answer posts nothing: it throws, never reads as 'no referrer'", async () => {
    for (const info of [{ referredBy: null }, { ...answer(null), referredBy: { code: "X" } }, { ...answer(null), cumVlm: 5 }, "not json we know"]) {
      const posted = stub({ info });
      await expect(applyDefaultReferrer({ net: "testnet", master: MASTER, code: "HLOCFG", signer })).rejects.toThrow();
      expect(posted.map(kind), JSON.stringify(info)).toEqual(["referral"]);
    }
    expect(wallet).not.toHaveBeenCalled();
  });
  it("does nothing at all without a code", async () => {
    const posted = stub();
    await expect(applyDefaultReferrer({ net: "testnet", master: MASTER, code: null, signer })).resolves.toBe("skipped");
    expect(posted).toEqual([]);
  });
  it("a refusal reaches the caller (who only logs it)", async () => {
    stub({ exchange: { status: "err", response: "Referral code does not exist" } });
    const e = await applyDefaultReferrer({ net: "testnet", master: MASTER, code: "HLOCFG", signer }).catch((x: unknown) => x);
    expect(messageOf(e)).toContain("Referral code does not exist");
  });
});

describe("the Referrals tab's actions", () => {
  it("setReferrer refuses a code HLO does not accept, before signing", async () => {
    const posted = stub();
    await expect(sendSetReferrer(signer, "bad code")).rejects.toThrow(CODE_RULE_TEXT);
    expect(posted).toEqual([]);
  });
  it("without an agent key nothing is signed", async () => {
    const posted = stub();
    await expect(sendSetReferrer({ ...signer, agentKey: null }, "HLOCFG")).rejects.toThrow(NO_AGENT_TEXT);
    await expect(sendClaimRewards({ ...signer, agentKey: null })).rejects.toThrow(NO_AGENT_TEXT);
    expect(posted).toEqual([]);
  });
  it("registerReferrer and claimRewards post their actions, signed by the agent", async () => {
    const posted = stub();
    await sendRegisterReferrer(signer, "MYCODE");
    await sendClaimRewards(signer);
    expect(posted.map((b) => b.action)).toEqual([{ type: "registerReferrer", code: "MYCODE" }, { type: "claimRewards" }]);
    expect(wallet).not.toHaveBeenCalled();
  });
  it("Hyperliquid's refusal is thrown with its own text", async () => {
    stub({ exchange: { status: "err", response: "Referral code already registered" } });
    const e = await sendRegisterReferrer(signer, "MYCODE").catch((x: unknown) => x);
    expect(messageOf(e)).toContain("Referral code already registered");
  });
});

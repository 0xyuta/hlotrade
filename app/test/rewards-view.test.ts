import { describe, expect, it } from "vitest";
import { CLAIM_LIMIT_TEXT, PAUSED_TEXT } from "../src/hl/errors";
import { claimButton, claimGate, lastPopText, pointsNeededText, poolQueueText, vaultRuleText } from "../src/rewards/view";
import { PAIRED_BLOCKED_TEXT } from "../src/wallet/permissions";

const E18 = 10n ** 18n;
const plan = (kind: "settleAndClaim" | "claim") => ({ kind }) as never;

describe("claimButton", () => {
  it("labels by plan kind", () => {
    expect(claimButton({ plan: plan("settleAndClaim"), busy: false, allowed: true, problem: null })).toEqual({ label: "Settle & claim", disabled: false });
    expect(claimButton({ plan: plan("claim"), busy: false, allowed: true, problem: null })).toEqual({ label: "Claim", disabled: false });
  });
  it("is off with no plan, while busy, when not allowed, or with a problem", () => {
    expect(claimButton({ plan: null, busy: false, allowed: true, problem: null })).toEqual({ label: "Claim", disabled: true });
    expect(claimButton({ plan: plan("claim"), busy: true, allowed: true, problem: null })).toEqual({ label: "Confirm in your wallet…", disabled: true });
    expect(claimButton({ plan: plan("settleAndClaim"), busy: false, allowed: false, problem: null }).disabled).toBe(true);
    expect(claimButton({ plan: plan("settleAndClaim"), busy: false, allowed: true, problem: "Rewards are updating…" }).disabled).toBe(true);
  });
});

describe("claimGate", () => {
  it("a wallet, not paused: allowed", () => expect(claimGate({ canClaim: true, paired: false, paused: false })).toEqual({ allowed: true }));
  it("no wallet: connect one", () => expect(claimGate({ canClaim: false, paired: false, paused: false })).toEqual({ allowed: false, blockedText: "Connect a wallet to claim." }));
  it("a paired phone: sent to the wallet device", () => expect(claimGate({ canClaim: false, paired: true, paused: false })).toEqual({ allowed: false, blockedText: PAIRED_BLOCKED_TEXT }));
  it("paused: off, with the paused text (also for a wallet)", () => expect(claimGate({ canClaim: true, paired: false, paused: true })).toEqual({ allowed: false, blockedText: PAUSED_TEXT }));
  it("the hourly allowance is empty: off, with the limit text; paused and not-a-wallet still come first", () => {
    expect(claimGate({ canClaim: true, paired: false, paused: false, limited: true })).toEqual({ allowed: false, blockedText: CLAIM_LIMIT_TEXT });
    expect(CLAIM_LIMIT_TEXT).toBe("Claims are at their hourly limit. Try again in a few minutes.");
    expect(claimGate({ canClaim: true, paired: false, paused: true, limited: true }).blockedText).toBe(PAUSED_TEXT);
    expect(claimGate({ canClaim: false, paired: false, paused: false, limited: true }).blockedText).toBe("Connect a wallet to claim.");
  });
  it("a paired phone while paused is still told to use the wallet device", () => expect(claimGate({ canClaim: false, paired: true, paused: true }).blockedText).toBe(PAIRED_BLOCKED_TEXT));
});

describe("pointsNeededText", () => {
  it("under 1 point: the dollars of trading still needed, rounded up", () => {
    expect(pointsNeededText(79_000_000n)).toBe("You need 1 point to share in a pop: $210 more in trades.");
    expect(pointsNeededText(99_999_999n)).toBe("You need 1 point to share in a pop: $1 more in trades.");
    expect(pointsNeededText(1n)).toBe("You need 1 point to share in a pop: $1,000 more in trades.");
  });
  it("says nothing with no points or at the minimum", () => {
    expect(pointsNeededText(0n)).toBeNull();
    expect(pointsNeededText(100_000_000n)).toBeNull();
    expect(pointsNeededText(500_000_000n)).toBeNull();
  });
});

describe("vaultRuleText", () => {
  it("mainnet: 1 in 1,250, about once every 21 hours", () =>
    expect(vaultRuleText(1250)).toBe(
      "0.1 HLO goes in every minute. Every minute it has a 1 in 1,250 chance to pop (about once every 21 hours). When it pops, 90% is shared by points among wallets with at least 1 point and 10% stays for the next round. 1 point per $1,000 traded.",
    ));
  it("testnet: 1 in 60, about once an hour", () => expect(vaultRuleText(60)).toContain("a 1 in 60 chance to pop (about once an hour)"));
  it("never a gambling word", () => {
    for (const o of [1, 60, 1250]) expect(vaultRuleText(o)).not.toMatch(/jackpot|lottery|prize|motherlode|\bwins?\b/i);
  });
});

describe("lastPopText (chain time)", () => {
  const L = 1_000_000;
  const pop = (o: object = {}) => ({ minute: 9, block: "77", amount: (12n * E18).toString(), kept: E18.toString(), recipients: 41, ...o });
  it("how long ago by the chain's now (minute 9 ends at launch + 600), the amount and the traders", () =>
    expect(lastPopText(pop(), L, L + 600 + 3 * 3600 + 120)).toBe("Popped 3h 2m ago: 12.00 HLO to 41 traders."));
  it("one trader is singular", () => expect(lastPopText(pop({ recipients: 1, amount: E18.toString() }), L, L + 660)).toBe("Popped 1m 0s ago: 1.00 HLO to 1 trader."));
  it("a pop with nobody's points paid nothing", () =>
    expect(lastPopText(pop({ recipients: 0, amount: "0" }), L, L + 600 + 7200)).toBe("Popped 2h 0m ago. Nobody had 1 point, so it all stayed in the vault."));
});

describe("poolQueueText (before the pool opens)", () => {
  const p = (poolOpen: boolean, openAt: number, now: number, claimable: bigint) => poolQueueText({ poolOpen, openAt, now, claimable });
  it("something claimable and the pool not open: claim now, with the time left by chain time", () => {
    expect(p(false, 1_000_000 + 3 * 3600 + 120, 1_000_000, E18)).toBe(
      "Claim before trading opens (in 3h 2m). After it opens, claims are paid out at a fixed rate per hour, so the first week's backlog can take about 18 hours to clear, first come first served.",
    );
  });
  it("opening due but not done yet: any minute now", () => expect(p(false, 1_000_000, 1_000_100, E18)).toContain("(any minute now)"));
  it("nothing claimable, or the pool open: no notice", () => {
    expect(p(false, 1_000_000 + 3600, 1_000_000, 0n)).toBeNull();
    expect(p(true, 1_000_000 + 3600, 1_000_000, E18)).toBeNull();
  });
});

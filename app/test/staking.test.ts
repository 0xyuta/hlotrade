import { describe, expect, it } from "vitest";
import { DAY_ONE_SHARE, DRIP_TEXT, buyOutcomeText, parseHlo, phaseText, stakeSteps } from "../src/rewards/staking";

describe("staking helpers", () => {
  it("parseHlo: up to 18 decimals", () => {
    expect(parseHlo("1")).toBe(10n ** 18n);
    expect(parseHlo("0.5")).toBe(5n * 10n ** 17n);
    expect(parseHlo("1.000000000000000001")).toBe(10n ** 18n + 1n);
    expect(parseHlo("1.0000000000000000001")).toBeNull();
    expect(parseHlo("")).toBeNull();
    expect(parseHlo("-1")).toBeNull();
    expect(parseHlo("0")).toBeNull();
  });
  it("stakeSteps: approve only when the allowance is short", () => {
    expect(stakeSteps(0n, 5n)).toEqual(["approve", "stake"]);
    expect(stakeSteps(4n, 5n)).toEqual(["approve", "stake"]);
    expect(stakeSteps(5n, 5n)).toEqual(["stake"]);
  });
  it("about 63% of a new reward is out after one day of 10-minute updates (a tail, not a schedule)", () => {
    expect(DAY_ONE_SHARE).toBeGreaterThan(0.62);
    expect(DAY_ONE_SHARE).toBeLessThan(0.64);
  });
  it("the drip text says about 63% a day and that the rest trails off, and has no APR", () => {
    expect(DRIP_TEXT).toMatch(/about 63%/);
    expect(DRIP_TEXT).toMatch(/keeps trickling in after that/);
    expect(DRIP_TEXT).not.toMatch(/APR|APY|per year|annual/i);
  });
  it("phaseText words every pool phase", () => {
    expect(phaseText({ kind: "countdown", secondsLeft: 90_000 })).toBe("The pool opens in 1d 1h.");
    expect(phaseText({ kind: "canOpen" })).toBe("The pool can open now. Anyone can open it.");
    expect(phaseText({ kind: "waitingForFees" })).toBe("The pool opens with the first fee deposit.");
    expect(phaseText({ kind: "waitingForDeposit" })).toBe("Buying starts after the next fee deposit.");
    expect(phaseText({ kind: "buyDue" })).toBe("A buyback is due. Anyone can run it.");
    expect(phaseText({ kind: "nextBuy", secondsLeft: 125 })).toBe("Next buyback in 2m 5s.");
  });
});

describe("buyOutcomeText", () => {
  it("says what the mined buy() did, in three ways, and what to do when the receipt is unknown", () => {
    expect(buyOutcomeText({ kind: "bought", hloOut: 12n * 10n ** 18n, burned: 0n, toStakers: 0n })).toBe("Bought 12.00 HLO (90% burned, 10% to stakers).");
    expect(buyOutcomeText({ kind: "skipped" })).toBe("Skipped: price moved more than 2% from its 30-minute average.");
    expect(buyOutcomeText({ kind: "nothing" })).toBe("Nothing to buy right now.");
    expect(buyOutcomeText(null)).toMatch(/Check the result/);
  });
});

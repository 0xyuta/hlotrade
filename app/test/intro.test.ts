import { describe, expect, it } from "vitest";
import { introCards, INTRO_SEEN, showIntro } from "../src/rewards/intro";
import { POP_ODDS } from "../src/rewards/odds";

describe("first-visit intro rules", () => {
  it("shows once, on mainnet only", () => {
    expect(showIntro("mainnet", null)).toBe(true);
    expect(showIntro("mainnet", "something else")).toBe(true);
    expect(showIntro("mainnet", INTRO_SEEN)).toBe(false);
    expect(showIntro("testnet", null)).toBe(false); // the images carry mainnet's odds
  });
  it("four cards in order, each alt text saying what its image says, with mainnet's numbers", () => {
    const cards = introCards(POP_ODDS[999]);
    expect(cards.map((c) => c.image)).toEqual(["mining", "vault", "claim", "start"]);
    const [mining, vault, claim, start] = cards.map((c) => c.alt);
    expect(mining).toContain("1 HLO a minute, shared by fees paid.");
    expect(vault).toContain("Every minute 0.1 HLO goes in");
    expect(vault).toContain("1 in 1,250 chance to pop each minute, about once every 21 hours.");
    expect(vault).toContain("90% is shared by points and 10% stays in the vault.");
    expect(claim).toContain("A claim pays 90%.");
    expect(start).toContain("Start mining in 3 steps");
  });
  it("no fee card, and the vault's wording rule", () => {
    for (const c of introCards(1250)) {
      expect(c.alt).not.toMatch(/0\.1%|fee goes/);
      expect(c.alt).not.toMatch(/jackpot|lottery|prize|motherlode|\bwins?\b/i);
    }
  });
});

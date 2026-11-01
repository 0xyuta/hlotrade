import { popMinimum, popOdds } from "@hlo/calc";
import { describe, expect, it } from "vitest";
import { POP_MIN_UNITS } from "../src/rewards/constants";
import { POP_ODDS } from "../src/rewards/odds";

describe("POP_ODDS (the app's copy: the bundle never imports calc)", () => {
  it("is calc's popOdds for the app's two networks", () => {
    expect(Object.keys(POP_ODDS).map(Number).sort()).toEqual([998, 999]);
    for (const c of [999, 998]) expect(POP_ODDS[c], String(c)).toBe(popOdds(c));
  });
  it("POP_MIN_UNITS is calc's popMinimum on both networks", () => {
    for (const c of [999, 998]) expect(popMinimum(c).units, String(c)).toBe(POP_MIN_UNITS);
  });
});

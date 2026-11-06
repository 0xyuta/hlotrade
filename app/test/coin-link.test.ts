import { describe, expect, it } from "vitest";
import { coinFromLink } from "../src/hl/coinLink";

describe("a ?coin= link (from chart.hlotrade.xyz)", () => {
  it("reads a plain Hyperliquid perp name", () => {
    expect(coinFromLink("?coin=HYPE")).toBe("HYPE");
    expect(coinFromLink("?ref=ABC&coin=kPEPE")).toBe("kPEPE");
  });
  it("ignores anything else", () => {
    expect(coinFromLink("")).toBeNull();
    expect(coinFromLink("?coin=")).toBeNull();
    expect(coinFromLink("?coin=xyz:TSLA")).toBeNull();
    expect(coinFromLink("?coin=%3Cb%3E")).toBeNull();
    expect(coinFromLink(`?coin=${"A".repeat(21)}`)).toBeNull();
  });
});

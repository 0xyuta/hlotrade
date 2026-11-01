import { describe, expect, it } from "vitest";
import { BLOCKED_COUNTRIES, BLOCKED_REGIONS, isBlocked } from "../src/geo/blocked";

describe("isBlocked", () => {
  it("blocks the US and Ontario [T §7.1]", () => {
    expect(isBlocked("US", "CA")).toBe(true); // US state California
    expect(isBlocked("CA", "ON")).toBe(true);
  });
  it("blocks the US territories, which Cloudflare reports under their own codes", () => {
    for (const c of ["PR", "GU", "VI", "AS", "MP", "UM"]) expect(isBlocked(c, null)).toBe(true);
  });
  it("lets the rest of Canada through when the region is known", () => {
    expect(isBlocked("CA", "QC")).toBe(false);
    expect(isBlocked("CA", "bc")).toBe(false);
  });
  it("fails closed when a country with blocked regions arrives without a region", () => {
    for (const region of [null, undefined, ""]) {
      expect(isBlocked("CA", region)).toBe(true);
      expect(isBlocked("UA", region)).toBe(true);
    }
    expect(isBlocked("DE", null)).toBe(false);
  });
  it("blocks the sanctioned countries the research lists", () => {
    for (const c of ["CU", "IR", "MM", "KP", "SY"]) expect(isBlocked(c, null)).toBe(true);
  });
  it("blocks the listed Ukrainian regions (Crimea, Sevastopol, Donetsk, Luhansk), not Ukraine as a whole", () => {
    for (const r of ["43", "40", "14", "09"]) expect(isBlocked("UA", r)).toBe(true);
    expect(isBlocked("UA", "30")).toBe(false);
  });
  it("is case-insensitive and lets unknown locations through (fail-open, docs/APP.md)", () => {
    expect(isBlocked("us", null)).toBe(true);
    expect(isBlocked(undefined, undefined)).toBe(false);
    expect(isBlocked("", "")).toBe(false);
  });
  it("lists are what docs/APP.md documents", () => {
    expect([...BLOCKED_COUNTRIES].sort()).toEqual(["AS", "CU", "GU", "IR", "KP", "MM", "MP", "PR", "SY", "UM", "US", "VI"]);
    expect([...BLOCKED_REGIONS].sort()).toEqual(["CA-ON", "UA-09", "UA-14", "UA-40", "UA-43"]);
  });
});

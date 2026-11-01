import { describe, expect, it } from "vitest";
import { AVATAR_COUNT, avatarSpec } from "../src/profile/avatar";
import { validateName } from "../src/profile/name";

describe("validateName (Profiles.setName)", () => {
  it("accepts 3–16 of a-z 0-9 _", () => {
    for (const ok of ["abc", "a_b9", "x".repeat(16), "___"]) expect(validateName(ok)).toBeNull();
  });
  it("says which rule was broken: charset before length", () => {
    expect(validateName("éé")).toMatch(/only/i);
    expect(validateName("ab")).toMatch(/3 to 16/);
    expect(validateName("")).toMatch(/3 to 16/);
    expect(validateName("abc\n")).not.toBeNull();
    expect(validateName("a".repeat(16))).toBeNull();
    expect(validateName("a".repeat(17))).toMatch(/3 to 16/);
  });
  it("refuses everything else", () => {
    for (const bad of ["ab", "x".repeat(17), "Abc", "a-b", "a b", "héllo", ""]) expect(validateName(bad)).not.toBeNull();
  });
});

describe("avatarSpec", () => {
  it("gives 32 distinct avatars for ids 0–31", () => {
    expect(AVATAR_COUNT).toBe(32);
    const keys = new Set(Array.from({ length: 32 }, (_, i) => JSON.stringify(avatarSpec(i))));
    expect(keys.size).toBe(32);
  });
  it("is a pure function of the id and refuses out-of-range ids", () => {
    expect(avatarSpec(5)).toEqual(avatarSpec(5));
    expect(() => avatarSpec(32)).toThrow();
    expect(() => avatarSpec(-1)).toThrow();
  });
});

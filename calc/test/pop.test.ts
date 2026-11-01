import fc from "fast-check";
import { concat, keccak256, pad, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { popOdds, popsAt } from "../src/index.js";

describe("popOdds", () => {
  it("1,250 on 999, 60 on 998, 1 on anvil", () => {
    expect(popOdds(999)).toBe(1250);
    expect(popOdds(998)).toBe(60);
    expect(popOdds(31337)).toBe(1);
  });
  it("any other chain throws", () => {
    for (const c of [1, 0, 42161, -1]) expect(() => popOdds(c), String(c)).toThrow(/no vault pop odds for chain/);
  });
});

describe("popsAt", () => {
  const h1 = pad(toHex(1n), { size: 32 });
  it("is keccak256(bytes32 hash ‖ uint256 minute) mod odds == 0 (abi.encodePacked of the two is 64 bytes)", () => {
    const k = keccak256(concat([h1, pad(toHex(5n), { size: 32 })]));
    expect(k).toBe("0x1471eb6eb2c5e789fc3de43f8ce62938c7d1836ec861730447e2ada8fd81017b");
    expect(BigInt(k) % 1250n).toBe(871n);
    expect(popsAt(h1, 5, 1250)).toBe(false);
    expect(popsAt(h1, 5, 1)).toBe(true);
  });
  it("agrees with the 64-byte form for any hash, minute and odds", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.integer({ min: 0, max: 10_000_000 }), fc.integer({ min: 1, max: 2000 }), (bytes, m, odds) => {
        const h = toHex(bytes) as Hex;
        const want = BigInt(keccak256(concat([h, pad(toHex(BigInt(m)), { size: 32 })]))) % BigInt(odds) === 0n;
        expect(popsAt(h, m, odds)).toBe(want);
      }),
    );
  });
  it("the minute is in the hash: one block hash draws separately for two minutes", () => {
    const draws = Array.from({ length: 200 }, (_, m) => popsAt(h1, m, 2));
    expect(draws.some(Boolean)).toBe(true);
    expect(draws.some((x) => !x)).toBe(true);
  });
});

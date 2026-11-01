import { describe, expect, it } from "vitest";
import { NOT_A_CODE, PAIR_CODE_HEX_LENGTH, groupPairCode, pairChecksum, pairCodeHex, pairQrText, parsePairCode } from "../src/hl/pairCode";

const KEY = `0x${"cd".repeat(32)}` as const;
const AGENT = "0x89AEF553A06ab0C3173e79DE1Ce241A9ed3b992C";

describe("the pairing code", () => {
  it("checksum: 2 bytes of keccak256('hlo pair' ‖ key), pinned", () => {
    expect(pairChecksum(KEY)).toBe("f336");
    expect(pairChecksum(`0x${"ef".repeat(32)}`)).toBe("86e6");
  });
  it("the QR text is the prefix, the network and 68 hex characters, and is not a URL", () => {
    const t = pairQrText("testnet", KEY);
    expect(t).toBe(`hlo pairing code testnet ${"cd".repeat(32)}f336`);
    expect(() => new URL(t)).toThrow();
    expect(t).not.toMatch(/[:/#?]/);
  });
  it("the typed form is 17 groups of 4 that join back to the code", () => {
    const g = groupPairCode(pairCodeHex(KEY));
    expect(pairCodeHex(KEY)).toHaveLength(PAIR_CODE_HEX_LENGTH);
    expect(g).toHaveLength(17);
    expect(g.every((x) => x.length === 4)).toBe(true);
    expect(g.join("")).toBe(pairCodeHex(KEY));
  });
});

describe("parsePairCode", () => {
  it("reads the QR text and derives the agent address", () => {
    expect(parsePairCode(pairQrText("testnet", KEY), "testnet")).toEqual({ ok: true, key: KEY, agent: AGENT });
  });
  it("reads a typed code with spaces, dashes and capitals", () => {
    const typed = groupPairCode(pairCodeHex(KEY)).join(" - ").toUpperCase();
    expect(parsePairCode(`  ${typed}  `, "testnet")).toEqual({ ok: true, key: KEY, agent: AGENT });
  });
  it("refuses a code made for the other network", () => {
    // discard: a whole key that can never pair here, so a typed field lets it go (Task 7 review m3)
    expect(parsePairCode(pairQrText("mainnet", KEY), "testnet")).toEqual({ ok: false, reason: "This code is for mainnet, but this is the testnet app.", discard: true });
  });
  it("catches a typo with the checksum", () => {
    const bad = pairCodeHex(KEY).replace(/^c/, "d");
    expect(parsePairCode(bad, "testnet")).toMatchObject({ ok: false, reason: expect.stringMatching(/typo/) });
    expect(parsePairCode(bad, "testnet")).not.toHaveProperty("discard"); // kept for correcting
  });
  it("names the length when characters are missing or extra", () => {
    expect(parsePairCode(pairCodeHex(KEY).slice(1), "testnet")).toMatchObject({ ok: false, reason: expect.stringMatching(/68 characters; this has 67/) });
  });
  it("a URL (for example the computer's link QR) is not a pairing code", () => {
    expect(parsePairCode("https://hlo.example/pair", "testnet")).toEqual({ ok: false, reason: NOT_A_CODE });
    expect(parsePairCode("hlo pairing code testnet", "testnet")).toEqual({ ok: false, reason: NOT_A_CODE });
    expect(parsePairCode("", "testnet")).toEqual({ ok: false, reason: NOT_A_CODE });
  });
  it("refuses a key that is not a valid secp256k1 key, even with a matching checksum (review M8)", () => {
    const N = `0x${"fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"}` as const;
    for (const k of [`0x${"0".repeat(64)}`, N, `0x${"f".repeat(64)}`] as const) {
      expect(parsePairCode(k.slice(2) + pairChecksum(k), "testnet")).toMatchObject({ ok: false, reason: expect.stringMatching(/not a valid key/) });
    }
  });
});

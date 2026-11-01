import { ExchangeClient, HttpTransport } from "@nktkas/hyperliquid";
import { describe, expect, it } from "vitest";
import { EMPTY_ERROR_TEXT, isChainMismatch, messageOf, plainError, walletCodes } from "../src/hl/errors";
import { injectedHlWallet } from "../src/hl/injected";

const AGENT = "0xF56B000000000000000000000000000000006DD2";
const missing = (addr: string) => ({ response: { status: "err", response: `User or API Wallet ${addr} does not exist.` } });

describe("plainError", () => {
  it("an unknown or expired agent asks for one re-sign [T §2.4]", () => {
    const r = plainError(missing(AGENT.toLowerCase()), AGENT);
    expect(r.reSign).toBe(true);
    expect(r.text).toContain("Sign once");
  });
  it("an abbreviated address in the live text still asks for a re-sign (review I2)", () => {
    for (const ell of ["…", "..."]) {
      const r = plainError(missing(`0xf56b${ell}6dd2`), AGENT);
      expect(r.reSign).toBe(true);
      expect(r.text).toContain("Sign once");
    }
  });
  it("an abbreviated address that is not ours is a signing problem", () => {
    const r = plainError(missing("0x1111…2222"), AGENT);
    expect(r.reSign).toBe(false);
    expect(r.text).toContain("signature");
  });
  it("a shortened address with fewer than 4 digits on a side is not taken as ours (carry T5)", () => {
    for (const short of ["0xf56b…", "0xf…6dd2", "0xf56…6dd2", "0xf56b…dd2"]) {
      const r = plainError(missing(short), AGENT);
      expect(r.reSign, short).toBe(false);
      expect(r.text, short).toContain("signature");
    }
    expect(plainError(missing("0xf56b0…06dd2"), AGENT).reSign).toBe(true); // more digits than 4 still match
  });
  it("an error with no text gets a plain fallback, never an empty message (carry T5)", () => {
    expect(EMPTY_ERROR_TEXT).toBe("Something went wrong. Try again.");
    expect(plainError(new Error("")).text).toBe(EMPTY_ERROR_TEXT);
    expect(plainError("   ").text).toBe(EMPTY_ERROR_TEXT);
    expect(plainError(new Error("")).raw).toBe("");
  });
  it("a different recovered address is a signing problem, not a re-sign", () => {
    const r = plainError(missing("0x1111111111111111111111111111111111111111"), AGENT);
    expect(r.reSign).toBe(false);
    expect(r.text).toContain("signature");
  });
  it("maps common exchange errors to plain words", () => {
    expect(plainError(new Error("Order must have minimum value of $10.")).text).toBe("Orders must be worth at least $10.");
    expect(plainError("Must deposit before performing actions. User: 0xabc").text).toContain("Deposit USDC");
    expect(plainError({ code: 4001, message: "User rejected the request." }).text).toBe("You cancelled the request in your wallet.");
    expect(plainError(new Error("Order was never placed, already canceled, or filled.")).text).toBe("That order is no longer open.");
  });
  it("passes unknown text through, trimmed", () => {
    expect(plainError(new Error("Something odd")).text).toBe("Something odd");
    expect(plainError(new Error("x".repeat(500))).text.length).toBeLessThanOrEqual(200);
  });
  it("anchored rules do not catch unrelated words (pre-flight N6)", () => {
    expect(plainError(new Error("stick figure")).text).toBe("stick figure");
    expect(plainError(new Error("builder of things")).text).toBe("builder of things");
    expect(plainError(new Error("Builder fee has not been approved")).text).toContain("Enable trading");
    expect(plainError(new Error("Price must be divisible by tick size 0.1")).text).toContain("too many digits");
  });
  it("keeps the raw text next to the plain words (review M1)", () => {
    expect(plainError(new Error("Order must have minimum value of $10.")).raw).toBe("Order must have minimum value of $10.");
  });
  it("a builder-fee cap error is not told to approve again", () => {
    expect(plainError(new Error("Builder fee exceeds approved max")).text).toBe("Builder fee exceeds approved max");
  });
  it("messageOf never gives [object Object] (review I3)", () => {
    expect(messageOf({ error: "x" })).toBe("x");
    expect(messageOf({ code: 1 })).toBe('{"code":1}');
    expect(messageOf({})).toBe("{}");
    expect(messageOf({ response: { data: { statuses: [{ error: "E" }] } } })).toContain('"error":"E"');
    expect(messageOf({ a: "y".repeat(500) }).length).toBeLessThanOrEqual(200);
    expect(messageOf(null)).toBe("null");
    expect(messageOf(undefined)).toBe("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(messageOf(cyclic)).not.toBe("[object Object]");
  });
  it("messageOf reads nktkas-style and plain errors", () => {
    expect(messageOf({ response: "flat" })).toBe("flat");
    expect(messageOf(new Error("m"))).toBe("m");
    expect(messageOf(42)).toBe("42");
  });
});

// nktkas wraps every wallet failure: AbstractWalletError("Failed to sign the typed data using the wallet", { cause }).
describe("errors wrapped by nktkas (review I1)", () => {
  const BUILDER = "0x2222222222222222222222222222222222222222";
  const ACCOUNT = "0x1111111111111111111111111111111111111111";
  const approve = (wallet: { request(a: { method: string }): Promise<unknown> }) =>
    new ExchangeClient({ transport: new HttpTransport({ isTestnet: true }), wallet: injectedHlWallet(wallet, ACCOUNT) as never })
      .approveBuilderFee({ builder: BUILDER, maxFeeRate: "0.1%" })
      .then(() => null, (e: unknown) => e);

  it("a real AbstractWalletError around {code: 4001} reads as a cancel", async () => {
    const e = await approve({
      request: async (a) => (a.method === "eth_chainId" ? "0xa4b1" : Promise.reject(Object.assign(new Error("User denied message signature."), { code: 4001 }))),
    });
    expect((e as Error).name).toBe("AbstractWalletError");
    expect((e as Error).message).toContain("Failed to sign the typed data");
    expect(walletCodes(e)).toContain(4001);
    expect(plainError(e).text).toBe("You cancelled the request in your wallet.");
  });
  it("a real wrapped chain-mismatch error shows the wallet's own cause, plainly", async () => {
    const e = await approve({
      request: async (a) =>
        a.method === "eth_chainId" ? "0x3e7" : Promise.reject(Object.assign(new Error('Provided chainId "999" must match the active chainId "42161"'), { code: -32603 })),
    });
    expect(messageOf(e)).toBe('Provided chainId "999" must match the active chainId "42161"');
    expect(isChainMismatch(e)).toBe(true);
    expect(plainError(e).text).toBe("Your wallet switched networks while signing. Try again.");
  });
  it("a wallet error with an unreadable code still shows its message, not the wrapper's", async () => {
    const e = await approve({ request: async (a) => (a.method === "eth_chainId" ? "0x1" : Promise.reject(new Error("Wallet is locked"))) });
    expect(plainError(e).text).toBe("Wallet is locked");
  });
  it("walks at most 5 causes, survives cycles, and 4001 deep in the chain still cancels", () => {
    let e: Record<string, unknown> = { message: "innermost", code: 4001 };
    for (let i = 0; i < 4; i++) e = { message: `wrap ${i}`, cause: e };
    expect(plainError(e).text).toBe("You cancelled the request in your wallet.");
    const cyc: Record<string, unknown> = { name: "AbstractWalletError", message: "Failed to sign the typed data using the wallet" };
    cyc.cause = cyc;
    expect(typeof messageOf(cyc)).toBe("string");
    expect(walletCodes(cyc)).toEqual([]);
    let deep: Record<string, unknown> = { message: "too deep", code: 4001 };
    for (let i = 0; i < 7; i++) deep = { message: `wrap ${i}`, cause: deep };
    expect(plainError(deep).text).not.toBe("You cancelled the request in your wallet.");
  });
  it("only wrappers are looked through: an ordinary Error with a cause keeps its own message", () => {
    expect(messageOf(new Error("outer", { cause: new Error("inner") }))).toBe("outer");
  });
});

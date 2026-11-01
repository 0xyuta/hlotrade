import { describe, expect, it, vi } from "vitest";
import { MIN_BUILDER_FEE, chainIdFor, hlApiFor, parseRegisterBody, registryKey, registryLogKey } from "../src/register/rules";
import { registerWallet } from "../src/hl/register";

const A = "0x00000000000000000000000000000000000000aa" as const;
const MIXED = "0x00000000000000000000000000000000000000Aa" as const;

describe("register rules", () => {
  it("the key is the literal ops reads (lowercase address)", () => {
    expect(registryKey(998, A)).toBe("registry/998/0x00000000000000000000000000000000000000aa.json");
    expect(registryKey(999, MIXED)).toBe("registry/999/0x00000000000000000000000000000000000000aa.json");
  });
  it("the index key is the literal ops reads: chain, registeredAt to 10 digits, lowercase address", () => {
    expect(registryLogKey(998, 1800000000, A)).toBe("registry-log/998/1800000000-0x00000000000000000000000000000000000000aa.json");
    expect(registryLogKey(999, 1800000000, MIXED)).toBe("registry-log/999/1800000000-0x00000000000000000000000000000000000000aa.json");
  });
  it("the index key pads a small registeredAt to 10 digits, so keys sort by time", () => {
    expect(registryLogKey(998, 5, A)).toBe("registry-log/998/0000000005-0x00000000000000000000000000000000000000aa.json");
    expect(registryLogKey(998, 999, A) < registryLogKey(998, 1000, A)).toBe(true);
  });
  it("parseRegisterBody accepts exactly {user: address} and lowercases it", () => {
    expect(parseRegisterBody({ user: MIXED })).toBe(A);
    expect(parseRegisterBody({ user: A })).toBe(A);
  });
  it("parseRegisterBody rejects a bad address, extra keys and non-objects", () => {
    for (const bad of [null, undefined, "x", 7, [], [A], {}, { user: 1 }, { user: "0x12" }, { user: A + "00" }, { user: "00000000000000000000000000000000000000aa" },
      { user: "0xzz00000000000000000000000000000000000000" }, { user: A, extra: 1 }, { user: A, registeredAt: 1 }]) {
      expect(parseRegisterBody(bad)).toBeNull();
    }
  });
  it("chain ids, Hyperliquid hosts and the fee floor", () => {
    expect(chainIdFor("mainnet")).toBe(999);
    expect(chainIdFor("testnet")).toBe(998);
    expect(hlApiFor("mainnet")).toBe("https://api.hyperliquid.xyz");
    expect(hlApiFor("testnet")).toBe("https://api.hyperliquid-testnet.xyz");
    expect(MIN_BUILDER_FEE).toBe(100);
  });
});

function fakeStorage(): Storage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  } as unknown as Storage & { map: Map<string, string> };
}
const reply = (status: number) => ({ ok: status >= 200 && status < 300, status }) as Response;

describe("registerWallet", () => {
  it("posts {user} (lowercase) to /api/register once per session and sets the flag on a 200", async () => {
    const f = vi.fn().mockResolvedValue(reply(200));
    const s = fakeStorage();
    await registerWallet(MIXED, f as unknown as typeof fetch, s);
    await registerWallet(A, f as unknown as typeof fetch, s);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("/api/register");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({ user: A });
    expect(s.map.get(`hlo.registered.${A}`)).toBe("1");
  });
  it("does not set the flag on a 500, so the next call tries again", async () => {
    const f = vi.fn().mockResolvedValue(reply(500));
    const s = fakeStorage();
    await registerWallet(A, f as unknown as typeof fetch, s);
    expect(s.map.size).toBe(0);
    await registerWallet(A, f as unknown as typeof fetch, s);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("swallows a network error and leaves the flag unset", async () => {
    const f = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const s = fakeStorage();
    await expect(registerWallet(A, f as unknown as typeof fetch, s)).resolves.toBeUndefined();
    expect(s.map.size).toBe(0);
  });
  it("works without any storage (private mode)", async () => {
    const f = vi.fn().mockResolvedValue(reply(200));
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } } as unknown as Storage;
    await expect(registerWallet(A, f as unknown as typeof fetch, broken)).resolves.toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
  });
});

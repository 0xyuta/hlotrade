import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Address, Network } from "../src/config/validate";
import { PHONE_AGENT_NAME, agentStorageKey, loadAgent, loadPaired, pairedKey, saveAgent, savePaired } from "../src/hl/agent";
import { pairQrText } from "../src/hl/pairCode";
import { LOST_TEXT, STORAGE_BLOCKED, cancelPairing, confirmPairing, resolveStagedMaster, stagePairCode } from "../src/hl/pairing";

const A = "0x00000000000000000000000000000000000000aa";
const B = "0x00000000000000000000000000000000000000bb";
const KEY = `0x${"cd".repeat(32)}` as const;
const OLD = `0x${"ef".repeat(32)}` as const;
const AGENT = "0x89AEF553A06ab0C3173e79DE1Ce241A9ed3b992C";
const CODE = pairQrText("testnet", KEY);

/** Like browserKV: never throws; `drop` names keys whose writes the browser silently refuses. */
function store(drop: (k: string) => boolean = () => false) {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void (drop(k) ? undefined : m.set(k, v)),
    removeItem: (k: string) => void m.delete(k),
  };
}
const lookup = vi.fn<(net: Network, agent: Address) => Promise<Address | null>>(async () => A);

beforeEach(() => {
  cancelPairing();
  lookup.mockReset().mockResolvedValue(A);
});

describe("staging and resolving", () => {
  it("stage parses the code and keeps the key in memory only; the answer carries the agent, not the key", () => {
    const r = stagePairCode(CODE, "testnet");
    expect(r).toEqual({ ok: true, agent: AGENT });
    expect(JSON.stringify(r)).not.toContain("cdcd");
  });
  it("a bad code stages nothing", async () => {
    expect(stagePairCode("https://x/pair", "testnet").ok).toBe(false);
    expect(await resolveStagedMaster(lookup)).toEqual({ ok: false, reason: LOST_TEXT, retry: false });
  });
  it("resolve asks Hyperliquid for the agent's master", async () => {
    stagePairCode(CODE, "testnet");
    expect(await resolveStagedMaster(lookup)).toEqual({ ok: true, master: A });
    expect(lookup).toHaveBeenCalledWith("testnet", AGENT);
  });
  it("an agent Hyperliquid does not know: refused, nothing kept", async () => {
    lookup.mockResolvedValueOnce(null);
    stagePairCode(CODE, "testnet");
    expect(await resolveStagedMaster(lookup)).toMatchObject({ ok: false, retry: false, reason: expect.stringMatching(/not know this code/) });
    expect(confirmPairing(store())).toBeNull();
  });
  it("Hyperliquid unreachable: retry keeps the staged key", async () => {
    lookup.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    stagePairCode(CODE, "testnet");
    expect(await resolveStagedMaster(lookup)).toMatchObject({ ok: false, retry: true });
    expect(await resolveStagedMaster(lookup)).toEqual({ ok: true, master: A });
  });
  it("a cancel or a new scan while Hyperliquid answers wins over the old answer", async () => {
    let release: (v: `0x${string}`) => void = () => {};
    lookup.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    stagePairCode(CODE, "testnet");
    const pending = resolveStagedMaster(lookup);
    cancelPairing();
    release(A);
    expect(await pending).toEqual({ ok: false, reason: LOST_TEXT, retry: false });
  });
});

describe("confirmPairing", () => {
  const staged = async () => {
    stagePairCode(CODE, "testnet");
    await resolveStagedMaster(lookup);
  };
  it("stores the phone's key in the 'hlo phone' slot and the paired master, then forgets the key", async () => {
    await staged();
    const kv = store();
    expect(confirmPairing(kv)).toBe(A);
    expect(loadAgent(kv, "testnet", A, PHONE_AGENT_NAME)).toEqual({ key: KEY, address: AGENT, validUntil: 0 });
    expect(loadAgent(kv, "testnet", A)).toBeNull(); // never the computer's "hlo" slot
    expect(loadPaired(kv, "testnet")).toBe(A);
    expect([...kv.m.keys()].sort()).toEqual([agentStorageKey("testnet", A, PHONE_AGENT_NAME), pairedKey("testnet")].sort());
    expect(confirmPairing(kv)).toBeNull();
  });
  it("nothing before the master is known", () => {
    stagePairCode(CODE, "testnet");
    expect(confirmPairing(store())).toBeNull();
  });
  it("pairing to a new master removes the previous master's phone key from this device", async () => {
    const kv = store();
    savePaired(kv, "testnet", B);
    saveAgent(kv, "testnet", B, { key: OLD, address: "0x2C581A028cedc657Fd1b754aB9DE4eaAF9c6Ca5D", validUntil: 0 }, PHONE_AGENT_NAME);
    await staged();
    expect(confirmPairing(kv)).toBe(A);
    expect(loadAgent(kv, "testnet", B, PHONE_AGENT_NAME)).toBeNull();
    expect(loadPaired(kv, "testnet")).toBe(A);
  });
  it("E3: the paired flag is not kept → STORAGE_BLOCKED, and the earlier pairing (to B) is restored, not cleared", async () => {
    const kv = store((k) => k === pairedKey("testnet"));
    kv.m.set(pairedKey("testnet"), B);
    kv.m.set(agentStorageKey("testnet", B, PHONE_AGENT_NAME), JSON.stringify({ key: OLD, validUntil: 0 }));
    await staged();
    expect(confirmPairing(kv)).toBe(STORAGE_BLOCKED);
    expect(kv.m.get(pairedKey("testnet"))).toBe(B);
    expect(loadAgent(kv, "testnet", B, PHONE_AGENT_NAME)?.key).toBe(OLD);
    expect(kv.m.has(agentStorageKey("testnet", A, PHONE_AGENT_NAME))).toBe(false);
  });
  it("E3: re-pairing the same master when the key is not kept leaves the old key and the flag as they were", async () => {
    const kv = store((k) => k === agentStorageKey("testnet", A, PHONE_AGENT_NAME));
    kv.m.set(pairedKey("testnet"), A);
    kv.m.set(agentStorageKey("testnet", A, PHONE_AGENT_NAME), JSON.stringify({ key: OLD, validUntil: 0 }));
    await staged();
    expect(confirmPairing(kv)).toBe(STORAGE_BLOCKED);
    expect(loadAgent(kv, "testnet", A, PHONE_AGENT_NAME)?.key).toBe(OLD);
    expect(kv.m.get(pairedKey("testnet"))).toBe(A);
  });
  it("E3: the new key is refused but the flag write to the new master lands → the flag goes back to the earlier master exactly", async () => {
    const kv = store((k) => k === agentStorageKey("testnet", A, PHONE_AGENT_NAME));
    const oldEntry = JSON.stringify({ key: OLD, validUntil: 0 });
    kv.m.set(pairedKey("testnet"), B);
    kv.m.set(agentStorageKey("testnet", B, PHONE_AGENT_NAME), oldEntry);
    await staged();
    expect(confirmPairing(kv)).toBe(STORAGE_BLOCKED);
    expect(kv.m.get(pairedKey("testnet"))).toBe(B);
    expect(kv.m.get(agentStorageKey("testnet", B, PHONE_AGENT_NAME))).toBe(oldEntry);
    expect(kv.m.has(agentStorageKey("testnet", A, PHONE_AGENT_NAME))).toBe(false);
    expect(kv.m.size).toBe(2);
  });
  it("E3: a first pairing that is not kept leaves nothing behind", async () => {
    const kv = store(() => true);
    await staged();
    expect(confirmPairing(kv)).toBe(STORAGE_BLOCKED);
    expect(kv.m.size).toBe(0);
  });
  it("cancel forgets the key", async () => {
    await staged();
    cancelPairing();
    expect(confirmPairing(store())).toBeNull();
  });
});

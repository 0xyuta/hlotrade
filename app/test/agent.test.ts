import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  AGENT_NAME, PHONE_AGENT_NAME, agentNameWithExpiry, agentStorageKey, clearAgent, clearPhoneRecord, loadAgent, loadPaired, loadPhoneRecord, phoneRecordKey,
  saveAgent, savePaired, savePhoneRecord,
} from "../src/hl/agent";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const MASTER = "0x00000000000000000000000000000000000000AA";

describe("agent storage", () => {
  it("is keyed by network and lowercase master", () => {
    expect(agentStorageKey("testnet", MASTER)).toBe("hlo:agent:testnet:0x00000000000000000000000000000000000000aa");
  });
  it("round-trips and derives the address from the key", () => {
    const kv = mem();
    const key = generatePrivateKey();
    saveAgent(kv, "mainnet", MASTER, { key, address: privateKeyToAccount(key).address, validUntil: 123 });
    expect(loadAgent(kv, "mainnet", MASTER)).toEqual({ key, address: privateKeyToAccount(key).address, validUntil: 123 });
    expect(loadAgent(kv, "testnet", MASTER)).toBeNull();
    clearAgent(kv, "mainnet", MASTER);
    expect(loadAgent(kv, "mainnet", MASTER)).toBeNull();
  });
  it("ignores garbage", () => {
    const kv = mem();
    kv.setItem(agentStorageKey("mainnet", MASTER), '{"key":"0x12"}');
    expect(loadAgent(kv, "mainnet", MASTER)).toBeNull();
  });
  it("names the agent with an expiry in ms [T §2.2]", () => {
    expect(agentNameWithExpiry(1800000000000)).toBe("hlo valid_until 1800000000000");
    expect(agentNameWithExpiry(1800000000000, AGENT_NAME)).toBe("hlo valid_until 1800000000000");
  });
});

describe("two agent names: the desktop's 'hlo' and the paired phone's 'hlo phone'", () => {
  it("names differ, and the phone's carries its own expiry", () => {
    expect(PHONE_AGENT_NAME).toBe("hlo phone");
    expect(PHONE_AGENT_NAME).not.toBe(AGENT_NAME);
    expect(agentNameWithExpiry(1800000000000, PHONE_AGENT_NAME)).toBe("hlo phone valid_until 1800000000000");
  });
  it("storage slots are separate per name, and the default slot is the one the key format above names", () => {
    expect(agentStorageKey("mainnet", MASTER, AGENT_NAME)).toBe(agentStorageKey("mainnet", MASTER));
    expect(agentStorageKey("mainnet", MASTER, PHONE_AGENT_NAME)).not.toBe(agentStorageKey("mainnet", MASTER));
    expect(agentStorageKey("mainnet", MASTER, PHONE_AGENT_NAME)).toBe("hlo:agent:mainnet:0x00000000000000000000000000000000000000aa:hlo phone");
  });
  it("holds both keys at once, loads and clears each independently", () => {
    const kv = mem();
    const k1 = generatePrivateKey();
    const k2 = generatePrivateKey();
    saveAgent(kv, "mainnet", MASTER, { key: k1, address: privateKeyToAccount(k1).address, validUntil: 1 });
    saveAgent(kv, "mainnet", MASTER, { key: k2, address: privateKeyToAccount(k2).address, validUntil: 2 }, PHONE_AGENT_NAME);
    expect(loadAgent(kv, "mainnet", MASTER)?.key).toBe(k1);
    expect(loadAgent(kv, "mainnet", MASTER, PHONE_AGENT_NAME)).toEqual({ key: k2, address: privateKeyToAccount(k2).address, validUntil: 2 });
    clearAgent(kv, "mainnet", MASTER, PHONE_AGENT_NAME);
    expect(loadAgent(kv, "mainnet", MASTER, PHONE_AGENT_NAME)).toBeNull();
    expect(loadAgent(kv, "mainnet", MASTER)?.key).toBe(k1);
  });
});

describe("paired master (on a phone)", () => {
  it("is stored lowercase per network", () => {
    const kv = mem();
    savePaired(kv, "testnet", MASTER);
    expect(loadPaired(kv, "testnet")).toBe("0x00000000000000000000000000000000000000aa");
    expect(loadPaired(kv, "mainnet")).toBeNull();
  });
});

describe("the computer's record of its paired phone (Plan 4 ruling 4)", () => {
  it("holds the phone agent's address and expiry, keyed by network and lowercase master, never a key", () => {
    const kv = mem();
    savePhoneRecord(kv, "testnet", MASTER, { address: "0x2C581A028cedc657Fd1b754aB9DE4eaAF9c6Ca5D", validUntil: 9 });
    expect(phoneRecordKey("testnet", MASTER)).toBe("hlo:phone:testnet:0x00000000000000000000000000000000000000aa");
    expect(loadPhoneRecord(kv, "testnet", MASTER)).toEqual({ address: "0x2c581a028cedc657fd1b754ab9de4eaaf9c6ca5d", validUntil: 9 });
    expect(loadPhoneRecord(kv, "mainnet", MASTER)).toBeNull();
    clearPhoneRecord(kv, "testnet", MASTER);
    expect(loadPhoneRecord(kv, "testnet", MASTER)).toBeNull();
  });
  it("ignores garbage", () => {
    const kv = mem();
    kv.setItem(phoneRecordKey("testnet", MASTER), "{");
    expect(loadPhoneRecord(kv, "testnet", MASTER)).toBeNull();
    kv.setItem(phoneRecordKey("testnet", MASTER), JSON.stringify({ address: "0x12", validUntil: 1 }));
    expect(loadPhoneRecord(kv, "testnet", MASTER)).toBeNull();
  });
});

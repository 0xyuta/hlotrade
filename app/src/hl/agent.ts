import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Network } from "../config/validate";

export type KVS = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** localStorage that never throws (private mode, blocked storage). */
export const browserKV: KVS = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // storage blocked: the agent lives for this page only
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // nothing stored
    }
  },
};

export interface StoredAgent {
  key: Hex;
  address: Address;
  validUntil: number; // ms; 0 = unknown (a paired phone, which receives only the key)
}

/**
 * Each device has its own named agent, so no two devices share a nonce stream and the phone can be revoked alone.
 * The desktop's is "hlo"; the paired phone's is "hlo phone", approved by the main wallet at pairing (Task 9).
 * Approving the same name again replaces that agent; a different name leaves the other in place [T §2.2 "API wallet
 * pruning"]. An account may hold up to 3 named agents [T §2.2], so two names fit.
 */
export const AGENT_NAME = "hlo";
export const PHONE_AGENT_NAME = "hlo phone";
export type AgentName = typeof AGENT_NAME | typeof PHONE_AGENT_NAME;
/** [T §2.2] valid_until may be at most 180 days ahead; 179 leaves a margin for clock skew. The computer's "hlo" agent. */
export const AGENT_VALID_DAYS = 179;
/**
 * The phone's "hlo phone" agent. 30 days keeps a lost or forgotten phone's reach short; re-pairing costs one signature,
 * and the computer can cut the phone off at any time (Plan 4 B).
 */
export const PHONE_AGENT_VALID_DAYS = 30;

const KEY = /^0x[0-9a-fA-F]{64}$/;

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** The default name keeps the original key format; any other name is a suffix, so slots never collide. */
export const agentStorageKey = (net: Network, master: string, agent: AgentName = AGENT_NAME) => {
  const base = `hlo:agent:${net}:${master.toLowerCase()}`;
  return agent === AGENT_NAME ? base : `${base}:${agent}`;
};
/** The `agentName` sent to approveAgent: "<name> valid_until <ms>" [T §2.2]. */
export const agentNameWithExpiry = (validUntilMs: number, agent: AgentName = AGENT_NAME) => `${agent} valid_until ${validUntilMs}`;

export function loadAgent(kv: KVS, net: Network, master: string, agent: AgentName = AGENT_NAME): StoredAgent | null {
  try {
    const v = JSON.parse(kv.getItem(agentStorageKey(net, master, agent)) ?? "null") as { key?: unknown; validUntil?: unknown } | null;
    if (!v || typeof v.key !== "string" || !KEY.test(v.key)) return null;
    const key = v.key as Hex;
    return { key, address: privateKeyToAccount(key).address, validUntil: typeof v.validUntil === "number" ? v.validUntil : 0 };
  } catch {
    return null;
  }
}
export const saveAgent = (kv: KVS, net: Network, master: string, a: StoredAgent, agent: AgentName = AGENT_NAME) =>
  kv.setItem(agentStorageKey(net, master, agent), JSON.stringify({ key: a.key, validUntil: a.validUntil }));
export const clearAgent = (kv: KVS, net: Network, master: string, agent: AgentName = AGENT_NAME) =>
  kv.removeItem(agentStorageKey(net, master, agent));

export const pairedKey = (net: Network) => `hlo:paired:${net}`;
export function loadPaired(kv: KVS, net: Network): Address | null {
  const v = kv.getItem(pairedKey(net));
  return v && ADDR.test(v) ? (v.toLowerCase() as Address) : null;
}
export const savePaired = (kv: KVS, net: Network, master: Address) => kv.setItem(pairedKey(net), master.toLowerCase());
export const clearPaired = (kv: KVS, net: Network) => kv.removeItem(pairedKey(net));

/** What the computer remembers about the phone it paired (Plan 4 ruling 4): never its key. */
export interface PhoneRecord {
  address: Address;
  validUntil: number; // ms
}
export const phoneRecordKey = (net: Network, master: string) => `hlo:phone:${net}:${master.toLowerCase()}`;
export function loadPhoneRecord(kv: KVS, net: Network, master: string): PhoneRecord | null {
  try {
    const v = JSON.parse(kv.getItem(phoneRecordKey(net, master)) ?? "null") as { address?: unknown; validUntil?: unknown } | null;
    if (!v || typeof v.address !== "string" || !ADDR.test(v.address) || typeof v.validUntil !== "number") return null;
    return { address: v.address.toLowerCase() as Address, validUntil: v.validUntil };
  } catch {
    return null;
  }
}
export const savePhoneRecord = (kv: KVS, net: Network, master: string, r: PhoneRecord) =>
  kv.setItem(phoneRecordKey(net, master), JSON.stringify({ address: r.address.toLowerCase(), validUntil: r.validUntil }));
export const clearPhoneRecord = (kv: KVS, net: Network, master: string) => kv.removeItem(phoneRecordKey(net, master));

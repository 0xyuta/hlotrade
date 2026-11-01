import type { Hex } from "viem";
import type { Address, Network } from "../config/validate";
import { PHONE_AGENT_NAME, agentStorageKey, browserKV, clearAgent, loadAgent, loadPaired, pairedKey, saveAgent, savePaired, type KVS } from "./agent";
import { parsePairCode } from "./pairCode";
import { fetchAgentMaster } from "./role";

/**
 * The phone's key waits here, in module memory (never React state, props or storage), from the scan to the user's
 * "Pair this phone". cancelPairing (also on pagehide) and confirmPairing drop it.
 */
let staged: { net: Network; key: Hex; agent: Address; master: Address | null } | null = null;

export const STORAGE_BLOCKED = "storage-blocked";
export const LOST_TEXT = "This code is no longer held on this page. Scan it again.";

export function stagePairCode(text: string, net: Network): { ok: true; agent: Address } | { ok: false; reason: string; discard?: true } {
  staged = null;
  const p = parsePairCode(text, net);
  if (!p.ok) return p;
  staged = { net, key: p.key, agent: p.agent, master: null };
  return { ok: true, agent: p.agent };
}

export type Resolved = { ok: true; master: Address } | { ok: false; reason: string; retry: boolean };

/** Asks Hyperliquid whose agent the staged key is (ruling 1). A newer stage or a cancel while waiting wins. */
export async function resolveStagedMaster(lookup: (net: Network, agent: Address) => Promise<Address | null> = fetchAgentMaster): Promise<Resolved> {
  const mine = staged;
  if (!mine) return { ok: false, reason: LOST_TEXT, retry: false };
  let master: Address | null;
  try {
    master = await lookup(mine.net, mine.agent);
  } catch {
    if (staged !== mine) return { ok: false, reason: LOST_TEXT, retry: false };
    return { ok: false, reason: "Could not reach Hyperliquid to check the code. Check the connection and try again.", retry: true };
  }
  if (staged !== mine) return { ok: false, reason: LOST_TEXT, retry: false };
  if (!master) {
    staged = null;
    return { ok: false, reason: "Hyperliquid does not know this code as an approved trading key. Approve the phone again on your computer and scan the new code.", retry: false };
  }
  mine.master = master;
  return { ok: true, master };
}

const put = (kv: KVS, k: string, v: string | null) => (v === null ? kv.removeItem(k) : kv.setItem(k, v));

/**
 * Stores the phone's key (the "hlo phone" slot; validUntil 0 = unknown, Hyperliquid's extraAgents has the real date)
 * and the paired master, then forgets the key. null = nothing ready (not staged, not resolved, used, or cancelled).
 * STORAGE_BLOCKED = the browser did not keep both; each key then holds exactly what it held before (E3), so an earlier
 * pairing survives. On success, a previous master's phone key on this device is removed.
 */
export function confirmPairing(kv: KVS = browserKV): Address | null | typeof STORAGE_BLOCKED {
  const p = staged;
  staged = null;
  if (!p || !p.master) return null;
  const slot = agentStorageKey(p.net, p.master, PHONE_AGENT_NAME);
  const flag = pairedKey(p.net);
  const before = { slot: kv.getItem(slot), flag: kv.getItem(flag) };
  const previousMaster = loadPaired(kv, p.net);
  saveAgent(kv, p.net, p.master, { key: p.key, address: p.agent, validUntil: 0 }, PHONE_AGENT_NAME);
  savePaired(kv, p.net, p.master);
  const kept = loadAgent(kv, p.net, p.master, PHONE_AGENT_NAME)?.key === p.key && loadPaired(kv, p.net) === p.master;
  if (!kept) {
    put(kv, slot, before.slot);
    put(kv, flag, before.flag);
    return STORAGE_BLOCKED;
  }
  if (previousMaster && previousMaster !== p.master) clearAgent(kv, p.net, previousMaster, PHONE_AGENT_NAME);
  return p.master;
}

export function cancelPairing(): void {
  staged = null;
}

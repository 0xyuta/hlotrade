import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { Address, Network } from "../config/validate";
import { AGENT_VALID_DAYS, PHONE_AGENT_NAME, PHONE_AGENT_VALID_DAYS, agentNameWithExpiry, saveAgent, type KVS, type StoredAgent } from "./agent";
import { getHl, userExchange } from "./clients";
import { isUnconfirmedHttp } from "./errors";
import { withChainRetry, type HlUserWallet } from "./injected";
import { BUILDER_F } from "./math";

export interface ExtraAgent {
  name: string;
  address: Address;
  validUntil: number | null; // ms
}

/** extraAgents is undocumented [T §2.3]: keep only rows with the expected shape. */
export function parseExtraAgents(raw: unknown): ExtraAgent[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const x = r as Record<string, unknown>;
    if (!x || typeof x.name !== "string" || typeof x.address !== "string") return [];
    return [{ name: x.name, address: x.address as Address, validUntil: typeof x.validUntil === "number" ? x.validUntil : null }];
  });
}

export interface TradingStatus {
  builderOk: boolean;
  maxBuilderFee: number;
  agentOk: boolean;
  agentValidUntil: number | null;
}

export function tradingStatus(o: { maxBuilderFee: number; agents: ExtraAgent[]; local: StoredAgent | null; nowMs: number }): TradingStatus {
  const mine = o.local ? o.agents.find((a) => a.address.toLowerCase() === o.local!.address.toLowerCase()) : undefined;
  const live = !!mine && (mine.validUntil === null || mine.validUntil > o.nowMs);
  return { builderOk: o.maxBuilderFee >= BUILDER_F, maxBuilderFee: o.maxBuilderFee, agentOk: live, agentValidUntil: mine?.validUntil ?? null };
}

export async function readTradingStatus(net: Network, master: Address, builder: Address, local: StoredAgent | null, nowMs: number): Promise<TradingStatus> {
  const { info } = getHl(net);
  const [fee, agents] = await Promise.all([info.maxBuilderFee({ user: master, builder }), info.extraAgents({ user: master })]);
  return tradingStatus({ maxBuilderFee: Number(fee), agents: parseExtraAgents(agents), local, nowMs });
}

/**
 * Main wallet signs approveBuilderFee("0.1%") [T §2.1] (skipped when already approved), then approveAgent for a fresh key
 * named "hlo valid_until <ms>" [T §2.2]; the same name replaces the previous hlo agent. The key is stored only after
 * the approval succeeded.
 */
export async function enableTrading(o: {
  net: Network; wallet: HlUserWallet; master: Address; builder: Address; builderOk: boolean; kv: KVS; nowMs: number;
}): Promise<StoredAgent> {
  const ex = userExchange(o.net, o.wallet);
  if (!o.builderOk) await withChainRetry(() => ex.approveBuilderFee({ builder: o.builder, maxFeeRate: "0.1%" }));
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const validUntil = o.nowMs + AGENT_VALID_DAYS * 86_400_000;
  await withChainRetry(() => ex.approveAgent({ agentAddress: address, agentName: agentNameWithExpiry(validUntil) }));
  const agent: StoredAgent = { key, address, validUntil };
  saveAgent(o.kv, o.net, o.master, agent);
  return agent;
}

/**
 * The phone's own key (controller ruling: the desktop's key never leaves the desktop). The main wallet signs a second
 * approveAgent named "hlo phone valid_until <ms>" [T §2.2], PHONE_AGENT_VALID_DAYS (30) ahead. A different name leaves the desktop's "hlo" agent in
 * place; the same name replaces the previous phone key, so re-pairing cuts the old phone off. Nothing is stored here:
 * the caller (the pair modal) shows the key only as the pairing code, a QR of plain text and the same code to type,
 * never in a URL, and drops it when the modal closes.
 */
export async function approvePhoneAgent(o: { net: Network; wallet: HlUserWallet; nowMs: number }): Promise<{ key: Hex; address: Address; validUntil: number }> {
  const validUntil = o.nowMs + PHONE_AGENT_VALID_DAYS * 86_400_000;
  const { key, address } = await approveFreshPhoneAgent(o.net, o.wallet, validUntil);
  return { key, address, validUntil };
}

/** The one signing call behind pairing and cutting off: a fresh key, approved under the phone's name until `validUntil`. */
async function approveFreshPhoneAgent(net: Network, wallet: HlUserWallet, validUntil: number): Promise<{ key: Hex; address: Address }> {
  const key = generatePrivateKey();
  const address = privateKeyToAccount(key).address;
  const ex = userExchange(net, wallet);
  await withChainRetry(() => ex.approveAgent({ agentAddress: address, agentName: agentNameWithExpiry(validUntil, PHONE_AGENT_NAME) }));
  return { key, address };
}

/** The throwaway agent's life (Plan 4 ruling 5): its key is never kept, so this only bounds how long the name slot is taken. */
export const CUTOFF_VALID_MS = 86_400_000;

/** What the UI says when the approval's answer did not arrive: Hyperliquid may or may not have replaced the phone's agent. */
export const CUTOFF_UNCONFIRMED_TEXT = "The answer from Hyperliquid did not arrive, so the phone may already be cut off. Cutting it off again is safe.";

/** The signed approval was posted but not confirmed (no answer, a 5xx or 408): the phone may already be cut off. The caller keeps its record of the phone. */
export class CutOffUnconfirmedError extends Error {
  constructor(options?: ErrorOptions) {
    super(CUTOFF_UNCONFIRMED_TEXT, options);
    this.name = "CutOffUnconfirmedError";
  }
}

/**
 * Cut off the paired phone (Plan 4 B): the main wallet approves a fresh, throwaway address under the phone's name
 * "hlo phone". Approving a name again replaces that agent [T §2.2], so the phone's key stops working at once. The
 * throwaway key is dropped here, unseen: nobody can ever sign with it. The computer's own "hlo" agent is not touched.
 * Throws CutOffUnconfirmedError when the post is not confirmed; any other error means the approval did not happen.
 */
export async function cutOffPhone(o: { net: Network; wallet: HlUserWallet; nowMs: number }): Promise<void> {
  try {
    await approveFreshPhoneAgent(o.net, o.wallet, o.nowMs + CUTOFF_VALID_MS); // the returned key goes out of scope here
  } catch (e) {
    if (isUnconfirmedHttp(e)) throw new CutOffUnconfirmedError({ cause: e });
    throw e;
  }
}

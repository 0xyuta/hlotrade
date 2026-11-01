import mainnet from "../src/config/mainnet.json" with { type: "json" };
import testnet from "../src/config/testnet.json" with { type: "json" };
import { MIN_BUILDER_FEE, chainIdFor, hlApiFor, parseRegisterBody, registryKey, registryLogKey } from "../src/register/rules.js";
import type { RegistryBucket } from "./env.js";

/**
 * POST /api/register  {user}
 * Writes `registry/<chainId>/<user>.json` once, when Hyperliquid says the wallet approved our builder fee. The record
 * never changes afterwards (a repeat is a 200 that touches nothing), so the poster counts fills from the first time only.
 * An index entry `registry-log/<chainId>/<registeredAt>-<user>.json` goes in first, so readers list what is new by time;
 * the record is the truth and a stale or duplicate entry (a failed record write, a race) is harmless.
 * The network comes from the Worker's HLO_NETWORK, never from the request. The store is the network's R2 bucket (binding).
 */

/** Where /api/register keeps the wallet records: written once, never overwritten. */
export interface RegistryStore {
  /** True only when the store answers that the record is there; not found and every other failure are false. */
  exists(key: string): Promise<boolean>;
  /** Writes an (empty) index entry, overwriting one of the same key. True only when the store took it. */
  writeIndex(key: string): Promise<boolean>;
  /** Writes the record unless one is there. True when the record is there afterwards (written now, or before). */
  createOnce(key: string, body: string): Promise<boolean>;
}

const HL_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 1024;
type Configs = Record<"mainnet" | "testnet", { builder?: string }>;
const CONFIGS: Configs = { mainnet, testnet } as Configs;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The R2 binding. `If-None-Match: *` makes R2 refuse (put returns null) when the key exists, atomically. */
export function bindingStore(bucket: RegistryBucket): RegistryStore {
  const exists = async (key: string): Promise<boolean> => {
    try {
      return (await bucket.head(key)) !== null;
    } catch {
      return false;
    }
  };
  return {
    exists,
    async writeIndex(key) {
      try {
        return (await bucket.put(key, "", { httpMetadata: { contentType: "application/json" } })) !== null;
      } catch {
        return false;
      }
    },
    async createOnce(key, body) {
      try {
        const r = await bucket.put(key, body, { onlyIf: new Headers({ "if-none-match": "*" }), httpMetadata: { contentType: "application/json" } });
        if (r !== null) return true;
      } catch {
        // decided below
      }
      return exists(key); // a lost race or an unclear failure: the record being there is what counts
    },
  };
}

export async function register(req: Request, network: string | undefined, store: RegistryStore, fetchFn: typeof fetch = fetch, configs: Configs = CONFIGS): Promise<Response> {
  if (network !== "mainnet" && network !== "testnet") return json(503, { error: "Registration is not configured." });
  const builder = configs[network].builder;
  if (!builder) return json(503, { error: "Registration is not configured." });

  // Refuse a declared oversize body before reading it; the byte check below still covers a missing or wrong header.
  const declared = Number(req.headers.get("content-length"));
  if (req.headers.has("content-length") && declared > MAX_BODY_BYTES) return json(400, { error: "Bad request." });

  let body: unknown;
  try {
    const text = await req.text();
    if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json(400, { error: "Bad request." });
    body = JSON.parse(text);
  } catch {
    return json(400, { error: "Bad request." });
  }
  const user = parseRegisterBody(body);
  if (!user) return json(400, { error: "Bad request." });

  const key = registryKey(chainIdFor(network), user);
  // A repeat caller (every app open) costs one lookup: no Hyperliquid call, nothing written.
  if (await store.exists(key)) return json(200, { registered: true });

  let fee: unknown;
  try {
    const r = await fetchFn(`${hlApiFor(network)}/info`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "maxBuilderFee", user, builder }),
      signal: AbortSignal.timeout(HL_TIMEOUT_MS),
    });
    if (!r.ok) return json(502, { error: "Could not check trading status." });
    fee = await r.json();
  } catch {
    return json(502, { error: "Could not check trading status." });
  }
  if (typeof fee !== "number" || !Number.isFinite(fee)) return json(502, { error: "Could not check trading status." });
  if (fee < MIN_BUILDER_FEE) return json(403, { error: "Enable trading first." });

  const registeredAt = Math.floor(Date.now() / 1000);
  // The index comes first: a record no reader's index can find would wait for the hourly full list.
  if (!(await store.writeIndex(registryLogKey(chainIdFor(network), registeredAt, user)))) return json(502, { error: "Could not register." });
  if (!(await store.createOnce(key, JSON.stringify({ user, registeredAt })))) return json(502, { error: "Could not register." });
  return json(200, { registered: true });
}

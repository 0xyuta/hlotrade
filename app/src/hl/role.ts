import { HL_HOSTS } from "../config/csp";
import type { Address, Network } from "../config/validate";

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const TIMEOUT_MS = 10_000;

/** [P4 §6] {"role":"agent","data":{"user":"0x…"}} → the master; anything else = not an approved agent. */
export function parseAgentMaster(raw: unknown): Address | null {
  const r = raw as { role?: unknown; data?: { user?: unknown } } | null;
  if (!r || typeof r !== "object" || r.role !== "agent") return null;
  const user = r.data?.user;
  return typeof user === "string" && ADDR.test(user) ? (user.toLowerCase() as Address) : null;
}

/**
 * Asks Hyperliquid whose agent this address is. A plain fetch (no SDK), so the phone's pair page stays small.
 * Throws when Hyperliquid cannot be reached or answers non-2xx; null when the address is not an approved agent.
 */
export async function fetchAgentMaster(net: Network, agent: Address): Promise<Address | null> {
  const res = await fetch(`${HL_HOSTS[net].api}/info`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "userRole", user: agent.toLowerCase() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Hyperliquid answered HTTP ${res.status}.`);
  return parseAgentMaster(await res.json());
}

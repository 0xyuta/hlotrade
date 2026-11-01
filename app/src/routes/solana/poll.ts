import type { AppConfig } from "../../config/validate";
import { SOLANA_DOMAIN } from "../addresses";
import { fetchIrisMessage } from "../exec";
import { settleByBalance, type Pending } from "../pending";
import { readSolanaUsdcAt } from "./rpc";
import { readSolanaDeposit, settleSolanaDeposit, type SolanaTxState } from "./settle";

/**
 * One poll of a Solana record. TransferModal's poll loads this module (a small chunk of its own) only while such a
 * record is pending (Plan 4 C).
 * - Deposit (a signature, or only the event account when the wallet gave no signature back): the chain first
 *   (readSolanaDeposit: block height, then status, then event account; it may adopt the burn's signature), then Iris
 *   (domain 5) by the signature of the record it returned, then settleSolanaDeposit on that record. The returned
 *   record is the one to store. Without a Solana RPC, or with the route turned off, only Iris is asked.
 * - Withdrawal: the watched USDC token account's balance on the build's Solana network (not read while the route is off).
 * Nothing here signs or sends.
 */
export async function pollSolana(cfg: AppConfig, p: Pending, nowMs: number = Date.now()): Promise<Pending> {
  if (p.status === "done") return p;
  // The CSP's connect-src has the Solana RPC only while the route is on (config/csp.ts): with it off, only Iris is asked
  // (final review M3), so a deposit with a signature still settles and nothing else fetches a blocked origin.
  const rpc = cfg.solanaEnabled ? cfg.solanaRpc : null;
  if (p.dir === "deposit" && p.srcDomain === SOLANA_DOMAIN && (p.txHash || p.eventAccount)) {
    const read: { p: Pending; tx: SolanaTxState } = rpc ? await readSolanaDeposit(rpc, p) : { p, tx: "unknown" };
    const iris = read.p.txHash ? await fetchIrisMessage(cfg.network, SOLANA_DOMAIN, read.p.txHash) : null;
    return settleSolanaDeposit(read.p, iris, read.tx, nowMs);
  }
  if (p.dir === "withdraw" && p.balanceKind === "solana" && p.watch && rpc) {
    const b = await readSolanaUsdcAt(rpc, cfg.network, p.watch);
    return b === null ? p : settleByBalance(p, b);
  }
  return p;
}

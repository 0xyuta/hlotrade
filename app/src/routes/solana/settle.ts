import { settleCctp, SOLANA_EXPIRED_NOTE, SOLANA_FAILED_NOTE, type IrisMessage, type Pending } from "../pending";
import { blockHeight, eventAccountState, firstSignatureFor, signatureStatus, type EventAccountState, type SigStatus } from "./rpc";

/** Recorded before the broadcast (ruling 14); stays until Solana or Iris shows the transaction. */
export const SOLANA_WATCH_NOTE = "unconfirmed: watching the Solana transaction";
/** The wallet's signAndSend gave no clear answer and no signature: watched through the event account until one shows. */
export const SOLANA_UNCONFIRMED_NOTE = "unconfirmed: check your Solana wallet's activity before sending again";
/** Final "not sent" notes: defined in routes/pending.ts, which the transfer list reads without this chunk. */
export { SOLANA_EXPIRED_NOTE, SOLANA_FAILED_NOTE };
/** "Expired" is said only this long after the start, however early the block height passes (ruling 14). */
export const EXPIRE_GRACE_MS = 15 * 60_000;

export type SolanaTxState = "landed" | "failed" | "expired" | "unknown";

/**
 * landed / failed come from the signature status, or landed from the event account (it exists only if the burn
 * landed). Expired = the RPC does not know the transaction and the chain is past the blockhash's last valid height, so
 * it can never land. Anything unanswered is unknown.
 */
export function solanaTxState(status: SigStatus | null, height: bigint | null, lastValid: bigint | null, event: EventAccountState | null = null): SolanaTxState {
  if (status?.state === "landed") return "landed";
  if (status?.state === "failed") return "failed";
  if (event === "present") return "landed";
  if (status?.state === "missing" && height !== null && lastValid !== null && height > lastValid) return "expired";
  return "unknown";
}

const RPC_READS = { blockHeight, signatureStatus, eventAccountState, firstSignatureFor };

/**
 * The chain reads for one poll of a Solana deposit (carried ruling 3: settled from the chain, never re-signed or
 * re-sent). The block height is read first: if it is already past the last valid height, a transaction that the later
 * reads do not show can never land. A record with no signature (the wallet's signAndSend gave no clear answer) is
 * settled by its event account: absent past the last valid height = expired; present = landed, and only then is the
 * account's first signature adopted (switching to the watch note so Iris can be asked by it). Adopting only with that
 * proof means lamports a stranger sends to the address of a burn that never landed can never pass for the burn.
 * Returns the record (possibly with that signature) and the state for settleSolanaDeposit.
 */
export async function readSolanaDeposit(url: string, p: Pending, io: typeof RPC_READS = RPC_READS): Promise<{ p: Pending; tx: SolanaTxState }> {
  if (p.status === "done" || (!p.txHash && !p.eventAccount)) return { p, tx: "unknown" };
  const lastValid = p.lastValid !== undefined ? BigInt(p.lastValid) : null;
  const height = lastValid !== null ? await io.blockHeight(url) : null;
  if (!p.txHash) {
    const event = await io.eventAccountState(url, p.eventAccount!);
    if (event === null) return { p, tx: "unknown" };
    if (event === "absent") return { p, tx: solanaTxState({ state: "missing" }, height, lastValid) };
    // Present: the burn landed, and the account's oldest signature is the burn's. A lagging signature index only delays the adoption.
    const first = await io.firstSignatureFor(url, p.eventAccount!);
    if (first?.state !== "found") return { p, tx: "landed" };
    return { p: { ...p, txHash: first.signature, ...(p.note === SOLANA_UNCONFIRMED_NOTE ? { note: SOLANA_WATCH_NOTE } : {}) }, tx: "landed" };
  }
  const status = await io.signatureStatus(url, p.txHash!);
  const decided = status?.state === "landed" || status?.state === "failed";
  if (decided || !p.eventAccount) return { p, tx: solanaTxState(status, height, lastValid) };
  const event = await io.eventAccountState(url, p.eventAccount);
  // A record that names its event account is "expired" only once that account reads as absent: a read that did not
  // answer proves nothing, and a missing status alone may be an RPC without the history (final review M1).
  if (event === null) return { p, tx: "unknown" };
  return { p, tx: solanaTxState(status, height, lastValid, event) };
}

/**
 * One poll of a Solana deposit. Iris decides first: forwardTxHash = done, and a message Iris knows clears every
 * "unconfirmed" or "not sent" note. Without Iris: a failed transaction and (after the grace) an expired one say
 * "not sent" (the record can then be dismissed); a landed one drops the watch note, and also any "not sent" note
 * except SOLANA_FAILED_NOTE, because landing on chain disproves it (a preflight answer or an "expired" read from a
 * lagging node). A failed status is itself on-chain proof, and one signature cannot be both. Finished records never change.
 */
export function settleSolanaDeposit(p: Pending, iris: IrisMessage | null, tx: SolanaTxState, nowMs: number): Pending {
  if (p.status === "done") return p;
  if (iris) return settleCctp(p.note?.startsWith("not sent") ? { ...p, note: undefined } : p, iris, nowMs);
  if (p.note?.startsWith("not sent")) return tx === "landed" && p.note !== SOLANA_FAILED_NOTE ? settleCctp({ ...p, note: undefined }, null, nowMs) : p;
  if (tx === "failed") return { ...p, note: SOLANA_FAILED_NOTE };
  if (tx === "expired" && nowMs - p.startedAt > EXPIRE_GRACE_MS) return { ...p, note: SOLANA_EXPIRED_NOTE };
  if (tx === "landed" && p.note === SOLANA_WATCH_NOTE) return settleCctp({ ...p, note: undefined }, null, nowMs);
  return settleCctp(p, null, nowMs);
}

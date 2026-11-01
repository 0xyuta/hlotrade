import type { Blockhash } from "@solana/kit";
import type { Network } from "../../config/validate";
import { MESSAGE_TRANSMITTER_V2, SOLANA_USDC } from "./constants";

/**
 * The few Solana JSON-RPC calls the route needs, as plain fetches to the config's `solanaRpc` (its origin is in the CSP
 * connect-src). Kit's typed RPC client is not used: it adds weight and these answers are small.
 */
const TIMEOUT_MS = 15_000;

/**
 * The RPC answered with a JSON-RPC error: a real answer. `data` is the error's `data` as sent (for a preflight failure,
 * the simulation result with its `err`); it is kept for classification and never logged.
 */
export class SolanaRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
    this.name = "SolanaRpcError";
  }
}
/** No usable answer (network failure, timeout, HTTP error, not JSON): the outcome of a send is unknown. */
export class SolanaNoAnswerError extends Error {
  constructor(cause: unknown) {
    super("The Solana network did not answer.", { cause });
    this.name = "SolanaNoAnswerError";
  }
}
/**
 * [P4 §3 ruling 14] sendTransaction's preflight simulation refused it. The code alone does not mean "nothing was sent":
 * Agave uses it for every simulation error, including AlreadyProcessed (these signed bytes already reached the cluster).
 */
export const PREFLIGHT_FAILED = -32002;

/**
 * Simulation errors (`data.err` of a -32002) that Agave's bank raises before it runs the transaction and after its
 * age check, while nothing of it has happened: the blockhash is unknown, or the fee payer has no account or too little
 * SOL for the fee. The status-cache check (AlreadyProcessed) sits between the age check and the fee check, so a fee
 * error also says the transaction was not already processed. The node did not forward it.
 */
const NEVER_FORWARDED = new Set(["BlockhashNotFound", "AccountNotFound", "InsufficientFundsForFee"]);

/**
 * True only when a send failure proves the transaction was not sent: a -32002 whose structured `data.err` is one of
 * NEVER_FORWARDED. Everything else (AlreadyProcessed, an instruction error, an object-shaped or missing `err`, any
 * other code) is unconfirmed. Safe default: calling a sent transaction "not sent" invites a second deposit, while an
 * unconfirmed one is only watched until the chain settles it. The message text is never read.
 */
export function preflightNotSent(e: unknown): boolean {
  if (!(e instanceof SolanaRpcError) || e.code !== PREFLIGHT_FAILED) return false;
  const err = e.data && typeof e.data === "object" ? (e.data as { err?: unknown }).err : undefined;
  return typeof err === "string" && NEVER_FORWARDED.has(err);
}

export async function solanaRpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  let j: { result?: T; error?: { code?: unknown; message?: unknown; data?: unknown } };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    j = (await res.json()) as typeof j;
  } catch (e) {
    throw new SolanaNoAnswerError(e);
  }
  if (j && typeof j === "object" && j.error) {
    const code = typeof j.error.code === "number" ? j.error.code : 0;
    throw new SolanaRpcError(code, typeof j.error.message === "string" ? j.error.message : `Solana RPC error ${code}`, j.error.data);
  }
  if (!j || typeof j !== "object" || !("result" in j)) throw new SolanaNoAnswerError(new Error("no result"));
  return j.result as T;
}

const big = (x: unknown): bigint | null => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : typeof x === "string" && /^\d+$/.test(x) ? BigInt(x) : null);

/**
 * USDC (1e6) in a token account. A missing account holds 0 (an ATA that does not exist yet). null = no answer, or the
 * account is not a USDC token account (never guess a balance).
 */
export async function readSolanaUsdcAt(url: string, net: Network, account: string): Promise<bigint | null> {
  try {
    const r = await solanaRpc<{ value: null | { data?: { parsed?: { info?: { mint?: unknown; tokenAmount?: { amount?: unknown } } } } } }>(url, "getAccountInfo", [
      account,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);
    if (r.value === null) return 0n;
    const info = r.value.data?.parsed?.info;
    if (info?.mint !== SOLANA_USDC[net]) return null;
    return big(info.tokenAmount?.amount);
  } catch {
    return null;
  }
}

/** Lamports held by an address; null = no answer. */
export async function readSol(url: string, owner: string): Promise<bigint | null> {
  try {
    return big((await solanaRpc<{ value: unknown }>(url, "getBalance", [owner, { commitment: "confirmed" }])).value);
  } catch {
    return null;
  }
}

export async function latestBlockhash(url: string): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }> {
  const r = await solanaRpc<{ value: { blockhash?: unknown; lastValidBlockHeight?: unknown } }>(url, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const h = big(r.value?.lastValidBlockHeight);
  if (typeof r.value?.blockhash !== "string" || h === null) throw new SolanaNoAnswerError(new Error("bad getLatestBlockhash answer"));
  return { blockhash: r.value.blockhash as Blockhash, lastValidBlockHeight: h };
}

const base64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

/** Broadcasts signed wire bytes once, with preflight. Returns the signature the node reports. Never retried. */
export async function sendWire(url: string, wire: Uint8Array): Promise<string> {
  return solanaRpc<string>(url, "sendTransaction", [base64(wire), { encoding: "base64", preflightCommitment: "confirmed" }]);
}

export type SigStatus = { state: "missing" } | { state: "failed" } | { state: "landed" };

/** The signature's status, searching history (a deposit may be days old). null = no answer. */
export async function signatureStatus(url: string, signature: string): Promise<SigStatus | null> {
  try {
    const r = await solanaRpc<{ value: ({ err?: unknown; confirmationStatus?: unknown } | null)[] }>(url, "getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    if (!r || typeof r !== "object" || !Array.isArray(r.value) || r.value.length !== 1) return null;
    const s = r.value[0];
    if (s === null) return { state: "missing" };
    if (typeof s !== "object") return null; // malformed: never read as "missing", which can feed "expired"
    if (s.err) return { state: "failed" };
    return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? { state: "landed" } : { state: "missing" };
  } catch {
    return null;
  }
}

/** The current block height (confirmed); null = no answer. */
export async function blockHeight(url: string): Promise<bigint | null> {
  try {
    return big(await solanaRpc<unknown>(url, "getBlockHeight", [{ commitment: "confirmed" }]));
  } catch {
    return null;
  }
}

export type EventAccountState = "present" | "absent";

/**
 * [P4 §1 "Event account rent"; C-SOL "MessageSent event storage"] The burn's message_sent_event_data account. The burn
 * creates it, owned by MessageTransmitter, so "present" means the burn landed. Anything else is "absent": no account,
 * or one another program owns (lamports anyone sent to the address prove nothing). null = no answer. Only the owner
 * field is asked for (an empty data slice).
 */
export async function eventAccountState(url: string, account: string): Promise<EventAccountState | null> {
  try {
    const r = await solanaRpc<{ value: null | { owner?: unknown } }>(url, "getAccountInfo", [
      account,
      { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } },
    ]);
    if (!r || typeof r !== "object" || r.value === undefined) return null;
    return r.value !== null && r.value.owner === MESSAGE_TRANSMITTER_V2 ? "present" : "absent";
  } catch {
    return null;
  }
}

export type FirstSignature = { state: "found"; signature: string } | { state: "none" };

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/**
 * The oldest transaction signature that touched an address (getSignaturesForAddress lists newest first, failed ones
 * included). For a deposit's event account that is the burn itself: the address is a fresh key that only the burn's
 * transaction could sign for, so nothing names it before the burn is broadcast. A fresh account is touched at most a
 * few times, far below the RPC's default page of 1000. null = no answer or a malformed one.
 */
export async function firstSignatureFor(url: string, account: string): Promise<FirstSignature | null> {
  try {
    const r = await solanaRpc<unknown>(url, "getSignaturesForAddress", [account, { commitment: "confirmed" }]);
    if (!Array.isArray(r)) return null;
    if (r.length === 0) return { state: "none" };
    const sig = (r[r.length - 1] as { signature?: unknown } | null)?.signature;
    return typeof sig === "string" && BASE58_SIGNATURE.test(sig) ? { state: "found", signature: sig } : null;
  } catch {
    return null;
  }
}

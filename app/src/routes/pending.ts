import type { Network } from "../config/validate";
import type { RouteId } from "./fees";

/** A transfer the app started, kept in localStorage until it lands (spec §6). Amounts are USDC 1e6 as decimal strings. */
export interface Pending {
  id: string;
  dir: "deposit" | "withdraw";
  route: RouteId;
  amount: string;
  startedAt: number; // ms
  status: "pending" | "done";
  srcDomain?: number; // CCTP deposits: poll Iris /v2/messages/{srcDomain}?transactionHash=
  txHash?: string; // EVM: 0x hash; Solana (srcDomain 5): the transaction's base58 signature
  /** Solana deposits: the blockhash's last valid block height, decimal; past it, a transaction never seen cannot land. */
  lastValid?: string;
  /**
   * Solana deposits: the base58 address of the burn's fresh message_sent_event_data account (an address, never a key).
   * It exists on chain only if the burn landed, and its first signature is the burn's, so a deposit whose signature
   * never came back is still settled from it [P4 §1 "Event account rent"].
   */
  eventAccount?: string;
  balanceKind?: BalanceKind; // withdrawals: watch this balance
  /** balanceKind "solana": the base58 USDC token account (ATA) whose balance is watched. */
  watch?: string;
  baseline?: string;
  minArrive?: string;
  note?: string;
}

export type BalanceKind = "hyperEvm" | "arbitrum" | "ethereum" | "solana";

/** A balance rise smaller than this never counts as a withdrawal arriving (dust sent to the address must not complete it). */
export const MIN_ARRIVE_FLOOR = 10_000n; // 0.01 USDC

/**
 * Where a new withdrawal's arrival is judged from, the same rule for every destination (EVM and Solana):
 * - minArrive: the rise that counts as arrived, `expected` (what is sure to arrive), but never below MIN_ARRIVE_FLOOR
 *   unless the amount itself is smaller;
 * - start: the balance to rise from, never below `ahead` (the highest mark an earlier, still-pending withdrawal to the
 *   same balance waits for), so one arrival cannot complete two records.
 */
export function withdrawMarks(amount: bigint, expected: bigint, baseline: bigint, ahead: bigint): { minArrive: bigint; start: bigint } {
  const minArrive = expected < MIN_ARRIVE_FLOOR ? (amount < MIN_ARRIVE_FLOOR ? amount : MIN_ARRIVE_FLOOR) : expected;
  return { minArrive, start: baseline > ahead ? baseline : ahead };
}

export interface IrisMessage {
  status: string;
  delayReason: string | null;
  forwardTxHash: string | null;
}

export type KV = Pick<Storage, "getItem" | "setItem">;

/**
 * Two of the Solana deposit notes that say nothing was sent (routes/solana/settle.ts writes them). They live here so the
 * transfer list can tell a final "not sent" record without loading the Solana chunk.
 */
export const SOLANA_FAILED_NOTE = "not sent: the Solana transaction failed. Only the network fee was charged.";
export const SOLANA_EXPIRED_NOTE = "not sent: the Solana transaction expired before it landed. Nothing moved.";
/**
 * After this long, a Solana deposit that says "not sent" can no longer be disproved: its blockhash (about a minute of
 * life) expired long before, so the transaction can never land. Until then the poll keeps reading it, because landing
 * on chain clears an "expired" or preflight note.
 */
export const NOT_SENT_FINAL_MS = 3_600_000;

/** The record says nothing was sent (a Solana deposit's "not sent: …" note) and is still listed as pending. */
export const saysNotSent = (p: Pending): boolean => p.status === "pending" && !!p.note?.startsWith("not sent");

/**
 * A Solana deposit whose "not sent" can no longer change (final review M2): a failed status at once (on-chain proof,
 * and one signature cannot also land), any other "not sent" after NOT_SENT_FINAL_MS. It is no longer polled, and it
 * gives way to a new transfer like a finished one, so a few refused attempts cannot fill the list.
 */
export function isFinalNotSent(p: Pending, nowMs: number): boolean {
  return p.route === "solana" && saysNotSent(p) && (p.note === SOLANA_FAILED_NOTE || nowMs - p.startedAt > NOT_SENT_FINAL_MS);
}

const KEEP = 20;
const DONE_TTL_MS = 7 * 86_400_000;
const SLOW_MS = 30 * 60_000;
const STALE_PENDING_MS = 7 * 86_400_000;

export const pendingKey = (net: Network, user: string) => `hlo:pending:${net}:${user.toLowerCase()}`;

const DIGITS = /^\d+$/;
const ROUTE_IDS = ["hypercore", "hyperevm", "arbitrum", "ethereum", "solana"];
const BALANCE_KINDS = ["hyperEvm", "arbitrum", "ethereum", "solana"];
/** base58, 32 to 44 characters: a Solana address (no 0, O, I or l). */
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const optDigits = (v: unknown) => v === undefined || (typeof v === "string" && DIGITS.test(v));

/** Storage is user-editable and versioned by nobody: accept only records every later BigInt() and switch can use. */
const isPending = (x: unknown): x is Pending => {
  if (!x || typeof x !== "object") return false;
  const p = x as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    (p.dir === "deposit" || p.dir === "withdraw") &&
    typeof p.route === "string" &&
    ROUTE_IDS.includes(p.route) &&
    typeof p.amount === "string" &&
    DIGITS.test(p.amount) &&
    typeof p.startedAt === "number" &&
    Number.isFinite(p.startedAt) &&
    (p.status === "pending" || p.status === "done") &&
    optDigits(p.baseline) &&
    optDigits(p.minArrive) &&
    optDigits(p.lastValid) &&
    (p.srcDomain === undefined || typeof p.srcDomain === "number") &&
    (p.txHash === undefined || typeof p.txHash === "string") &&
    (p.balanceKind === undefined || (typeof p.balanceKind === "string" && BALANCE_KINDS.includes(p.balanceKind))) &&
    // a Solana balance watch needs the token account it watches
    (p.balanceKind !== "solana" || (typeof p.watch === "string" && BASE58_ADDRESS.test(p.watch))) &&
    (p.watch === undefined || (typeof p.watch === "string" && BASE58_ADDRESS.test(p.watch))) &&
    (p.eventAccount === undefined || (typeof p.eventAccount === "string" && BASE58_ADDRESS.test(p.eventAccount)))
  );
};

export function loadPending(kv: KV, net: Network, user: string): Pending[] {
  try {
    const v: unknown = JSON.parse(kv.getItem(pendingKey(net, user)) ?? "[]");
    return Array.isArray(v) ? v.filter(isPending) : [];
  } catch {
    return [];
  }
}

const newest = (a: Pending, b: Pending) => b.startedAt - a.startedAt;

/**
 * Brings a list down to KEEP entries: oldest finished ones go first, then final "not sent" Solana deposits
 * (isFinalNotSent), then pending ones older than 7 days. A younger pending transfer is never dropped here, so the result
 * can still be longer than KEEP.
 */
function makeRoom(list: Pending[], nowMs: number): Pending[] {
  const out = [...list].sort(newest);
  const dropLast = (pred: (p: Pending) => boolean) => {
    for (let i = out.length - 1; i >= 0; i--) {
      if (pred(out[i])) {
        out.splice(i, 1);
        return true;
      }
    }
    return false;
  };
  while (out.length > KEEP && (dropLast((p) => p.status === "done") || dropLast((p) => isFinalNotSent(p, nowMs)) || dropLast((p) => nowMs - p.startedAt >= STALE_PENDING_MS)));
  return out;
}

/** The store holds at most 20 entries. Finished ones also expire after 7 days. */
export function savePending(kv: KV, net: Network, user: string, list: Pending[], nowMs: number): void {
  const fresh = list.filter((p) => p.status === "pending" || nowMs - p.startedAt < DONE_TTL_MS);
  const keep = makeRoom(fresh, nowMs).slice(0, KEEP); // slice only bites on tampered storage: upsertPending refuses first
  try {
    kv.setItem(pendingKey(net, user), JSON.stringify(keep));
  } catch {
    // storage full or blocked: the list lives for this page only
  }
}

export class PendingFullError extends Error {
  constructor() {
    super("Too many transfers are still in progress. Wait for one to finish before starting another.");
    this.name = "PendingFullError";
  }
}

/**
 * Whether a NEW transfer can be recorded: the same decision upsertPending makes for a new id, without throwing.
 * Callers MUST check this before asking the wallet to sign. After the burn is sent the record has to be stored,
 * and upsertPending throws PendingFullError when there is no room, which would lose an in-flight transfer's record.
 */
export function hasPendingRoom(list: Pending[], nowMs: number = Date.now()): boolean {
  const probe: Pending = { id: "\0new", dir: "deposit", route: "hypercore", amount: "0", startedAt: nowMs, status: "pending" };
  return makeRoom([probe, ...list], nowMs).length <= KEEP;
}

/**
 * Adds or replaces by id, newest first. When a new entry would pass 20, finished entries make room first, then a
 * pending one that is over 7 days old (the only pending entries ever dropped; a younger one is never touched).
 * If neither exists it throws PendingFullError. Call hasPendingRoom BEFORE signing a transfer, so this cannot throw
 * once funds are in flight. Replacing an existing id never needs room.
 */
export function upsertPending(list: Pending[], p: Pending, nowMs: number = Date.now()): Pending[] {
  const next = makeRoom([p, ...list.filter((x) => x.id !== p.id)], nowMs);
  if (next.length > KEEP) throw new PendingFullError();
  return next.sort((a, b) => (a.id === p.id ? -1 : b.id === p.id ? 1 : newest(a, b)));
}

/** [R §2.5] /v2/messages/{domain}?transactionHash=…: first message's status, delayReason, forwardTxHash. */
export function parseIrisMessage(raw: unknown): IrisMessage | null {
  const m = (raw as { messages?: unknown[] } | null)?.messages?.[0] as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return null;
  const s = (k: string) => (typeof m[k] === "string" && m[k] !== "" ? (m[k] as string) : null);
  return { status: s("status") ?? "unknown", delayReason: s("delayReason"), forwardTxHash: s("forwardTxHash") };
}

/** With forwarding on, forwardTxHash appearing is the completion signal [R §2.5]. Finished records never change. */
export function settleCctp(p: Pending, m: IrisMessage | null, nowMs: number): Pending {
  if (p.status === "done") return p;
  if (m?.forwardTxHash) return { ...p, status: "done", note: undefined };
  // "unconfirmed: …" says the burn itself may not have happened: only Iris showing the message (m) settles that, never silence.
  if (!m && p.note?.startsWith("unconfirmed")) return p;
  // [R §2.5] mintAndForward is the by-hand fallback; the UI does not offer it, so the text stays plain.
  if (m?.delayReason) return { ...p, note: `Circle reports a delay: ${m.delayReason}` };
  if (nowMs - p.startedAt > SLOW_MS) return { ...p, note: "Taking longer than expected. Circle's relay is slow; we are still watching." };
  return p.note === undefined ? p : { ...p, note: undefined }; // an earlier delay note is stale once the delay is gone
}

export function settleByBalance(p: Pending, balance: bigint): Pending {
  if (p.status === "done" || p.baseline === undefined || p.minArrive === undefined) return p;
  return balance >= BigInt(p.baseline) + BigInt(p.minArrive) ? { ...p, status: "done", note: undefined } : p;
}

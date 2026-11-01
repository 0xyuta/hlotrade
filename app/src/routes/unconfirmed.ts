import { useSyncExternalStore } from "react";
import type { Network } from "../config/validate";
import type { SignedBody } from "../hl/userSigned";
import type { Pending } from "./pending";

/**
 * Transfer state that must outlive the modal, in module memory: the pending list of each account, the signed bodies
 * whose post was not confirmed, the one-transfer-at-a-time lock and the retries in flight. Every change notifies, so a
 * modal opened (or reopened) at any moment shows the current state and updates live (useTransferStore).
 */
let version = 0;
const listeners = new Set<() => void>();
const notify = () => {
  version++;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** Re-renders the component on every change of the state in this module; read the state during render. */
export const useTransferStore = (): number => useSyncExternalStore(subscribe, () => version);

const acct = (net: Network, user: string) => `${net}:${user.toLowerCase()}`;

/** The pending list of an account. The first read loads it from storage (`load`); after that the module's copy is the truth. */
const lists = new Map<string, Pending[]>();
export function getList(net: Network, user: string, load: () => Pending[]): Pending[] {
  const k = acct(net, user);
  let l = lists.get(k);
  if (!l) {
    l = load();
    lists.set(k, l);
  }
  return l;
}
export function setList(net: Network, user: string, list: Pending[]): void {
  lists.set(acct(net, user), list);
  notify();
}

/**
 * Signed Hyperliquid bodies whose post was not confirmed, by pending-record id. Module memory only, never storage:
 * a signed action is a bearer instruction, so it lives until the page is reloaded and no longer. It outlives the
 * modal, so closing and reopening still offers the safe retry (the same body, the same nonce).
 */
const bodies = new Map<string, SignedBody>();
const key = (net: Network, user: string, id: string) => `${acct(net, user)}:${id}`;
export function keepSigned(net: Network, user: string, id: string, body: SignedBody): void {
  bodies.set(key(net, user, id), body);
  notify();
}
export const heldBody = (net: Network, user: string, id: string): SignedBody | undefined => bodies.get(key(net, user, id));
export function dropSigned(net: Network, user: string, id: string): void {
  if (bodies.delete(key(net, user, id))) notify();
}
/** Whether any unconfirmed body is held for this account. */
export const hasHeld = (net: Network, user: string): boolean => [...bodies.keys()].some((k) => k.startsWith(`${acct(net, user)}:`));

/** "Retry (same request)" posts at most once at a time per record, also across close and reopen. */
const retrying = new Set<string>();
export function beginRetry(net: Network, user: string, id: string): boolean {
  const k = key(net, user, id);
  if (retrying.has(k)) return false;
  retrying.add(k);
  notify();
  return true;
}
export function endRetry(net: Network, user: string, id: string): void {
  retrying.delete(key(net, user, id));
  notify();
}
export const isRetrying = (net: Network, user: string, id: string): boolean => retrying.has(key(net, user, id));

/**
 * One transfer at a time for the whole page: while any transfer is being signed or sent, no other can start, however
 * the modal is navigated (back and re-pick, close and reopen). A second prompt on top of an unanswered one is how a
 * double send happens. There is no automatic release: a wallet prompt might still be open. After WAIT_LONG_MS the UI
 * says so (see sendingSince) and the way out is the wallet, or a page reload.
 */
let sending = false;
let since = 0;
export const WAIT_LONG_MS = 60_000;
export const transferLock = {
  tryBegin(): boolean {
    if (sending) return false;
    sending = true;
    since = Date.now();
    notify();
    return true;
  },
  end(): void {
    sending = false;
    notify();
  },
};
/** When the transfer in flight started (ms), or null when none is. */
export const sendingSince = (): number | null => (sending ? since : null);
export const useTransferBusy = (): boolean => {
  useTransferStore();
  return sending;
};

/** Forgets everything and releases the lock (a page reload does the same; tests use it). */
export function resetTransferState(): void {
  lists.clear();
  bodies.clear();
  retrying.clear();
  sending = false;
  notify();
}

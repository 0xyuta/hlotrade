export interface Eip1193 {
  request(a: { method: string; params?: unknown }): Promise<unknown>;
  on?(event: string, fn: (...a: unknown[]) => void): void;
  removeListener?(event: string, fn: (...a: unknown[]) => void): void;
}
export interface WalletInfo {
  uuid: string;
  name: string;
  icon: string; // data: URI (EIP-6963)
  rdns: string;
}
export interface Discovered {
  info: WalletInfo;
  provider: Eip1193;
}

/** EIP-6963: listen for announcements, then ask every wallet to announce. Returns the unsubscribe. */
export function discoverWallets(target: EventTarget, onChange: (w: Discovered[]) => void): () => void {
  const found = new Map<string, Discovered>();
  const onAnnounce = (ev: Event) => {
    const d = (ev as CustomEvent<Discovered>).detail;
    if (!d?.info?.uuid || typeof d.info.name !== "string" || typeof d.provider?.request !== "function") return;
    // Keyed by the announcement's uuid: a second provider that claims the same rdns must not replace the first (EIP-6963).
    found.set(d.info.uuid, d);
    onChange([...found.values()]);
  };
  target.addEventListener("eip6963:announceProvider", onAnnounce);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => target.removeEventListener("eip6963:announceProvider", onAnnounce);
}

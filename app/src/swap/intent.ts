/** Top bar, Rewards and the Swap screen share this. The App listens and opens Swap; the screen switches to Buy. */
export const BUY_HLO_EVENT = "hlo-buy-hlo";

const listeners = new Set<() => void>();

export function requestBuyHlo(): void {
  for (const l of listeners) l();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BUY_HLO_EVENT));
}

export function watchBuyHlo(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

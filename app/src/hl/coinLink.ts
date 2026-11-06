/**
 * A `?coin=HYPE` link (the "Trade on HLO" button on chart.hlotrade.xyz) opens Trade on that market. Only a plain
 * Hyperliquid perp name is read; anything else is ignored. The URL is not changed, and the stored market is not either:
 * a name that is not listed falls back to it (TradeScreen).
 */
export function coinFromLink(search: string): string | null {
  const coin = new URLSearchParams(search).get("coin");
  return coin && /^[A-Za-z0-9]{1,20}$/.test(coin) ? coin : null;
}

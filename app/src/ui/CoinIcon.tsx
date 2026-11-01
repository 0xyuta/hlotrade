import { useState } from "react";
import { COIN_ICONS_ORIGIN } from "../config/csp";

/** Hyperliquid's icon for the coin, or its first letter on a plain circle when there is none. */
export function CoinIcon({ coin, size }: { coin: string; size: number }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === coin) {
    return <span className="coin-badge" style={{ width: size, height: size, fontSize: size * 0.5 }} aria-hidden="true">{coin.slice(0, 1).toUpperCase()}</span>;
  }
  return <img className="coin-icon" src={`${COIN_ICONS_ORIGIN}/coins/${encodeURIComponent(coin)}.svg`} alt="" width={size} height={size} loading="lazy" onError={() => setFailed(coin)} />;
}

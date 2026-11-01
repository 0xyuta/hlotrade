import { useMemo, useState } from "react";
import { useHl } from "../../hl/HlProvider";
import { change24h } from "../../hl/math";
import { CoinIcon } from "../CoinIcon";
import { fmtCompactUsd, fmtPct, fmtPx } from "../format";

/** The phone's first screen: every market, busiest first. A tap opens that market on Trade. */
export function MarketList({ onPick }: { onPick(coin: string): void }) {
  const { markets, price, error } = useHl();
  const [q, setQ] = useState("");
  const list = useMemo(() => markets.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200), [markets, q]);
  return (
    <section className="market-list">
      <h1 className="page-title">Markets</h1>
      <input className="input market-search" placeholder="Search markets" aria-label="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <p className="error small">{error}</p>}
      {markets.length === 0 && !error && <p className="muted small">Loading markets…</p>}
      {markets.length > 0 && list.length === 0 && <p className="muted small">No market matches.</p>}
      {list.map((m) => {
        const px = price(m.name) ?? m.markPx;
        const ch = change24h(px, m.prevDayPx);
        return (
          <button key={m.name} className="market-row" onClick={() => onPick(m.name)}>
            <CoinIcon coin={m.name} size={40} />
            <span className="market-main">
              <span><span className="market-name">{m.name}</span><span className="market-lev">{m.maxLeverage}×</span></span>
              <span className="muted small">{fmtCompactUsd(m.dayNtlVlm)} · 24h vol</span>
            </span>
            <span className="market-side">
              <span className="market-px">{fmtPx(px)}</span>
              <span className={`num small ${Number.isFinite(ch) ? (ch >= 0 ? "up" : "down") : "muted"}`}>{fmtPct(ch)}</span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

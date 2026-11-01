import { useHl } from "../../hl/HlProvider";
import { fmtPx, fmtUsd } from "../format";

export function MarketStats({ coin }: { coin: string }) {
  const { market } = useHl();
  const m = market(coin);
  if (!m) return null;
  return (
    <section className="card">
      <h3 className="card-h">{coin} market</h3>
      <div className="stat"><span className="k">Mark</span><span className="v">{fmtPx(m.markPx)}</span></div>
      <div className="stat"><span className="k">Oracle</span><span className="v">{fmtPx(m.oraclePx)}</span></div>
      <div className="stat"><span className="k">Funding (1h)</span><span className="v">{(m.funding * 100).toFixed(4)}%</span></div>
      <div className="stat"><span className="k">Open interest</span><span className="v">{fmtUsd(m.openInterest, 2)}</span></div>
      <div className="stat"><span className="k">24h volume</span><span className="v">${fmtUsd(m.dayNtlVlm, 0)}</span></div>
      <div className="stat"><span className="k">Max leverage</span><span className="v">{m.maxLeverage}×{m.onlyIsolated ? " · isolated only" : ""}</span></div>
    </section>
  );
}

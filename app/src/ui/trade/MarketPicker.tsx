import { useEffect, useMemo, useRef, useState } from "react";
import { useHl } from "../../hl/HlProvider";
import { change24h } from "../../hl/math";
import { CoinIcon } from "../CoinIcon";
import { fmtPct, fmtPx } from "../format";

const tone = (n: number) => (Number.isFinite(n) ? (n >= 0 ? "up" : "down") : "muted");

export function MarketPicker({ coin, onPick }: { coin: string; onPick(c: string): void }) {
  const { markets, price, market, error } = useHl();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const m = market(coin);
  const px = price(coin);
  const list = useMemo(() => markets.filter((x) => x.name.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 200), [markets, q]);
  const ch = m && px !== null ? change24h(px, m.prevDayPx) : NaN;
  const anchor = useRef<HTMLDivElement>(null);

  // Escape and a click outside close the list (as in the account menu).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      anchor.current?.querySelector<HTMLElement>("button.picker")?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div className="menu-anchor picker-anchor" ref={anchor}>
      <button className="picker" onClick={() => setOpen(!open)} aria-expanded={open}>
        <CoinIcon coin={coin} size={24} />
        <span className="picker-coin">{coin}-USD</span>
        <span className="num">{px !== null ? fmtPx(px) : "—"}</span>
        <span className={`num small ${tone(ch)}`}>{fmtPct(ch)}</span>
        <span className="muted small">▾</span>
      </button>
      {error && <p className="error small">{error}</p>}
      {open && (
        <div className="menu picker-menu">
          <input className="input" autoFocus placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="picker-list">
            {list.map((x) => {
              const p = price(x.name) ?? x.markPx;
              const c = change24h(p, x.prevDayPx);
              return (
                <button key={x.name} className="menu-item picker-row" onClick={() => { onPick(x.name); setOpen(false); setQ(""); }}>
                  <span className="picker-name"><CoinIcon coin={x.name} size={20} /><span>{x.name} <span className="faint small">{x.maxLeverage}×</span></span></span>
                  <span className="num">{fmtPx(p)}</span>
                  <span className={`num small ${tone(c)}`}>{fmtPct(c)}</span>
                </button>
              );
            })}
            {list.length === 0 && <p className="muted small">No market matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

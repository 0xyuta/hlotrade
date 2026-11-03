import { useEffect, useMemo, useRef, useState } from "react";
import { useConfig } from "../../config/context";
import { useAccount } from "../../hl/AccountProvider";
import { useBook } from "../../hl/book";
import { useHl } from "../../hl/HlProvider";
import { impactPctText, impactWarning, passesLimit, priceImpact, shouldWarn } from "../../hl/impact";
import { DEFAULT_SLIPPAGE, estimateLiq, limitFromPct, sizeFromMargin } from "../../hl/math";
import { num, outcomeText, planOrder } from "../../hl/orders";
import { fillNote } from "../../hl/positions";
import { placeOrder } from "../../hl/trade";
import { useTrading } from "../../hl/TradingProvider";
import { useSession } from "../../wallet/session";
import { fmtPx, fmtUsd } from "../format";
import { EnableGate, tradingReady } from "./EnableGate";
import { ReSignPrompt, tradeErrorText } from "./tradeError";
import { EMPTY_LEG, legPrice, TpslPctField, type TpslLeg } from "./TpslPct";

/** Limit price shortcuts, each counted from the current price (0 = the current price). */
const LIMIT_PRESETS = [-10, -5, -1, 0, 1, 5, 10];

/** How far a limit price is from the current price, in words. */
function limitDistance(px: number | undefined, ref: number): string | null {
  if (px === undefined || !(px > 0) || !(ref > 0)) return null;
  const d = ((px - ref) / ref) * 100;
  if (Math.abs(d) < 0.005) return "at the current price";
  return `${Math.abs(d).toFixed(2)}% ${d > 0 ? "above" : "below"} the current price`;
}

export interface OrderResult {
  coin: string;
  ok: boolean;
  text: string;
}

/**
 * `onResult` is called only when the answer arrives after this form is gone (the user switched market while the order was
 * in flight; TradeScreen keys the form by coin), so the result is not lost.
 */
export function OrderForm({ coin, onResult }: { coin: string; onResult?: (r: OrderResult) => void }) {
  const cfg = useConfig();
  const { session } = useSession();
  const trading = useTrading();
  const account = useAccount();
  const { market, price } = useHl();
  const m = market(coin);
  const ref = price(coin) ?? 0;
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [isBuy, setIsBuy] = useState(true);
  const [margin, setMargin] = useState("");
  const [leverage, setLeverage] = useState(5);
  const [limitPx, setLimitPx] = useState("");
  const [slippagePct, setSlippagePct] = useState(String(DEFAULT_SLIPPAGE * 100));
  const [withTpsl, setWithTpsl] = useState(false);
  const [tp, setTp] = useState<TpslLeg>(EMPTY_LEG);
  const [sl, setSl] = useState<TpslLeg>(EMPTY_LEG);
  const [accepted, setAccepted] = useState<{ key: string; pct: number } | null>(null); // the price impact the user accepted, for this side and size
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const maxLev = m?.maxLeverage ?? 1;
  const lev = Math.min(leverage, maxLev);
  const entry = kind === "limit" ? num(limitPx) ?? 0 : ref;
  const marginN = Number(margin);
  const size = m && entry > 0 && marginN > 0 && Number.isFinite(marginN) ? Number(sizeFromMargin(marginN, lev, entry, m.szDecimals)) : 0;
  const tpslCtx = { entry, leverage: lev, isLong: isBuy };
  const tpPx = withTpsl ? legPrice(tp, "tp", tpslCtx) : undefined;
  const slPx = withTpsl ? legPrice(sl, "sl", tpslCtx) : undefined;
  const plan = useMemo(
    () => (m ? planOrder(m, {
      kind, isBuy, size, refPx: ref, limitPx: num(limitPx), slippage: Number(slippagePct) / 100,
      tp: tpPx, sl: slPx,
    }) : null),
    [m, kind, isBuy, size, ref, limitPx, slippagePct, tpPx, slPx],
  );
  const notional = plan?.ok ? plan.plan.notional : size * entry;
  const liq = m && size > 0 ? estimateLiq(entry, size, isBuy, lev, m.maxLeverage) : null;
  const book = useBook(cfg.network, coin, kind === "market" && size > 0);
  const impact = kind === "market" && book ? priceImpact(book, isBuy, size) : null;
  const warn = impact !== null && shouldWarn(impact);
  const impactKey = `${isBuy}|${size}`;
  // An acceptance holds for this side and size, and only while the impact stays within a quarter point of what was accepted.
  const impactOk = !warn || (accepted !== null && accepted.key === impactKey && impact.pct <= accepted.pct + 0.25);
  const ready = tradingReady(cfg, trading);

  const submit = async () => {
    if (!m || !plan?.ok || !trading.agent || !trading.master || !cfg.builder || !impactOk) return;
    setBusy(true);
    setMsg(null);
    const show = (r: { ok: boolean; text: string }) => (alive.current ? setMsg(r) : onResult?.({ coin: m.name, ...r }));
    try {
      const out = await placeOrder({ net: cfg.network, agentKey: trading.agent.key, master: trading.master, builder: cfg.builder, market: m, leverage: lev, plan: plan.plan });
      const base = outcomeText(out, plan.plan, m.name);
      // A market (IOC) entry can fill only part of its size: say so. A limit order's rest stays on the book, so it needs no note.
      const r = kind === "market" ? fillNote(base, out, plan.plan) : base;
      show(r);
      // Something is live, or the batch was part-rejected: clear the amounts so a second click cannot repeat it blindly.
      if (r.partial || out.some((x) => x.kind === "filled" || x.kind === "resting")) {
        setMargin("");
        setTp(EMPTY_LEG);
        setSl(EMPTY_LEG);
      }
    } catch (e) {
      show({ ok: false, text: tradeErrorText(e, trading, session.kind) });
    } finally {
      if (alive.current) setBusy(false);
      account.refresh();
    }
  };

  if (!m) return <section className="card"><p className="muted">Loading market…</p></section>;
  return (
    <section className="card order-form">
      <div className="seg">
        <button className={kind === "market" ? "on" : ""} onClick={() => setKind("market")}>Market</button>
        <button className={kind === "limit" ? "on" : ""} onClick={() => { setKind("limit"); if (limitPx === "") setLimitPx(limitFromPct(ref, 0, m.szDecimals)); }}>Limit</button>
      </div>
      <div className="seg side">
        <button className={isBuy ? "on long" : ""} onClick={() => setIsBuy(true)}>Long</button>
        <button className={!isBuy ? "on short" : ""} onClick={() => setIsBuy(false)}>Short</button>
      </div>

      <div className="row between small"><span className="muted">Available</span><span className="num">{account.balances ? `$${fmtUsd(account.balances.trade)}` : "—"}</span></div>

      {kind === "limit" && (
        <div className="field">
          <label htmlFor="lpx">Limit price</label>
          <input id="lpx" className="input" inputMode="decimal" placeholder={fmtPx(ref)} value={limitPx} onChange={(e) => setLimitPx(e.target.value)} />
          <div className="row limit-presets">
            {LIMIT_PRESETS.map((p) => (
              <button key={p} type="button" className="btn small" disabled={!(ref > 0)} onClick={() => setLimitPx(limitFromPct(ref, p, m.szDecimals))}>
                {p === 0 ? "Price" : `${p > 0 ? "+" : "−"}${Math.abs(p)}%`}
              </button>
            ))}
          </div>
          {limitDistance(num(limitPx), ref) && <span className="muted small">{limitDistance(num(limitPx), ref)}</span>}
        </div>
      )}
      <div className="field">
        <label htmlFor="margin">Margin (USDC)</label>
        <input id="margin" className="input" inputMode="decimal" placeholder="0.00" value={margin} onChange={(e) => setMargin(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="lev">Leverage: <span className="num">{lev}×</span> · isolated</label>
        <input id="lev" type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => setLeverage(Number(e.target.value))} />
      </div>
      {kind === "market" && (
        <div className="field">
          <label htmlFor="slip">Max slippage (%)</label>
          <input id="slip" className="input" inputMode="decimal" value={slippagePct} onChange={(e) => setSlippagePct(e.target.value)} />
        </div>
      )}
      <label className="row small"><input type="checkbox" checked={withTpsl} onChange={(e) => setWithTpsl(e.target.checked)} /> Take profit / stop loss</label>
      {withTpsl && (
        <div className="grid2 tpsl-grid">
          <TpslPctField id="tp" kind="tp" leg={tp} ctx={tpslCtx} onChange={setTp} />
          <TpslPctField id="sl" kind="sl" leg={sl} ctx={tpslCtx} onChange={setSl} />
        </div>
      )}

      <div className="stat"><span className="k">Size</span><span className="v">{size > 0 ? `${size} ${coin}` : "—"}</span></div>
      <div className="stat"><span className="k">Order value</span><span className="v">${fmtUsd(notional)}</span></div>
      {kind === "market" && plan?.ok && <div className="stat"><span className="k">Worst price</span><span className="v">{fmtPx(Number(plan.plan.orders[0].p))}</span></div>}
      {kind === "market" && size > 0 && <div className="stat"><span className="k">Price impact</span><span className={`v ${warn ? "hot" : ""}`}>{impact ? impactPctText(impact) : "—"}</span></div>}
      <div className="stat"><span className="k">Est. liquidation</span><span className="v">{liq ? fmtPx(liq) : "—"}</span></div>
      {warn && (
        <div className="impact-warn" role="alert">
          <p>{impactWarning(impact, "This order")} A smaller size or a limit order costs less.</p>
          {plan?.ok && passesLimit(impact, isBuy, Number(plan.plan.orders[0].p)) && <p>Part of it may not fill within your max slippage.</p>}
          <label className="row small">
            <input type="checkbox" checked={impactOk} onChange={(e) => setAccepted(e.target.checked ? { key: impactKey, pct: impact.pct } : null)} /> I accept about {impactPctText(impact)} price impact
          </label>
        </div>
      )}

      {!ready ? (
        <EnableGate />
      ) : (
        <button className={`btn wide ${isBuy ? "long" : "short"}`} disabled={busy || !plan?.ok || !impactOk} onClick={() => void submit()}>
          {busy ? "Sending…" : `${isBuy ? "Long" : "Short"} ${coin}`}
        </button>
      )}
      {plan && !plan.ok && size > 0 && <p className="muted small">{plan.error}</p>}
      {size === 0 && marginN > 0 && entry > 0 && <p className="muted small">That margin is too small for one lot of {coin}.</p>}
      {marginN > (account.balances?.trade ?? Infinity) && <p className="muted small">That is more than your available ${fmtUsd(account.balances?.trade ?? 0)}.</p>}
      {msg && <p className={msg.ok ? "note" : "error"}>{msg.text}</p>}
      <ReSignPrompt />
      {trading.error && <p className="error">{trading.error}</p>}
    </section>
  );
}

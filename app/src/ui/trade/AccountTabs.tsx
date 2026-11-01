import { useEffect, useRef, useState } from "react";
import { useConfig } from "../../config/context";
import { useAccount } from "../../hl/AccountProvider";
import { fetchBook, useBook } from "../../hl/book";
import { useHl } from "../../hl/HlProvider";
import { impactPctText, impactWarning, priceImpact, shouldWarn } from "../../hl/impact";
import { DEFAULT_SLIPPAGE, livePnl } from "../../hl/math";
import { outcomeText, type PlanResult } from "../../hl/orders";
import { describeCancels, fillNote, planClose, planReverse, tpslOrdersAll, tpslOrdersFor } from "../../hl/positions";
import { cancelOrders, submitPlan } from "../../hl/trade";
import { useTrading } from "../../hl/TradingProvider";
import { useSession } from "../../wallet/session";
import { fmtPx, fmtUsd, signedUsd } from "../format";
import { Modal } from "../Modal";
import { ReSignPrompt, tradeErrorText } from "./tradeError";
import { TpslModal } from "./TpslModal";

type TabId = "positions" | "orders" | "history";

const HOLD_MS = 10_000;

export function AccountTabs() {
  const cfg = useConfig();
  const trading = useTrading();
  const { session } = useSession();
  const account = useAccount();
  const { market, price } = useHl();
  const [tab, setTab] = useState<TabId>("positions");
  const [editing, setEditing] = useState<string | null>(null); // a coin: the modal reads the position as it is now
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState<{ coin: string; text: string } | null>(null); // a close whose price impact needs a yes
  const [confirmRev, setConfirmRev] = useState<string | null>(null); // a coin: the question and the order are both built from the position as it is now
  // After a close or reverse the row is stale until the account refetches: its buttons stay off until `positions` is a new array (every fetch makes one), or HOLD_MS pass.
  const [held, setHeld] = useState<{ coin: string; at: unknown } | null>(null);
  const positionsRef = useRef(account.positions);
  positionsRef.current = account.positions;
  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => setHeld(null), HOLD_MS);
    return () => clearTimeout(t);
  }, [held]);
  const isHeld = (coin: string) => held !== null && held.coin === coin && held.at === account.positions;
  const canAct = !!trading.agent && !!cfg.builder && !!trading.status?.agentOk;
  const reversing = confirmRev ? account.positions.find((p) => p.coin === confirmRev) ?? null : null;
  const closing = confirmClose ? account.positions.find((p) => p.coin === confirmClose.coin) ?? null : null;
  const revBook = useBook(cfg.network, reversing?.coin ?? "", reversing !== null);
  const revImpact = reversing && revBook ? priceImpact(revBook, reversing.szi < 0, 2 * Math.abs(reversing.szi)) : null;
  const editingPosition = editing ? account.positions.find((p) => p.coin === editing) ?? null : null;

  const run = async (id: string, f: () => Promise<{ ok: boolean; text: string }>) => {
    setBusy(id);
    setMsg(null);
    try {
      setMsg(await f());
    } catch (e) {
      setMsg({ ok: false, text: tradeErrorText(e, trading, session.kind) });
    } finally {
      setBusy(null);
      account.refresh();
    }
  };
  const send = (id: string, coin: string, plan: PlanResult) =>
    run(id, async () => {
      if (!plan.ok) return { ok: false, text: plan.error };
      let out: Awaited<ReturnType<typeof submitPlan>>;
      try {
        out = await submitPlan({ net: cfg.network, agentKey: trading.agent!.key, builder: cfg.builder!, plan: plan.plan });
      } catch (e) {
        // A throw (network failure, timeout) does not say the order did not reach Hyperliquid: hold the row as after a fill.
        setHeld({ coin, at: positionsRef.current });
        throw e;
      }
      setHeld({ coin, at: positionsRef.current });
      return fillNote(outcomeText(out, plan.plan), out, plan.plan);
    });
  const sendClose = (coin: string) => {
    const m = market(coin);
    const p = positionsRef.current.find((x) => x.coin === coin);
    if (m && p) void send(`close:${coin}`, coin, planClose(m, p, price(coin) ?? 0, DEFAULT_SLIPPAGE));
  };
  /** Close reads the book first: a close that moves the price 1% or more (or one that cannot be checked) asks before sending. */
  const close = async (coin: string) => {
    const m = market(coin);
    const p = account.positions.find((x) => x.coin === coin);
    if (!m || !p) return;
    if (!planClose(m, p, price(coin) ?? 0, DEFAULT_SLIPPAGE).ok) return sendClose(coin); // shows the plan's message
    setBusy(`check:${coin}`);
    setMsg(null);
    let text: string | null = "Could not read the order book to check the price impact.";
    try {
      const book = await fetchBook(cfg.network, coin);
      const i = book ? priceImpact(book, p.szi < 0, Math.abs(p.szi)) : null;
      if (i) text = shouldWarn(i) ? impactWarning(i, "Closing it") : null;
    } catch {
      // the text above stands
    } finally {
      setBusy(null);
    }
    if (text) setConfirmClose({ coin, text });
    else sendClose(coin);
  };
  const cancel = (coin: string, oid: number) => {
    const m = market(coin);
    if (!m) return;
    void run(`cancel:${oid}`, async () => {
      const cancels = [{ a: m.index, o: oid }];
      const out = await cancelOrders({ net: cfg.network, agentKey: trading.agent!.key, cancels });
      return describeCancels(cancels, out, account.openOrders);
    });
  };

  return (
    <section className="card account-tabs">
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "positions"} className={`tab ${tab === "positions" ? "on" : ""}`} onClick={() => setTab("positions")}>Positions ({account.positions.length})</button>
        <button role="tab" aria-selected={tab === "orders"} className={`tab ${tab === "orders" ? "on" : ""}`} onClick={() => setTab("orders")}>Open orders ({account.openOrders.length})</button>
        <button role="tab" aria-selected={tab === "history"} className={`tab ${tab === "history" ? "on" : ""}`} onClick={() => setTab("history")}>Trade history</button>
      </div>
      {account.error && <p className="error">{account.error}</p>}
      {msg && <p className={msg.ok ? "note" : "error"}>{msg.text}</p>}
      <ReSignPrompt />

      {tab === "positions" && (
        <div className="scroll-x">
          {account.positions.length === 0 ? <p className="muted small">No open positions.</p> : (
            <table className="table cards">
              <thead><tr><th>Market</th><th className="num">Size</th><th className="num">Entry</th><th className="num">Price</th><th className="num">PnL</th><th className="num">Liq.</th><th className="num">Margin</th><th>TP / SL</th><th /></tr></thead>
              <tbody>
                {account.positions.map((p) => {
                  const m = market(p.coin);
                  const px = price(p.coin);
                  const pnl = px !== null ? livePnl(p.szi, p.entryPx, px) : p.unrealizedPnl;
                  const t = tpslOrdersFor(p.coin, account.openOrders);
                  const off = !canAct || !m || busy !== null || isHeld(p.coin);
                  const all = tpslOrdersAll(p.coin, account.openOrders);
                  const extra = all.length - (t.tp ? 1 : 0) - (t.sl ? 1 : 0);
                  return (
                    <tr key={p.coin}>
                      <td className="card-title"><span className={p.szi > 0 ? "up" : "down"}>{p.coin} {p.szi > 0 ? "long" : "short"}</span> <span className="faint small">{p.leverage.value}× {p.leverage.type}</span></td>
                      <td className="num" data-label="Size">{Math.abs(p.szi)}</td>
                      <td className="num" data-label="Entry">{fmtPx(p.entryPx)}</td>
                      <td className="num" data-label="Price">{px !== null ? fmtPx(px) : "—"}</td>
                      <td className={`num ${pnl >= 0 ? "up" : "down"}`} data-label="PnL">{signedUsd(pnl)}</td>
                      <td className="num" data-label="Liq.">{p.liquidationPx !== null ? fmtPx(p.liquidationPx) : "—"}</td>
                      <td className="num" data-label="Margin">${fmtUsd(p.marginUsed)}</td>
                      <td className="num small" data-label="TP / SL">{t.tp?.triggerPx ? fmtPx(t.tp.triggerPx) : "—"} / {t.sl?.triggerPx ? fmtPx(t.sl.triggerPx) : "—"}{extra > 0 && ` +${extra}`}</td>
                      <td className="card-actions">
                        <div className="row">
                          <button className="btn small" disabled={off} onClick={() => void close(p.coin)}>{busy === `check:${p.coin}` ? "Checking…" : "Close"}</button>
                          <button className="btn small" disabled={off} onClick={() => setConfirmRev(p.coin)}>Reverse</button>
                          <button className="btn small" disabled={off} onClick={() => setEditing(p.coin)}>TP/SL</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "orders" && (
        <div className="scroll-x">
          {account.openOrders.length === 0 ? <p className="muted small">No open orders.</p> : (
            <table className="table cards">
              <thead><tr><th>Market</th><th>Type</th><th>Side</th><th className="num">Price</th><th className="num">Trigger</th><th className="num">Size</th><th /></tr></thead>
              <tbody>
                {account.openOrders.map((o) => (
                  <tr key={o.oid}>
                    <td className="card-title">{o.coin}</td>
                    <td data-label="Type">{o.orderType}{o.reduceOnly ? " · reduce-only" : ""}</td>
                    <td className={o.side === "B" ? "up" : "down"} data-label="Side">{o.side === "B" ? "Buy" : "Sell"}</td>
                    <td className="num" data-label="Price">{o.isTrigger && o.limitPx === 0 ? "Market" : fmtPx(o.limitPx)}</td>
                    <td className="num" data-label="Trigger">{o.triggerPx !== null ? fmtPx(o.triggerPx) : "—"}</td>
                    <td className="num" data-label="Size">{o.sz}</td>
                    <td className="card-actions">
                      <button className="btn small" disabled={!canAct || !market(o.coin) || busy !== null} onClick={() => cancel(o.coin, o.oid)}>Cancel</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === "history" && (
        <div className="scroll-x">
          {account.fills.length === 0 ? <p className="muted small">No trades yet.</p> : (
            <table className="table cards">
              <thead><tr><th>Time</th><th>Market</th><th>Direction</th><th className="num">Price</th><th className="num">Size</th><th className="num">Fee</th><th className="num">of which HLO</th><th className="num">Closed PnL</th></tr></thead>
              <tbody>
                {account.fills.slice(0, 100).map((f) => (
                  <tr key={f.tid}>
                    <td className="small" data-label="Time">{new Date(f.time).toLocaleString()}</td>
                    <td className="card-title">{f.coin}</td>
                    <td className={f.side === "B" ? "up" : "down"} data-label="Direction">{f.dir}</td>
                    <td className="num" data-label="Price">{fmtPx(f.px)}</td>
                    <td className="num" data-label="Size">{f.sz}</td>
                    <td className="num" data-label="Fee">${fmtUsd(f.fee, 4)}</td>
                    <td className="num" data-label="of which HLO">${fmtUsd(f.builderFee, 4)}</td>
                    <td className={`num ${f.closedPnl >= 0 ? "up" : "down"}`} data-label="Closed PnL">{f.closedPnl ? signedUsd(f.closedPnl) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {reversing && (() => {
        const m = market(reversing.coin);
        const sz = Math.abs(reversing.szi);
        const [from, to] = reversing.szi > 0 ? ["long", "short"] : ["short", "long"];
        return (
          <Modal title="Reverse position" onClose={() => setConfirmRev(null)}>
            <p>Reverse {sz} {reversing.coin} {from} into a {sz} {reversing.coin} {to}?</p>
            <p className="muted small">Price impact: {revImpact ? impactPctText(revImpact) : "checking…"}</p>
            {revImpact && shouldWarn(revImpact) && <p className="impact-warn" role="alert">{impactWarning(revImpact, "Reversing it")}</p>}
            <div className="row">
              <button className="btn primary" disabled={!m || busy !== null || isHeld(reversing.coin)} onClick={() => {
                setConfirmRev(null);
                if (m) void send(`rev:${reversing.coin}`, reversing.coin, planReverse(m, reversing, price(reversing.coin) ?? 0, DEFAULT_SLIPPAGE));
              }}>Yes, reverse</button>
              <button className="btn" onClick={() => setConfirmRev(null)}>Cancel</button>
            </div>
          </Modal>
        );
      })()}
      {closing && confirmClose && (
        <Modal title="Close position" onClose={() => setConfirmClose(null)}>
          <p className="impact-warn" role="alert">{confirmClose.text}</p>
          <p>Close {Math.abs(closing.szi)} {closing.coin} {closing.szi > 0 ? "long" : "short"} anyway?</p>
          <div className="row">
            <button className="btn primary" disabled={busy !== null || isHeld(closing.coin)} onClick={() => {
              setConfirmClose(null);
              sendClose(closing.coin);
            }}>Yes, close</button>
            <button className="btn" onClick={() => setConfirmClose(null)}>Cancel</button>
          </div>
        </Modal>
      )}
      {editingPosition && <TpslModal position={editingPosition} onClose={() => setEditing(null)} />}
    </section>
  );
}

import { useState } from "react";
import { useConfig } from "../../config/context";
import type { Position } from "../../hl/account";
import { useAccount } from "../../hl/AccountProvider";
import { useHl } from "../../hl/HlProvider";
import { pctFromTpslPrice } from "../../hl/math";
import { outcomeText } from "../../hl/orders";
import { describeCancels, planPositionTpsl, tpslOrdersAll, tpslOrdersFor } from "../../hl/positions";
import { cancelOrders, submitPlan } from "../../hl/trade";
import { useTrading } from "../../hl/TradingProvider";
import { useSession } from "../../wallet/session";
import { fmtPx } from "../format";
import { Modal } from "../Modal";
import { ReSignPrompt, tradeErrorText } from "./tradeError";
import { EMPTY_LEG, legPrice, TpslPctField, type TpslCtx, type TpslLeg } from "./TpslPct";

/** Cancel wires for ALL reduce-only trigger orders of the coin, not only the first TP and SL: leaving one would stack a new pair on it (an edit is cancel-then-place [T §3.2, §3.7]). */
const cancelsOf = (assetIndex: number, orders: ReturnType<typeof tpslOrdersAll>) => orders.map((o) => ({ a: assetIndex, o: o.oid }));

/** Edit = cancel the existing TP/SL trigger orders, then place new ones [T §3.2, §3.7]. */
export function TpslModal({ position, onClose }: { position: Position; onClose(): void }) {
  const cfg = useConfig();
  const trading = useTrading();
  const { session } = useSession();
  const account = useAccount();
  const { market, price } = useHl();
  const m = market(position.coin);
  const ref = price(position.coin) ?? 0;
  const current = tpslOrdersFor(position.coin, account.openOrders);
  const existing = tpslOrdersAll(position.coin, account.openOrders);
  const ctx: TpslCtx = { entry: position.entryPx, leverage: position.leverage.value, isLong: position.szi > 0 };
  // An existing trigger is shown as its % and kept at its exact price until the % is changed.
  const fromOrder = (px: number | null | undefined, kind: "tp" | "sl"): TpslLeg => {
    if (!px) return EMPTY_LEG;
    const pct = pctFromTpslPrice({ ...ctx, price: px, kind });
    return { pct: Number.isFinite(pct) ? String(Math.round(pct * 10) / 10) : "", px };
  };
  const [tp, setTp] = useState(() => fromOrder(current.tp?.triggerPx, "tp"));
  const [sl, setSl] = useState(() => fromOrder(current.sl?.triggerPx, "sl"));
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!m || !trading.agent || !cfg.builder) return;
    const plan = planPositionTpsl(m, position, ref, { tp: legPrice(tp, "tp", ctx), sl: legPrice(sl, "sl", ctx) });
    if (!plan.ok) return setMsg(plan.error);
    setBusy(true);
    let cancelled = false;
    try {
      const old = cancelsOf(m.index, existing);
      if (old.length) {
        const out = await cancelOrders({ net: cfg.network, agentKey: trading.agent.key, cancels: old });
        const d = describeCancels(old, out, existing);
        if (!d.ok) return setMsg(`${d.text} No new TP/SL was placed. Check Open orders, then try again.`); // HL has done the ones it could; stacking new triggers on the rest would be worse
        cancelled = true;
      }
      const r = outcomeText(await submitPlan({ net: cfg.network, agentKey: trading.agent.key, builder: cfg.builder, plan: plan.plan }), plan.plan, position.coin);
      setMsg(r.ok || !cancelled ? r.text : `${r.text} Your old TP/SL was cancelled.`);
      if (r.ok) onClose();
    } catch (e) {
      const text = tradeErrorText(e, trading, session.kind);
      setMsg(cancelled ? `${text} Your old TP/SL was cancelled.` : text);
    } finally {
      setBusy(false);
      account.refresh();
    }
  };

  const removeAll = async () => {
    if (!m || !trading.agent) return;
    const old = cancelsOf(m.index, existing);
    if (!old.length) return onClose();
    setBusy(true);
    try {
      const out = await cancelOrders({ net: cfg.network, agentKey: trading.agent.key, cancels: old });
      const d = describeCancels(old, out, existing);
      if (d.ok) onClose();
      else setMsg(`${d.text} Check Open orders.`);
    } catch (e) {
      setMsg(tradeErrorText(e, trading, session.kind));
    } finally {
      setBusy(false);
      account.refresh();
    }
  };

  return (
    <Modal title={`TP/SL · ${position.coin} ${position.szi > 0 ? "long" : "short"}`} onClose={onClose}>
      <p className="muted small">Price {fmtPx(ref)} · entry {fmtPx(position.entryPx)} · {ctx.leverage}×. The % is the gain or loss on your margin, counted from entry. Triggers on the mark price and fills within 10% of the trigger.</p>
      <div className="grid2 tpsl-grid">
        <TpslPctField id="ptp" kind="tp" leg={tp} ctx={ctx} onChange={setTp} />
        <TpslPctField id="psl" kind="sl" leg={sl} ctx={ctx} onChange={setSl} />
      </div>
      <div className="row">
        <button className="btn primary" disabled={busy || !m} onClick={() => void save()}>{busy ? "Sending…" : "Save"}</button>
        {existing.length > 0 && <button className="btn" disabled={busy || !m} onClick={() => void removeAll()}>Remove TP/SL</button>}
      </div>
      {existing.length > (current.tp ? 1 : 0) + (current.sl ? 1 : 0) && <p className="muted small">This market has {existing.length} reduce-only trigger orders. Saving or removing replaces all of them.</p>}
      {msg && <p className="note tpsl-msg">{msg}</p>}
      <ReSignPrompt />
    </Modal>
  );
}

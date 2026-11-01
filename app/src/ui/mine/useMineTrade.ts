import { useEffect, useRef, useState } from "react";
import { useConfig } from "../../config/context";
import { useAccount } from "../../hl/AccountProvider";
import { fetchBook } from "../../hl/book";
import { useHl } from "../../hl/HlProvider";
import { impactWarning, priceImpact, shouldWarn } from "../../hl/impact";
import { DEFAULT_SLIPPAGE } from "../../hl/math";
import { outcomeText, type OrderPlan, type OrderOutcome } from "../../hl/orders";
import { fillNote, planClose } from "../../hl/positions";
import { placeOrder, submitPlan } from "../../hl/trade";
import { useTrading } from "../../hl/TradingProvider";
import { useSession } from "../../wallet/session";
import { tradeErrorText } from "../trade/tradeError";

/** After a send the button stays off until the account has read again, or this long: a stale screen must not invite a second trade. */
const HOLD_MS = 10_000;

/** Opening and closing in mine mode. Each happens only on the user's press; nothing here closes or repeats a trade by itself. */
export function useMineTrade() {
  const cfg = useConfig();
  const trading = useTrading();
  const { session } = useSession();
  const account = useAccount();
  const { market, price } = useHl();
  const [busy, setBusy] = useState<"open" | "check" | "close" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmClose, setConfirmClose] = useState<{ coin: string; text: string } | null>(null); // a close whose price impact needs a yes
  const [held, setHeld] = useState<{ at: unknown } | null>(null);
  const sending = useRef(false); // set at once, before the next render, so a double click cannot send twice
  const positionsRef = useRef(account.positions);
  positionsRef.current = account.positions;
  useEffect(() => {
    if (!held) return;
    const t = setTimeout(() => setHeld(null), HOLD_MS);
    return () => clearTimeout(t);
  }, [held]);
  const waiting = held !== null && held.at === account.positions;

  const send = async (kind: "open" | "close", plan: OrderPlan, go: () => Promise<OrderOutcome[]>) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(kind);
    setMsg(null);
    try {
      const out = await go();
      setMsg(fillNote(outcomeText(out, plan), out, plan));
    } catch (e) {
      setMsg({ ok: false, text: tradeErrorText(e, trading, session.kind) });
    } finally {
      // A throw (network failure, timeout) does not say the order did not reach Hyperliquid: hold as after a fill.
      setHeld({ at: positionsRef.current });
      sending.current = false;
      setBusy(null);
      account.refresh();
    }
  };

  const open = (coin: string, plan: OrderPlan, leverage: number) => {
    const m = market(coin);
    if (!m || !trading.agent || !trading.master || !cfg.builder) return;
    const [agentKey, master, builder] = [trading.agent.key, trading.master, cfg.builder];
    void send("open", plan, () => placeOrder({ net: cfg.network, agentKey, master, builder, market: m, leverage, plan }));
  };

  const sendClose = (coin: string) => {
    const m = market(coin);
    const p = positionsRef.current.find((x) => x.coin === coin);
    if (!m || !p || !trading.agent || !cfg.builder) return;
    const planned = planClose(m, p, price(coin) ?? 0, DEFAULT_SLIPPAGE);
    if (!planned.ok) return setMsg({ ok: false, text: planned.error });
    const [agentKey, builder] = [trading.agent.key, cfg.builder];
    void send("close", planned.plan, () => submitPlan({ net: cfg.network, agentKey, builder, plan: planned.plan }));
  };

  /** Close reads the book first: a close that moves the price 1% or more (or one that cannot be checked) asks before sending. */
  const close = async (coin: string) => {
    const p = account.positions.find((x) => x.coin === coin);
    if (!p || sending.current) return;
    setBusy("check");
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

  return { busy, msg, waiting, confirmClose, setConfirmClose, open, close, sendClose };
}

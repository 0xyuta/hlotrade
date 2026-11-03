import { useEffect, useMemo, useRef, useState } from "react";
import { useConfig } from "../../config/context";
import { useAccount } from "../../hl/AccountProvider";
import { useBook } from "../../hl/book";
import { useHl } from "../../hl/HlProvider";
import { impactPctText, impactWarning, priceImpact, shouldWarn } from "../../hl/impact";
import { COIN_KEY } from "../../hl/markets";
import { browserKV } from "../../hl/agent";
import { estimateLiq, livePnl } from "../../hl/math";
import { num } from "../../hl/orders";
import { useTrading } from "../../hl/TradingProvider";
import { feeTable, tradeRows } from "../../rewards/explore";
import { amountProblem, clockText, DEFAULT_AMOUNT, DEFAULT_LEVERAGE, estimateText, fundsText, lastMinuteText, lastTradeText, leverageChoices, MINE_AMOUNTS, minePosition, otherPositionsText, planMine, positionLine, riskText, secondsLeft, startLabel, tableTotal } from "../../rewards/mine";
import { claimLimited } from "../../rewards/model";
import { POP_ODDS } from "../../rewards/odds";
import { useClaim } from "../../rewards/useClaim";
import { useMinuteTables } from "../../rewards/useMinuteTables";
import { useRewards } from "../../rewards/useRewards";
import { claimButton, claimGate, pointsNeededText } from "../../rewards/view";
import { allowed } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";
import { fmtHlo, signedUsd } from "../format";
import { Modal } from "../Modal";
import { EnableGate, tradingReady } from "../trade/EnableGate";
import { MarketPicker } from "../trade/MarketPicker";
import { ReSignPrompt } from "../trade/tradeError";
import { useMineTrade } from "./useMineTrade";

const RING = 2 * Math.PI * 62;

/**
 * Chain time moved on by the seconds since it was read. The base is always the block timestamp and each poll sets it again; the
 * ticking between polls is only for the clock on this screen, and decides nothing.
 */
function useTickingNow(chainNow: number | null): number | null {
  const [, tick] = useState(0);
  const readAt = useRef({ now: chainNow, at: performance.now() });
  if (readAt.current.now !== chainNow) readAt.current = { now: chainNow, at: performance.now() };
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return chainNow === null ? null : chainNow + Math.floor((performance.now() - readAt.current.at) / 1000);
}

/** Mine mode: this minute, your HLO, and one button that opens a real position or closes it. The rules are rewards/mine.ts. */
export function MineScreen() {
  const cfg = useConfig();
  const { session } = useSession();
  const trading = useTrading();
  const account = useAccount();
  const { markets, market, price } = useHl();
  const { master } = trading;
  const { state, reload, hold } = useRewards(master);
  const data = state.kind === "ready" ? state.data : null;
  const chain = data?.chain ?? null;
  const latest = data?.latest ?? null;
  const y = data?.yours ?? null;
  const { busy: claiming, msg: claimMsg, claim } = useClaim({ plan: data?.plan ?? null, master, reload, hold });
  const trade = useMineTrade();

  const [coin, setCoin] = useState(() => browserKV.getItem(COIN_KEY) ?? "BTC");
  const [isBuy, setIsBuy] = useState(true);
  const [amount, setAmount] = useState(String(DEFAULT_AMOUNT));
  const [picked, setPicked] = useState(DEFAULT_LEVERAGE);
  const [accepted, setAccepted] = useState<{ key: string; pct: number } | null>(null);
  const pick = (c: string) => {
    setCoin(c);
    browserKV.setItem(COIN_KEY, c);
  };
  useEffect(() => {
    if (markets.length && !markets.some((m) => m.name === coin)) setCoin(markets[0].name);
  }, [markets, coin]);
  // Back on this screen with a position elsewhere: open on it, once, so its Close is in front of the user.
  const jumped = useRef(false);
  useEffect(() => {
    if (jumped.current || account.positions.length === 0) return;
    jumped.current = true;
    if (!minePosition(account.positions, coin)) setCoin(account.positions[0].coin);
  }, [account.positions, coin]);

  const m = market(coin);
  const px = price(coin);
  const position = minePosition(account.positions, coin);
  const amountN = num(amount) ?? 0;
  const maxLeverage = m?.maxLeverage ?? DEFAULT_LEVERAGE;
  const leverage = Math.min(picked, maxLeverage); // a market with a lower maximum: its own maximum
  const plan = useMemo(() => (m ? planMine(m, isBuy, amountN, px ?? 0, leverage) : null), [m, isBuy, amountN, px, leverage]);
  const size = plan?.ok ? Number(plan.plan.orders[0].s) : 0;
  const book = useBook(cfg.network, coin, !position && size > 0);
  const impact = !position && book ? priceImpact(book, isBuy, size) : null;
  const warn = impact !== null && shouldWarn(impact);
  const impactKey = `${coin}|${isBuy}|${size}`;
  const liq = plan?.ok && px !== null ? estimateLiq(px, size, isBuy, leverage, maxLeverage) : null;
  // As in the order form: an acceptance holds for this order, while the impact stays within a quarter point of what was accepted.
  const impactOk = !warn || (accepted !== null && accepted.key === impactKey && impact.pct <= accepted.pct + 0.25);
  const available = account.balances?.trade ?? null;
  const tooMuch = amountProblem(amountN, available);
  const ready = tradingReady(cfg, trading);

  const lastTotal = useMemo(() => {
    const table = latest ? feeTable(latest.table, latest.throughMinute) : null;
    return table ? tableTotal(table) : null;
  }, [latest]);
  const published = latest?.throughMinute ?? null;
  const tradesOf = { fills: master ? account.fills : [], user: master ?? "", launchTime: chain?.launchTime ?? 0, published, max: 1 };
  const first = chain ? tradeRows({ ...tradesOf, tables: new Map(), failed: new Set() })[0] ?? null : null;
  const { tables, failed } = useMinuteTables(first?.counts && published !== null && first.minute <= published ? [first.minute] : [], chain, latest);
  const lastTrade = chain ? tradeRows({ ...tradesOf, tables, failed })[0] ?? null : null;

  const now = useTickingNow(chain?.now ?? null);
  const seconds = now !== null && chain ? secondsLeft(now, chain.launchTime) : null;
  const pointsStale = latest !== null && data?.yoursAt != null && latest.vault.lastPopMinute > data.yoursAt; // as on the Vault card
  const gate = claimGate({ canClaim: allowed(session.kind, "claim"), paired: session.kind === "paired", paused: chain?.paused ?? false, limited: y !== null && claimLimited(y) });
  const btn = claimButton({ plan: data?.plan ?? null, busy: claiming, allowed: gate.allowed, problem: data?.latestProblem ?? null });
  const odds = latest?.vault.odds ?? POP_ODDS[cfg.hyperEvmChainId];
  const lastTradeLine = lastTrade && master ? lastTradeText(lastTrade, tables.get(lastTrade.minute), master) : null;
  const closing = trade.confirmClose ? minePosition(account.positions, trade.confirmClose.coin) : null;
  const off = trade.busy !== null || trade.waiting;

  return (
    <div className="mine">
      <div className="mine-clock" role="timer" aria-label={`This minute: ${clockText(seconds)} left`}>
        <svg viewBox="0 0 140 140" aria-hidden="true">
          <circle cx="70" cy="70" r="62" className="mine-ring-back" />
          <circle cx="70" cy="70" r="62" className="mine-ring" strokeDasharray={RING} strokeDashoffset={RING * (1 - (seconds ?? 0) / 60)} />
        </svg>
        <div className="mine-clock-text"><strong className="num">{clockText(seconds)}</strong><span className="muted small">this minute</span></div>
      </div>
      {lastMinuteText(lastTotal) && <p className="muted small mine-center">{lastMinuteText(lastTotal)}</p>}
      {lastTradeLine && <p className="small mine-center mine-last">{lastTradeLine}</p>}
      {state.kind === "down" && <p className="notice-warn">The rewards numbers cannot load right now. Trading still works.</p>}
      {data?.latestProblem && <p className="notice-warn">{data.latestProblem}</p>}

      <div className="mine-stats">
        <div className="mine-stat">
          <span className="muted small">Your HLO</span>
          <strong className="num">{y ? fmtHlo(y.claimable) : "—"}</strong>
          {y && y.claimable > 0n && <button className="btn small primary" disabled={btn.disabled} onClick={() => void claim()}>{btn.label}</button>}
        </div>
        <div className="mine-stat">
          <span className="muted small">Vault</span>
          <strong className="num">{latest ? fmtHlo(BigInt(latest.vault.amount), 0) : "—"}</strong>
          {odds !== undefined && <span className="muted small">1 in {odds.toLocaleString("en-US")} each minute</span>}
        </div>
      </div>
      {y && y.claimable > 0n && !gate.allowed && gate.blockedText && <p className="note">{gate.blockedText}</p>}
      {claimMsg && <p className="note">{claimMsg}</p>}
      {y && !pointsStale && pointsNeededText(y.points) && <p className="muted small mine-center">{pointsNeededText(y.points)}</p>}

      <section className="card mine-order">
        <MarketPicker coin={coin} onPick={pick} />
        {position ? (
          <>
            <div className="stat"><span className="k">{positionLine(position, px)}</span><span className={`v ${(px !== null ? livePnl(position.szi, position.entryPx, px) : position.unrealizedPnl) >= 0 ? "up" : "down"}`}>{signedUsd(px !== null ? livePnl(position.szi, position.entryPx, px) : position.unrealizedPnl)}</span></div>
            <p className="muted small">It stays open until you close it.</p>
            <button className="btn wide" disabled={off || !ready || !m} onClick={() => void trade.close(coin)}>
              {trade.busy === "check" ? "Checking…" : trade.busy === "close" ? "Closing…" : "Close position"}
            </button>
          </>
        ) : (
          <>
            <div className="seg side" role="group" aria-label="Direction">
              <button className={isBuy ? "on long" : ""} aria-pressed={isBuy} onClick={() => setIsBuy(true)}>Long</button>
              <button className={!isBuy ? "on short" : ""} aria-pressed={!isBuy} onClick={() => setIsBuy(false)}>Short</button>
            </div>
            <div className="field">
              <label htmlFor="mine-amount">Amount (USDC)</label>
              <input id="mine-amount" className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
              <div className="row mine-amounts">
                {MINE_AMOUNTS.map((a) => (
                  <button key={a} type="button" className={`btn small ${amountN === a ? "on" : ""}`} onClick={() => setAmount(String(a))}>${a.toLocaleString("en-US")}</button>
                ))}
              </div>
            </div>
            <div className="field">
              <span className="field-label" id="mine-leverage">Leverage · isolated</span>
              <div className="row mine-amounts" role="group" aria-labelledby="mine-leverage">
                {leverageChoices(maxLeverage).map((l) => (
                  <button key={l} type="button" className={`btn small ${leverage === l ? "on" : ""}`} aria-pressed={leverage === l} onClick={() => setPicked(l)}>{l}×</button>
                ))}
              </div>
            </div>
            {warn && (
              <div className="impact-warn" role="alert">
                <p>{impactWarning(impact, "This order")}</p>
                <label className="row small">
                  <input type="checkbox" checked={impactOk} onChange={(e) => setAccepted(e.target.checked ? { key: impactKey, pct: impact.pct } : null)} /> I accept about {impactPctText(impact)} price impact
                </label>
              </div>
            )}
            {ready ? (
              <button className="btn primary wide" disabled={off || !plan?.ok || !impactOk || tooMuch !== null} onClick={() => plan?.ok && trade.open(coin, plan.plan, leverage)}>
                {trade.busy === "open" ? "Sending…" : startLabel(isBuy, amountN, coin, leverage)}
              </button>
            ) : <EnableGate />}
            {estimateText(amountN * leverage, lastTotal) && <p className="muted small mine-center">{estimateText(amountN * leverage, lastTotal)}</p>}
            {plan?.ok && <p className="muted small mine-center">{riskText(liq, amountN)}</p>}
            {plan && !plan.ok && amount.trim() !== "" && <p className="muted small mine-center">{plan.error}</p>}
            {tooMuch && <p className="muted small mine-center">{tooMuch}</p>}
            {ready && fundsText(available) && <p className="note">{fundsText(available)}</p>}
          </>
        )}
        {trade.msg && <p className={trade.msg.ok ? "note" : "error"}>{trade.msg.text}</p>}
        <ReSignPrompt />
        {trading.error && <p className="error">{trading.error}</p>}
      </section>
      {otherPositionsText(account.positions, coin) && <p className="muted small mine-center">{otherPositionsText(account.positions, coin)}</p>}

      {closing && trade.confirmClose && (
        <Modal title="Close position" onClose={() => trade.setConfirmClose(null)}>
          <p className="impact-warn" role="alert">{trade.confirmClose.text}</p>
          <p>Close {Math.abs(closing.szi)} {closing.coin} {closing.szi > 0 ? "long" : "short"} anyway?</p>
          <div className="row">
            <button className="btn primary" disabled={off} onClick={() => {
              const c = closing.coin;
              trade.setConfirmClose(null);
              trade.sendClose(c);
            }}>Yes, close</button>
            <button className="btn" onClick={() => trade.setConfirmClose(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

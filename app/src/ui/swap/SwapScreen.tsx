import { useEffect, useMemo, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useConfig } from "../../config/context";
import { publicClient } from "../../evm/clients";
import { plainError } from "../../hl/errors";
import {
  SWAP_CONFIRM,
  SWAP_CONNECT,
  SWAP_DONE,
  SWAP_GAS,
  SWAP_INTRO,
  SWAP_MAINNET_ONLY,
  SWAP_PAIR,
  SWAP_QUOTE_CHANGED,
  SWAP_READING,
  SWAP_SLIPPAGE,
} from "../../swap/copy";
import { swapCalls } from "../../swap/execute";
import { watchBuyHlo } from "../../swap/intent";
import { swapMarket, tokensFor, type SwapSide } from "../../swap/market";
import { planSwap } from "../../swap/plan";
import { fmtAmount, guardedMin, moveText, parseSlippagePercent, parseTokenAmount, swapButtonLabel } from "../../swap/quote";
import { readSwapSnapshot, type SwapReader } from "../../swap/read";
import { viemChain } from "../../wallet/chains";
import { allowed, PAIRED_BLOCKED_TEXT } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";
import { useSwapPool } from "./useSwapPool";

const PRESETS = ["0.5", "1", "3"] as const;

/** Buy HLO (USDC → HLO) or swap HLO back to USDC, against the deployment's Uniswap V2 pair. */
export function SwapScreen() {
  const cfg = useConfig();
  const { session, write } = useSession();
  const market = useMemo(() => swapMarket(cfg.hyperEvmChainId, cfg.contracts), [cfg.hyperEvmChainId, cfg.contracts]);
  const user = session.kind === "none" ? null : session.address;
  const { state, reload } = useSwapPool(market, user);
  const [side, setSide] = useState<SwapSide>("buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState("0.5");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const sending = useRef(false);
  const can = allowed(session.kind, "swap");

  useEffect(() => watchBuyHlo(() => {
    setSide("buy");
    setAmount("");
    setMsg(null);
  }), []);

  if (!market) {
    return (
      <section className="card swap-panel">
        <h1 className="page-title">Swap</h1>
        <p className="muted">{SWAP_MAINNET_ONLY}</p>
      </section>
    );
  }

  const tokens = tokensFor(side, market);
  const parsed = parseTokenAmount(amount, tokens.payDecimals);
  const slippage = parseSlippagePercent(slip);
  const planned = state.kind === "ready" && parsed && slippage ? planSwap({ market, side, amountIn: parsed, slippageBps: slippage, snap: state.snap }) : null;
  const balance = user && state.kind === "ready" ? (side === "buy" ? state.snap.usdcBalance : state.snap.hloBalance) : null;
  const slipError = slip.trim() !== "" && !slippage ? SWAP_SLIPPAGE : null;
  const reason = slipError ?? (planned && !planned.ok ? planned.reason : null);
  const quote = planned && planned.ok ? planned.quote : null;
  const moved = quote ? moveText(quote.moveBps) : null;

  const pick = (next: SwapSide) => {
    setSide(next);
    setAmount("");
    setMsg(null);
  };

  const submit = async () => {
    if (sending.current || !can || session.kind !== "wallet" || state.kind !== "ready") return;
    const amountIn = parseTokenAmount(amount, tokens.payDecimals);
    const slippageBps = parseSlippagePercent(slip);
    if (!amountIn || !slippageBps) return;
    const shown = planSwap({ market, side, amountIn, slippageBps, snap: state.snap });
    if (!shown.ok) return;
    sending.current = true;
    setBusy(true);
    setMsg(SWAP_CONFIRM);
    try {
      const client = publicClient(viemChain("hyperEvm", cfg)) as unknown as SwapReader;
      const fresh = await readSwapSnapshot(client, market, session.address);
      if (!fresh.ok) {
        setMsg(SWAP_PAIR);
        return;
      }
      const next = planSwap({ market, side, amountIn, slippageBps, snap: fresh.snap });
      const min = next.ok ? guardedMin(shown.quote.amountOutMin, next.quote.quoted) : null;
      if (!next.ok || min === null) {
        setMsg(SWAP_QUOTE_CHANGED);
        reload();
        return;
      }
      for (const call of swapCalls(market, { ...next.quote, amountOutMin: min }, session.address)) {
        await write("hyperEvm", call);
      }
      setAmount("");
      setMsg(SWAP_DONE);
      reload();
    } catch (e) {
      setMsg(plainError(e).text);
      reload();
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="card swap-panel">
      <h1 className="page-title">Swap</h1>
      <p className="card-sub">{SWAP_INTRO}</p>
      {state.kind === "loading" ? <p className="muted">{SWAP_READING}</p> : null}
      {state.kind === "down" ? (
        <>
          <p className="warn">{state.error}</p>
          <button className="btn" onClick={reload}>Try again</button>
        </>
      ) : null}
      {state.kind === "bad" ? <p className="warn">{SWAP_PAIR}</p> : null}
      {state.kind === "ready" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="seg" role="group" aria-label="Direction">
            <button type="button" className={side === "buy" ? "on" : ""} aria-pressed={side === "buy"} onClick={() => pick("buy")}>Buy HLO</button>
            <button type="button" className={side === "sell" ? "on" : ""} aria-pressed={side === "sell"} onClick={() => pick("sell")}>Swap to USDC</button>
          </div>
          <div className="swap-box">
            <div className="row between"><span className="muted small">You pay</span><span className="muted small">{tokens.paySymbol}</span></div>
            <input id="swap-pay" className="swap-amt" inputMode="decimal" autoComplete="off" placeholder="0" aria-label="You pay" value={amount} onChange={(e) => setAmount(e.target.value)} />
            {balance !== null && (
              <div className="row between">
                <span className="muted small">Balance {fmtAmount(balance, tokens.payDecimals)}</span>
                <button type="button" className="btn small" disabled={busy || balance === 0n} onClick={() => setAmount(formatUnits(balance, tokens.payDecimals))}>Max</button>
              </div>
            )}
          </div>
          <div className="swap-box">
            <div className="row between"><span className="muted small">You receive</span><span className="muted small">{tokens.receiveSymbol}</span></div>
            <div className="swap-receive">{quote ? fmtAmount(quote.quoted, tokens.receiveDecimals) : "—"}</div>
            {quote && <p className="muted small">Minimum received {fmtAmount(quote.amountOutMin, tokens.receiveDecimals)} {tokens.receiveSymbol}</p>}
          </div>
          <div className="field">
            <label htmlFor="swap-slip">Slippage %</label>
            <input id="swap-slip" className="input" inputMode="decimal" value={slip} onChange={(e) => setSlip(e.target.value)} />
            <div className="row">
              {PRESETS.map((p) => (
                <button key={p} type="button" className={`btn small ${slip === p ? "on" : ""}`} onClick={() => setSlip(p)}>{p}%</button>
              ))}
            </div>
          </div>
          {moved && <p className="warn">{moved}</p>}
          {reason && <p className="warn">{reason}</p>}
          <button type="submit" className="btn primary wide" disabled={busy || !can || !quote}>{swapButtonLabel(side, can && !!quote && quote.steps[0] === "approve")}</button>
          {!can && <p className="note">{session.kind === "paired" ? PAIRED_BLOCKED_TEXT : SWAP_CONNECT}</p>}
          <p className="muted small">{SWAP_GAS}</p>
          {msg && <p className="note">{msg}</p>}
        </form>
      ) : null}
    </section>
  );
}

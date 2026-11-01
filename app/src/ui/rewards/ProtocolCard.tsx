import { useEffect, useMemo, useRef, useState } from "react";
import { useConfig } from "../../config/context";
import { buybackAbi } from "../../evm/abi";
import { plainError } from "../../hl/errors";
import type { RewardsChain } from "../../rewards/chain";
import { poolPhase } from "../../rewards/model";
import { buyOutcome, simulateBuy, type BuyClient } from "../../rewards/buyback";
import { buyOutcomeText, phaseText } from "../../rewards/staking";
import { publicClient } from "../../evm/clients";
import { viemChain } from "../../wallet/chains";
import { allowed, PAIRED_BLOCKED_TEXT } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";
import { fmtHlo, fmtPx, fmtUsdc } from "../format";

export function ProtocolCard({ chain, onDone }: { chain: RewardsChain; onDone(): void }) {
  const cfg = useConfig();
  const { session, write } = useSession();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const sending = useRef(false);
  // Chain time (the latest HyperEVM block), advanced locally between reloads so the countdown ticks.
  const [offset, setOffset] = useState(0);
  useEffect(() => {
    const start = Date.now();
    setOffset(0);
    const t = setInterval(() => setOffset(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(t);
  }, [chain]);
  const p = chain.protocol;
  const phase = poolPhase({
    now: chain.now + offset, openAt: p.openAt, poolOpen: p.poolOpen, usdcHeld: p.usdcHeld, slice: p.slice, lastBuy: p.lastBuy, buyInterval: p.buyInterval,
  });
  const can = allowed(session.kind, "protocol");
  const k = cfg.contracts;
  const client = useMemo(() => publicClient(viemChain("hyperEvm", cfg)) as unknown as BuyClient, [cfg]);

  // Whether a buy() would really buy, by simulating it: a buy() that is skipped (price guard, no 30-minute average yet) or has nothing
  // to spend does not revert, so the wallet would not warn and the caller would pay gas for nothing. undefined: checking; null: could not check.
  const simKey = `${p.poolOpen}:${phase.kind}`; // re-checked on every chain reload and when the local clock moves the phase (e.g. nextBuy to buyDue)
  const [sim, setSim] = useState<{ key: string; v: bigint | null }>({ key: "", v: null });
  useEffect(() => {
    if (!p.poolOpen || !k) return;
    let live = true;
    void simulateBuy(client, k.buyback).then((v) => live && setSim({ key: simKey, v }));
    return () => {
      live = false;
    };
  }, [chain, simKey, client, k, p.poolOpen]);
  const simNow: bigint | null | undefined = sim.key === simKey ? sim.v : undefined;
  const wouldBuy = typeof simNow === "bigint" && simNow > 0n;

  const showOpen = phase.kind === "canOpen";
  const showBuy = p.poolOpen && (phase.kind !== "waitingForDeposit" || wouldBuy);

  const press = async (fn: "openPool" | "buy") => {
    if (sending.current || !k) return;
    sending.current = true;
    setBusy(true);
    try {
      if (fn === "buy") {
        // Again right before the wallet call: the answer on screen may be a minute old.
        setMsg("Checking that a buyback would run…");
        const v = await simulateBuy(client, k.buyback);
        setSim({ key: simKey, v });
        if (v === null) return void setMsg("Could not check whether a buyback would run (HyperEVM did not answer), so nothing was sent. Try again in a moment.");
        if (v === 0n) return void setMsg("A buyback would not buy anything right now, so nothing was sent.");
      }
      setMsg("Confirm in your wallet (HyperEVM, a little HYPE for gas)…");
      const hash = await write("hyperEvm", { address: k.buyback, abi: buybackAbi, functionName: fn });
      setMsg(fn === "openPool" ? "The pool is open." : buyOutcomeText(await buyOutcome(client, hash, k.buyback)));
      onDone();
    } catch (e) {
      setMsg(plainError(e).text);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2 className="card-h">Protocol</h2>
      <div className="stat"><span className="k">Total burned</span><span className="v">{fmtHlo(p.totalBurned)} HLO</span></div>
      <div className="stat"><span className="k">Buyback USDC spent</span><span className="v">${fmtUsdc(p.totalSpent)}</span></div>
      <div className="stat"><span className="k">HLO bought back</span><span className="v">{fmtHlo(p.totalBought)} HLO</span></div>
      <div className="stat"><span className="k">USDC waiting in the buyback</span><span className="v">${fmtUsdc(p.usdcHeld)}</span></div>
      <div className="stat"><span className="k">Pool price</span><span className="v">{p.price !== null ? `$${fmtPx(p.price)} per HLO` : "pool not open"}</span></div>
      <p style={{ marginTop: 10 }}>{phaseText(phase)}</p>
      {(showOpen || showBuy) && (
        <div className="row">
          {showOpen && <button className="btn" disabled={!can || busy} onClick={() => void press("openPool")}>Open pool</button>}
          {showBuy && <button className="btn" disabled={!can || busy || !wouldBuy} onClick={() => void press("buy")}>Run buyback</button>}
        </div>
      )}
      {showBuy && simNow === undefined && <p className="muted small">Checking whether a buyback would run…</p>}
      {showBuy && simNow === null && <p className="muted small">Could not check whether a buyback would run (HyperEVM did not answer). Trying again in a minute.</p>}
      {showBuy && simNow === 0n && phase.kind === "buyDue" && (
        <p className="muted small">A buyback would not buy anything right now: the price history may still be filling up, the price may be outside the guard, or there is no USDC to spend. The keeper tries again later.</p>
      )}
      {(showOpen || showBuy) && !can && <p className="note" style={{ marginTop: 8 }}>{session.kind === "paired" ? PAIRED_BLOCKED_TEXT : "Connect a wallet to do this."}</p>}
      {msg && <p className="note" style={{ marginTop: 8 }}>{msg}</p>}
    </section>
  );
}

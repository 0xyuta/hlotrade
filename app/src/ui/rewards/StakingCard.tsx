import { useRef, useState } from "react";
import { formatUnits } from "viem";
import { useConfig } from "../../config/context";
import { stakingAbi, tokenAbi } from "../../evm/abi";
import { plainError } from "../../hl/errors";
import type { RewardsChain } from "../../rewards/chain";
import { DRIP_TEXT, parseHlo, stakeSteps } from "../../rewards/staking";
import { allowed, PAIRED_BLOCKED_TEXT } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";
import { fmtHlo } from "../format";

export function StakingCard({ chain, onDone }: { chain: RewardsChain; onDone(): void }) {
  const cfg = useConfig();
  const { session, write } = useSession();
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const sending = useRef(false); // set at once, before the next render, so a double click cannot send twice
  const k = cfg.contracts;
  const u = chain.user;
  const can = allowed(session.kind, "stake");
  const value = parseHlo(amount);

  const run = async (label: string, f: () => Promise<unknown>, clear: boolean) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    setMsg(`${label}: confirm in your wallet (HyperEVM, a little HYPE for gas)…`);
    try {
      await f();
      setMsg(`${label}: done.`);
      if (clear) setAmount("");
    } catch (e) {
      setMsg(plainError(e).text);
    } finally {
      sending.current = false;
      setBusy(false);
      onDone(); // also after a failed step: an approve that went through changes the allowance
    }
  };
  const stake = () =>
    run("Stake", async () => {
      if (!value || !u || !k) return;
      // Approve only when the allowance is short (the approval is for exactly this amount).
      for (const step of stakeSteps(u.allowance, value)) {
        if (step === "approve") await write("hyperEvm", { address: k.token, abi: tokenAbi, functionName: "approve", args: [k.staking, value] });
        else await write("hyperEvm", { address: k.staking, abi: stakingAbi, functionName: "stake", args: [value] });
      }
    }, true);
  const unstake = () => run("Unstake", () => write("hyperEvm", { address: k!.staking, abi: stakingAbi, functionName: "unstake", args: [value!] }), true);
  const claim = () => run("Claim staking rewards", () => write("hyperEvm", { address: k!.staking, abi: stakingAbi, functionName: "claim" }), false);

  return (
    <section className="card">
      <h2 className="card-h">Staking</h2>
      <p className="card-sub">Stakers get 10% of the HLO the buyback buys. The other 90% is burned.</p>
      <div className="stat"><span className="k">Total staked</span><span className="v">{fmtHlo(chain.staking.totalStaked)} HLO</span></div>
      <div className="stat"><span className="k">Still dripping in</span><span className="v">{fmtHlo(chain.staking.undripped)} HLO</span></div>
      {u && (
        <>
          <div className="stat"><span className="k">Your stake</span><span className="v">{fmtHlo(u.staked)} HLO</span></div>
          <div className="stat"><span className="k">Your staking rewards</span><span className="v">{fmtHlo(u.pending)} HLO</span></div>
          <div className="stat"><span className="k">In your wallet</span><span className="v">{fmtHlo(u.hlo)} HLO</span></div>
        </>
      )}
      <p className="muted small">{DRIP_TEXT}</p>
      {!u || !k ? <p className="note">Connect a wallet to stake.</p> : !can ? <p className="note">{PAIRED_BLOCKED_TEXT}</p> : (
        <>
          <div className="field">
            <label htmlFor="stk">Amount (HLO)</label>
            <input id="stk" className="input" inputMode="decimal" placeholder="0.0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <div className="row wrap">
              <button className="btn small" disabled={busy || u.hlo === 0n} onClick={() => setAmount(formatUnits(u.hlo, 18))}>All in wallet</button>
              <button className="btn small" disabled={busy || u.staked === 0n} onClick={() => setAmount(formatUnits(u.staked, 18))}>All staked</button>
            </div>
          </div>
          <div className="row wrap">
            <button className="btn primary" disabled={busy || !value || value > u.hlo} onClick={() => void stake()}>
              {value && value > u.allowance ? "Approve and stake" : "Stake"}
            </button>
            <button className="btn" disabled={busy || !value || value > u.staked} onClick={() => void unstake()}>Unstake</button>
            <button className="btn" disabled={busy || u.pending === 0n} onClick={() => void claim()}>Claim rewards</button>
          </div>
          {value && value > u.hlo && <p className="muted small">That is more than the HLO in your wallet.</p>}
        </>
      )}
      {msg && <p className="note" style={{ marginTop: 8 }}>{msg}</p>}
    </section>
  );
}

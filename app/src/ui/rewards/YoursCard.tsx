import { claimLimited, claimPartial, type ClaimPlan, type Yours } from "../../rewards/model";
import { claimButton } from "../../rewards/view";
import { fmtHlo } from "../format";

export interface YoursProps {
  yours: Yours | null; // null while there is no usable file: every figure is a dash
  plan: ClaimPlan | null;
  /** Why the figures cannot be shown or claimed (a file behind the chain, a bad signature, an entry that contradicts the signed tree): a warning, and Claim is off. */
  problem: string | null;
  settled: string; // "settled through HH:MM UTC"
  /** Before the pool opens: claim now to avoid the queue at the opening (poolQueueText). */
  queueNotice?: string | null;
  claim: { allowed: boolean; busy: boolean; msg: string | null; onClaim(): void; blockedText?: string };
}

const hlo = (x: bigint | undefined) => (x === undefined ? "—" : `${fmtHlo(x)} HLO`);

export function YoursCard({ yours: y, plan, problem, settled, queueNotice, claim }: YoursProps) {
  const btn = claimButton({ plan, busy: claim.busy, allowed: claim.allowed, problem });
  return (
    <section className="card">
      <h2 className="card-h">Yours</h2>
      <p className="muted small">{settled}</p>
      <div className="stat"><span className="k">Earned so far</span><span className="v">{hlo(y?.earned)}</span></div>
      <div className="stat"><span className="k">Claimed</span><span className="v">{hlo(y?.claimed)}</span></div>
      <div className="stat"><span className="k">Claimable now</span><span className="v">{hlo(y?.claimable)}</span></div>
      {y && !claimLimited(y) && <p className="muted small">You receive 90%: {fmtHlo(y.youGet)} HLO. The other 10% is refining, shared with holders who have not claimed yet.</p>}
      {y && claimPartial(y) && <p className="muted small">Claims share an hourly allowance. You can claim {fmtHlo(y.claimNow)} HLO now; the rest stays claimable.</p>}
      <div className="stat"><span className="k">Refining earned</span><span className="v">{hlo(y?.refined)}</span></div>
      {queueNotice && <p className="note">{queueNotice}</p>}
      {problem && <p className="warn">{problem}</p>}
      <button className="btn primary wide" style={{ marginTop: 10 }} disabled={btn.disabled} onClick={claim.onClaim}>{btn.label}</button>
      {!claim.allowed && <p className="note">{claim.blockedText ?? "Connect a wallet to claim."}</p>}
      <p className="muted small">Claiming happens on HyperEVM and needs a little HYPE for gas.</p>
      {claim.msg && <p className="note">{claim.msg}</p>}
    </section>
  );
}

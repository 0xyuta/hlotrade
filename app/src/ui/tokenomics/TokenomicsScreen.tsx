import { Fragment, useState } from "react";
import { useConfig } from "../../config/context";
import { POP_ODDS } from "../../rewards/odds";
import { contractList, liveFigures, liveNotes, tokenContract, tokenomicsFlows, tokenomicsSections } from "../../rewards/tokenomics";
import { useRewards } from "../../rewards/useRewards";

/** The Tokenomics tab (spec 2026-10-30 referrals §5): the rules from rewards/tokenomics.ts and live figures from the Rewards reads. */
export function TokenomicsScreen() {
  const cfg = useConfig();
  const { state } = useRewards(null);
  const data = state.kind === "ready" ? state.data : null;
  const full = data?.full ?? null;
  const figures = liveFigures(
    full ? { totalBurned: full.protocol.totalBurned, totalBought: full.protocol.totalBought, totalStaked: full.staking.totalStaked } : null,
    data?.latest ? BigInt(data.latest.vault.amount) : null,
  );
  return (
    <>
      <section className="card">
        <h2 className="card-h">HLO tokenomics</h2>
        <p className="card-sub">Where the fees go and how HLO is mined.</p>
        <TokenAddress />
        <div className="flows">
          {tokenomicsFlows().map((f) => (
            <div key={f.label} className="flow" role="group" aria-label={f.label}>
              {f.steps.map((s, i) => (
                <Fragment key={s}>
                  {i > 0 && <span className="flow-arrow" aria-hidden="true">→</span>}
                  <span className="flow-box">{s}</span>
                </Fragment>
              ))}
            </div>
          ))}
        </div>
      </section>
      <div className="grid2">
        {tokenomicsSections(POP_ODDS[cfg.hyperEvmChainId]).map((s) => (
          <section key={s.title} className="card">
            <h2 className="card-h">{s.title}</h2>
            {s.lines.map((l) => <p key={l}>{l}</p>)}
          </section>
        ))}
        <section className="card">
          <h2 className="card-h">Live</h2>
          {figures.map((f) => (
            <div key={f.label} className="stat"><span className="k">{f.label}</span><span className="v">{f.value}</span></div>
          ))}
          {data && liveNotes(data).map((n) => <p key={n} className="muted small">{n}</p>)}
          {state.kind === "off" && <p className="muted small">The contracts are not deployed on this network yet.</p>}
          {state.kind === "down" && <p className="muted small">HyperEVM is not answering right now.</p>}
        </section>
      </div>
      <Contracts />
    </>
  );
}

/** Every HLO contract, linking to its verified source on mainnet; nothing before a deployment. */
function Contracts() {
  const list = contractList(useConfig());
  if (!list) return null;
  return (
    <section className="card" aria-labelledby="contracts-h">
      <h2 className="card-h" id="contracts-h">Contracts</h2>
      {list.note && <p className="card-sub">{list.note}</p>}
      <div className="contracts">
        {list.rows.map((r) => (
          <div key={r.name} className="contract-row">
            <span className="contract-name">{r.name}</span>
            <span className="muted small">{r.job}</span>
            {r.url ? <a className="contract-addr" href={r.url} target="_blank" rel="noreferrer">{r.address}</a> : <span className="contract-addr">{r.address}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

const COPY_FAILED = "Could not copy. Select the address and copy it by hand.";

/** The token's contract address, with Copy and its HyperEVMScan page (mainnet); nothing before a deployment. */
function TokenAddress() {
  const t = tokenContract(useConfig());
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!t) return null;
  const copy = () => {
    try {
      if (!navigator.clipboard) return setFailed(true);
      navigator.clipboard.writeText(t.address).then(() => setCopied(true), () => setFailed(true));
    } catch {
      setFailed(true);
    }
  };
  return (
    <div className="token-ca">
      <span className="muted small">HLO token contract</span>
      <span className="token-ca-addr">{t.address}</span>
      <span className="token-ca-actions">
        <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        {t.explorerUrl && <a className="btn small" href={t.explorerUrl} target="_blank" rel="noreferrer">HyperEVMScan</a>}
      </span>
      {failed && <span className="muted small">{COPY_FAILED}</span>}
    </div>
  );
}

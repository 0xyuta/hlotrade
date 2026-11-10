import { useConfig } from "../../config/context";
import { useTrading } from "../../hl/TradingProvider";
import { SWAP_INTRO } from "../../swap/copy";
import { requestBuyHlo } from "../../swap/intent";
import { swapMarket } from "../../swap/market";
import { POP_ODDS } from "../../rewards/odds";
import { claimLimited, settledText } from "../../rewards/model";
import { useClaim } from "../../rewards/useClaim";
import { CLAIM_HOLD_MS, useRewards } from "../../rewards/useRewards";
import { claimGate, notAvailableText, poolQueueText } from "../../rewards/view";
import { allowed } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";
import { CoinIcon } from "../CoinIcon";
import { HaloLogo } from "../Logo";
import { ProtocolCard } from "./ProtocolCard";
import { StakingCard } from "./StakingCard";
import { VaultCard } from "./VaultCard";
import { YoursCard } from "./YoursCard";

export { CLAIM_HOLD_MS };

/** The Rewards screen: Yours and the vault on top, then Staking and the Protocol card. The decisions live in rewards/view.ts and rewards/model.ts. */
export function RewardsScreen() {
  const cfg = useConfig();
  const { session } = useSession();
  const { master } = useTrading();
  const { state, reload, hold } = useRewards(master);
  const { busy, msg, claim } = useClaim({ plan: state.kind === "ready" ? state.data.plan : null, master, reload, hold });
  const swapBtn = swapMarket(cfg.hyperEvmChainId, cfg.contracts) ? (
    <div className="row" style={{ marginBottom: 12 }}>
      <button className="btn primary with-icon" onClick={() => requestBuyHlo()}>
        <HaloLogo size={18} />
        <CoinIcon coin="USDC" size={18} />
        Swap
      </button>
      <span className="muted small">{SWAP_INTRO}</span>
    </div>
  ) : null;

  if (state.kind === "off") return <section className="card"><h2 className="card-h">Rewards</h2><p className="muted">The rewards contracts are not deployed on this network yet.</p></section>;
  if (state.kind === "loading") return <>{swapBtn}<section className="card"><p className="muted">Loading rewards…</p></section></>;
  if (state.kind === "down") {
    return (
      <>
      {swapBtn}
      <section className="card">
        <h2 className="card-h">Rewards are paused</h2>
        <p>HyperEVM is not answering, so the rewards screen cannot load. Trading still works.</p>
        <p className="muted small">{state.error}</p>
        <button className="btn" onClick={reload}>Try again</button>
      </section>
      </>
    );
  }
  const d = state.data;
  const { yours: y, plan } = d;
  const gate = claimGate({ canClaim: allowed(session.kind, "claim"), paired: session.kind === "paired", paused: d.chain.paused, limited: y !== null && claimLimited(y) });

  const p = d.full?.protocol;
  const queueNotice = p && y ? poolQueueText({ poolOpen: p.poolOpen, openAt: p.openAt, now: d.chain.now, claimable: y.claimable }) : null;

  return (
    <>
      {swapBtn}
      <div className="grid2">
      {master ? (
        <YoursCard yours={y} plan={plan} problem={d.latestProblem} settled={settledText(d.chain)} queueNotice={queueNotice} claim={{ ...gate, busy, msg, onClaim: () => void claim() }} />
      ) : (
        <section className="card">
          <h2 className="card-h">Yours</h2>
          <p className="muted">Connect a wallet to see your rewards.</p>
          {d.latestProblem && <p className="warn">{d.latestProblem}</p>}
        </section>
      )}
      <VaultCard latest={d.latest} yours={y} yoursAt={d.yoursAt} now={d.chain.now} launchTime={d.chain.launchTime} odds={POP_ODDS[cfg.hyperEvmChainId]} />
      {d.full ? (
        <>
          <StakingCard chain={d.full} onDone={reload} />
          <ProtocolCard chain={d.full} onDone={reload} />
        </>
      ) : d.extraError ? (
        // Staking and Buyback are read apart from the rewards, so they can fail alone.
        <section className="card"><h2 className="card-h">Staking and the buyback</h2><p className="muted">{notAvailableText(d.extraError)}</p></section>
      ) : null}
      </div>
    </>
  );
}

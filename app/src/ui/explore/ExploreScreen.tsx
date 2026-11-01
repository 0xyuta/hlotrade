import { useAccount } from "../../hl/AccountProvider";
import { useTrading } from "../../hl/TradingProvider";
import {
  checkedMinutes,
  lastEndedMinute,
  latenessMinutes,
  MINUTES_SHOWN,
  minuteRows,
  paceText,
  popRows,
  TRADES_SHOWN,
  tradeRows,
  type MinuteStatus,
  type TradeStatus,
} from "../../rewards/explore";
import { useMinuteTables } from "../../rewards/useMinuteTables";
import { pointsText } from "../../rewards/model";
import { useRewards } from "../../rewards/useRewards";
import { fmtFeeUnits, fmtHlo, fmtPx, fmtUsd } from "../format";

const MINUTE_PILL: Record<MinuteStatus, { text: string; cls: string }> = {
  pending: { text: "Pending", cls: "pill-wait" },
  counted: { text: "Counted", cls: "pill-brand" },
  onchain: { text: "On chain", cls: "pill-good" },
};
const TRADE_PILL: Record<TradeStatus["kind"], { text: string; cls: string }> = {
  pending: { text: "Pending", cls: "pill-wait" },
  counted: { text: "Counted", cls: "pill-good" },
  checking: { text: "Checking…", cls: "pill-plain" },
  unknown: { text: "Could not check", cls: "pill-plain" },
  notCounted: { text: "Not counted", cls: "pill-bad" },
};
const clock = (sec: number) => new Date(sec * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const usd = (x: bigint | null) => (x === null ? "—" : `$${fmtFeeUnits(x)}`);

/** The Explore tab: where each minute stands and whether the wallet's trades were counted. The rules are rewards/explore.ts. */
export function ExploreScreen() {
  const { master } = useTrading();
  const { fills } = useAccount();
  const { state, reload } = useRewards(null);
  const data = state.kind === "ready" ? state.data : null;
  const chain = data?.chain ?? null;
  const latest = data?.latest ?? null;
  const published = latest?.throughMinute ?? null;
  const settled = chain?.latestValidMinute ?? null;
  const launchTime = chain?.launchTime ?? 0;
  const lastEnded = chain ? lastEndedMinute(chain.now, launchTime) : -1;
  const pops = new Set(latest?.pops.map((p) => p.minute));

  const base = { launchTime, published, settled, lastEnded, count: MINUTES_SHOWN, pops };
  const trades = { fills: master ? fills : [], user: master ?? "", launchTime, published, max: TRADES_SHOWN };
  // The list of minutes to read does not depend on what has been read, so it is worked out with nothing read yet.
  const wanted = checkedMinutes(minuteRows({ ...base, tables: new Map() }), tradeRows({ ...trades, tables: new Map(), failed: new Set() }), published);
  const { tables, failed } = useMinuteTables(wanted, chain, latest);

  if (state.kind === "off") return <section className="card"><h2 className="card-h">Explore</h2><p className="muted">The rewards contracts are not deployed on this network yet.</p></section>;
  if (state.kind === "loading") return <section className="card"><p className="muted">Loading live data…</p></section>;
  if (state.kind === "down") {
    return (
      <section className="card">
        <h2 className="card-h">Explore is paused</h2>
        <p>HyperEVM is not answering, so live data cannot load. Trading still works.</p>
        <p className="muted small">{state.error}</p>
        <button className="btn" onClick={reload}>Try again</button>
      </section>
    );
  }

  const late = latenessMinutes(lastEnded, published);
  const minutes = minuteRows({ ...base, tables });
  const mine = tradeRows({ ...trades, tables, failed });
  const popList = popRows(latest?.pops ?? [], launchTime);
  return (
    <>
      <section className="card">
        <h2 className="card-h">Live status</h2>
        {chain?.paused && <p className="notice-warn">Claims are paused while the rewards are checked.</p>}
        {data?.latestProblem && <p className="notice-warn">{data.latestProblem}</p>}
        <div className="stat"><span className="k">Rewards</span><span className="v">{latest ? paceText(late) : "—"}</span></div>
        <div className="stat"><span className="k">Last counted minute</span><span className="v">{published ?? "—"}</span></div>
        <div className="stat"><span className="k">On chain through</span><span className="v">{settled ?? "Not yet"}</span></div>
        <p className="muted small">A late minute is not lost: its fees are counted when the poster reaches it.</p>
      </section>

      <section className="card">
        <h2 className="card-h">Your trades</h2>
        {!master ? <p className="muted">Connect a wallet to see whether your trades were counted.</p> : mine.length === 0 ? <p className="muted">No trades through HLO yet. Trades placed elsewhere are not listed.</p> : (
          <div className="scroll-x">
            <table className="table cards">
              <thead><tr><th>Market</th><th>Time</th><th className="num">Price</th><th className="num">Size</th><th className="num">HLO fee</th><th className="num">Points</th><th>Status</th></tr></thead>
              <tbody>
                {mine.map((t) => (
                  <tr key={t.fill.tid}>
                    <td className="card-title">{t.fill.coin}</td>
                    <td className="small" data-label="Time">{new Date(t.fill.time).toLocaleString()}</td>
                    <td className="num" data-label="Price">{fmtPx(t.fill.px)}</td>
                    <td className="num" data-label="Size">{t.fill.sz}</td>
                    <td className="num" data-label="HLO fee">${fmtUsd(t.fill.builderFee, 4)}</td>
                    <td className="num" data-label="Points">{t.points === null ? "—" : pointsText(t.points)}</td>
                    <td className="wrap" data-label="Status">
                      <span className={`pill ${TRADE_PILL[t.status.kind].cls}`}>{TRADE_PILL[t.status.kind].text}</span>
                      {t.status.kind === "notCounted" && <span className="muted small status-why">{t.status.why}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-h">Minutes</h2>
        <p className="card-sub">Each minute's fees are counted, signed and published, then settled on chain.</p>
        {!latest ? <p className="muted">No published minutes to show right now.</p> : (
          <div className="scroll-x">
            <table className="table">
              <thead><tr><th>Minute</th><th>Status</th><th className="num">Fees</th><th className="num hide-phone">Wallets</th></tr></thead>
              <tbody>
                {minutes.map((r) => (
                  <tr key={r.minute}>
                    <td><strong>{r.minute}</strong><span className="muted small minute-clock">{clock(r.endsAt)}</span></td>
                    <td>
                      <span className={`pill ${MINUTE_PILL[r.status].cls}`}>{MINUTE_PILL[r.status].text}</span>
                      {r.pop && <span className="pill pill-brand pill-pop">Popped</span>}
                    </td>
                    <td className="num">{usd(r.fees)}</td>
                    <td className="num hide-phone">{r.wallets ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="card-h">Recent vault pops</h2>
        {popList.length === 0 ? <p className="muted">The vault has not popped yet.</p> : (
          <div className="scroll-x">
            <table className="table cards">
              <thead><tr><th>Minute</th><th>Ended</th><th className="num">Paid out</th><th className="num">Stayed in the vault</th><th className="num">Wallets paid</th></tr></thead>
              <tbody>
                {popList.map((p) => (
                  <tr key={p.minute}>
                    <td className="card-title">{p.minute}</td>
                    <td className="small" data-label="Ended">{clock(p.endsAt)}</td>
                    <td className="num" data-label="Paid out">{fmtHlo(p.paid)} HLO</td>
                    <td className="num" data-label="Stayed in the vault">{fmtHlo(p.kept)} HLO</td>
                    <td className="num" data-label="Wallets paid">{p.recipients}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {popList.some((p) => p.note) && <p className="muted small">{popList.find((p) => p.note)?.note}</p>}
      </section>
    </>
  );
}

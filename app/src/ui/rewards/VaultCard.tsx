import type { LatestFile } from "../../rewards/files";
import { pointsText, type Yours } from "../../rewards/model";
import { lastPopText, pointsNeededText, vaultRuleText } from "../../rewards/view";
import { fmtHlo } from "../format";

/**
 * `latest` is null while there is no usable file: the rule stays (with the network's `odds`) and the numbers are dashes.
 * `yours` is null without a wallet, or when the wallet's own file could not be read or trusted: dashes. A connected wallet with no entry has zeros and shows 0.00,
 * never a dash, with one exception: `yoursAt` is the minute of the wallet's file, and while the vault popped after it (`latest.vault.lastPopMinute`; above 2,000
 * wallets the files lag latest.json by up to 15 minutes) the file's points are the pre-pop ones and the share could exceed the vault, so points and share are dashes.
 * `now` and `launchTime` are chain time.
 */
export function VaultCard({ latest, yours, yoursAt, now, launchTime, odds }: { latest: LatestFile | null; yours: Yours | null; yoursAt?: number | null; now: number; launchTime: number; odds: number }) {
  const last = latest?.pops[0];
  const stale = latest !== null && yoursAt != null && latest.vault.lastPopMinute > yoursAt;
  const mine = yours && !stale ? yours : null;
  return (
    <section className="card">
      <h2 className="card-h">Vault</h2>
      <p className="card-sub">{vaultRuleText(latest?.vault.odds ?? odds)}</p>
      <div className="stat"><span className="k">In the vault</span><span className="v">{latest ? `${fmtHlo(BigInt(latest.vault.amount))} HLO` : "—"}</span></div>
      <div className="stat"><span className="k">Your points since the last pop</span><span className="v">{mine ? pointsText(mine.points) : "—"}</span></div>
      <div className="stat"><span className="k">Your share if it popped now</span><span className="v">{mine ? `${fmtHlo(mine.vaultShare)} HLO` : "—"}</span></div>
      {mine && pointsNeededText(mine.points) && <p className="small">{pointsNeededText(mine.points)}</p>}
      {last && <p className="muted small">{lastPopText(last, launchTime, now)}</p>}
    </section>
  );
}

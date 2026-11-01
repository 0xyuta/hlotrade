import type { AppConfig } from "../../config/validate";
import { useConfig } from "../../config/context";
import { enableReferralText } from "../../hl/referral";
import { useTrading, type TradingApi } from "../../hl/TradingProvider";
import { allowed, PAIRED_BLOCKED_TEXT } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";
import { PAIR_AGAIN_TEXT } from "./tradeError";

export const tradingReady = (cfg: AppConfig, trading: Pick<TradingApi, "agent" | "status">) => !!cfg.builder && !!trading.agent && !!trading.status?.builderOk && !!trading.status?.agentOk;

/** What stands in for the order button while trading is not ready: connect, Enable trading, or why neither is possible here. */
export function EnableGate() {
  const cfg = useConfig();
  const { session } = useSession();
  const trading = useTrading();
  if (session.kind === "none") return <p className="note">Connect a wallet to trade.</p>;
  if (!cfg.builder) return <p className="note">Trading is not available on this build.</p>;
  if (allowed(session.kind, "enable")) {
    // A stored key whose status is still being read must not look like "not enabled".
    if (trading.agent && !trading.status && !trading.error) return <p className="note">Checking your trading key…</p>;
    return (
      <>
        <button className="btn primary wide" disabled={trading.enabling} onClick={() => void trading.enable(trading.referralCode)}>
          {trading.enabling ? "Confirm in your wallet…" : "Enable trading"}
        </button>
        {trading.referralCode && <p className="muted small">{enableReferralText(trading.referralCode)}</p>}
      </>
    );
  }
  if (!trading.agent || trading.status?.agentOk === false) return <p className="note">{PAIR_AGAIN_TEXT}</p>;
  if (trading.status?.builderOk === false) return <p className="note">{PAIRED_BLOCKED_TEXT}</p>;
  return <p className="note">Checking your trading key…</p>;
}

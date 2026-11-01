import { plainError } from "../../hl/errors";
import { useTrading, type TradingApi } from "../../hl/TradingProvider";
import { allowed, type SessionKind } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";

export const PAIR_AGAIN_TEXT = "Pair again from your desktop to keep trading on this phone.";

/**
 * Plain words for a failed trading call. When the agent is unknown ("does not exist" [T §2.4]) it also asks for one
 * re-sign, and a paired phone, which cannot sign, is told to pair again instead.
 */
export function tradeErrorText(e: unknown, trading: Pick<TradingApi, "agent" | "markReSign">, kind: SessionKind): string {
  const pe = plainError(e, trading.agent?.address);
  if (!pe.reSign) return pe.text;
  trading.markReSign();
  return allowed(kind, "enable") ? pe.text : PAIR_AGAIN_TEXT;
}

/**
 * The way out after "your trading key is no longer approved": sign again on the desktop, pair again on a phone. It shows
 * no Enable referral text, so it passes no code: re-signing never sets a referral code.
 */
export function ReSignPrompt() {
  const trading = useTrading();
  const { session } = useSession();
  if (!trading.reSignNeeded) return null;
  return allowed(session.kind, "enable")
    ? <button className="btn wide" onClick={() => void trading.enable()}>Sign once to enable trading again</button>
    : <p className="note">{PAIR_AGAIN_TEXT}</p>;
}

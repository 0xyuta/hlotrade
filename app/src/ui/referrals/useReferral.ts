import { useCallback, useEffect, useRef, useState } from "react";
import type { Address, Network } from "../../config/validate";
import { plainError } from "../../hl/errors";
import type { ReferralView } from "../../hl/referral";
import { readReferral } from "../../hl/referralActions";

export type ReferralState = { kind: "loading" } | { kind: "down"; error: string } | { kind: "ready"; view: ReferralView };

/**
 * Hyperliquid's `referral` answer for `user` (spec referrals §4): read when the tab opens and on `reload()`, which the
 * screen calls after each action. The answer is tagged with the account it was read for, so another account never sees it.
 */
export function useReferral(net: Network, user: Address | null): { state: ReferralState; reload(): void } {
  const key = `${net}:${user?.toLowerCase() ?? ""}`;
  const [res, setRes] = useState<{ key: string; state: ReferralState } | null>(null);
  const seq = useRef(0); // a slow answer for an older account or read must not overwrite a newer one

  const reload = useCallback(async () => {
    const mine = ++seq.current;
    if (!user) return;
    try {
      const view = await readReferral(net, user);
      if (mine === seq.current) setRes({ key, state: { kind: "ready", view } });
    } catch (e) {
      if (mine === seq.current) setRes({ key, state: { kind: "down", error: plainError(e).text } });
    }
  }, [net, user, key]);

  useEffect(() => {
    void reload();
    return () => {
      seq.current++; // nothing for this account lands after it is gone
    };
  }, [reload]);

  const state: ReferralState = res && res.key === key ? res.state : { kind: "loading" };
  return { state, reload: () => void reload() };
}

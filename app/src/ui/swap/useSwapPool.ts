import { useCallback, useEffect, useState } from "react";
import { useConfig } from "../../config/context";
import type { Address } from "../../config/validate";
import { publicClient } from "../../evm/clients";
import { plainError } from "../../hl/errors";
import type { SwapMarket } from "../../swap/market";
import type { SwapSnapshot } from "../../swap/plan";
import { readSwapSnapshot, type SwapReader } from "../../swap/read";
import { viemChain } from "../../wallet/chains";

const POLL_MS = 15_000;

export type PoolState =
  | { kind: "loading" }
  | { kind: "down"; error: string }
  | { kind: "bad" }
  | { kind: "ready"; snap: SwapSnapshot };

/** Live reserves, balances and allowances. Reserves are not shown; the screen quotes from them. */
export function useSwapPool(market: SwapMarket | null, user: Address | null): { state: PoolState; reload(): void } {
  const cfg = useConfig();
  const [state, setState] = useState<PoolState>({ kind: "loading" });
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!market) return;
    let live = true;
    const load = () => {
      const client = publicClient(viemChain("hyperEvm", cfg)) as unknown as SwapReader;
      readSwapSnapshot(client, market, user).then(
        (r) => {
          if (live) setState(r.ok ? { kind: "ready", snap: r.snap } : { kind: "bad" });
        },
        (e: unknown) => {
          if (live) setState({ kind: "down", error: plainError(e).text });
        },
      );
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [market, user, cfg, n]);
  return { state, reload };
}

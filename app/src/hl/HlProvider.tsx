import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfig } from "../config/context";
import { getHl } from "./clients";
import { plainError } from "./errors";
import { livePrice, parseMids, toMarkets, type Market } from "./markets";

export interface HlApi {
  markets: Market[];
  error: string | null;
  mids: Record<string, number>;
  market(name: string): Market | undefined;
  price(name: string): number | null;
}

const Ctx = createContext<HlApi | null>(null);
const MARKETS_EVERY_MS = 60_000; // weight 20 per call [T §4.7]
const MIDS_FLUSH_MS = 1_000;

export function HlProvider({ children }: { children: ReactNode }) {
  const { network } = useConfig();
  const [markets, setMarkets] = useState<Market[]>([]);
  const [marketsError, setMarketsError] = useState<string | null>(null);
  const [midsError, setMidsError] = useState<string | null>(null); // kept apart so a good markets load does not hide it
  const [mids, setMids] = useState<Record<string, number>>({});
  const pending = useRef<Record<string, number> | null>(null);

  // Markets refresh every 60 s. Until the first load succeeds (the screen has no market list yet), a failure is
  // retried sooner, with a growing delay (1 s, 2 s, 4 s … up to 30 s), instead of waiting for the next 60 s tick.
  useEffect(() => {
    let dead = false;
    let loaded = false;
    let failures = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const load = (): Promise<void> =>
      getHl(network)
        .info.metaAndAssetCtxs()
        .then((r) => {
          if (dead) return;
          loaded = true;
          clearTimeout(retry);
          setMarkets(toMarkets(r));
          setMarketsError(null);
        })
        .catch((e) => {
          if (dead) return;
          setMarketsError(plainError(e).text);
          if (loaded) return;
          clearTimeout(retry);
          retry = setTimeout(() => void load(), Math.min(30_000, 1_000 * 2 ** failures++));
        });
    void load();
    const t = setInterval(() => void load(), MARKETS_EVERY_MS);
    return () => {
      dead = true;
      clearInterval(t);
      clearTimeout(retry);
    };
  }, [network]);

  // One allMids subscription; React state is updated at most once a second.
  // A failed first subscribe (the dispatcher gives up after 10 s) is retried with a growing delay, so prices do not
  // silently stay at the 60 s markPx. After it succeeds the SDK resubscribes by itself on reconnect.
  useEffect(() => {
    let dead = false;
    let sub: { unsubscribe(): Promise<void> } | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const attempt = (n: number) =>
      getHl(network)
        .subs()
        .allMids((ev: unknown) => {
          if (!dead) Object.assign((pending.current ??= {}), parseMids(ev));
        })
        .then((s) => {
          if (dead) void s.unsubscribe();
          else {
            sub = s;
            setMidsError(null);
          }
        })
        .catch((e) => {
          if (dead) return;
          setMidsError(plainError(e).text);
          retry = setTimeout(() => attempt(n + 1), Math.min(30_000, 1_000 * 2 ** n));
        });
    void attempt(0);
    const t = setInterval(() => {
      if (pending.current) {
        const next = pending.current;
        pending.current = null;
        setMids((m) => ({ ...m, ...next }));
      }
    }, MIDS_FLUSH_MS);
    return () => {
      dead = true;
      clearInterval(t);
      clearTimeout(retry);
      void sub?.unsubscribe();
    };
  }, [network]);

  const error = marketsError ?? midsError;
  const byName = useMemo(() => new Map(markets.map((m) => [m.name, m])), [markets]);
  const market = useCallback((name: string) => byName.get(name), [byName]);
  const price = useCallback((name: string) => {
    const m = byName.get(name);
    return m ? livePrice(m, mids) : null;
  }, [byName, mids]);

  const api = useMemo<HlApi>(() => ({ markets, error, mids, market, price }), [markets, error, mids, market, price]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useHl(): HlApi {
  const h = useContext(Ctx);
  if (!h) throw new Error("useHl outside HlProvider");
  return h;
}

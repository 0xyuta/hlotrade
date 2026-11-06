import { Suspense, useEffect, useRef, useState } from "react";
import { browserKV } from "../../hl/agent";
import { useHl } from "../../hl/HlProvider";
import { COIN_KEY } from "../../hl/markets";
import { ErrorBoundary, useRetryableLazy } from "../ErrorBoundary";
import { Loading } from "../Loading";
import { useNarrow } from "../useNarrow";
import { AccountTabs } from "./AccountTabs";
import { MarketList } from "./MarketList";
import { MarketPicker } from "./MarketPicker";
import { MarketStats } from "./MarketStats";
import { OrderForm, type OrderResult } from "./OrderForm";

const loadChart = () => import("./Chart").then((m) => ({ default: m.Chart }));

/** On a phone one part shows at a time (styles.css); on a wide screen always "trade", and everything shows. */
export type TradeView = "markets" | "trade" | "positions";

/** `linkCoin`: the market a ?coin= link asked for (hl/coinLink.ts); it is not stored, the stored market stays as it was. */
export function TradeScreen({ view = "trade", onView, linkCoin = null }: { view?: TradeView; onView?(v: TradeView): void; linkCoin?: string | null }) {
  const { markets } = useHl();
  const narrow = useNarrow();
  const [Chart, retryChart] = useRetryableLazy(loadChart);
  const [coin, setCoin] = useState(() => linkCoin ?? browserKV.getItem(COIN_KEY) ?? "BTC");
  // A coin that is not listed on this network (a stored one that got delisted, or a link's) falls back to the stored
  // market if that one is listed, else to the busiest market.
  useEffect(() => {
    if (!markets.length || markets.some((m) => m.name === coin)) return;
    const stored = browserKV.getItem(COIN_KEY);
    setCoin(stored && markets.some((m) => m.name === stored) ? stored : markets[0].name);
  }, [markets, coin]);
  // The answer to an order sent before the user switched market (the form is keyed by coin, so it is gone by then).
  const [late, setLate] = useState<OrderResult | null>(null);
  const pick = (c: string) => {
    setCoin(c);
    browserKV.setItem(COIN_KEY, c);
  };
  // The chart loads the first time its view opens: a phone landing on Markets does not pay for it.
  const chartSeen = useRef(false);
  if (view === "trade") chartSeen.current = true;
  return (
    <div className="trade" data-view={view}>
      {narrow && view === "markets" && <MarketList onPick={(c) => { pick(c); onView?.("trade"); }} />}
      <div className="trade-left">
        <div className="view-trade"><MarketPicker coin={coin} onPick={pick} /></div>
        {/* A chart that fails to load (or breaks) stays in its own place with Try again: positions and the order form stay up. */}
        {chartSeen.current && (
          <div className="view-trade">
            <ErrorBoundary scope="screen" onRetry={retryChart}>
              <Suspense fallback={<Loading />}>
                <Chart coin={coin} />
              </Suspense>
            </ErrorBoundary>
          </div>
        )}
        <div className="view-positions"><AccountTabs /></div>
      </div>
      <div className="trade-right view-trade">
        {late && (
          <div className={`card ${late.ok ? "note" : "error"}`} role="status">
            <p>{late.coin}: {late.text}</p>
            <button className="btn" onClick={() => setLate(null)}>Dismiss</button>
          </div>
        )}
        <OrderForm key={coin} coin={coin} onResult={setLate} />
        <MarketStats coin={coin} />
      </div>
    </div>
  );
}

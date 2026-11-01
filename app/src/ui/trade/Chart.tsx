import { CandlestickSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { useConfig } from "../../config/context";
import { getHl } from "../../hl/clients";
import { useHl } from "../../hl/HlProvider";
import { plainError } from "../../hl/errors";
import { priceTickDecimals } from "../../hl/math";
import { CHART_INTERVALS, candleWindow, mergeBar, toBar, type Bar, type ChartInterval } from "../../hl/markets";

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const toData = (b: Bar) => ({ ...b, time: b.time as UTCTimestamp });

export function Chart({ coin }: { coin: string }) {
  const { network } = useConfig();
  const { market } = useHl();
  const m = market(coin);
  // [T §3.5] the price scale shows the decimals a price can carry; the default 2 would flatten sub-dollar coins.
  const decimals = m ? priceTickDecimals(m.markPx, m.szDecimals) : null;
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const [interval, setInterval_] = useState<ChartInterval>("15m");
  const [error, setError] = useState<string | null>(null);

  // Create once.
  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: css("--card") }, textColor: css("--muted"), fontFamily: css("--mono"), attributionLogo: false },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true },
      handleScroll: { vertTouchDrag: false }, // an up-or-down swipe on a phone scrolls the page, it does not get stuck on the chart
    });
    series.current = c.addSeries(CandlestickSeries, {
      upColor: css("--up"), downColor: css("--down"), borderVisible: false, wickUpColor: css("--up"), wickDownColor: css("--down"),
    });
    chart.current = c;
    return () => {
      c.remove();
      chart.current = null;
      series.current = null;
    };
  }, []);

  useEffect(() => {
    if (decimals === null) return;
    series.current?.applyOptions({ priceFormat: { type: "price", precision: decimals, minMove: 10 ** -decimals } });
  }, [decimals, coin]);

  // Load the snapshot, then follow the candle subscription; older updates are ignored.
  useEffect(() => {
    let dead = false;
    let bars: Bar[] = [];
    let sub: { unsubscribe(): Promise<void> } | null = null;
    let offSocket: (() => void) | null = null;
    setError(null);
    series.current?.setData([]); // do not keep the previous coin on screen while the snapshot loads
    const hl = getHl(network);
    // The snapshot window ends now; the same call backfills what a dropped socket missed.
    const load = (fit: boolean) =>
      hl.info.candleSnapshot({ coin, interval, ...candleWindow(interval, Date.now()) }).then((rows: unknown[]) => {
        if (dead || !series.current) return false;
        // setData throws on duplicate times, so keep the last row of each bar
        bars = rows.map(toBar).filter((b): b is Bar => b !== null).sort((a, b) => a.time - b.time).filter((b, i, a) => i === a.length - 1 || a[i + 1].time !== b.time);
        series.current.setData(bars.map(toData));
        if (fit) chart.current?.timeScale().fitContent();
        return true;
      });
    load(true)
      .then((ok) => {
        if (!ok) return;
        return hl.subs().candle({ coin, interval }, (c: unknown) => {
          const b = toBar(c);
          if (dead || !b || !series.current) return;
          const next = mergeBar(bars, b); // replaces the open bar, appends a new one, returns the same array for an older one
          if (next === bars) return;
          bars = next;
          series.current.update(toData(b));
        });
      })
      .then((s) => {
        if (!s) return;
        if (dead) void s.unsubscribe();
        else {
          sub = s;
          // The SDK resubscribes on its own after a reconnect; the bars missed meanwhile come from a fresh snapshot.
          offSocket = hl.onSocketOpen(() => void load(false).catch(() => undefined));
        }
      })
      .catch((e) => !dead && setError(plainError(e).text));
    return () => {
      dead = true;
      offSocket?.();
      void sub?.unsubscribe();
    };
  }, [coin, interval, network]);

  return (
    <section className="card chart-card">
      <div className="row between wrap">
        <div className="seg" role="group" aria-label="Chart interval">
          {CHART_INTERVALS.map((i) => (
            <button key={i} className={i === interval ? "on" : ""} onClick={() => setInterval_(i)}>{i}</button>
          ))}
        </div>
        <a className="faint small" href="https://www.tradingview.com/" target="_blank" rel="noreferrer">Charts by TradingView</a>
      </div>
      {error && <p className="error small">{error}</p>}
      <div ref={el} className="chart" />
    </section>
  );
}

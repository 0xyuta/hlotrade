import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfig } from "../config/context";
import { balances, parseAbstraction, parseFills, parseOpenOrders, parsePositions, takerRate, type Abstraction, type Balances, type Fill, type OpenOrder, type Position } from "./account";
import { getHl, infoPost } from "./clients";
import { plainError } from "./errors";
import { BASE_TAKER_RATE } from "./math";
import { useTrading } from "./TradingProvider";

export interface AccountApi {
  positions: Position[];
  openOrders: OpenOrder[];
  fills: Fill[];
  balances: Balances | null;
  abstraction: Abstraction;
  takerRate: number;
  error: string | null;
  refresh(): void;
}

const Ctx = createContext<AccountApi | null>(null);
const EMPTY: Omit<AccountApi, "refresh" | "error"> = { positions: [], openOrders: [], fills: [], balances: null, abstraction: "unknown", takerRate: BASE_TAKER_RATE };

/** After the last request wait this long, but never longer than MAX_WAIT_MS after the first one: steady events cannot starve the refresh. */
export const DEBOUNCE_MS = 1_000;
export const MAX_WAIT_MS = 5_000;
const MAX_FILLS = 500;

interface Parts {
  orders: boolean;
  fills: boolean;
}

/**
 * The trading account's state (the master address, also on a paired phone). Refetched after WS user events, never on a
 * timer [T §4.7]. Info weights (1,200/min per IP): clearinghouseState 2, spotClearinghouseState 2, frontendOpenOrders 20,
 * userFees 20, userAbstraction 20, userFills 20 + 1 per 20 rows, userFillsByTime the same.
 *  - first load of an account: 4 + 20 + (20 + fills/20) + 40 = about 85 to 185, once;
 *  - after a fill event: 4 + (20 + new fills/20) = about 25; after an order event: 4 + 20 = 24; "refresh()" (after our own
 *    order, cancel or TP/SL change): both = about 45;
 *  - events inside one debounce window are one fetch, and a fetch happens at most once per MAX_WAIT_MS under a constant
 *    stream, so the worst case is 12 fetches a minute, about 540 weight.
 * userFees and userAbstraction are read once per account; the WS snapshot message is ignored (the first load already read it).
 */
export function AccountProvider({ children }: { children: ReactNode }) {
  const { network } = useConfig();
  const { master } = useTrading();
  const [state, setState] = useState(EMPTY);
  const [error, setError] = useState<string | null>(null);

  const cur = useRef({ master, network });
  const epoch = useRef(0); // bumped on every account or network change: older answers are dropped
  const fixed = useRef<{ abstraction: Abstraction; takerRate: number } | null>(null); // userAbstraction + userFees, once per account
  const fillsRef = useRef<Fill[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstAt = useRef<number | null>(null);
  const dirty = useRef<Parts>({ orders: false, fills: false });
  const running = useRef(false);
  const requestRef = useRef<(parts: Parts) => void>(() => {});

  const run = useCallback(async (parts: Parts) => {
    const { master: who, network: net } = cur.current;
    if (!who) return;
    const mine = epoch.current;
    const { info } = getHl(net);
    const known = fixed.current;
    const newest = fillsRef.current[0]?.time;
    try {
      const [ch, spot, oo, fl, fees, abs] = await Promise.all([
        info.clearinghouseState({ user: who }),
        info.spotClearinghouseState({ user: who }),
        parts.orders ? info.frontendOpenOrders({ user: who }) : null,
        parts.fills ? (newest ? info.userFillsByTime({ user: who, startTime: newest }) : info.userFills({ user: who })) : null,
        known ? null : info.userFees({ user: who }),
        known ? null : infoPost<unknown>(net, { type: "userAbstraction", user: who }),
      ]);
      if (mine !== epoch.current) return;
      if (!known) fixed.current = { abstraction: parseAbstraction(abs), takerRate: takerRate(fees) };
      const f = fixed.current!;
      if (fl) {
        const byTid = new Map(fillsRef.current.map((x) => [x.tid, x]));
        for (const x of parseFills(fl)) byTid.set(x.tid, x);
        fillsRef.current = [...byTid.values()].sort((a, b) => b.time - a.time).slice(0, MAX_FILLS);
      }
      setState((prev) => ({
        positions: parsePositions(ch),
        openOrders: oo ? parseOpenOrders(oo) : prev.openOrders,
        fills: fl ? fillsRef.current : prev.fills,
        balances: balances({ abstraction: f.abstraction, clearinghouse: ch, spot }),
        abstraction: f.abstraction,
        takerRate: f.takerRate,
      }));
      setError(null);
    } catch (e) {
      if (mine === epoch.current) setError(plainError(e).text);
    }
  }, []);

  const fire = useCallback(async () => {
    timer.current = null;
    firstAt.current = null;
    if (running.current) return; // the running fetch re-requests when it ends (dirty keeps the flags)
    const parts = dirty.current;
    dirty.current = { orders: false, fills: false };
    running.current = true;
    try {
      await run(parts);
    } finally {
      running.current = false;
      if (timer.current === null && (dirty.current.orders || dirty.current.fills)) requestRef.current(dirty.current);
    }
  }, [run]);

  const request = useCallback((parts: Parts) => {
    dirty.current = { orders: dirty.current.orders || parts.orders, fills: dirty.current.fills || parts.fills };
    const now = Date.now();
    if (firstAt.current === null) firstAt.current = now;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void fire(), Math.max(0, Math.min(DEBOUNCE_MS, firstAt.current + MAX_WAIT_MS - now)));
  }, [fire]);
  requestRef.current = request;

  /** Stable on purpose: a refresh captured before an account switch still reaches the current account. */
  const refresh = useCallback(() => requestRef.current({ orders: true, fills: true }), []);

  useEffect(() => {
    cur.current = { master, network };
    epoch.current++;
    fixed.current = null;
    fillsRef.current = [];
    dirty.current = { orders: false, fills: false };
    firstAt.current = null;
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setState(EMPTY);
    setError(null);
    if (master) void run({ orders: true, fills: true });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [master, network, run]);

  useEffect(() => {
    if (!master) return;
    let dead = false;
    const subs: { unsubscribe(): Promise<void> }[] = [];
    const keep = (s: { unsubscribe(): Promise<void> }) => (dead ? void s.unsubscribe() : subs.push(s));
    const c = getHl(network).subs();
    c.userFills({ user: master }, (ev: { isSnapshot?: true }) => {
      if (!ev.isSnapshot) requestRef.current({ orders: false, fills: true });
    }).then(keep).catch(() => {});
    c.orderUpdates({ user: master }, () => requestRef.current({ orders: true, fills: false })).then(keep).catch(() => {});
    return () => {
      dead = true;
      subs.forEach((s) => void s.unsubscribe());
    };
  }, [master, network]);

  const api = useMemo<AccountApi>(() => ({ ...state, error, refresh }), [state, error, refresh]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useAccount(): AccountApi {
  const a = useContext(Ctx);
  if (!a) throw new Error("useAccount outside AccountProvider");
  return a;
}

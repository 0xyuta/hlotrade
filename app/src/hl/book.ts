import { useEffect, useState } from "react";
import type { Network } from "../config/validate";
import { infoPost } from "./clients";
import { parseBook, type Book } from "./impact";

const POLL_MS = 3_000;

/** One l2Book read; null when Hyperliquid's answer is not a book. Throws on a network or HTTP failure. */
export async function fetchBook(net: Network, coin: string): Promise<Book | null> {
  return parseBook(await infoPost<unknown>(net, { type: "l2Book", coin }));
}

/** The coin's book, read every 3 s while `on` (a market order with a size); null while off, loading or unreadable. */
export function useBook(net: Network, coin: string, on: boolean): Book | null {
  const [book, setBook] = useState<Book | null>(null);
  useEffect(() => {
    setBook(null);
    if (!on) return;
    let dead = false;
    const tick = () =>
      fetchBook(net, coin).then(
        (b) => void (dead || setBook(b)),
        () => void (dead || setBook(null)), // a failed read shows no estimate; the max slippage still bounds the order
      );
    void tick();
    const t = setInterval(tick, POLL_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [net, coin, on]);
  return book;
}

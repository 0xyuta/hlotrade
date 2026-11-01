import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TradeFeed, type FeedSocket } from "../src/tradefeed.js";

const T0 = 1_000_000;
const URL = "wss://hl.test/ws";
const U1 = "0xAAaa000000000000000000000000000000000001";
const U2 = "0xBBbb000000000000000000000000000000000002";
const U3 = "0xCCcc000000000000000000000000000000000003";
const low = (...us: string[]) => us.map((u) => u.toLowerCase()).sort();

/** Like a WebSocket: `send` throws while the socket is still connecting; `close()` is the server closing it (or the feed closing it, once the feed has dropped its handlers). */
class FakeSocket implements FeedSocket {
  sent: any[] = [];
  closed = false;
  isOpen = false;
  failSend = false;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(readonly url: string) {}
  send(s: string) {
    if (!this.isOpen || this.failSend) throw new Error("InvalidStateError");
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.isOpen = false;
    this.onclose?.({});
  }
  open() {
    this.isOpen = true;
    this.onopen?.({});
  }
  msg(j: unknown) {
    this.onmessage?.({ data: JSON.stringify(j) });
  }
  raw(s: string) {
    this.onmessage?.({ data: s });
  }
}

const ack = (ws: FakeSocket, coin: string) => ws.msg({ channel: "subscriptionResponse", data: { method: "subscribe", subscription: { type: "trades", coin } } });
const trade = (ws: FakeSocket, coin: string, time: number, a: string, b: string) => ws.msg({ channel: "trades", data: [{ coin, time, users: [a, b] }] });
const sub = (coin: string) => ({ method: "subscribe", subscription: { type: "trades", coin } });
const subs = (ws: FakeSocket) => ws.sent.filter((m) => m.method === "subscribe").map((m) => m.subscription.coin);
const pings = (ws: FakeSocket) => ws.sent.filter((m) => m.method === "ping").length;
const pong = (ws: FakeSocket) => ws.msg({ channel: "pong" });

function harness(coinsFn: () => Promise<string[]> = async () => ["BTC", "ETH"], maxSilenceMs: number | null | undefined = undefined) {
  const sockets: FakeSocket[] = [];
  const logs: string[] = [];
  const coins = vi.fn(coinsFn);
  const feed = new TradeFeed({
    url: URL,
    coins,
    connect: (u) => {
      const s = new FakeSocket(u);
      sockets.push(s);
      return s;
    },
    log: (s) => logs.push(s),
    maxSilenceMs,
  });
  return { feed, sockets, logs, coins };
}
type H = ReturnType<typeof harness>;

const flush = () => vi.advanceTimersByTimeAsync(0);
/** Starts the feed and opens its first socket, without acknowledging anything. */
async function opened(h: H): Promise<FakeSocket> {
  h.feed.start();
  await flush();
  const ws = h.sockets[0];
  ws.open();
  return ws;
}
/** Starts the feed, opens the socket and acknowledges every coin: live at T0. */
async function live(h: H, coins = ["BTC", "ETH"]): Promise<FakeSocket> {
  const ws = await opened(h);
  for (const c of coins) ack(ws, c);
  return ws;
}
/** Lets `ms` pass in steps of at most 15 s, answering each with a pong (a healthy connection). */
async function alive(ws: FakeSocket, ms: number) {
  for (let left = ms; left > 0; left -= 15_000) {
    await vi.advanceTimersByTimeAsync(Math.min(15_000, left));
    pong(ws);
  }
}

describe("TradeFeed", () => {
  beforeEach(() => vi.useFakeTimers({ now: T0 }));
  afterEach(() => vi.useRealTimers());

  it("start() reads coins() then connects to url; on open it sends one subscribe per coin", async () => {
    const h = harness();
    h.feed.start();
    expect(h.sockets).toHaveLength(0);
    await flush();
    expect(h.coins).toHaveBeenCalledTimes(1);
    expect(h.sockets).toHaveLength(1);
    expect(h.sockets[0].url).toBe(URL);
    expect(h.sockets[0].sent).toEqual([]);
    h.sockets[0].open();
    expect(h.sockets[0].sent).toEqual([sub("BTC"), sub("ETH")]);
  });

  it("start() twice opens one connection", async () => {
    const h = harness();
    h.feed.start();
    h.feed.start();
    await flush();
    expect(h.sockets).toHaveLength(1);
  });

  it("is not live until every coin is acknowledged; an open period has no end margin", async () => {
    const h = harness();
    const ws = await opened(h);
    ack(ws, "BTC");
    ack(ws, "SOL"); // not one of ours
    expect(h.feed.uncovered(T0, T0 + 60_000)).toBe(60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    const t = Date.now();
    ack(ws, "ETH");
    expect(h.feed.uncovered(t + 5_000, t + 65_000)).toBe(0);
    expect(h.feed.uncovered(t, t + 65_000)).toBe(5_000);
  });

  it("before the first live moment everything is uncovered, however old the window", async () => {
    const h = harness();
    expect(h.feed.uncovered(0, 500_000)).toBe(500_000);
    h.feed.start();
    await flush();
    expect(h.feed.uncovered(0, 500_000)).toBe(500_000);
    expect(h.feed.uncovered(T0 - 3_600_000, T0)).toBe(3_600_000);
    expect(h.feed.uncovered(10, 10)).toBe(0);
    expect(h.feed.uncovered(20, 10)).toBe(0);
  });

  describe("usersSince and prune", () => {
    it("records both sides lowercased; the later of two times wins; prune drops the older", async () => {
      const h = harness();
      const ws = await live(h);
      const T = T0 + 1_000;
      trade(ws, "BTC", T, U1, U2);
      expect(h.feed.usersSince(T).sort()).toEqual(low(U1, U2));
      expect(h.feed.usersSince(T + 1)).toEqual([]);
      trade(ws, "ETH", T + 10, U1, U3);
      trade(ws, "BTC", T + 2, U1, U2); // older than U1's last: U1 stays at T + 10, U2 moves from T to T + 2
      expect(h.feed.usersSince(T + 3).sort()).toEqual(low(U1, U3));
      expect(h.feed.usersSince(T + 2).sort()).toEqual(low(U1, U2, U3));
      h.feed.prune(T + 3);
      expect(h.feed.usersSince(0).sort()).toEqual(low(U1, U3));
      h.feed.prune(T + 11);
      expect(h.feed.usersSince(0)).toEqual([]);
    });
    it("records trades that arrive before the feed is live", async () => {
      const h = harness();
      const ws = await opened(h);
      ack(ws, "BTC");
      trade(ws, "BTC", T0 + 5, U1, U2);
      expect(h.feed.usersSince(T0)).toHaveLength(2);
    });
    it("prune forgets live periods that ended before the cut: what is not known is uncovered", async () => {
      const h = harness();
      const ws = await live(h);
      await vi.advanceTimersByTimeAsync(20_000);
      pong(ws);
      ws.close(); // lost at T0 + 20 s
      expect(h.feed.uncovered(T0 + 5_000, T0 + 15_000)).toBe(0);
      h.feed.prune(T0 + 60_000);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 15_000)).toBe(10_000);
    });
  });

  describe("ping, pong and reconnects", () => {
    it("pings every 15 s; a pong keeps it open; no pong for 30 s closes it and reconnects after 1 s", async () => {
      const h = harness();
      const ws = await live(h);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(pings(ws)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(pings(ws)).toBe(1);
      expect(ws.sent.at(-1)).toEqual({ method: "ping" });
      ws.msg({ channel: "pong" });
      await vi.advanceTimersByTimeAsync(15_000); // T0 + 30 s: 15 s since the pong
      expect(pings(ws)).toBe(2);
      expect(ws.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000); // T0 + 45 s: 30 s since the pong
      expect(ws.closed).toBe(true);
      expect(h.logs.some((l) => l.includes("no pong"))).toBe(true);
      await vi.advanceTimersByTimeAsync(999);
      expect(h.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(2);
      expect(h.coins).toHaveBeenCalledTimes(2); // the list is read again before each connection
    });

    it("a connection that never sends a pong is closed 30 s after it opened", async () => {
      const h = harness();
      const ws = await live(h);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(ws.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.closed).toBe(true);
    });

    it("backs off 1, 2, 4 … capped at 30 s, and starts over once live again", async () => {
      const h = harness();
      let ws = await opened(h);
      for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
        const n = h.sockets.length;
        ws.close(); // the server closes it
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(h.sockets).toHaveLength(n);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.sockets).toHaveLength(n + 1);
        ws = h.sockets[n];
        ws.open();
      }
      for (const c of ["BTC", "ETH"]) ack(ws, c); // live again
      const n = h.sockets.length;
      ws.close();
      await vi.advanceTimersByTimeAsync(999);
      expect(h.sockets).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(n + 1);
    });

    it("a failing coins() read before a connection retries with the same backoff", async () => {
      let fail = true;
      const h = harness(async () => {
        if (fail) throw new Error("meta down");
        return ["BTC", "ETH"];
      });
      h.feed.start();
      await flush();
      expect(h.sockets).toHaveLength(0);
      expect(h.logs.some((l) => l.includes("meta down"))).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000); // second try fails, the next is in 2 s
      expect(h.coins).toHaveBeenCalledTimes(2);
      fail = false;
      await vi.advanceTimersByTimeAsync(1_999);
      expect(h.sockets).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.sockets).toHaveLength(1);
    });

    it("an error event is a loss too, once (the close that follows is ignored)", async () => {
      const h = harness();
      const ws = await live(h);
      ws.onerror?.({});
      expect(h.logs.filter((l) => l.includes("connection lost"))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
    });

    it("a send that throws drops the connection instead of crashing", async () => {
      const h = harness();
      h.feed.start();
      await flush();
      const ws = h.sockets[0];
      ws.isOpen = true;
      ws.failSend = true;
      expect(() => ws.onopen?.({})).not.toThrow();
      expect(ws.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
    });
  });

  describe("coverage", () => {
    it("a connection that closes: the 5 s before are not covered, nor anything after until it is acknowledged again", async () => {
      const h = harness();
      const ws = await live(h); // live at T0
      await vi.advanceTimersByTimeAsync(20_000);
      pong(ws); // heard just before the close
      const lostAt = Date.now();
      ws.close();
      expect(h.feed.uncovered(T0, T0 + 5_000)).toBe(5_000); // the first 5 s after it went live are not covered either
      expect(h.feed.uncovered(lostAt - 10_000, lostAt - 5_000)).toBe(0);
      expect(h.feed.uncovered(lostAt - 5_000, lostAt)).toBe(5_000);
      expect(h.feed.uncovered(lostAt, lostAt + 500)).toBe(500);
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      expect(h.feed.uncovered(lostAt, lostAt + 1_000)).toBe(1_000); // reconnecting
      for (const c of ["BTC", "ETH"]) ack(ws2, c);
      const R = Date.now();
      expect(R).toBe(lostAt + 1_000);
      expect(h.feed.uncovered(R + 5_000, R + 6_000)).toBe(0);
      expect(h.feed.uncovered(lostAt - 5_000, R + 5_000)).toBe(11_000);
    });

    it("a silent death is noticed 30 s late, but the period ends at the last message heard, not at the detection", async () => {
      const h = harness();
      const ws = await live(h); // live at T0
      await vi.advanceTimersByTimeAsync(15_000);
      ws.msg({ channel: "pong" }); // the last sign of life: T0 + 15 s
      await vi.advanceTimersByTimeAsync(30_000); // T0 + 45 s: no pong for 30 s
      expect(ws.closed).toBe(true);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 10_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 10_000, T0 + 45_000)).toBe(35_000);
    });

    it("a trade is a sign of life too", async () => {
      const h = harness();
      const ws = await live(h);
      await vi.advanceTimersByTimeAsync(20_000);
      trade(ws, "BTC", T0 + 19_000, U1, U2); // heard at T0 + 20 s
      await vi.advanceTimersByTimeAsync(10_000); // no pong ever: lost at T0 + 30 s
      expect(ws.closed).toBe(true);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 15_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 15_000, T0 + 30_000)).toBe(15_000);
    });

    it("a wall clock stepped back cannot make a stretch count twice", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 30_000);
      ws.close(); // watched: T0 + 5 s to T0 + 25 s
      vi.setSystemTime(T0 + 10_000); // the clock is stepped back 20 s
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      for (const c of ["BTC", "ETH"]) ack(ws2, c); // live from T0 + 11 s: overlaps the first period
      expect(h.feed.uncovered(T0 + 5_000, T0 + 35_000)).toBe(0);
      expect(h.feed.uncovered(T0, T0 + 35_000)).toBe(5_000);
    });

    it("a socket that goes quiet and then closes is trusted only up to the last message it delivered", async () => {
      const h = harness();
      const ws = await live(h); // live at T0
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws); // the last message: T0 + 15 s
      await vi.advanceTimersByTimeAsync(11_000); // quiet until T0 + 26 s ...
      ws.close(); // ... then the server closes it
      expect(h.feed.uncovered(T0 + 5_000, T0 + 10_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 10_000, T0 + 26_000)).toBe(16_000); // not covered up to the close
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      for (const c of ["BTC", "ETH"]) ack(ws2, c);
      expect(h.feed.uncovered(T0 + 10_000, T0 + 26_000)).toBe(16_000); // and the reconnect does not bring it back
    });

    it("an open period counts only while something was heard within 20 s", async () => {
      const h = harness();
      const ws = await live(h); // live at T0
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws); // heard at T0 + 15 s
      await vi.advanceTimersByTimeAsync(20_000); // T0 + 35 s: 20 s since, not more
      expect(h.feed.uncovered(T0 + 25_000, T0 + 35_000)).toBe(0);
      await vi.advanceTimersByTimeAsync(1); // more than 20 s: the period ended at T0 + 15 s, before any close
      expect(ws.closed).toBe(false);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 10_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 10_000, T0 + 25_000)).toBe(15_000);
      expect(h.feed.uncovered(T0 + 25_000, T0 + 35_001)).toBe(10_001);
      await vi.advanceTimersByTimeAsync(4_999); // T0 + 40 s: 25 s of nothing
      expect(h.feed.uncovered(T0 + 25_000, T0 + 40_000)).toBe(15_000);
    });

    it("a socket that delivers again after a quiet spell does not get the quiet spell back", async () => {
      const h = harness();
      const ws = await live(h); // live at T0
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws); // T0 + 15 s
      await vi.advanceTimersByTimeAsync(25_000); // T0 + 40 s
      pong(ws); // delivering again
      expect(ws.closed).toBe(false);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 10_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 10_000, T0 + 45_000)).toBe(35_000);
      expect(h.feed.uncovered(T0 + 45_000, T0 + 60_000)).toBe(0);
    });

    it("stop() after a quiet spell ends the period at the last message", async () => {
      const h = harness();
      const ws = await live(h);
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws);
      await vi.advanceTimersByTimeAsync(10_000);
      h.feed.stop();
      expect(h.feed.uncovered(T0 + 5_000, T0 + 10_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 10_000, T0 + 25_000)).toBe(15_000);
    });

    it("stop() ends the live period at once", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 30_000);
      expect(h.feed.uncovered(T0 + 25_000, T0 + 30_000)).toBe(0); // open: no end margin yet
      h.feed.stop();
      expect(h.feed.uncovered(T0 + 5_000, T0 + 25_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 25_000, T0 + 30_000)).toBe(5_000);
    });
  });

  describe("periods that add no coverage", () => {
    const periods = (h: H) => (h.feed as unknown as { periods: unknown[] }).periods;
    it("a live period of 10 s or less is not kept, one of 10.001 s is", async () => {
      for (const [length, kept] of [[10_000, false], [10_001, true]] as const) {
        const h = harness();
        const ws = await live(h);
        await vi.advanceTimersByTimeAsync(length);
        pong(ws);
        ws.close();
        expect(periods(h)).toHaveLength(kept ? 1 : 0);
        expect(h.feed.uncovered(T0, T0 + 20_000)).toBe(kept ? 19_999 : 20_000);
        h.feed.stop();
      }
    });
    it("a renamed field at 100 messages a second keeps one period, not one per message", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 30_000);
      for (let i = 0; i < 3_000; i++) {
        await vi.advanceTimersByTimeAsync(10);
        ws.msg({ channel: "trades", data: [{ coin: "BTC", time: Date.now(), usr: [U1, U2] }] });
      }
      expect(periods(h)).toHaveLength(1); // the 30 s before the first one
      expect(h.feed.uncovered(T0 + 5_000, T0 + 25_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 30_000, T0 + 60_000)).toBe(30_000);
    });
  });

  describe("new listings", () => {
    it("a coin found at a read is subscribed; from the previous read until its acknowledgment is not covered", async () => {
      let list = ["BTC", "ETH"];
      const h = harness(async () => list);
      const ws = await live(h); // read at T0, live at T0
      await alive(ws, 60_000); // the read at T0 + 60 s finds nothing new
      const P = T0 + 60_000;
      expect(h.coins).toHaveBeenCalledTimes(2);
      expect(subs(ws)).toEqual(["BTC", "ETH"]);
      expect(h.feed.uncovered(T0 + 5_000, P)).toBe(0);
      list = ["BTC", "ETH", "SOL"];
      await alive(ws, 60_000); // the read at T0 + 120 s finds SOL
      expect(Date.now()).toBe(P + 60_000);
      expect(subs(ws)).toEqual(["BTC", "ETH", "SOL"]);
      await vi.advanceTimersByTimeAsync(2_000);
      const A = Date.now();
      const window = A + 5_000 - (P - 5_000);
      expect(h.feed.uncovered(P - 5_000, A + 5_000)).toBe(window); // not live yet
      expect(h.feed.uncovered(T0 + 5_000, P - 5_000)).toBe(0); // before the previous read: still covered
      ack(ws, "SOL");
      expect(h.feed.uncovered(P - 5_000, A + 5_000)).toBe(window); // the whole window
      expect(h.feed.uncovered(A + 5_000, A + 65_000)).toBe(0); // live again
      expect(h.logs.some((l) => l.includes("new coins SOL"))).toBe(true);
    });

    it("meta is read about once a minute; a read with no new coin changes nothing", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 59_999);
      expect(h.coins).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); // T0 + 60 s
      expect(h.coins).toHaveBeenCalledTimes(2);
      await alive(ws, 120_000);
      expect(h.coins).toHaveBeenCalledTimes(4);
      expect(subs(ws)).toEqual(["BTC", "ETH"]);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 180_000)).toBe(0);
    });

    it("a failing read logs and keeps the old list; the gap of a coin found later starts at the last good read", async () => {
      let list = ["BTC", "ETH"];
      let fail = false;
      const h = harness(async () => {
        if (fail) throw new Error("meta 500");
        return list;
      });
      const ws = await live(h);
      await alive(ws, 60_000); // good read at T0 + 60 s
      const good = T0 + 60_000;
      fail = true;
      await alive(ws, 120_000); // reads at 120 s and 180 s fail
      expect(h.logs.filter((l) => l.includes("meta read failed: meta 500"))).toHaveLength(2);
      expect(subs(ws)).toEqual(["BTC", "ETH"]);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 180_000)).toBe(0); // 120 s since the good read: not stale yet
      fail = false;
      list = ["BTC", "ETH", "SOL"];
      await alive(ws, 60_000); // T0 + 240 s
      expect(subs(ws)).toEqual(["BTC", "ETH", "SOL"]);
      expect(h.feed.uncovered(good - 10_000, good - 5_000)).toBe(0);
      expect(h.feed.uncovered(good - 5_000, T0 + 240_000)).toBe(T0 + 240_000 - (good - 5_000));
    });

    it("the time of a read is when its request started, not when the answer came", async () => {
      let list = ["BTC", "ETH"];
      let slow = false;
      const h = harness(() => {
        const answer = [...list];
        return new Promise((r) => setTimeout(() => r(answer), slow ? 3_000 : 0));
      });
      const ws = await live(h);
      slow = true;
      await alive(ws, 60_000); // the read starts at T0 + 60 s ...
      const started = T0 + 60_000;
      await alive(ws, 15_000); // ... and its answer comes 3 s later: nothing new
      expect(h.coins).toHaveBeenCalledTimes(2);
      list = ["BTC", "ETH", "SOL"];
      await alive(ws, 45_000); // the next read starts at T0 + 120 s
      await alive(ws, 15_000); // and finds SOL 3 s later
      expect(subs(ws)).toEqual(["BTC", "ETH", "SOL"]);
      expect(h.feed.uncovered(started - 10_000, started - 5_000)).toBe(0);
      expect(h.feed.uncovered(started - 5_000, started)).toBe(5_000); // not 3 s less
    });

    it("a reconnect whose read lists a coin the lost connection never had cuts that connection's period back to the previous read", async () => {
      let list = ["BTC", "ETH"];
      const h = harness(async () => list);
      const ws = await live(h);
      await alive(ws, 60_000); // read at P = T0 + 60 s: the list was complete then
      const P = T0 + 60_000;
      await vi.advanceTimersByTimeAsync(10_000);
      list = ["BTC", "ETH", "SOL"]; // SOL was listed some time after P
      pong(ws);
      const lostAt = Date.now();
      ws.close();
      expect(h.feed.uncovered(P, lostAt - 5_000)).toBe(0); // not known yet
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      for (const c of ["BTC", "ETH", "SOL"]) ack(ws2, c);
      const R = Date.now();
      expect(h.feed.uncovered(P - 10_000, P - 5_000)).toBe(0);
      expect(h.feed.uncovered(P - 5_000, R + 5_000)).toBe(R + 5_000 - (P - 5_000));
      expect(h.feed.uncovered(R + 5_000, R + 65_000)).toBe(0);
    });

    it("a reconnect whose read lists no new coin leaves the lost connection's period alone", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 60_000);
      await vi.advanceTimersByTimeAsync(10_000);
      pong(ws);
      const lostAt = Date.now();
      ws.close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
      expect(h.feed.uncovered(lostAt - 15_000, lostAt - 5_000)).toBe(0);
    });

    it("with no good read for over 3 minutes the open period counts only up to the last good read; a good read restores it", async () => {
      let fail = false;
      const h = harness(async () => {
        if (fail) throw new Error("meta down");
        return ["BTC", "ETH"];
      });
      const ws = await live(h); // good read at T0
      fail = true;
      await alive(ws, 180_000); // every read from T0 + 60 s fails; the socket stays healthy
      expect(h.coins.mock.calls.length).toBeGreaterThan(2);
      expect(h.feed.uncovered(T0 + 100_000, T0 + 170_000)).toBe(0); // 180 s since the good read, not more
      await vi.advanceTimersByTimeAsync(1);
      expect(h.feed.uncovered(T0 + 100_000, T0 + 170_000)).toBe(70_000);
      fail = false;
      await alive(ws, 59_999); // the next read succeeds and shows nothing new
      expect(h.feed.uncovered(T0 + 100_000, T0 + 170_000)).toBe(0);
    });
  });

  describe("a meta outage cannot stall the owner", () => {
    // The last good read is T0; the minute ending T0 + 60 s is covered through a pong at T0 + 75 s, but deliveredPast waits
    // for a read that started after the minute, and reads keep failing.
    const failing = () => {
      let fail = false;
      const h = harness(async () => {
        if (fail) throw new Error("meta: unexpected response");
        return ["BTC", "ETH"];
      });
      return { h, fail: (v: boolean) => (fail = v) };
    };
    const end = T0 + 60_000;

    it("a closed period stops counting past the last good read once it is 3 minutes old; a good read restores it", async () => {
      const { h, fail } = failing();
      const ws = await live(h);
      await alive(ws, 10_000);
      fail(true);
      await alive(ws, 50_000); // T0 + 60 s: the minute ends, the read at this tick fails
      await alive(ws, 15_000); // a pong at T0 + 75 s
      pong(ws);
      ws.close(); // no new socket can be made: connecting needs the coin list
      expect(h.feed.uncovered(T0 + 10_000, end)).toBe(0);
      expect(h.feed.deliveredPast(end)).toBe(false);
      await vi.advanceTimersByTimeAsync(105_000); // T0 + 180 s: 180 s since the good read, not more
      expect(h.feed.uncovered(T0 + 10_000, end)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.feed.uncovered(T0 + 10_000, end)).toBe(end - (T0 + 10_000)); // all of it: the owner takes its wider reads
      expect(h.sockets).toHaveLength(1);
      fail(false);
      await vi.advanceTimersByTimeAsync(30_000); // the retry reads the list again: nothing new
      expect(h.sockets).toHaveLength(2);
      expect(h.feed.uncovered(T0 + 10_000, end)).toBe(0);
    });

    it("so does a closed period left by a gap on a socket that stays up", async () => {
      const { h, fail } = failing();
      const ws = await live(h);
      await alive(ws, 10_000);
      fail(true);
      await alive(ws, 50_000);
      await alive(ws, 15_000); // T0 + 75 s
      ws.msg({ channel: "trades", data: [{ coin: "BTC", time: T0, usr: [U1, U2] }] }); // unreadable: the period closes
      expect(h.feed.uncovered(T0 + 10_000, end)).toBe(0);
      expect(h.feed.deliveredPast(end)).toBe(false);
      await alive(ws, 105_000); // T0 + 180 s
      expect(h.feed.uncovered(T0 + 10_000, end)).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.feed.uncovered(T0 + 10_000, end)).toBe(end - (T0 + 10_000));
      expect(ws.closed).toBe(false);
    });
  });

  describe("deliveredPast", () => {
    it("false at first, and no read is started for nothing", async () => {
      const h = harness();
      await live(h);
      expect(h.feed.deliveredPast(T0)).toBe(false); // everything heard so far is within 5 s of it
      expect(h.coins).toHaveBeenCalledTimes(1);
    });
    it("a trade counts only for times more than 5 s before its time; then a read that started after them is needed", async () => {
      const h = harness();
      const ws = await live(h); // read at T0
      await vi.advanceTimersByTimeAsync(10_000);
      trade(ws, "BTC", T0 + 14_000, U1, U2); // heard at T0 + 10 s, timed 4 s ahead of it (within the allowed 5 s)
      expect(h.feed.deliveredPast(T0 + 9_000)).toBe(false); // 14 000 is not more than 9 000 + 5 000, and 10 000 is not either
      expect(h.coins).toHaveBeenCalledTimes(1); // and so no read is started
      expect(h.feed.deliveredPast(T0 + 8_999)).toBe(false); // arrived, but the only read started before it: starts one
      expect(h.coins).toHaveBeenCalledTimes(2);
      await flush();
      expect(h.feed.deliveredPast(T0 + 8_999)).toBe(true); // the read started at T0 + 10 s, after it
      expect(h.feed.deliveredPast(T0 + 9_000)).toBe(false);
    });
    it("any message heard at or after 5 s past the minute counts, not only a pong or a trade's time", async () => {
      const h = harness();
      const ws = await live(h); // read at T0
      await alive(ws, 45_000); // the last pong: T0 + 45 s
      await vi.advanceTimersByTimeAsync(14_000);
      trade(ws, "BTC", T0 + 100, U1, U2); // an old trade heard at T0 + 59 s: not a pong, and its time says nothing
      expect(h.feed.deliveredPast(T0 + 54_001)).toBe(false); // 59 000 is before 54 001 + 5 000
      expect(h.coins).toHaveBeenCalledTimes(1);
      expect(h.feed.deliveredPast(T0 + 54_000)).toBe(false); // heard exactly 5 s after it: only the read is missing, so one starts
      expect(h.coins).toHaveBeenCalledTimes(2);
      await flush();
      expect(h.feed.deliveredPast(T0 + 54_000)).toBe(true);
      expect(h.feed.deliveredPast(T0 + 54_001)).toBe(false);
    });
    it("what a closed socket last delivered still counts, and a new socket does not reset it", async () => {
      // The socket closes and the next one never opens: a minute covered through the last message must still become
      // delivered, or the owner would wait for a message that cannot come.
      const h = harness();
      const ws = await live(h);
      await alive(ws, 60_000); // read at T0 + 60 s
      const end = T0 + 65_000;
      await vi.advanceTimersByTimeAsync(10_500); // T0 + 70.5 s, which is end + 5.5 s
      trade(ws, "BTC", end + 4_900, U1, U2); // heard at end + 5.5 s, timed end + 4.9 s
      ws.close();
      for (const after of [1_000, 600_000, 3_600_000]) {
        await vi.advanceTimersByTimeAsync(after); // the new sockets are created and never opened
        expect(h.sockets.length).toBeGreaterThan(1);
        expect(h.feed.uncovered(T0 + 10_000, end)).toBe(0);
        expect(h.feed.deliveredPast(end)).toBe(true);
      }
    });
    it("whenever a window is covered and meta answers, its end becomes delivered without a new socket", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 60_000);
      await vi.advanceTimersByTimeAsync(10_500);
      trade(ws, "BTC", T0 + 100, U1, U2); // the last message, an old trade (not a pong): E = T0 + 70.5 s
      const E = Date.now();
      ws.close();
      await vi.advanceTimersByTimeAsync(1_000); // the new socket is never opened; meta is read again
      // the last covered ms, E - 5 s, is also the last delivered one: the two edges meet there
      for (const ms of [T0 + 20_000, T0 + 50_000, E - 20_000, E - 5_500, E - 5_001, E - 5_000]) {
        expect(h.feed.uncovered(T0 + 10_000, ms)).toBe(0);
        expect(h.feed.deliveredPast(ms)).toBe(true);
      }
      // one millisecond on, it is neither covered nor delivered
      expect(h.feed.deliveredPast(E - 4_999)).toBe(false);
      expect(h.feed.uncovered(E - 5_000, E - 4_999)).toBe(1);
    });
    it("a pong counts for times up to 5 s before it was received, and no later", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 60_000); // the read at T0 + 60 s; the last pong at T0 + 60 s
      expect(h.coins).toHaveBeenCalledTimes(2);
      expect(h.feed.deliveredPast(T0 + 54_999)).toBe(true);
      expect(h.feed.deliveredPast(T0 + 55_000)).toBe(true);
      expect(h.feed.deliveredPast(T0 + 55_001)).toBe(false);
      expect(h.feed.deliveredPast(T0 + 60_000)).toBe(false);
    });
    it("an older trade does not take it back", async () => {
      const h = harness();
      const ws = await live(h);
      await vi.advanceTimersByTimeAsync(10_000);
      trade(ws, "BTC", T0 + 14_000, U1, U2); // timed ahead of when it was heard (T0 + 10 s)
      trade(ws, "ETH", T0 + 100, U1, U2);
      expect(h.feed.deliveredPast(T0 + 8_999)).toBe(false);
      expect(h.coins).toHaveBeenCalledTimes(2); // 14 000 is past 8 999 + 5 000 (the older 100 would not be): a read starts
    });
    it("a trade timed more than 5 s ahead of the clock does not count", async () => {
      const h = harness();
      const ws = await live(h); // read at T0
      trade(ws, "BTC", T0 + 5_001, U1, U2); // one far-future time must not make every minute delivered for good
      expect(h.feed.deliveredPast(T0 - 4_000)).toBe(false); // (the messages heard at T0 are within 5 s of this minute)
      expect(h.feed.usersSince(T0)).toHaveLength(2); // the wallets are still remembered
      trade(ws, "BTC", T0 + 5_000, U1, U2);
      expect(h.feed.deliveredPast(T0 - 4_000)).toBe(true);
    });
    it("only a read that started after the minute ended will do; a call that lacks only that starts one, once", async () => {
      let slow = false;
      const h = harness(() => new Promise((r) => setTimeout(() => r(["BTC", "ETH"]), slow ? 3_000 : 0)));
      const ws = await live(h); // read at T0
      await alive(ws, 30_000);
      const ms = T0 + 10_000;
      slow = true;
      expect(h.feed.deliveredPast(ms)).toBe(false); // pong at T0 + 30 s is past the minute, but the read is older
      expect(h.coins).toHaveBeenCalledTimes(2);
      expect(h.feed.deliveredPast(ms)).toBe(false); // in flight: not started again
      await vi.advanceTimersByTimeAsync(2_999);
      expect(h.feed.deliveredPast(ms)).toBe(false);
      expect(h.coins).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.feed.deliveredPast(ms)).toBe(true); // the read started at T0 + 30 s
      expect(h.coins).toHaveBeenCalledTimes(2);
    });
    it("a failed read is not repeated on demand for 5 s", async () => {
      let fail = false;
      const h = harness(async () => {
        if (fail) throw new Error("meta 500");
        return ["BTC", "ETH"];
      });
      const ws = await live(h);
      fail = true;
      await vi.advanceTimersByTimeAsync(10_000);
      trade(ws, "BTC", T0 + 9_000, U1, U2);
      expect(h.feed.deliveredPast(T0 + 3_000)).toBe(false);
      await flush();
      expect(h.coins).toHaveBeenCalledTimes(2);
      expect(h.feed.deliveredPast(T0 + 3_000)).toBe(false);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(h.feed.deliveredPast(T0 + 3_000)).toBe(false);
      expect(h.coins).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      fail = false;
      expect(h.feed.deliveredPast(T0 + 3_000)).toBe(false);
      expect(h.coins).toHaveBeenCalledTimes(3);
      await flush();
      expect(h.feed.deliveredPast(T0 + 3_000)).toBe(true);
    });
    it("a coin listed inside a minute that looks covered is cut before the minute counts as delivered", async () => {
      let list = ["BTC", "ETH"];
      const h = harness(async () => list);
      const ws = await live(h); // read at T0
      await alive(ws, 45_000);
      list = ["BTC", "ETH", "SOL"]; // listed at about T0 + 30 s; the next scheduled read is at T0 + 60 s
      const end = T0 + 35_000; // a minute that ended at T0 + 35 s
      expect(h.feed.uncovered(T0 + 5_000, end)).toBe(0); // looks covered ...
      expect(h.feed.deliveredPast(end)).toBe(false); // ... but the pong at T0 + 45 s alone is not enough: a read starts
      await flush();
      expect(subs(ws)).toEqual(["BTC", "ETH", "SOL"]);
      expect(h.feed.deliveredPast(end)).toBe(true);
      expect(h.feed.uncovered(T0 + 5_000, end)).toBe(end - (T0 + 5_000)); // and by now the cut has landed
    });
  });

  describe("a socket that does not become live", () => {
    it("one that never opens is dropped after 30 s", async () => {
      const h = harness();
      h.feed.start();
      await flush();
      const ws = h.sockets[0]; // created, never opened
      await vi.advanceTimersByTimeAsync(29_999);
      expect(ws.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.closed).toBe(true);
      expect(h.logs.some((l) => l.includes("not live"))).toBe(true);
    });
    it("one that opens but is not acknowledged in full is dropped, pongs or not", async () => {
      const h = harness();
      const ws = await opened(h);
      ack(ws, "BTC");
      await alive(ws, 29_999);
      expect(ws.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.closed).toBe(true);
    });
    it("the backoff does not start over until the feed is live", async () => {
      const h = harness();
      h.feed.start();
      await flush();
      for (const wait of [1_000, 2_000, 4_000, 8_000]) {
        const n = h.sockets.length;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(h.sockets[n - 1].closed).toBe(true);
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(h.sockets).toHaveLength(n);
        await vi.advanceTimersByTimeAsync(1);
        expect(h.sockets).toHaveLength(n + 1);
      }
    });
    it("a refused new coin keeps the feed down for at most 30 s from its subscribe", async () => {
      let list = ["BTC", "ETH"];
      const h = harness(async () => list);
      const ws = await live(h);
      await alive(ws, 59_999);
      list = ["BTC", "ETH", "SOL"];
      await alive(ws, 1); // the read at T0 + 60 s finds SOL and subscribes
      expect(subs(ws)).toEqual(["BTC", "ETH", "SOL"]);
      ws.msg({ channel: "error", data: "Subscription refused" });
      expect(h.logs.some((l) => l.includes("Subscription refused"))).toBe(true);
      await alive(ws, 29_999);
      expect(ws.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(ws.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
      expect(subs(h.sockets[1])).toEqual([]); // not opened yet
      h.sockets[1].open();
      expect(subs(h.sockets[1])).toEqual(["BTC", "ETH", "SOL"]); // the list is read again, SOL included
    });
    it("a live feed is not touched by it", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 120_000);
      expect(ws.closed).toBe(false);
    });
    it("stop() clears it", async () => {
      const h = harness();
      h.feed.start();
      await flush();
      h.feed.stop();
      expect(h.sockets[0].closed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("lateTrades", () => {
    it("a trade at or before the covered time, from the live moment on, is late", async () => {
      const h = harness();
      const ws = await live(h); // live at T0
      trade(ws, "BTC", T0 + 10_000, U1, U2);
      expect(h.feed.lateTrades).toBe(0); // nothing covered yet
      h.feed.setCovered(T0 + 60_000);
      trade(ws, "BTC", T0 + 30_000, U1, U2);
      expect(h.feed.lateTrades).toBe(1);
      trade(ws, "BTC", T0 - 1, U1, U2); // older than the live moment: a snapshot on subscribing
      expect(h.feed.lateTrades).toBe(1);
      trade(ws, "BTC", T0 + 60_001, U1, U2); // after the covered time
      expect(h.feed.lateTrades).toBe(1);
      trade(ws, "BTC", T0 + 60_000, U1, U2); // exactly at it
      trade(ws, "BTC", T0, U1, U2); // exactly the live moment
      expect(h.feed.lateTrades).toBe(3);
    });
    it("a late trade right after a quiet spell on the same connection still counts", async () => {
      const h = harness();
      const ws = await live(h); // live at T0
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws);
      h.feed.setCovered(T0 + 9_000);
      await vi.advanceTimersByTimeAsync(25_000); // quiet until T0 + 40 s, then delivering again
      trade(ws, "BTC", T0 + 8_000, U1, U2);
      expect(h.feed.lateTrades).toBe(1);
      trade(ws, "BTC", T0 - 1, U1, U2); // still older than the acknowledgment: a snapshot
      expect(h.feed.lateTrades).toBe(1);
    });
    it("the covered time never moves back", async () => {
      const h = harness();
      const ws = await live(h);
      h.feed.setCovered(T0 + 60_000);
      h.feed.setCovered(T0 + 10_000);
      trade(ws, "BTC", T0 + 50_000, U1, U2);
      expect(h.feed.lateTrades).toBe(1);
    });
    it("takeLate gives both sides of the late trades since the last call, lowercase, once", async () => {
      const h = harness();
      const ws = await live(h);
      expect(h.feed.takeLate()).toEqual([]);
      h.feed.setCovered(T0 + 60_000);
      trade(ws, "BTC", T0 + 30_000, U1, U2);
      trade(ws, "BTC", T0 + 31_000, U1, U3); // U1 again: once
      trade(ws, "BTC", T0 - 1, "0xDDdd000000000000000000000000000000000004", "0xEEee000000000000000000000000000000000005"); // a snapshot: not late
      trade(ws, "BTC", T0 + 60_001, "0xDDdd000000000000000000000000000000000004", "0xEEee000000000000000000000000000000000005"); // after it: not late
      expect(h.feed.lateTrades).toBe(2);
      expect(h.feed.takeLate().sort()).toEqual(low(U1, U2, U3));
      expect(h.feed.takeLate()).toEqual([]); // emptied
      trade(ws, "BTC", T0 + 40_000, U2, U3);
      expect(h.feed.lateTrades).toBe(3);
      expect(h.feed.takeLate().sort()).toEqual(low(U2, U3));
    });
    it("a trade is late from the moment the owner marks the minute, so one heard while it reads is reported", async () => {
      const h = harness();
      const ws = await live(h);
      trade(ws, "BTC", T0 + 30_000, U1, U2); // before the mark: on the owner's list, not late
      expect(h.feed.takeLate()).toEqual([]);
      h.feed.setCovered(T0 + 60_000); // the owner has made its list
      trade(ws, "BTC", T0 + 50_000, U3, U1); // heard while the owner reads
      expect(h.feed.takeLate().sort()).toEqual(low(U1, U3));
    });
    it("nothing is late while the feed is not live", async () => {
      const h = harness();
      const ws = await opened(h);
      ack(ws, "BTC");
      h.feed.setCovered(T0 + 60_000);
      trade(ws, "BTC", T0 + 30_000, U1, U2);
      expect(h.feed.lateTrades).toBe(0);
      expect(h.feed.takeLate()).toEqual([]);
    });
  });

  describe("messages it does not understand", () => {
    it("malformed JSON, other shapes and unknown channels are ignored: no log, no gap", async () => {
      const h = harness();
      const ws = await live(h);
      const good = { coin: "BTC", time: T0 + 5, users: [U1, U2] };
      ws.raw("not json");
      ws.raw("");
      ws.raw("null");
      ws.raw("[]");
      ws.raw('"trades"');
      ws.msg({ channel: "mystery", data: [good] });
      ws.msg({ noChannel: true });
      ws.msg({ channel: "subscriptionResponse", data: "x" });
      expect(h.feed.usersSince(0)).toEqual([]);
      expect(h.feed.lateTrades).toBe(0);
      expect(h.logs).toEqual([]);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 65_000)).toBe(0); // still live, all of it
      ws.msg({ channel: "trades", data: [good] }); // and a good one after them all still counts
      expect(h.feed.usersSince(0)).toHaveLength(2);
    });
    it("an error message is logged, short, and its coin stays unacknowledged: not live", async () => {
      const h = harness();
      const ws = await opened(h);
      ack(ws, "BTC");
      ws.msg({ channel: "error", data: "Already subscribed" });
      ws.msg({ channel: "error", data: { reason: "x".repeat(500) } });
      expect(h.logs.some((l) => l.includes("Already subscribed"))).toBe(true);
      expect(h.logs.every((l) => l.length < 300)).toBe(true);
      expect(h.feed.uncovered(T0, T0 + 60_000)).toBe(60_000);
    });
  });

  describe("trades it cannot read", () => {
    const good = { coin: "BTC", time: T0 + 29_000, users: [U1, U2] };
    const unreadable: [string, unknown][] = [
      ["a renamed users field", { ...good, users: undefined, buyerSeller: [U1, U2] }],
      ["one user", { ...good, users: [U1] }],
      ["three users", { ...good, users: [U1, U2, U3] }],
      ["a user that is not a string", { ...good, users: [U1, 5] }],
      ["users that is not a list", { ...good, users: U1 }],
      ["a time that is a string", { ...good, time: "1000005" }],
      ["no time", { ...good, time: undefined }],
      ["a null time", { ...good, time: null }],
      ["an entry that is not an object", "x"],
      ["a null entry", null],
      ["a list as the entry", []],
    ];
    for (const [name, entry] of unreadable) {
      it(`${name}: logged once, and a gap`, async () => {
        const h = harness();
        const ws = await live(h);
        await alive(ws, 30_000);
        ws.msg({ channel: "trades", data: [entry] });
        expect(h.logs.filter((l) => l.startsWith("trade feed: unreadable trade"))).toHaveLength(1);
        expect(h.logs.every((l) => l.length <= 200)).toBe(true);
        expect(h.feed.usersSince(0)).toEqual([]);
        expect(h.feed.uncovered(T0 + 5_000, T0 + 25_000)).toBe(0); // before it: covered
        expect(h.feed.uncovered(T0 + 25_000, T0 + 35_000)).toBe(10_000); // the margins on both sides
        expect(h.feed.uncovered(T0 + 35_000, T0 + 65_000)).toBe(0); // and watched again at once
        expect(ws.closed).toBe(false);
      });
    }
    it("a trades message whose data is not a list is the same", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 30_000);
      ws.msg({ channel: "trades", data: { trades: [good] } });
      expect(h.logs.filter((l) => l.startsWith("trade feed: unreadable trade"))).toHaveLength(1);
      expect(h.feed.uncovered(T0 + 25_000, T0 + 35_000)).toBe(10_000);
    });
    it("a time that is not finite is the same", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 30_000);
      ws.raw('{"channel":"trades","data":[{"coin":"BTC","time":1e999,"users":["0xa","0xb"]}]}');
      expect(h.feed.deliveredPast(T0 + 100_000)).toBe(false); // Infinity is past every minute: it must not count
      expect(h.feed.uncovered(T0 + 25_000, T0 + 35_000)).toBe(10_000);
    });
    it("each gap counts, the log is once a connection and shows at most 200 characters", async () => {
      const h = harness();
      const ws = await live(h);
      await alive(ws, 30_000);
      ws.msg({ channel: "trades", data: [{ ...good, users: "x".repeat(5_000) }] });
      await alive(ws, 15_000);
      ws.msg({ channel: "trades", data: [{ ...good, users: undefined }] });
      expect(h.logs.filter((l) => l.startsWith("trade feed: unreadable trade"))).toHaveLength(1);
      expect(h.logs.every((l) => l.length <= 200)).toBe(true);
      expect(h.feed.uncovered(T0 + 25_000, T0 + 35_000)).toBe(10_000);
      expect(h.feed.uncovered(T0 + 40_000, T0 + 50_000)).toBe(10_000); // the second one
      expect(h.feed.uncovered(T0 + 35_000, T0 + 40_000)).toBe(0);
      pong(ws);
      ws.close(); // a new connection logs again
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      for (const c of ["BTC", "ETH"]) ack(ws2, c);
      ws2.msg({ channel: "trades", data: [null] });
      expect(h.logs.filter((l) => l.startsWith("trade feed: unreadable trade"))).toHaveLength(2);
    });
    it("a readable trade among unreadable ones is still read", async () => {
      const h = harness();
      const ws = await live(h);
      ws.msg({ channel: "trades", data: [null, good, { ...good, users: [U1] }] });
      expect(h.feed.usersSince(0)).toHaveLength(2);
    });
  });

  describe("a live socket with pongs but no trades (maxSilenceMs)", () => {
    const silent = (coinsFn?: () => Promise<string[]>) => harness(coinsFn, 30_000);
    const noTrades = (h: H) => h.logs.filter((l) => l.includes("no trades for"));
    const readable = (t: number) => ({ coin: "BTC", time: t - 100, users: [U1, U2] });
    /**
     * `ms` (a multiple of 5 s) of life in 5 s steps: a pong whenever `pongEveryMs` has passed since T0, and a trade
     * (`entry`, readable by default) at every step up to and including `tradesUntil`. The ping ticks come during the advance,
     * so a message at a step arrives just after a tick at the same moment.
     */
    async function steps(ws: FakeSocket, ms: number, tradesUntil = -1, entry: (t: number) => unknown = readable, pongEveryMs = 5_000) {
      for (let left = ms; left > 0; left -= 5_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        const t = Date.now();
        if (t <= tradesUntil) ws.msg({ channel: "trades", data: [entry(t)] });
        if ((t - T0) % pongEveryMs === 0) pong(ws);
      }
    }

    it("pongs keep coming, trades stop: reconnects 30 to 45 s after the last one, and the stretch since is not covered", async () => {
      const h = silent();
      const ws = await live(h); // live at T0
      await steps(ws, 20_000, T0 + 20_000); // the last trade arrives at T0 + 20 s
      await steps(ws, 35_000); // T0 + 55 s: the ticks at 30 s and 45 s saw 10 s and 25 s
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000); // the tick at T0 + 60 s: 40 s
      expect(ws.closed).toBe(true);
      expect(noTrades(h)).toEqual(["trade feed: no trades for 40 s on a live socket, reconnecting"]);
      // the period ended when the last trade arrived (T0 + 20 s), not at the last pong (T0 + 55 s)
      expect(h.feed.uncovered(T0 + 5_000, T0 + 15_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 15_000, T0 + 20_000)).toBe(5_000);
      expect(h.feed.uncovered(T0 + 15_000, T0 + 55_000)).toBe(40_000);
      expect(h.feed.uncovered(T0 + 15_000, T0 + 60_000)).toBe(45_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
    });

    it("with no trade at all the silence counts from when the socket went live: not at 29 s, at the limit", async () => {
      const h = silent();
      const ws = await live(h); // live at T0, no trade ever
      await steps(ws, 25_000); // the tick at T0 + 15 s saw 15 s
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000); // the tick at T0 + 30 s: 30 s, at the limit
      expect(ws.closed).toBe(true);
      expect(noTrades(h)).toEqual(["trade feed: no trades for 30 s on a live socket, reconnecting"]);
      expect(h.feed.uncovered(T0, T0 + 60_000)).toBe(60_000); // nothing was watched: the period is not even kept
    });

    it("a socket that went live 5 s after it opened is dropped by the tick 40 s after that, never later than 45 s", async () => {
      const h = silent();
      const ws = await opened(h);
      await vi.advanceTimersByTimeAsync(5_000);
      for (const c of ["BTC", "ETH"]) ack(ws, c); // live at T0 + 5 s
      await steps(ws, 35_000); // T0 + 40 s: the tick at 30 s saw 25 s
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000); // the tick at T0 + 45 s: 40 s
      expect(ws.closed).toBe(true);
    });

    it("trades keep coming: no reconnect, and pauses of 25 s do not matter", async () => {
      const h = silent();
      const ws = await live(h);
      await steps(ws, 300_000, T0 + 300_000);
      for (let i = 0; i < 20; i++) {
        await steps(ws, 25_000); // 25 s of nothing ...
        ws.msg({ channel: "trades", data: [{ coin: "BTC", time: Date.now(), users: [U1, U2] }] }); // ... then one
      }
      expect(ws.closed).toBe(false);
      expect(h.sockets).toHaveLength(1);
      expect(noTrades(h)).toEqual([]);
      expect(h.feed.uncovered(T0 + 5_000, Date.now())).toBe(0);
    });

    it("maxSilenceMs null or absent: pongs alone keep the feed live, as before", async () => {
      for (const h of [harness(undefined, null), harness()]) {
        const liveAt = Date.now();
        const ws = await live(h);
        await steps(ws, 600_000, -1, readable, 5_000);
        expect(ws.closed).toBe(false);
        expect(h.sockets).toHaveLength(1);
        expect(h.logs).toEqual([]);
        expect(h.feed.uncovered(liveAt + 5_000, Date.now())).toBe(0);
        h.feed.stop();
      }
    });

    it("a period closed earlier in the silence is cut back to the last trade too", async () => {
      const h = silent();
      const ws = await live(h); // live at T0
      await steps(ws, 20_000, T0 + 20_000); // the last readable trade arrives at T0 + 20 s
      await steps(ws, 15_000); // T0 + 35 s
      ws.msg({ channel: "trades", data: [null] }); // unreadable: closes the period at T0 + 35 s and opens a new one
      await steps(ws, 25_000); // the tick at T0 + 60 s: 40 s since the last trade
      expect(ws.closed).toBe(true);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 15_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 15_000, T0 + 35_000)).toBe(20_000); // watched only up to 5 s before the last trade
    });

    it("a snapshot-only subscription trips it: the acknowledgments and one trade, then only pongs", async () => {
      const h = silent();
      const ws = await live(h);
      trade(ws, "BTC", T0 - 2_000, U1, U2); // the snapshot on subscribing, arriving at T0
      await steps(ws, 25_000);
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000);
      expect(ws.closed).toBe(true);
      expect(noTrades(h)).toHaveLength(1);
    });

    it("trades that cannot be read do not reset the clock", async () => {
      const h = silent();
      const ws = await live(h);
      const renamed = (t: number) => ({ coin: "BTC", time: t - 100, usr: [U1, U2] });
      await steps(ws, 25_000, T0 + 25_000, renamed); // one every 5 s
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000, T0 + 30_000, renamed);
      expect(ws.closed).toBe(true);
      expect(noTrades(h)).toHaveLength(1);
      expect(h.logs.filter((l) => l.startsWith("trade feed: unreadable trade"))).toHaveLength(1);
    });

    it("neither does a message whose data is not a list, and an unreadable one that moves the live period does not move the clock", async () => {
      const h = silent();
      const ws = await live(h);
      await steps(ws, 25_000);
      ws.msg({ channel: "trades", data: { trades: [readable(Date.now())] } }); // T0 + 25 s: not a list
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000); // the tick at T0 + 30 s: 30 s
      expect(ws.closed).toBe(true);
      const h2 = silent();
      const t0 = Date.now(); // the second feed starts later on the same clock
      const ws2 = await live(h2);
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws2);
      trade(ws2, "BTC", t0 + 14_000, U1, U2); // a readable trade at t0 + 15 s ...
      await vi.advanceTimersByTimeAsync(10_000);
      pong(ws2);
      ws2.msg({ channel: "trades", data: [null] }); // ... an unreadable one at t0 + 25 s: it reopens the live period at once
      await vi.advanceTimersByTimeAsync(15_000); // t0 + 40 s: the tick at 30 s saw 15 s
      pong(ws2);
      expect(ws2.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000); // the tick at t0 + 45 s: 30 s since the readable one
      expect(ws2.closed).toBe(true);
    });

    it("a readable trade among unreadable ones resets it", async () => {
      const h = silent();
      const ws = await live(h);
      await steps(ws, 25_000);
      ws.msg({ channel: "trades", data: [null, { coin: "BTC", time: Date.now(), users: [U1, U2] }] }); // T0 + 25 s
      await steps(ws, 30_000); // T0 + 55 s: the ticks at 45 s saw 20 s
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000); // the tick at T0 + 60 s: 35 s
      expect(ws.closed).toBe(true);
    });

    it("a socket that is not live yet is the watchdog's, not the silence rule's", async () => {
      const h = silent();
      const ws = await opened(h);
      ack(ws, "BTC"); // ETH is never acknowledged
      await steps(ws, 25_000); // the tick at 15 s: the rule would trip here if it applied
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000);
      expect(ws.closed).toBe(true);
      expect(h.logs.some((l) => l.includes("not live, reconnecting"))).toBe(true);
      expect(noTrades(h)).toEqual([]);
    });

    it("a new coin takes the live state away and its acknowledgment gives it back, without giving the socket a new live time", async () => {
      let list = ["BTC", "ETH"];
      const h = silent(async () => list);
      const ws = await live(h); // live at T0
      await steps(ws, 50_000, T0 + 50_000); // the last trade arrives at T0 + 50 s
      list = ["BTC", "ETH", "SOL"];
      await steps(ws, 10_000); // the read at T0 + 60 s finds SOL: not live until it is acknowledged
      expect(subs(ws)).toEqual(["BTC", "ETH", "SOL"]);
      await steps(ws, 10_000);
      ack(ws, "SOL"); // live again at T0 + 70 s
      expect(ws.closed).toBe(false);
      await steps(ws, 15_000); // T0 + 85 s: the tick at 75 s saw 25 s
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000); // the tick at T0 + 90 s: 40 s since the last trade (not 20 s since it was acknowledged)
      expect(ws.closed).toBe(true);
    });

    it("after the reconnect the clock starts afresh: neither the old socket's last trade nor its live time count", async () => {
      const h = silent();
      const ws = await live(h); // live at T0
      await steps(ws, 30_000, T0 + 30_000); // trades up to T0 + 30 s
      await steps(ws, 30_000); // the tick at T0 + 60 s: 30 s of silence
      expect(ws.closed).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      for (const c of ["BTC", "ETH"]) ack(ws2, c); // live at T0 + 61 s
      expect(Date.now()).toBe(T0 + 61_000);
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws2);
      expect(ws2.closed).toBe(false); // the tick at open + 15 s saw 15 s
      await vi.advanceTimersByTimeAsync(14_999);
      expect(ws2.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); // the tick at open + 30 s: 30 s since it went live
      expect(ws2.closed).toBe(true);
      expect(noTrades(h)).toHaveLength(2);
    });

    it("a trade on the new socket moves its clock", async () => {
      const h = silent();
      const ws = await live(h);
      await steps(ws, 30_000);
      expect(ws.closed).toBe(true); // the tick at T0 + 30 s
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      for (const c of ["BTC", "ETH"]) ack(ws2, c); // live at T0 + 31 s
      await vi.advanceTimersByTimeAsync(20_000);
      pong(ws2);
      trade(ws2, "BTC", Date.now(), U1, U2); // T0 + 51 s
      await vi.advanceTimersByTimeAsync(10_000);
      pong(ws2);
      await vi.advanceTimersByTimeAsync(15_000); // T0 + 76 s: the ticks at 61 s and 76 s saw 10 s and 25 s
      pong(ws2);
      expect(ws2.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(14_999);
      pong(ws2);
      expect(ws2.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(1); // the tick at T0 + 91 s: 40 s
      expect(ws2.closed).toBe(true);
    });

    it("a wall clock stepped back after the old socket's last trade does not hide a silent new socket", async () => {
      const h = silent();
      const ws = await live(h);
      await steps(ws, 10_000, T0 + 10_000); // the last trade arrives at T0 + 10 s
      ws.close(); // the server closes it at T0 + 10 s
      vi.setSystemTime(T0 - 100_000); // the clock is stepped back 110 s
      await vi.advanceTimersByTimeAsync(1_000);
      const ws2 = h.sockets[1];
      ws2.open();
      for (const c of ["BTC", "ETH"]) ack(ws2, c);
      await vi.advanceTimersByTimeAsync(15_000);
      pong(ws2);
      expect(ws2.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(15_000); // the tick at 30 s: 30 s since it went live
      expect(ws2.closed).toBe(true);
    });

    it("a truly silent exchange reconnects about once per interval: no faster loop", async () => {
      const h = silent();
      h.feed.start();
      await flush();
      let ws = h.sockets[0];
      const liveAt: number[] = [];
      const goLive = (s: FakeSocket) => {
        s.open();
        for (const c of ["BTC", "ETH"]) ack(s, c);
        liveAt.push(Date.now());
      };
      goLive(ws);
      for (let sec = 1; sec <= 1_200; sec++) {
        await vi.advanceTimersByTimeAsync(1_000);
        const cur = h.sockets[h.sockets.length - 1];
        if (cur !== ws) {
          ws = cur;
          goLive(ws);
        }
        if (sec % 10 === 0) pong(ws);
      }
      expect(liveAt.length).toBeGreaterThanOrEqual(1_200 / 46);
      expect(liveAt.length).toBeLessThanOrEqual(1_200 / 31 + 1);
      for (let i = 1; i < liveAt.length; i++) expect(liveAt[i] - liveAt[i - 1]).toBeGreaterThanOrEqual(31_000);
      expect(noTrades(h)).toHaveLength(liveAt.length - 1);
    });

    it("the drop moves the end of the live period, not lastHeardAt: a window the last pong covered still counts as delivered", async () => {
      const h = silent();
      const ws = await live(h); // read at T0
      await steps(ws, 60_000, T0 + 60_000, readable, 15_000); // trades up to T0 + 60 s, pongs every 15 s; the read at T0 + 60 s
      await steps(ws, 15_000, -1, readable, 15_000); // the last pong at T0 + 75 s
      await steps(ws, 5_000 * 3 - 5_000, -1, readable, 15_000); // T0 + 85 s
      expect(ws.closed).toBe(false);
      await steps(ws, 5_000, -1, readable, 15_000); // the tick at T0 + 90 s: 30 s since the last trade
      expect(ws.closed).toBe(true);
      expect(h.feed.uncovered(T0 + 5_000, T0 + 55_000)).toBe(0);
      expect(h.feed.uncovered(T0 + 55_000, T0 + 75_000)).toBe(20_000); // the pongs of 75 s were not watching trades
      expect(h.feed.deliveredPast(T0 + 58_000)).toBe(true); // heard at T0 + 75 s >= 58 s + 5 s, and the read of T0 + 60 s started after 58 s
    });
  });

  describe("stop", () => {
    it("closes the socket and clears the timers: no more pings, reads or reconnects", async () => {
      const h = harness();
      const ws = await live(h);
      h.feed.stop();
      expect(ws.closed).toBe(true);
      const sent = ws.sent.length;
      await vi.advanceTimersByTimeAsync(600_000);
      expect(ws.sent).toHaveLength(sent);
      expect(h.sockets).toHaveLength(1);
      expect(h.coins).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
    it("while a reconnect is waiting, it cancels it", async () => {
      const h = harness();
      const ws = await live(h);
      ws.close();
      h.feed.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(h.sockets).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
    it("while the first coins() read is pending, nothing is opened", async () => {
      const h = harness();
      h.feed.start();
      h.feed.stop();
      await flush();
      expect(h.sockets).toHaveLength(0);
    });
    it("while a read from deliveredPast is in flight, nothing is subscribed afterwards", async () => {
      let list = ["BTC", "ETH"];
      const h = harness(() => new Promise((r) => setTimeout(() => r([...list, "SOL"]), 3_000)));
      h.coins.mockImplementationOnce(async () => list);
      const ws = await live(h);
      await alive(ws, 30_000);
      expect(h.feed.deliveredPast(T0 + 10_000)).toBe(false); // starts the slow read
      h.feed.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(subs(ws)).toEqual(["BTC", "ETH"]);
    });
  });
});

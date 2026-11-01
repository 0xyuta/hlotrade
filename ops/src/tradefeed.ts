/**
 * Hyperliquid's public `trades` feed: which wallets traded (both sides of every trade, any wallet: one may register just
 * after its first trade), and whether we were watching. Spec 2026-10-31 §4. Nothing is stored on disk: a restart is a gap.
 * Coverage is measured on the wall clock with a 5 s margin, the one exception to "now is chain time".
 */

/** What the poster and the verifier use. */
export interface ActiveWallets {
  /** Lowercase users whose last trade is at or after `ms`: a superset of who traded in a window, which is safe. */
  usersSince(ms: number): string[];
  prune(ms: number): void;
  /** How many ms of [fromMs, toMs] were not live. Ask again after `deliveredPast(toMs)` turns true: a coin found by the read it waits for cuts coverage back. */
  uncovered(fromMs: number, toMs: number): number;
  /**
   * Nothing older than `ms` is still on the way, and no coin listed before `ms` is unwatched: a message of any kind was
   * heard at or after the margin past `ms` (or a trade timed more than that late), and a `meta` read that started after `ms` found
   * nothing it was not subscribed to (a new coin's cut is made before this turns true). When only the read is missing this
   * starts one, if none is in flight.
   */
  deliveredPast(ms: number): boolean;
  /**
   * The owner has made its list for the minute ending at `ms` and starts reading: from here a trade at or before `ms` is
   * late (it is on no list), counts in `lateTrades` and is given by `takeLate`.
   */
  setCovered(ms: number): void;
  /** The wallets (lowercase, both sides) of the trades counted in `lateTrades` since the last call. Empties the set. */
  takeLate(): string[];
  readonly lateTrades: number;
}

export interface FeedSocket {
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export interface TradeFeedDeps {
  url: string;
  coins(): Promise<string[]>;
  connect?(url: string): FeedSocket;
  log(s: string): void;
  /**
   * A live socket that has delivered no readable trade for this long is dropped and reconnected, though pongs keep coming
   * (the exchange may have silently dropped the subscriptions). Null or absent: no rule, the right choice for a quiet market.
   */
  maxSilenceMs?: number | null;
}

const MARGIN_MS = 5_000;
const PING_MS = 15_000;
const PONG_TIMEOUT_MS = 30_000;
/** A healthy socket delivers something at least every 15 s (the pong): quieter than this and it is not counted as watching. */
const HEARD_MS = 20_000;
/** `meta` is read about this often (checked on the ping tick), and sooner when `deliveredPast` is waiting for a read. */
const META_MS = 60_000;
/** After a failed read, `deliveredPast` waits this long before starting another. */
const META_RETRY_MS = 5_000;
/** Without a successful read for this long a new coin cannot be ruled out: no period, open or closed, counts past the last good read. */
const META_STALE_MS = 180_000;
/** A socket not live this long after it was created, or after a new coin was subscribed, is dropped and reconnected. */
const NOT_LIVE_MS = 30_000;
const BACKOFF_MAX_MS = 30_000;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

export class TradeFeed implements ActiveWallets {
  private readonly seen = new Map<string, number>();
  /** Closed live periods [from, to], wall-clock ms. */
  private periods: [number, number][] = [];
  private liveSince: number | null = null;
  /** When the connection was last acknowledged in full: the lower bound for `lateTrades` (a quiet spell moves `liveSince`, not this). */
  private ackedAt = 0;
  private ws: FeedSocket | null = null;
  private coinList: string[] = [];
  private acked = new Set<string>();
  private lastTrade = -1;
  private lastPongAt = -1;
  /** When a readable trade last arrived on the current socket (-1: none yet). Unreadable ones do not count. For the silence rule only. */
  private lastTradeAt = -1;
  /** When the current socket first went live (-1: not yet). The silence rule counts from the newer of this and `lastTradeAt`. */
  private socketLiveAt = -1;
  /** When a socket last delivered anything at all, of any kind: the last moment it is known to have been alive. Not reset by a new socket. */
  private lastHeardAt = 0;
  private pongDeadlineFrom = 0;
  /** When the newest successful `meta` read started: the coin list was complete as of then. */
  private metaOkAt = 0;
  /** When the newest read, successful or not, started. */
  private metaTryAt = 0;
  private metaFailedAt = 0;
  private metaBusy = false;
  private unreadableLogged = false;
  private covered = -1;
  /** Both sides of the trades counted in `lateTrades` that `takeLate` has not given yet. */
  private readonly lateUsers = new Set<string>();
  private backoffMs = 1_000;
  private stopped = true;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private liveTimer: ReturnType<typeof setTimeout> | null = null;
  lateTrades = 0;

  constructor(private readonly d: TradeFeedDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.dropSocket();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  usersSince(ms: number): string[] {
    const out: string[] = [];
    for (const [u, t] of this.seen) if (t >= ms) out.push(u);
    return out;
  }

  prune(ms: number): void {
    for (const [u, t] of this.seen) if (t < ms) this.seen.delete(u);
    this.periods = this.periods.filter(([, to]) => to >= ms - MARGIN_MS);
  }

  uncovered(fromMs: number, toMs: number): number {
    if (toMs <= fromMs) return 0;
    const now = Date.now();
    // With no good `meta` read for 3 minutes a new coin cannot be ruled out: nothing after the last good read counts as
    // watched, in any period, closed or open (the owner then takes its wider reads instead of waiting for a read that
    // does not come). It is not stored, so a good read that shows nothing new restores it.
    const limit = now - this.metaOkAt > META_STALE_MS ? this.metaOkAt - MARGIN_MS : Infinity;
    // A period is watched from 5 s after it began; a closed one until 5 s before it ended.
    const spans: [number, number][] = this.periods.map(([a, b]) => [a + MARGIN_MS, Math.min(b - MARGIN_MS, limit)]);
    if (this.liveSince !== null) {
      // The open one has no end yet ("now" is not a gap; if it closes, the margin is applied back from then), unless the
      // socket has gone quiet: then it ended at the last sign of life.
      const end = now - this.lastHeardAt > HEARD_MS ? this.lastHeardAt : Infinity;
      spans.push([this.liveSince + MARGIN_MS, Math.min(end - MARGIN_MS, limit)]);
    }
    spans.sort((x, y) => x[0] - y[0]);
    let watched = 0;
    let reached = fromMs;
    for (const [a, b] of spans) {
      const lo = Math.max(a, reached);
      const hi = Math.min(b, toMs);
      if (hi > lo) {
        watched += hi - lo;
        reached = hi;
      }
    }
    return toMs - fromMs - watched;
  }

  deliveredPast(ms: number): boolean {
    // Heard at or after ms + 5 s: a period ends 5 s before its last message, so a window covered through it is delivered too.
    if (this.lastTrade <= ms + MARGIN_MS && this.lastHeardAt < ms + MARGIN_MS) return false;
    if (this.metaOkAt > ms) return true;
    this.startMetaRead();
    return false;
  }

  setCovered(ms: number): void {
    if (ms > this.covered) this.covered = ms;
  }

  takeLate(): string[] {
    const out = [...this.lateUsers];
    this.lateUsers.clear();
    return out;
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      // The time of a read is when its request began: the list was complete as of then, not as of the answer.
      const readAt = Date.now();
      this.metaTryAt = readAt;
      const coins = await this.d.coins();
      if (this.stopped) return;
      // A coin listed since the previous read was not subscribed by the connection that has just ended, so that
      // connection is trusted only up to that read.
      const known = new Set(this.coinList);
      if (known.size > 0 && coins.some((c) => !known.has(c))) this.cutBack(this.metaOkAt);
      this.coinList = coins;
      this.metaOkAt = readAt;
      const ws = (this.d.connect ?? ((u: string) => new WebSocket(u) as unknown as FeedSocket))(this.d.url);
      this.ws = ws;
      this.acked = new Set();
      this.unreadableLogged = false;
      this.lastTradeAt = -1;
      this.socketLiveAt = -1;
      this.watchLive(ws);
      ws.onopen = () => {
        if (this.ws !== ws) return;
        for (const coin of this.coinList) if (!this.subscribe(ws, coin)) return;
        this.pongDeadlineFrom = Date.now();
        this.pingTimer = setInterval(() => this.ping(ws), PING_MS);
      };
      ws.onmessage = (e) => {
        if (this.ws === ws) this.onMessage(e.data);
      };
      ws.onclose = () => {
        if (this.ws === ws) this.lost("closed");
      };
      ws.onerror = () => {
        if (this.ws === ws) this.lost("error");
      };
    } catch (e) {
      this.d.log(`trade feed: ${(e as Error).message}`);
      this.retry();
    }
  }

  private subscribe(ws: FeedSocket, coin: string): boolean {
    return this.send(ws, { method: "subscribe", subscription: { type: "trades", coin } });
  }

  /** False (and the connection dropped) when the socket refused the message. */
  private send(ws: FeedSocket, msg: unknown): boolean {
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (e) {
      this.lost(`send failed: ${(e as Error).message}`);
      return false;
    }
  }

  private ping(ws: FeedSocket) {
    if (this.ws !== ws) return;
    const now = Date.now();
    if (now - Math.max(this.lastPongAt, this.pongDeadlineFrom) >= PONG_TIMEOUT_MS) {
      this.d.log("trade feed: no pong, reconnecting");
      this.lost("no pong");
      return;
    }
    // Pongs prove the socket is up, not that the subscriptions still deliver. Only on a live socket: one that is not live
    // is the watchdog's. The period ends when the last trade arrived: the seconds since were not watched.
    const maxSilence = this.d.maxSilenceMs ?? null;
    if (maxSilence !== null && this.liveSince !== null) {
      const since = Math.max(this.lastTradeAt, this.socketLiveAt);
      if (now - since >= maxSilence) {
        this.d.log(`trade feed: no trades for ${Math.round((now - since) / 1000)} s on a live socket, reconnecting`);
        this.cutBack(since); // closed periods too: a stretch closed earlier in the silence was not watched either
        this.lost("no trades");
        return;
      }
    }
    if (!this.send(ws, { method: "ping" })) return;
    if (Date.now() - this.metaTryAt >= META_MS) this.startMetaRead();
  }

  /**
   * A socket that is not live (every subscription acknowledged) within NOT_LIVE_MS is dropped: a subscription that is
   * refused or never answered would otherwise keep the feed down for as long as the socket stays up. Armed when the
   * socket is created and at each new subscribe; the backoff does not reset until the feed is live.
   */
  private watchLive(ws: FeedSocket) {
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      this.liveTimer = null;
      if (this.ws === ws && this.liveSince === null) {
        this.d.log("trade feed: not live, reconnecting");
        this.lost("not live");
      }
    }, NOT_LIVE_MS);
  }

  /**
   * Drops the socket. Its live period ends at the last message it delivered, never later: that is all that is known.
   * `lastHeardAt` itself stays: a closed socket's last message still counts for `deliveredPast`.
   */
  private dropSocket() {
    this.endLive(this.lastHeardAt);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.liveTimer) clearTimeout(this.liveTimer);
    this.liveTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  /** A period of 10 s or less is not kept: the margins on both ends leave it no coverage (and a renamed trade field would make one per message). */
  private endLive(at: number) {
    if (this.liveSince !== null && at - this.liveSince > 2 * MARGIN_MS) this.periods.push([this.liveSince, at]);
    this.liveSince = null;
  }

  /** The stretch after `from` was not watched, but the socket is delivering again: the open period ends there and a new one starts now. */
  private reopen(from: number) {
    if (this.liveSince === null) return;
    this.endLive(from);
    this.liveSince = Date.now();
  }

  /** Nothing after `at` counts as watched any more: the open period ends there, and closed ones are cut. */
  private cutBack(at: number) {
    this.endLive(at);
    this.periods = this.periods.map(([a, b]): [number, number] => [a, Math.min(b, at)]).filter(([a, b]) => b > a);
  }

  private lost(why: string) {
    this.d.log(`trade feed: connection lost (${why})`);
    this.dropSocket();
    this.retry();
  }

  private retry() {
    if (this.stopped) return;
    const wait = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS);
    const t = setTimeout(() => {
      this.timers.delete(t);
      void this.connect();
    }, wait);
    this.timers.add(t);
  }

  /** Starts a `meta` read for the current socket, unless one is in flight or one failed a moment ago. */
  private startMetaRead() {
    const ws = this.ws;
    if (!ws || this.metaBusy || Date.now() - this.metaFailedAt < META_RETRY_MS) return;
    void this.refreshCoins(ws);
  }

  private async refreshCoins(ws: FeedSocket): Promise<void> {
    this.metaBusy = true;
    const readAt = Date.now();
    this.metaTryAt = readAt;
    try {
      let coins: string[];
      try {
        coins = await this.d.coins();
      } catch (e) {
        this.metaFailedAt = Date.now();
        this.d.log(`trade feed: meta read failed: ${(e as Error).message}`);
        return;
      }
      if (this.ws !== ws) return;
      const known = new Set(this.coinList);
      const fresh = coins.filter((c) => !known.has(c));
      if (fresh.length > 0) {
        // We were not watching these since at least the previous read: a gap, until they are acknowledged.
        this.cutBack(this.metaOkAt);
        this.coinList = [...this.coinList, ...fresh];
        this.d.log(`trade feed: new coins ${fresh.join(",")}`);
      }
      this.metaOkAt = readAt;
      if (fresh.length > 0) {
        this.watchLive(ws);
        for (const c of fresh) if (!this.subscribe(ws, c)) return;
      }
    } finally {
      this.metaBusy = false;
    }
  }

  private onMessage(raw: unknown) {
    const now = Date.now();
    // Quiet for longer than a healthy socket ever is, and then delivering again: the quiet stretch was not watched.
    if (now - this.lastHeardAt > HEARD_MS) this.reopen(this.lastHeardAt);
    this.lastHeardAt = now;
    let j: unknown;
    try {
      j = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (!isObj(j)) return;
    if (j.channel === "pong") {
      this.lastPongAt = now;
    } else if (j.channel === "subscriptionResponse") {
      const sub = isObj(j.data) && isObj(j.data.subscription) ? j.data.subscription : null;
      if (sub && sub.type === "trades" && typeof sub.coin === "string") this.acked.add(sub.coin);
      if (this.liveSince === null && this.coinList.length > 0 && this.coinList.every((c) => this.acked.has(c))) {
        this.liveSince = now;
        this.ackedAt = now;
        if (this.socketLiveAt < 0) this.socketLiveAt = now;
        this.backoffMs = 1_000;
        if (this.liveTimer) clearTimeout(this.liveTimer);
        this.liveTimer = null;
      }
    } else if (j.channel === "trades") {
      if (!Array.isArray(j.data)) this.unreadable(j.data);
      else for (const t of j.data) if (!this.onTrade(t)) this.unreadable(t);
    } else if (j.channel === "error") {
      this.d.log(`trade feed: ${(typeof j.data === "string" ? j.data : JSON.stringify(j.data) ?? "").slice(0, 200)}`);
    }
  }

  /** A trade message we cannot read means we may not be seeing trades at all (a renamed field, say) while pongs keep coming: a gap. */
  private unreadable(entry: unknown) {
    if (!this.unreadableLogged) {
      this.unreadableLogged = true;
      this.d.log(`trade feed: unreadable trade ${String(JSON.stringify(entry)).slice(0, 150)}`);
    }
    this.reopen(Date.now());
  }

  /** False when the entry is not a readable trade. */
  private onTrade(t: unknown): boolean {
    if (!isObj(t) || typeof t.time !== "number" || !Number.isFinite(t.time) || !Array.isArray(t.users) || t.users.length !== 2) return false;
    if (!t.users.every((u) => typeof u === "string")) return false;
    this.lastTradeAt = Date.now();
    const late = this.liveSince !== null && t.time >= this.ackedAt && t.time <= this.covered;
    if (late) this.lateTrades++;
    for (const u of t.users as string[]) {
      const k = u.toLowerCase();
      if ((this.seen.get(k) ?? -1) < t.time) this.seen.set(k, t.time);
      if (late) this.lateUsers.add(k);
    }
    // One far-future time must not make `deliveredPast` true for the life of the process.
    if (t.time > this.lastTrade && t.time <= Date.now() + MARGIN_MS) this.lastTrade = t.time;
    return true;
  }
}

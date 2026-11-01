import { describe, expect, it } from "vitest";
import { hasPendingRoom, isFinalNotSent, loadPending, NOT_SENT_FINAL_MS, parseIrisMessage, PendingFullError, pendingKey, savePending, settleByBalance, settleCctp, SOLANA_EXPIRED_NOTE, SOLANA_FAILED_NOTE, upsertPending, withdrawMarks, type Pending } from "../src/routes/pending";

const USER = "0x00000000000000000000000000000000000000AA";
const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};
const p = (o: Partial<Pending> = {}): Pending => ({ id: "a", dir: "deposit", route: "arbitrum", amount: "10000000", startedAt: 1_000, status: "pending", ...o });

describe("pending transfers (localStorage)", () => {
  it("key includes network and lowercase user", () => {
    expect(pendingKey("testnet", USER)).toBe("hlo:pending:testnet:0x00000000000000000000000000000000000000aa");
  });
  it("round-trips, keeps pending ones first, drops done ones after 7 days, at most 20 in all", () => {
    const kv = mem();
    const now = 10 * 86_400_000;
    const list = [p({ id: "old-done", status: "done", startedAt: 1 }), p({ id: "live" }), ...Array.from({ length: 25 }, (_, i) => p({ id: `d${i}`, status: "done", startedAt: now - i }))];
    savePending(kv, "testnet", USER, list, now);
    const back = loadPending(kv, "testnet", USER);
    expect(back.some((x) => x.id === "live")).toBe(true);
    expect(back.some((x) => x.id === "old-done")).toBe(false);
    expect(back.length).toBe(20);
  });
  it("never holds more than 20; a pending one over 7 days old makes room, newer pending ones stay (review M2)", () => {
    const kv = mem();
    const now = 100 * 86_400_000;
    const young = Array.from({ length: 20 }, (_, i) => p({ id: `y${i}`, startedAt: now - 1_000 - i }));
    savePending(kv, "testnet", USER, [...young, p({ id: "stale", startedAt: now - 8 * 86_400_000 })], now);
    const back = loadPending(kv, "testnet", USER);
    expect(back.length).toBe(20);
    expect(back.some((x) => x.id === "stale")).toBe(false);
    expect(back.every((x) => x.id.startsWith("y"))).toBe(true);
  });
  it("upsert makes room: finished first, then a stale pending one, else refuses (review M2)", () => {
    const now = 100 * 86_400_000;
    const full = Array.from({ length: 20 }, (_, i) => p({ id: `y${i}`, startedAt: now - 1_000 - i }));
    expect(() => upsertPending(full, p({ id: "new", startedAt: now }), now)).toThrow(PendingFullError);
    expect(() => upsertPending(full, p({ id: "new", startedAt: now }), now)).toThrow(/Too many transfers/);
    const withDone = [...full.slice(1), p({ id: "d", status: "done", startedAt: now - 5 })];
    expect(upsertPending(withDone, p({ id: "new", startedAt: now }), now).map((x) => x.id)).not.toContain("d");
    const withStale = [...full.slice(1), p({ id: "stale", startedAt: now - 9 * 86_400_000 })];
    const r = upsertPending(withStale, p({ id: "new", startedAt: now }), now);
    expect(r.length).toBe(20);
    expect(r.map((x) => x.id)).not.toContain("stale");
    expect(r[0].id).toBe("new");
    // replacing an existing id never grows the list, so it works even when full
    expect(upsertPending(full, { ...full[3], status: "done" }, now).length).toBe(20);
  });
  it("hasPendingRoom agrees with upsertPending for a new entry (fix round 2)", () => {
    const now = 100 * 86_400_000;
    const young = (n: number) => Array.from({ length: n }, (_, i) => p({ id: `y${i}`, startedAt: now - 1_000 - i }));
    const cases: Pending[][] = [
      [],
      young(19),
      young(20), // full of young pending: no room
      [...young(19), p({ id: "stale", startedAt: now - 8 * 86_400_000 })], // a stale pending one makes room
      [...young(19), p({ id: "d", status: "done", startedAt: now - 5 })], // a finished one makes room
      [...young(19), p({ id: "edge", startedAt: now - 7 * 86_400_000 + 1 })], // just under 7 days: not stale
      Array.from({ length: 25 }, (_, i) => p({ id: `d${i}`, status: "done", startedAt: now - i })),
    ];
    for (const list of cases) {
      let threw = false;
      try {
        upsertPending(list, p({ id: "new", startedAt: now }), now);
      } catch (e) {
        threw = e instanceof PendingFullError;
      }
      expect(hasPendingRoom(list, now)).toBe(!threw);
    }
    expect(hasPendingRoom(young(20), now)).toBe(false);
    expect(hasPendingRoom(cases[3], now)).toBe(true);
    expect(hasPendingRoom([], now)).toBe(true);
  });
  it("final 'not sent' Solana deposits give way to a new transfer; younger or undecided ones do not (final review M2)", () => {
    const now = 100 * 86_400_000;
    const sol = (i: number, o: Partial<Pending>) => p({ id: `s${i}`, route: "solana", srcDomain: 5, startedAt: now - 1_000 - i, ...o });
    // a failed status is final at once
    const failed = Array.from({ length: 20 }, (_, i) => sol(i, { note: SOLANA_FAILED_NOTE }));
    expect(hasPendingRoom(failed, now)).toBe(true);
    const next = upsertPending(failed, p({ id: "new", startedAt: now }), now);
    expect(next.length).toBe(20);
    expect(next[0].id).toBe("new");
    // expired or refused: final only once NOT_SENT_FINAL_MS has passed (landing could still disprove it before)
    const expired = Array.from({ length: 20 }, (_, i) => sol(i, { note: SOLANA_EXPIRED_NOTE }));
    expect(hasPendingRoom(expired, now)).toBe(false);
    const old = expired.map((x) => ({ ...x, startedAt: now - NOT_SENT_FINAL_MS - 1 }));
    expect(hasPendingRoom(old, now)).toBe(true);
    // a watched or unconfirmed record never gives way, nor an EVM record whatever its note says
    expect(hasPendingRoom(Array.from({ length: 20 }, (_, i) => sol(i, { note: "unconfirmed: watching the Solana transaction", startedAt: 0 + now - NOT_SENT_FINAL_MS - 1 })), now)).toBe(false);
    expect(hasPendingRoom(Array.from({ length: 20 }, (_, i) => p({ id: `e${i}`, startedAt: now - NOT_SENT_FINAL_MS - 1, note: SOLANA_FAILED_NOTE })), now)).toBe(false);
  });
  it("isFinalNotSent", () => {
    const now = 10 * 86_400_000;
    const s = (o: Partial<Pending>) => p({ route: "solana", srcDomain: 5, startedAt: now, ...o });
    expect(isFinalNotSent(s({ note: SOLANA_FAILED_NOTE }), now)).toBe(true);
    expect(isFinalNotSent(s({ note: SOLANA_EXPIRED_NOTE }), now)).toBe(false);
    expect(isFinalNotSent(s({ note: SOLANA_EXPIRED_NOTE }), now + NOT_SENT_FINAL_MS + 1)).toBe(true);
    expect(isFinalNotSent(s({ note: "not sent: Solana refused it (x)" }), now + NOT_SENT_FINAL_MS + 1)).toBe(true);
    expect(isFinalNotSent(s({ note: SOLANA_FAILED_NOTE, status: "done" }), now)).toBe(false);
    expect(isFinalNotSent(s({ note: undefined }), now + NOT_SENT_FINAL_MS + 1)).toBe(false);
    expect(isFinalNotSent(p({ note: SOLANA_FAILED_NOTE }), now)).toBe(false); // an EVM route
  });
  it("hasPendingRoom changes nothing and never throws (fix round 2)", () => {
    const now = 100 * 86_400_000;
    const full = Array.from({ length: 20 }, (_, i) => p({ id: `y${i}`, startedAt: now - 1_000 - i }));
    const before = JSON.stringify(full);
    expect(() => hasPendingRoom(full, now)).not.toThrow();
    expect(JSON.stringify(full)).toBe(before);
  });
  it("sorts newest first when saving", () => {
    const kv = mem();
    savePending(kv, "testnet", USER, [p({ id: "a", startedAt: 1 }), p({ id: "c", startedAt: 3 }), p({ id: "b", startedAt: 2 })], 10);
    expect(loadPending(kv, "testnet", USER).map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
  it("storage that throws is survived on both sides (review M6)", () => {
    const bad = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } };
    expect(loadPending(bad, "testnet", USER)).toEqual([]);
    expect(() => savePending(bad, "testnet", USER, [p()], 2_000)).not.toThrow();
  });
  it("drops records that would crash later code (review I3)", () => {
    const kv = mem();
    const key = pendingKey("testnet", USER);
    const load = (v: unknown) => {
      kv.setItem(key, JSON.stringify(v));
      return loadPending(kv, "testnet", USER);
    };
    expect(load(null)).toEqual([]);
    expect(load({})).toEqual([]);
    expect(load([null, 1, "x", {}])).toEqual([]);
    expect(load([{ id: "a", amount: "abc", startedAt: 1 }])).toEqual([]);
    expect(load([p({ amount: "abc" })])).toEqual([]);
    expect(load([p({ amount: "1.5" })])).toEqual([]);
    expect(load([p({ amount: "-1" })])).toEqual([]);
    expect(load([p({ baseline: "1.5", minArrive: "1" })])).toEqual([]);
    expect(load([p({ baseline: "1", minArrive: "x" })])).toEqual([]);
    expect(load([p({ status: "weird" as never })])).toEqual([]);
    expect(load([p({ dir: "sideways" as never })])).toEqual([]);
    expect(load([p({ route: "robinhood" as never })])).toEqual([]);
    expect(load([p({ balanceKind: "base" as never })])).toEqual([]);
    expect(load([p({ lastValid: "12.5" })])).toEqual([]);
    expect(load([{ ...p(), startedAt: "1" }])).toEqual([]);
    expect(load([p({ baseline: "5", minArrive: "9" }), p({ id: "b" })]).length).toBe(2);
  });
  it("Solana records (Plan 4 C): a deposit with its signature and last valid height, a withdrawal watching a token account", () => {
    const kv = mem();
    const SIG = "5".repeat(88);
    const ATA = "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M";
    const dep = p({ id: SIG, route: "solana", srcDomain: 5, txHash: SIG, lastValid: "312345678" });
    const wd = p({ id: "w-1", dir: "withdraw", route: "solana", balanceKind: "solana", watch: ATA, baseline: "0", minArrive: "1000000" });
    kv.setItem(pendingKey("testnet", USER), JSON.stringify([dep, wd]));
    expect(loadPending(kv, "testnet", USER)).toEqual([dep, wd]);
    // a Solana watch without a valid base58 token account is refused (it could never settle)
    for (const bad of [{ watch: undefined }, { watch: "0x00000000000000000000000000000000000000aa" }, { watch: "0OIl".repeat(10) }]) {
      kv.setItem(pendingKey("testnet", USER), JSON.stringify([{ ...wd, ...bad }]));
      expect(loadPending(kv, "testnet", USER)).toEqual([]);
    }
  });
  it("Solana deposits keep the event account's address; a deposit with no signature is kept by it; a bad one is refused", () => {
    const kv = mem();
    const EVENT = "A37BHqE1TkVJVdFu5FGzYezD6vxgG5FNHa1dHsV6NU6M";
    const dep = p({ id: "s-1", route: "solana", srcDomain: 5, lastValid: "312345678", eventAccount: EVENT, note: "unconfirmed: x" });
    kv.setItem(pendingKey("testnet", USER), JSON.stringify([dep]));
    expect(loadPending(kv, "testnet", USER)).toEqual([dep]);
    for (const eventAccount of [7, "0x00000000000000000000000000000000000000aa", "0OIl".repeat(10)]) {
      kv.setItem(pendingKey("testnet", USER), JSON.stringify([{ ...dep, eventAccount }]));
      expect(loadPending(kv, "testnet", USER)).toEqual([]);
    }
  });
  it("ignores garbage", () => {
    const kv = mem();
    kv.setItem(pendingKey("testnet", USER), "{nope");
    expect(loadPending(kv, "testnet", USER)).toEqual([]);
  });
  it("upsert replaces by id and puts the newest first", () => {
    expect(upsertPending([p({ id: "x" }), p({ id: "y" })], p({ id: "y", status: "done" })).map((x) => [x.id, x.status])).toEqual([["y", "done"], ["x", "pending"]]);
  });
});

describe("withdrawMarks (the arrival rule shared by EVM and Solana withdrawals; Task 11-12 review minor)", () => {
  it("counts what is sure to arrive, never less than 0.01 USDC unless the amount is smaller", () => {
    expect(withdrawMarks(2_000_000n, 1_500_000n, 0n, 0n).minArrive).toBe(1_500_000n);
    expect(withdrawMarks(2_000_000n, 5_000n, 0n, 0n).minArrive).toBe(10_000n);
    expect(withdrawMarks(8_000n, -10n, 0n, 0n).minArrive).toBe(8_000n);
  });
  it("starts from the higher of the balance and an earlier pending withdrawal's mark", () => {
    expect(withdrawMarks(1n, 1n, 7n, 9n).start).toBe(9n);
    expect(withdrawMarks(1n, 1n, 9n, 7n).start).toBe(9n);
    expect(withdrawMarks(1n, 1n, 5n, 0n).start).toBe(5n);
  });
});

describe("settling", () => {
  it("a CCTP deposit is done when Circle reports forwardTxHash [R §2.5]", () => {
    const m = parseIrisMessage({ messages: [{ status: "complete", forwardTxHash: "0xabc", delayReason: null }] });
    expect(settleCctp(p(), m, 2_000).status).toBe("done");
    expect(settleCctp(p(), parseIrisMessage({ messages: [{ status: "pending_confirmations" }] }), 2_000).status).toBe("pending");
    expect(settleCctp(p(), parseIrisMessage({ messages: [{ status: "pending_confirmations", delayReason: "insufficient_fee" }] }), 2_000).note).toContain("insufficient_fee");
    expect(settleCctp(p(), null, 1_000 + 31 * 60_000).note).toContain("longer than expected");
  });
  it("a finished record never changes again, and a stale delay note clears (review M3)", () => {
    const done = p({ status: "done" });
    expect(settleCctp(done, null, 1_000 + 99 * 60_000)).toBe(done);
    const doneW = { ...done, baseline: "1", minArrive: "1" };
    expect(settleByBalance(doneW, 0n)).toBe(doneW);
    const delayed = settleCctp(p(), parseIrisMessage({ messages: [{ status: "pending_confirmations", delayReason: "insufficient_fee" }] }), 2_000);
    expect(delayed.note).toContain("insufficient_fee");
    const cleared = settleCctp(delayed, parseIrisMessage({ messages: [{ status: "pending_confirmations" }] }), 3_000);
    expect(cleared.note).toBeUndefined();
    expect(cleared.status).toBe("pending");
  });
  it("notes carry no research citations or contract names (review M1)", () => {
    expect(settleCctp(p(), null, 1_000 + 31 * 60_000).note).not.toMatch(/\[R|§|mintAndForward/);
  });
  it("a withdrawal is done when the destination balance grew by at least minArrive", () => {
    const w = p({ dir: "withdraw", baseline: "5000000", minArrive: "9800000" });
    expect(settleByBalance(w, 14_700_000n).status).toBe("pending");
    expect(settleByBalance(w, 14_800_000n).status).toBe("done");
  });
  it("parseIrisMessage is null for an empty answer", () => {
    expect(parseIrisMessage({ messages: [] })).toBeNull();
    expect(parseIrisMessage("x")).toBeNull();
  });

  it("an 'unconfirmed' note stays while Iris shows nothing, even past 30 minutes, and clears once Iris shows the message", () => {
    const u = p({ note: "unconfirmed: watching the transaction", startedAt: 0 });
    expect(settleCctp(u, null, 10_000)).toBe(u);
    expect(settleCctp(u, null, 40 * 60_000)).toBe(u);
    expect(settleCctp({ ...u, startedAt: 9_000 }, { status: "pending_confirmations", delayReason: null, forwardTxHash: null }, 10_000).note).toBeUndefined();
    expect(settleCctp(u, { status: "complete", delayReason: null, forwardTxHash: "0xfeed" }, 10_000).status).toBe("done");
  });
});

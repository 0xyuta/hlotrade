import { countedFee, parseTableCsv, tableCsv } from "@hlo/calc";
import { describe, expect, it } from "vitest";
import type { Fill } from "../src/hl/account";
import type { LatestPop } from "../src/rewards/files";
import {
  checkedMinutes,
  countedFeeUnits,
  feeTable,
  lastEndedMinute,
  latenessMinutes,
  minuteRows,
  minuteStatus,
  paceText,
  popRows,
  tradeRows,
  type MinuteTables,
} from "../src/rewards/explore";

const LAUNCH = 1_000_000;
const ME = "0x517b22f40b1b9bebf1776fa9d732e2c27fdeb590";
const OTHER = "0x00000000000000000000000000000000000000bb";
const at = (minute: number, sec = 5) => (LAUNCH + minute * 60 + sec) * 1000;
let tid = 0;
const fill = (minute: number, builderFee: number, over: Partial<Fill> = {}): Fill => ({
  coin: "BTC", px: 100_000, sz: builderFee / 100, side: "B", time: at(minute), dir: "Open Long", closedPnl: 0, fee: builderFee, builderFee, oid: 1, tid: ++tid, ...over,
});
const tables = (entries: [number, [string, bigint][]][]): MinuteTables => new Map(entries.map(([m, rows]) => [m, new Map(rows)]));

describe("the clock", () => {
  it("the last ended minute comes from chain time: minute m ends at launch + 60(m + 1)", () => {
    expect(lastEndedMinute(LAUNCH + 59, LAUNCH)).toBe(-1);
    expect(lastEndedMinute(LAUNCH + 60, LAUNCH)).toBe(0);
    expect(lastEndedMinute(LAUNCH + 119, LAUNCH)).toBe(0);
    expect(lastEndedMinute(LAUNCH - 500, LAUNCH)).toBe(-1);
  });
  it("lateness is the ended minutes with no published checkpoint, never below 0", () => {
    expect(latenessMinutes(9, 9)).toBe(0);
    expect(latenessMinutes(9, 12)).toBe(0); // a block that lags the file
    expect(latenessMinutes(9, 2)).toBe(7);
    expect(latenessMinutes(3, null)).toBe(4);
  });
  it("one minute behind is on time: the newest minute is always just being counted", () => {
    expect(paceText(0)).toBe("On time");
    expect(paceText(1)).toBe("On time");
    expect(paceText(2)).toBe("Running 2 minutes late");
    expect(paceText(70)).toBe("Running 70 minutes late");
  });
});

describe("a minute's status", () => {
  it("pending, then counted, then on chain", () => {
    expect(minuteStatus(10, 9, 5)).toBe("pending");
    expect(minuteStatus(9, 9, 5)).toBe("counted");
    expect(minuteStatus(5, 9, 5)).toBe("onchain");
    expect(minuteStatus(4, 9, 5)).toBe("onchain");
  });
  it("with nothing published or settled every minute is pending", () => expect(minuteStatus(0, null, null)).toBe("pending"));
  it("a settled minute is on chain even when the file lags it", () => expect(minuteStatus(9, 7, 9)).toBe("onchain"));
});

describe("feeTable", () => {
  it("reads what calc writes, one minute's rows", () => {
    const csv = tableCsv([{ minute: 7, user: ME as `0x${string}`, fee: 5n }, { minute: 8, user: OTHER as `0x${string}`, fee: 7n }, { minute: 8, user: ME as `0x${string}`, fee: 6n }]);
    expect(parseTableCsv(csv)).toHaveLength(3);
    expect(feeTable(csv, 7)).toEqual(new Map([[ME, 5n]]));
    expect(feeTable(csv, 8)).toEqual(new Map([[OTHER, 7n], [ME, 6n]]));
    expect(feeTable(csv, 9)).toEqual(new Map());
    expect(feeTable(tableCsv([]), 9)).toEqual(new Map());
  });
  it.each(["", "nope", "minute,user,fee\n1,0xabc,5", "minute,user,fee\n1,0x00000000000000000000000000000000000000bb,-5", `minute,user,fee\n1,${OTHER},${"9".repeat(40)}`])("refuses %j", (csv) => {
    expect(feeTable(csv, 1)).toBeNull();
  });
});

describe("minuteRows", () => {
  it("newest first, totals of the known tables, a dash for a minute not read yet, a pop marked", () => {
    const rows = minuteRows({ lastEnded: 12, count: 5, launchTime: LAUNCH, published: 11, settled: 9, tables: tables([[11, []], [10, [[ME, 100n], [OTHER, 50n]]], [8, [[ME, 1n]]]]), pops: new Set([10]) });
    expect(rows.map((r) => [r.minute, r.status, r.fees, r.wallets, r.pop])).toEqual([
      [12, "pending", null, null, false],
      [11, "counted", 0n, 0, false],
      [10, "counted", 150n, 2, true],
      [9, "onchain", null, null, false],
      [8, "onchain", 1n, 1, false],
    ]);
    expect(rows[0].endsAt).toBe(LAUNCH + 60 * 13);
  });
  it("stops at minute 0, and is empty before the first minute ends", () => {
    expect(minuteRows({ lastEnded: 1, count: 5, launchTime: LAUNCH, published: 1, settled: null, tables: new Map(), pops: new Set() }).map((r) => r.minute)).toEqual([1, 0]);
    expect(minuteRows({ lastEnded: -1, count: 5, launchTime: LAUNCH, published: null, settled: null, tables: new Map(), pops: new Set() })).toEqual([]);
  });
});

describe("countedFeeUnits, the app's copy of calc's counting rule on Fill's numbers", () => {
  const cases: [string, Partial<Fill> & { px: number; sz: number; builderFee: number }][] = [
    ["exactly 0.1%", { px: 100_000, sz: 0.01, builderFee: 1 }],
    ["the real trade of minute 1536", { px: 109_000.5, sz: 0.00733, builderFee: 0.799 }],
    ["inside the tolerance", { px: 100, sz: 1, builderFee: 0.100001 }],
    ["outside the tolerance", { px: 100, sz: 1, builderFee: 0.100003 }],
    ["half the fee", { px: 100, sz: 1, builderFee: 0.05 }],
    ["no fee", { px: 100, sz: 1, builderFee: 0 }],
    ["spot", { coin: "@107", px: 100, sz: 1, builderFee: 0.1 }],
    ["a pair", { coin: "PURR/USDC", px: 100, sz: 1, builderFee: 0.1 }],
    ["a HIP-3 market", { coin: "xyz:GOLD", px: 100, sz: 1, builderFee: 0.1 }],
  ];
  it.each(cases)("%s agrees with calc", (_name, over) => {
    const f = fill(3, over.builderFee, over);
    const api = { time: f.time, coin: f.coin, px: String(f.px), sz: String(f.sz), builderFee: f.builderFee ? f.builderFee.toFixed(8) : undefined };
    expect(countedFeeUnits(f, LAUNCH)).toBe(countedFee(api as Parameters<typeof countedFee>[0], LAUNCH));
  });
  it("a fill before the launch does not count, like calc", () => {
    const f = fill(-1, 1, { px: 100_000, sz: 0.01 });
    expect(countedFeeUnits(f, LAUNCH)).toBeNull();
  });
});

describe("tradeRows", () => {
  const base = { user: ME, launchTime: LAUNCH, published: 10, failed: new Set<number>(), max: 30 };
  const kinds = (fills: Fill[], t: MinuteTables, over: Partial<typeof base> = {}) => tradeRows({ ...base, fills, tables: t, ...over }).map((r) => r.status.kind);

  it("hides a trade with no builder fee: it was not placed through HLO", () => {
    expect(tradeRows({ ...base, fills: [fill(5, 0)], tables: new Map() })).toEqual([]);
  });
  it("newer than the newest published minute: pending", () => {
    expect(kinds([fill(11, 1)], new Map())).toEqual(["pending"]);
    expect(kinds([fill(1, 1)], new Map(), { published: null as unknown as number })).toEqual(["pending"]);
  });
  it("published and the table holds its fee: counted, with its minute", () => {
    const rows = tradeRows({ ...base, fills: [fill(5, 1)], tables: tables([[5, [[ME, 100_000_000n]]]]) });
    expect(rows[0].status).toEqual({ kind: "counted" });
    expect(rows[0].minute).toBe(5);
  });
  it("a trade's points are its counted fee (units; 1 point per $1 of fee); a trade that did not count has none", () => {
    const t = tables([[5, [[ME, 100_000_000n]]], [6, []]]);
    const rows = tradeRows({ ...base, fills: [fill(11, 2), fill(5, 1), fill(6, 3), fill(7, 4), fill(4, 0.1, { coin: "@107", px: 100, sz: 1 })], tables: t, failed: new Set([7]) });
    expect(rows.map((r) => [r.status.kind, r.points])).toEqual([
      ["pending", 200_000_000n],
      ["counted", 100_000_000n],
      ["notCounted", null],
      ["unknown", 400_000_000n],
      ["notCounted", null],
    ]);
  });
  it("two trades in one minute are checked by the minute's sum", () => {
    const fills = [fill(5, 1), fill(5, 2)];
    expect(kinds(fills, tables([[5, [[ME, 300_000_000n]]]]))).toEqual(["counted", "counted"]);
    const part = tradeRows({ ...base, fills, tables: tables([[5, [[ME, 100_000_000n]]]]) });
    expect(part[0].status).toEqual({ kind: "notCounted", why: "Only $1.00 of this minute's $3.00 in fees was counted." });
  });
  it("an address in any case finds its row", () => {
    expect(kinds([fill(5, 1)], tables([[5, [[ME, 100_000_000n]]]]), { user: "0x517B22F40B1B9BEBF1776FA9D732E2C27FDEB590" })).toEqual(["counted"]);
  });
  it("published, and the table has no row for this wallet: not counted, and it says why", () => {
    const rows = tradeRows({ ...base, fills: [fill(5, 1)], tables: tables([[5, [[OTHER, 100_000_000n]]]]) });
    expect(rows[0].status).toEqual({ kind: "notCounted", why: "Not in this minute's published fees. A trade counts only after Enable trading has registered the wallet." });
  });
  it("the rule's own refusals say why, without any file", () => {
    const rows = tradeRows({ ...base, fills: [fill(5, 0.1, { coin: "@107", px: 100, sz: 1 }), fill(5, 0.05, { px: 100, sz: 1 }), fill(-1, 1, { px: 100_000, sz: 0.01 })], tables: new Map() });
    expect(rows.map((r) => r.status)).toEqual([
      { kind: "notCounted", why: "Only Hyperliquid's main perps count, not spot or other markets." },
      { kind: "notCounted", why: "Its builder fee is not HLO's." },
      { kind: "notCounted", why: "Placed before rewards started." },
    ]);
  });
  it("a table not read yet is checking; one that could not be read is unknown, never not counted", () => {
    expect(kinds([fill(5, 1)], new Map())).toEqual(["checking"]);
    expect(kinds([fill(5, 1)], new Map(), { failed: new Set([5]) })).toEqual(["unknown"]);
  });
  it("shows at most `max` trades, but the sum still sees every fill of the minute", () => {
    const fills = [fill(5, 1), fill(5, 2)];
    const rows = tradeRows({ ...base, max: 1, fills, tables: tables([[5, [[ME, 300_000_000n]]]]) });
    expect(rows.map((r) => r.status.kind)).toEqual(["counted"]);
  });
});

describe("checkedMinutes", () => {
  it("every shown minute and trade minute at or under the published one, once", () => {
    const rows = tradeRows({ fills: [fill(5, 1), fill(5, 1), fill(11, 1), fill(2, 0.1, { coin: "@107", px: 100, sz: 1 })], user: ME, launchTime: LAUNCH, published: 10, failed: new Set(), tables: new Map(), max: 30 });
    const minutes = minuteRows({ lastEnded: 11, count: 3, launchTime: LAUNCH, published: 10, settled: null, tables: new Map(), pops: new Set() });
    expect(checkedMinutes(minutes, rows, 10)).toEqual([10, 9, 5]);
  });
  it("nothing published, nothing to read", () => expect(checkedMinutes([], [], null)).toEqual([]));
});

describe("popRows", () => {
  const pop = (over: Partial<LatestPop>): LatestPop => ({ minute: 5, block: "1", amount: "0", kept: "0", recipients: 0, ...over });
  it("what went out, what stayed and how many wallets; a pop with no points pays nobody", () => {
    const rows = popRows([pop({ minute: 9, amount: `${718n * 10n ** 18n}`, kept: `${80n * 10n ** 18n}`, recipients: 3 }), pop({ minute: 4, kept: `${9n * 10n ** 18n}` })], LAUNCH);
    expect(rows[0]).toEqual({ minute: 9, endsAt: LAUNCH + 600, paid: 718n * 10n ** 18n, kept: 80n * 10n ** 18n, recipients: 3, note: null });
    expect(rows[1].note).toBe("0 wallets paid means nobody had 1 point, so it all stayed in the vault.");
  });
});

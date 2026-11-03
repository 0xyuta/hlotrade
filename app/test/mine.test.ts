import { describe, expect, it } from "vitest";
import {
  amountProblem, clockText, earnedAbout, estimateText, fundsText, lastMinuteText, lastTradeText, leverageChoices, MINE_AMOUNTS, minePosition, otherPositionsText, planMine,
  positionLine, riskText, secondsLeft, startLabel, tableTotal,
} from "../src/rewards/mine";
import { parseMode } from "../src/ui/mode";
import type { TradeRow } from "../src/rewards/explore";
import type { Position } from "../src/hl/account";

const BTC = { index: 3, name: "BTC", szDecimals: 5, maxLeverage: 40 };
const USD = 100_000_000n;
const E18 = 10n ** 18n;
const USER = "0x00000000000000000000000000000000000000aa";
const position = (o: Partial<Position> = {}): Position => ({
  coin: "BTC", szi: 0.001, entryPx: 80000, positionValue: 80, unrealizedPnl: 0, returnOnEquity: 0, liquidationPx: null, leverage: { type: "isolated", value: 1 }, marginUsed: 80, ...o,
});
const row = (status: TradeRow["status"], minute = 7): TradeRow => ({ fill: {} as TradeRow["fill"], minute, counts: true, points: 1n, status });

describe("the mode", () => {
  it("is mine only when stored as mine", () => {
    expect(parseMode("mine")).toBe("mine");
    for (const v of ["full", "", "MINE", null]) expect(parseMode(v)).toBe("full");
  });
});

describe("the minute clock (chain time)", () => {
  it("counts down what is left of the minute, from launch", () => {
    expect(secondsLeft(1000, 1000)).toBe(60);
    expect(secondsLeft(1018, 1000)).toBe(42);
    expect(secondsLeft(1059, 1000)).toBe(1);
    expect(secondsLeft(1060, 1000)).toBe(60);
  });
  it("has no minute before launch", () => expect(secondsLeft(999, 1000)).toBeNull());
  it("reads as a clock", () => {
    expect(clockText(60)).toBe("1:00");
    expect(clockText(42)).toBe("0:42");
    expect(clockText(7)).toBe("0:07");
    expect(clockText(null)).toBe("—");
  });
});

describe("what the last counted minute says", () => {
  it("adds up the fees", () => expect(tableTotal(new Map([["a", 3n * USD], ["b", USD]]))).toBe(4n * USD));
  it("names the fees that shared the minute's HLO", () => expect(lastMinuteText(410_000_000n)).toBe("Last counted minute: $4.10 in fees shared 1 HLO"));
  it("says so when nobody traded", () => expect(lastMinuteText(0n)).toBe("Nobody traded in the last counted minute"));
  it("says nothing without a table", () => expect(lastMinuteText(null)).toBeNull());
  it("estimates a trade's share as if the minute repeats, with its own fee in the total", () => {
    // $100 pays a $0.10 HLO fee; with $0.30 from others it takes a quarter of the 1 HLO.
    expect(estimateText(100, 30_000_000n)).toBe("If this minute looks like the last one: about 0.25 HLO");
    expect(estimateText(100, 0n)).toBe("If this minute looks like the last one: about 1.00 HLO");
  });
  it("gives no estimate without a table or an amount", () => {
    expect(estimateText(100, null)).toBeNull();
    expect(estimateText(0, 0n)).toBeNull();
    expect(estimateText(Number.NaN, 0n)).toBeNull();
  });
});

describe("the wallet's last trade", () => {
  const table = new Map([[USER, USD], ["0xother", 3n * USD]]);
  it("gives the wallet's share of its minute", () => {
    expect(earnedAbout(table, USER)).toBe(E18 / 4n);
    expect(earnedAbout(new Map(), USER)).toBe(0n);
  });
  it("says where the trade stands", () => {
    expect(lastTradeText(null, undefined, USER)).toBeNull();
    expect(lastTradeText(row({ kind: "pending" }), undefined, USER)).toBe("Your last trade is waiting to be counted");
    expect(lastTradeText(row({ kind: "checking" }), undefined, USER)).toBe("Checking your last trade…");
    expect(lastTradeText(row({ kind: "unknown" }), undefined, USER)).toBe("Could not check your last trade");
    expect(lastTradeText(row({ kind: "counted" }), table, USER)).toBe("Your last trade's minute: counted, about +0.25 HLO");
    expect(lastTradeText(row({ kind: "counted" }), undefined, USER)).toBe("Your last trade was counted");
    expect(lastTradeText(row({ kind: "notCounted", why: "Its builder fee is not HLO's." }), table, USER)).toBe("Your last trade was not counted. Its builder fee is not HLO's.");
  });
});

describe("the mine order", () => {
  it("offers amounts a size rounded down still fits: every one clears the $10 floor", () => {
    for (const a of MINE_AMOUNTS) expect(planMine(BTC, true, a, 77_123, 1).ok).toBe(true);
  });
  it("is one market order with nothing else attached: at 1x the amount is the position's value", () => {
    const r = planMine(BTC, true, 100, 80_000, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.orders).toHaveLength(1);
    expect(r.plan.grouping).toBe("na");
    expect(r.plan.orders[0]).toMatchObject({ a: 3, b: true, s: "0.00125", r: false, t: { limit: { tif: "Ioc" } } });
  });
  it("the position is the amount times the leverage", () => {
    const r = planMine(BTC, true, 100, 80_000, 5);
    expect(r.ok && r.plan.orders[0].s).toBe("0.00625");
  });
  it("offers the usual steps up to the market's own maximum, which is the last one", () => {
    expect(leverageChoices(40)).toEqual([1, 3, 5, 10, 40]);
    expect(leverageChoices(10)).toEqual([1, 3, 5, 10]);
    expect(leverageChoices(5)).toEqual([1, 3, 5]);
    expect(leverageChoices(3)).toEqual([1, 3]);
    expect(leverageChoices(1)).toEqual([1]);
  });
  it("shorts when asked", () => {
    const r = planMine(BTC, false, 100, 80_000, 1);
    expect(r.ok && r.plan.orders[0].b).toBe(false);
  });
  it("refuses what cannot be sent", () => {
    expect(planMine(BTC, true, 0, 80_000, 1)).toEqual({ ok: false, error: "Enter an amount." });
    expect(planMine(BTC, true, Number.NaN, 80_000, 1)).toEqual({ ok: false, error: "Enter an amount." });
    expect(planMine(BTC, true, 100, 0, 1)).toEqual({ ok: false, error: "No price yet. Wait a moment." });
    expect(planMine(BTC, true, 5, 80_000, 1)).toEqual({ ok: false, error: "Orders must be worth at least $10." });
  });
  it("never puts in more than the balance", () => {
    expect(amountProblem(100, 500)).toBeNull();
    expect(amountProblem(500, 500)).toBeNull();
    expect(amountProblem(501, 500)).toBe("That is more than your available $500.00.");
    expect(amountProblem(100, null)).toBeNull();
  });
  it("points to a deposit under the $10 floor", () => {
    expect(fundsText(9.99)).toBe("Deposit USDC to start: an order must be worth at least $10.");
    expect(fundsText(10)).toBeNull();
    expect(fundsText(null)).toBeNull();
  });
  it("words the button and the risk", () => {
    expect(startLabel(true, 100, "BTC", 1)).toBe("Start mining: long $100 BTC");
    expect(startLabel(false, 1000, "ETH", 1)).toBe("Start mining: short $1,000 ETH");
    expect(startLabel(true, 100, "BTC", 5)).toBe("Start mining: long $500 BTC at 5×");
    expect(startLabel(true, Number.NaN, "BTC", 5)).toBe("Start mining");
    expect(riskText(null, 100)).toBe("Real position. You can lose money.");
    expect(riskText(64_800, 100)).toBe("Real position. Liquidation near 64,800: you could lose your $100.");
  });
});

describe("the position", () => {
  it("finds the chosen coin's position, and counts the others", () => {
    const ps = [position(), position({ coin: "ETH" })];
    expect(minePosition(ps, "ETH")?.coin).toBe("ETH");
    expect(minePosition(ps, "SOL")).toBeNull();
    expect(otherPositionsText(ps, "ETH")).toBe("You also have 1 other position. Switch to Trade to see it.");
    expect(otherPositionsText([...ps, position({ coin: "SOL" })], "ETH")).toBe("You also have 2 other positions. Switch to Trade to see them.");
    expect(otherPositionsText(ps.slice(0, 1), "BTC")).toBeNull();
  });
  it("words it by side and value at the live price; leverage only when it is not 1x", () => {
    expect(positionLine(position(), 80_000)).toBe("Long $80 BTC");
    expect(positionLine(position({ szi: -0.5, coin: "ETH" }), 2_000)).toBe("Short $1,000 ETH");
    expect(positionLine(position({ leverage: { type: "cross", value: 20 } }), 80_000)).toBe("Long $80 BTC · 20×");
    expect(positionLine(position(), null)).toBe("Long BTC");
  });
});

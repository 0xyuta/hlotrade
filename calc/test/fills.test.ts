import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeLz4, isCorePerp, parseFills } from "../src/fills.js";
import { dayOf, parseFeeUnits, yyyymmdd } from "../src/units.js";

const FIXTURE = new URL("./fixtures/builder-0x1924-20261025.csv.lz4", import.meta.url);
const DAY_20261025 = Date.UTC(2026, 9, 25) / 86_400_000;

describe("parseFeeUnits", () => {
  it("parses up to 8 decimals into 1e-8 USDC units", () => {
    expect(parseFeeUnits("0.109727")).toBe(10_972_700n);
    expect(parseFeeUnits("0.00440671")).toBe(440_671n);
    expect(parseFeeUnits("0")).toBe(0n);
    expect(parseFeeUnits("12")).toBe(1_200_000_000n);
    expect(parseFeeUnits("1.5")).toBe(150_000_000n);
  });
  it("rejects signs, exponents, too many decimals and junk", () => {
    for (const s of ["-1", "1e-5", "0.123456789", "", ".5", "1.", " 1", "0x10"]) {
      expect(() => parseFeeUnits(s), s).toThrow();
    }
  });
});

describe("day helpers", () => {
  it("dayOf and yyyymmdd agree with UTC", () => {
    expect(dayOf(Date.parse("2026-10-25T23:59:59Z") / 1000)).toBe(DAY_20261025);
    expect(dayOf(Date.parse("2026-10-26T00:00:00Z") / 1000)).toBe(DAY_20261025 + 1);
    expect(yyyymmdd(DAY_20261025)).toBe("20261025");
  });
});

describe("isCorePerp", () => {
  it("accepts core perps only", () => {
    expect(isCorePerp("BTC")).toBe(true);
    expect(isCorePerp("kPEPE")).toBe(true);
    expect(isCorePerp("@305")).toBe(false);
    expect(isCorePerp("PURR/USDC")).toBe(false);
    expect(isCorePerp("xyz:GOLD")).toBe(false);
  });
});

describe("parseFills", () => {
  const header = "time,user,coin,side,px,sz,crossed,special_trade_type,tif,is_trigger,counterparty,closed_pnl,twap_id,builder_fee";
  it("parses rows by header name, lowercases users, accepts CRLF and no trailing newline", () => {
    const text = `${header}\r\n2026-10-25T00:06:00Z,0xAbCDEF0000000000000000000000000000000001,BTC,Bid,1,1,true,Na,Ioc,false,0x0000000000000000000000000000000000000002,0,0,0.5\r\n`;
    const f = parseFills(text);
    expect(f).toEqual([
      { time: Date.parse("2026-10-25T00:06:00Z") / 1000, user: "0xabcdef0000000000000000000000000000000001", coin: "BTC", fee: 50_000_000n },
    ]);
  });
  it("returns [] for a header-only or empty file", () => {
    expect(parseFills("")).toEqual([]);
    expect(parseFills(header)).toEqual([]);
  });
  it("rejects a wrong field count, a bad time and a bad address", () => {
    expect(() => parseFills(`${header}\n2026-10-25T00:06:00Z,0x1`)).toThrow(/fields/);
    expect(() =>
      parseFills(`${header}\n2026-10-25 00:06:00,0x0000000000000000000000000000000000000001,BTC,Bid,1,1,true,Na,Ioc,false,0x0000000000000000000000000000000000000002,0,0,0.5`),
    ).toThrow(/time/);
    expect(() =>
      parseFills(`${header}\n2026-10-25T00:06:00Z,0x01,BTC,Bid,1,1,true,Na,Ioc,false,0x0000000000000000000000000000000000000002,0,0,0.5`),
    ).toThrow(/user/);
  });
  it("rejects a file without a builder_fee column", () => {
    expect(() => parseFills("time,user,coin\n")).toThrow(/builder_fee/);
  });
});

describe("real Hyperliquid file (2026-10-25)", () => {
  const fills = parseFills(decodeLz4(readFileSync(FIXTURE)));
  it("decodes every row", () => {
    expect(fills.length).toBe(631);
    expect(fills[0]).toEqual({
      time: Date.parse("2026-10-25T00:06:00Z") / 1000,
      user: "0x66a3566af5ecc6fd016e314c1e58318f91871772",
      coin: "xyz:GOLD",
      fee: 10_972_700n,
    });
    expect(fills.every((f) => dayOf(f.time) === DAY_20261025)).toBe(true);
  });
  it("matches independently computed totals", () => {
    const all = fills.reduce((a, f) => a + f.fee, 0n);
    const perps = fills.filter((f) => isCorePerp(f.coin) && f.fee > 0n);
    expect(all).toBe(18_359_017_371n);
    expect(perps.length).toBe(492);
    expect(perps.reduce((a, f) => a + f.fee, 0n)).toBe(17_795_898_400n);
    expect(new Set(perps.map((f) => f.user)).size).toBe(59);
  });
});

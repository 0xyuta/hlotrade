import { describe, expect, it } from "vitest";
import type { Addr } from "../src/fills.js";
import { parseTableCsv, tableCsv, type FeeRow } from "../src/table.js";

const A = "0x00000000000000000000000000000000000000aa" as Addr;
const B = "0x00000000000000000000000000000000000000bb" as Addr;
const rows: FeeRow[] = [
  { minute: 0, user: A, fee: 1n },
  { minute: 1, user: B, fee: 5n },
];

describe("fee table csv", () => {
  it("csv is canonical", () => {
    expect(tableCsv(rows)).toBe(`minute,user,fee\n0,${A},1\n1,${B},5`);
    expect(tableCsv([])).toBe("minute,user,fee");
  });
  it("parseTableCsv round-trips and rejects unsorted or duplicate rows", () => {
    expect(parseTableCsv(tableCsv(rows))).toEqual(rows);
    expect(parseTableCsv("minute,user,fee")).toEqual([]);
    expect(() => parseTableCsv(`minute,user,fee\n1,${B},5\n0,${A},1`)).toThrow(/order/);
    expect(() => parseTableCsv(`minute,user,fee\n0,${A},1\n0,${A},2`)).toThrow(/order/);
    expect(() => parseTableCsv(`minute,user,fee\n0,${A},0`)).toThrow(/bad table line/);
    expect(() => parseTableCsv(`wrong\n`)).toThrow(/header/);
  });
  it("parseTableCsv only accepts canonical text (no leading zeros, no trailing newline)", () => {
    expect(() => parseTableCsv(`minute,user,fee\n01,${A},1`)).toThrow(/bad table line/);
    expect(() => parseTableCsv(`minute,user,fee\n0,${A},01`)).toThrow(/bad table line/);
    expect(() => parseTableCsv(`minute,user,fee\n0,${A},1\n`)).toThrow(/bad table line/);
    const text = `minute,user,fee\n0,${A},1\n10,${B},50`;
    expect(tableCsv(parseTableCsv(text))).toBe(text);
  });
});

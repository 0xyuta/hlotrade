import { describe, expect, it } from "vitest";
import { dayLabel, fmtHlo, fmtDuration, fmtFeeUnits, fmtPct, fmtUsd, fmtUsdc, shortAddr } from "../src/ui/format";

describe("format", () => {
  it("numbers", () => {
    expect(fmtUsd(1234.5)).toBe("1,234.50");
    expect(fmtPct(1.234)).toBe("+1.23%");
    expect(fmtPct(-0.5)).toBe("-0.50%");
    expect(fmtHlo(1_234_567_000_000_000_000_000n)).toBe("1,234.57");
    expect(fmtUsdc(1_200_000n)).toBe("1.20");
    expect(fmtFeeUnits(400_000_000n)).toBe("4.00");
  });
  it("non-finite and negative values (review M6)", () => {
    expect(fmtUsd(NaN)).toBe("—");
    expect(fmtUsd(-1234.5)).toBe("-1,234.50");
    expect(fmtUsd(-0.001)).toBe("0.00");
    expect(fmtPct(NaN)).toBe("—");
    expect(fmtPct(-0.001)).toBe("+0.00%");
    expect(fmtPct(0)).toBe("+0.00%");
    expect(fmtDuration(NaN)).toBe("—");
    expect(fmtDuration(Infinity)).toBe("—");
    expect(fmtDuration(-5)).toBe("0s");
  });
  it("addresses and durations", () => {
    expect(shortAddr("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(fmtDuration(59)).toBe("59s");
    expect(fmtDuration(61)).toBe("1m 1s");
    expect(fmtDuration(3725)).toBe("1h 2m");
    expect(fmtDuration(90061)).toBe("1d 1h");
  });
  it("dayLabel: a UTC day number as YYYY-MM-DD", () => {
    expect(dayLabel(0)).toBe("1970-01-01");
    expect(dayLabel(20_001)).toBe("2024-10-05");
  });
});

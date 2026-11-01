// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const markets = [{ name: "BTC", markPx: 100, midPx: null, prevDayPx: 100, szDecimals: 5, maxLeverage: 40 }];
vi.mock("../src/hl/HlProvider", () => ({
  useHl: () => ({ markets, error: null, market: (n: string) => markets.find((m) => m.name === n), price: () => 100 }),
}));

import { MarketPicker } from "../src/ui/trade/MarketPicker";

afterEach(() => cleanup());

describe("MarketPicker closes on Escape and on a click outside (carry T10)", () => {
  it("Escape closes the list and returns focus to the picker button", () => {
    render(<MarketPicker coin="BTC" onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByPlaceholderText("Search markets")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Search markets")).toBeNull();
    expect(document.activeElement?.className).toContain("picker");
  });
  it("a mousedown outside closes it; one inside does not", () => {
    render(
      <div>
        <p>elsewhere</p>
        <MarketPicker coin="BTC" onPick={() => {}} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    fireEvent.mouseDown(screen.getByPlaceholderText("Search markets"));
    expect(screen.getByPlaceholderText("Search markets")).toBeTruthy();
    fireEvent.mouseDown(screen.getByText("elsewhere"));
    expect(screen.queryByPlaceholderText("Search markets")).toBeNull();
  });
});

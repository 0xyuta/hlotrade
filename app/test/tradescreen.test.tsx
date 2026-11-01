// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/hl/HlProvider", () => ({ useHl: () => ({ markets: [{ name: "BTC" }, { name: "ETH" }] }) }));
vi.mock("../src/hl/agent", () => ({ browserKV: { getItem: () => "BTC", setItem: () => {} } }));
vi.mock("../src/ui/trade/AccountTabs", () => ({ AccountTabs: () => null }));
// The chart's chunk: the first load fails (a redeploy removed it, or the network dropped), later ones work.
let chartLoads = 0;
vi.mock("../src/ui/trade/Chart", () => {
  chartLoads++;
  if (chartLoads === 1) throw new Error("Failed to fetch dynamically imported module");
  return { Chart: () => <p>the chart</p> };
});
vi.mock("../src/ui/trade/MarketStats", () => ({ MarketStats: () => null }));
vi.mock("../src/ui/trade/MarketPicker", () => ({ MarketPicker: (p: { onPick: (c: string) => void }) => <button onClick={() => p.onPick("ETH")}>to ETH</button> }));
vi.mock("../src/ui/trade/OrderForm", () => ({
  // like the real form: the answer is reported through onResult when the form was keyed away mid-order
  OrderForm: (p: { coin: string; onResult?: (r: { coin: string; ok: boolean; text: string }) => void }) => (
    <button onClick={() => p.onResult?.({ coin: "BTC", ok: false, text: "Your long filled, but the stop loss was rejected." })}>form {p.coin}</button>
  ),
}));

import { TradeScreen } from "../src/ui/trade/TradeScreen";

afterEach(cleanup);

describe("TradeScreen", () => {
  it("a chart chunk that fails to load stays in the chart's place with Try again; the order form stays up (final review M5)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<TradeScreen />);
    expect(await screen.findByText(/did not load/)).toBeTruthy();
    expect(screen.getByText("form BTC")).toBeTruthy(); // not the screen-wide fallback
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("the chart")).toBeTruthy();
    expect(chartLoads).toBe(2);
    vi.restoreAllMocks();
  });
  it("keeps the answer of an order sent on another market, names the market, and can be dismissed", async () => {
    render(<TradeScreen />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull()); // the lazy chart's fallback is also a status
    fireEvent.click(screen.getByText("to ETH"));
    fireEvent.click(screen.getByText("form ETH"));
    expect(screen.getByRole("status").textContent).toContain("BTC: Your long filled, but the stop loss was rejected.");
    fireEvent.click(screen.getByText("Dismiss"));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

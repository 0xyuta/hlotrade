// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MARKETS = [
  { name: "BTC", maxLeverage: 40, dayNtlVlm: 5_300_000_000, markPx: 76_956.5, prevDayPx: 79_000 },
  { name: "ETH", maxLeverage: 25, dayNtlVlm: 1_900_000_000, markPx: 2_236.15, prevDayPx: 2_200 },
];
vi.mock("../src/hl/HlProvider", () => ({ useHl: () => ({ markets: MARKETS, price: () => null, error: null }) }));
vi.mock("../src/hl/agent", () => ({ browserKV: { getItem: () => "ETH", setItem: () => {} } }));
vi.mock("../src/ui/trade/AccountTabs", () => ({ AccountTabs: () => <p>the positions</p> }));
vi.mock("../src/ui/trade/Chart", () => ({ Chart: ({ coin }: { coin: string }) => <p>chart {coin}</p> }));
vi.mock("../src/ui/trade/MarketStats", () => ({ MarketStats: () => null }));
vi.mock("../src/ui/trade/MarketPicker", () => ({ MarketPicker: () => null }));
vi.mock("../src/ui/trade/OrderForm", () => ({ OrderForm: ({ coin }: { coin: string }) => <p>form {coin}</p> }));

import { BottomNav } from "../src/ui/BottomNav";
import { CoinIcon } from "../src/ui/CoinIcon";
import { fmtCompactUsd } from "../src/ui/format";
import { MarketList } from "../src/ui/trade/MarketList";
import { TradeScreen } from "../src/ui/trade/TradeScreen";
import { useNarrow } from "../src/ui/useNarrow";

let listeners: (() => void)[] = [];
function setWidth(narrow: boolean) {
  window.matchMedia = ((q: string) => ({
    media: q,
    matches: narrow,
    addEventListener: (_: string, f: () => void) => listeners.push(f),
    removeEventListener: (_: string, f: () => void) => { listeners = listeners.filter((x) => x !== f); },
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => setWidth(true));
afterEach(() => {
  cleanup();
  listeners = [];
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("useNarrow", () => {
  const Probe = () => <p>{useNarrow() ? "narrow" : "wide"}</p>;
  it("follows the width, and is wide where matchMedia is missing", () => {
    render(<Probe />);
    expect(screen.getByText("narrow")).toBeTruthy();
    setWidth(false);
    act(() => listeners.forEach((f) => f()));
    expect(screen.getByText("wide")).toBeTruthy();
    cleanup();
    delete (window as { matchMedia?: unknown }).matchMedia;
    render(<Probe />);
    expect(screen.getByText("wide")).toBeTruthy();
  });
});

describe("BottomNav", () => {
  const labels = () => [...screen.getByRole("navigation").querySelectorAll("button")].map((b) => b.textContent);
  it("lists the phone's tabs in order and switches on a tap", () => {
    const onTab = vi.fn();
    render(<BottomNav tab="trade" onTab={onTab} />);
    expect(labels()).toEqual(["Markets", "Trade", "Positions", "Rewards", "More"]);
    expect(screen.getByRole("button", { name: "Trade" }).getAttribute("aria-current")).toBe("page");
    fireEvent.click(screen.getByRole("button", { name: "Positions" }));
    expect(onTab).toHaveBeenCalledWith("positions");
  });
  it.each(["explore", "bots", "tokenomics", "referrals", "swap"] as const)("More stays lit on %s, which is reached through it", (tab) => {
    render(<BottomNav tab={tab} onTab={() => {}} />);
    expect(screen.getByRole("button", { name: "More" }).getAttribute("aria-current")).toBe("page");
  });
});

describe("MarketList", () => {
  it("shows each market's leverage, volume, price and change; a tap picks it", () => {
    const onPick = vi.fn();
    render(<MarketList onPick={onPick} />);
    const btc = screen.getByText("BTC").closest("button")!;
    expect(btc.textContent).toContain("40×");
    expect(btc.textContent).toContain("$5.3B · 24h vol");
    expect(btc.textContent).toContain("76,957");
    expect(btc.querySelector(".down")?.textContent).toBe("-2.59%");
    fireEvent.click(btc);
    expect(onPick).toHaveBeenCalledWith("BTC");
  });
  it("searches by name and says when nothing matches", () => {
    render(<MarketList onPick={() => {}} />);
    const box = screen.getByRole("textbox", { name: "Search markets" });
    fireEvent.change(box, { target: { value: "et" } });
    expect(screen.queryByText("BTC")).toBeNull();
    expect(screen.getByText("ETH")).toBeTruthy();
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No market matches.")).toBeTruthy();
  });
});

describe("TradeScreen on a phone", () => {
  it("starts on the market list without loading the chart; a picked market opens Trade with its chart and form", async () => {
    const onView = vi.fn();
    const { rerender } = render(<TradeScreen view="markets" onView={onView} />);
    expect(screen.queryByText(/^chart /)).toBeNull();
    expect(document.querySelector(".trade")?.getAttribute("data-view")).toBe("markets");
    fireEvent.click(screen.getByText("BTC").closest("button")!);
    expect(onView).toHaveBeenCalledWith("trade");
    rerender(<TradeScreen view="trade" onView={onView} />);
    expect(await screen.findByText("chart BTC")).toBeTruthy();
    expect(screen.getByText("form BTC")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Search markets" })).toBeNull();
  });
  it("keeps the form and the positions mounted on every view, so an order in flight survives a switch", async () => {
    const { rerender } = render(<TradeScreen view="trade" />);
    await waitFor(() => expect(screen.getByText("chart ETH")).toBeTruthy());
    for (const view of ["positions", "markets", "trade"] as const) {
      rerender(<TradeScreen view={view} />);
      expect(screen.getByText("form ETH")).toBeTruthy();
      expect(screen.getByText("the positions")).toBeTruthy();
    }
  });
  it("shows no market list on a wide screen", () => {
    setWidth(false);
    render(<TradeScreen view="trade" />);
    expect(screen.queryByRole("textbox", { name: "Search markets" })).toBeNull();
  });
});

describe("CoinIcon", () => {
  it("asks Hyperliquid for the icon and falls back to the coin's letter", () => {
    const { container } = render(<CoinIcon coin="kPEPE" size={24} />);
    const img = container.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("https://app.hyperliquid.xyz/coins/kPEPE.svg");
    expect(img.getAttribute("alt")).toBe("");
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("K");
  });
  it("tries again for another coin", () => {
    const { container, rerender } = render(<CoinIcon coin="AAA" size={24} />);
    fireEvent.error(container.querySelector("img")!);
    rerender(<CoinIcon coin="BBB" size={24} />);
    expect(container.querySelector("img")?.getAttribute("src")).toContain("BBB.svg");
  });
});

describe("fmtCompactUsd", () => {
  it.each([[5_300_000_000, "$5.3B"], [454_600_000, "$454.6M"], [12_400, "$12.4K"], [950, "$950"], [0, "$0"], [NaN, "—"]])("%s → %s", (n, s) => {
    expect(fmtCompactUsd(n)).toBe(s);
  });
});

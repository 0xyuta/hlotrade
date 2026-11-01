// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Footer } from "../src/ui/Footer";

afterEach(cleanup);

// lightweight-charts 5.2.1 asks for its NOTICE text and a link to tradingview.com on a page users can see.
describe("Footer TradingView attribution", () => {
  it("shows the NOTICE text and the link", () => {
    const { container } = render(<Footer />);
    expect(container.textContent).toContain("TradingView Lightweight Charts™ Copyright (c) 2025 TradingView, Inc.");
    const a = container.querySelector('a[href="https://www.tradingview.com/"]');
    expect(a?.textContent).toBe("https://www.tradingview.com/");
  });
});

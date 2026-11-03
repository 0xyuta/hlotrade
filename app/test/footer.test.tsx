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

describe("Footer links", () => {
  it("links to HLO's X account and its GitHub repo", () => {
    const { getByRole } = render(<Footer />);
    for (const [name, href] of [["HLO on X", "https://x.com/hlotrade"], ["HLO on GitHub", "https://github.com/0xyuta/hlotrade"]]) {
      const a = getByRole("link", { name });
      expect(a.getAttribute("href")).toBe(href);
      expect(a.getAttribute("target")).toBe("_blank");
    }
  });
});

// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/ui/ErrorBoundary";

function Boom(): never {
  throw new Error("render failed");
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ErrorBoundary (final review M1)", () => {
  it("a throwing child shows the plain message, where the positions are, and a Reload button that reloads", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    render(
      <ErrorBoundary network="mainnet">
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Something went wrong")).toBeTruthy();
    expect(screen.getByText(/Your positions are safe on Hyperliquid, and after the reload they show here again/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "app.hyperliquid.xyz" }).getAttribute("href")).toBe("https://app.hyperliquid.xyz");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeTruthy();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
  it("a screen boundary keeps its siblings (the top bar) on screen and links the testnet app on testnet", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <div>
        <nav>top bar</nav>
        <ErrorBoundary scope="screen" network="testnet">
          <Boom />
        </ErrorBoundary>
      </div>,
    );
    expect(screen.getByText("top bar")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("link", { name: "app.hyperliquid-testnet.xyz" })).toBeTruthy();
  });
  it("with onRetry, a screen boundary offers Try again, which calls it and renders the children afresh", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let fail = true;
    const Flaky = () => {
      if (fail) throw new Error("chunk failed");
      return <p>loaded</p>;
    };
    const onRetry = vi.fn(() => {
      fail = false;
    });
    render(
      <ErrorBoundary scope="screen" network="testnet" onRetry={onRetry}>
        <Flaky />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/did not load/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("loaded")).toBeTruthy();
  });
  it("the Try again text also fits a part that broke after it loaded (Task 16 review m5), and `frame` wraps it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary scope="screen" onRetry={() => {}} frame={(b) => <section aria-label="framed">{b}</section>}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("This part did not load, or it stopped working. Try again. If it keeps failing, reload the page.")).toBeTruthy();
    expect(screen.getByLabelText("framed").textContent).toMatch(/Try again/);
  });
});

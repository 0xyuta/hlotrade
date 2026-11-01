import { Component, lazy, useCallback, useState, type ComponentType, type ErrorInfo, type LazyExoticComponent, type ReactNode } from "react";
import type { Network } from "../config/validate";

const HL_APP: Record<Network, string> = { mainnet: "app.hyperliquid.xyz", testnet: "app.hyperliquid-testnet.xyz" };

/**
 * A render or effect error unmounts everything under the nearest boundary (final review M1). Without one the page goes
 * blank, Positions and its Close button included. The fallback says what to do and that the positions live on
 * Hyperliquid, not in this page: a reload brings the app (and Positions) back. `scope="screen"` is used around each
 * screen so a Rewards failure leaves the top bar (and the Trade tab) working; the page-wide one wraps the whole root.
 * With `onRetry` (a lazily loaded part, such as the Solana form), the fallback offers "Try again" in place: it calls
 * onRetry (which can make a fresh lazy import) and renders the children again, so a chunk that failed to load over a
 * dropped connection does not need a reload, which would forget transfers held in memory. (A file that a redeploy
 * removed stays gone: Try again then fails again and the text says to reload; docs/APP.md §4.) `frame` wraps that
 * fallback (a lazily loaded dialog puts it in a dialog the user can close).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; network?: Network | null; scope?: "page" | "screen"; onRetry?: () => void; frame?: (body: ReactNode) => ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The message and component stack only, no props or state. React also logs the caught error itself; no error message
    // in this app carries a key.
    console.error("HLO: render error", error instanceof Error ? error.message : String(error), info.componentStack ?? "");
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const host = HL_APP[this.props.network ?? "mainnet"];
    const onRetry = this.props.onRetry;
    if (onRetry) {
      const retry = (
        <div className="card" role="alert">
          <h1 className="card-h">Something went wrong</h1>
          <p>This part did not load, or it stopped working. Try again. If it keeps failing, reload the page.</p>
          <button
            className="btn primary wide"
            onClick={() => {
              onRetry();
              this.setState({ failed: false });
            }}
          >
            Try again
          </button>
        </div>
      );
      return this.props.frame ? this.props.frame(retry) : retry;
    }
    const body = (
      <div className="card" role="alert">
        <h1 className="card-h">Something went wrong</h1>
        <p>
          Reload the page. Your positions are safe on Hyperliquid, and after the reload they show here again. You can also
          see them at{" "}
          <a href={`https://${host}`} target="_blank" rel="noreferrer">
            {host}
          </a>
          .
        </p>
        <button className="btn primary wide" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
    if (this.props.scope === "screen") return body;
    return (
      <div className="app">
        <main className="main" style={{ maxWidth: 560 }}>
          {body}
        </main>
      </div>
    );
  }
}

/**
 * A lazily loaded component that can be made afresh: React keeps a failed lazy import's error for good, so "Try again"
 * (an ErrorBoundary's onRetry) needs a new lazy() around the same loader. `load` must be a stable (module-level) function.
 */
// `any` props: the same bound as React's own lazy().
export function useRetryableLazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): [LazyExoticComponent<T>, () => void] {
  const [C, setC] = useState(() => lazy(load));
  const retry = useCallback(() => setC(() => lazy(load)), [load]);
  return [C, retry];
}

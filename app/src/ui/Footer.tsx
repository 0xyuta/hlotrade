const X_URL = "https://x.com/hlotrade";

export function Footer() {
  return (
    <footer className="footer">
      <span>HLO · not available in the US or Ontario</span>
      <span>
        TradingView Lightweight Charts™ Copyright (c) 2025 TradingView, Inc.{" "}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">https://www.tradingview.com/</a>
      </span>
      <a className="footer-x" href={X_URL} target="_blank" rel="noreferrer" aria-label="HLO on X" title="HLO on X">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
      </a>
    </footer>
  );
}

import type { Tab } from "../App";

const ROWS: { tab: Tab; label: string; text: string }[] = [
  { tab: "explore", label: "Explore", text: "Live minutes and whether your trades were counted" },
  { tab: "bots", label: "Bots", text: "Mine with your own bot" },
  { tab: "tokenomics", label: "Tokenomics", text: "Supply, mining, the vault and fees" },
  { tab: "referrals", label: "Referrals", text: "Your code and your USDC rewards" },
];

/** The phone's More tab: what does not fit on the bottom bar. */
export function MoreScreen({ onTab }: { onTab(t: Tab): void }) {
  return (
    <section>
      <h1 className="page-title">More</h1>
      {ROWS.map((r) => (
        <button key={r.tab} className="more-row" onClick={() => onTab(r.tab)}>
          <span>
            <strong>{r.label}</strong>
            <br />
            <span className="muted small">{r.text}</span>
          </span>
          <span className="muted" aria-hidden="true">›</span>
        </button>
      ))}
    </section>
  );
}

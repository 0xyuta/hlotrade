import type { ReactNode } from "react";
import type { Tab } from "../App";

const icon = (path: ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{path}</svg>
);

const ITEMS: { tab: Tab; label: string; icon: ReactNode }[] = [
  { tab: "markets", label: "Markets", icon: icon(<path d="M4 7h16M4 12h16M4 17h16" />) },
  { tab: "trade", label: "Trade", icon: icon(<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>) },
  { tab: "positions", label: "Positions", icon: icon(<><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8 15v-3M12 15V9M16 15v-5" /></>) },
  { tab: "rewards", label: "Rewards", icon: icon(<><circle cx="12" cy="12" r="8" /><ellipse cx="12" cy="12" rx="4" ry="2.2" transform="rotate(-14 12 12)" /></>) },
  { tab: "more", label: "More", icon: icon(<><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></>) },
];

/** The phone's tabs. Explore, Bots, Tokenomics and Referrals are reached through More, so it stays lit on them. */
export function BottomNav({ tab, onTab }: { tab: Tab; onTab(t: Tab): void }) {
  const lit: Tab = tab === "explore" || tab === "bots" || tab === "tokenomics" || tab === "referrals" ? "more" : tab;
  return (
    <nav className="bottom-nav" aria-label="Main">
      {ITEMS.map((i) => (
        <button key={i.tab} className={`bottom-btn ${lit === i.tab ? "on" : ""}`} aria-current={lit === i.tab ? "page" : undefined} onClick={() => onTab(i.tab)}>
          {i.icon}
          {i.label}
        </button>
      ))}
    </nav>
  );
}

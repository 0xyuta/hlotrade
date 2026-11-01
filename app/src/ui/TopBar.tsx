import { Suspense, useState, type ReactNode } from "react";
import type { Tab } from "../App";
import type { AppMode } from "./mode";
import { useConfig } from "../config/context";
import { allowed } from "../wallet/permissions";
import { useSession } from "../wallet/session";
import { ErrorBoundary, useRetryableLazy } from "./ErrorBoundary";
import { Loading } from "./Loading";
import { HaloLogo } from "./Logo";
import { Modal } from "./Modal";
import { useNarrow } from "./useNarrow";
import { WalletButton } from "./WalletButton";

const loadTransferModal = () => import("./transfer/TransferModal").then((m) => ({ default: m.TransferModal }));

/** The tabs, in order (Trade, Rewards, Explore, Bots, Tokenomics, Referrals). */
const TABS: { tab: Tab; label: string }[] = [
  { tab: "trade", label: "Trade" },
  { tab: "rewards", label: "Rewards" },
  { tab: "explore", label: "Explore" },
  { tab: "bots", label: "Bots" },
  { tab: "tokenomics", label: "Tokenomics" },
  { tab: "referrals", label: "Referrals" },
];

export function TopBar({ tab, onTab, mode, onMode }: { tab: Tab; onTab(t: Tab): void; mode: AppMode; onMode(m: AppMode): void }) {
  const cfg = useConfig();
  const { session } = useSession();
  const narrow = useNarrow(); // a phone has the bottom bar instead
  const [transfer, setTransfer] = useState<"deposit" | "withdraw" | null>(null);
  const [TransferModal, retryTransfer] = useRetryableLazy(loadTransferModal);
  const closeTransfer = () => setTransfer(null);
  // While the chunk loads, and if it fails, the user sees a dialog that can be closed, with Try again: never the
  // page-wide fallback, whose reload forgets transfers held in memory. Try again cures a dropped connection; a file a
  // redeploy removed stays gone, and then only a reload helps (docs/APP.md §4).
  const frame = (body: ReactNode) => (
    <Modal title={transfer === "withdraw" ? "Withdraw USDC" : "Deposit USDC"} onClose={closeTransfer}>
      {body}
    </Modal>
  );
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="HLO"><HaloLogo size={28} /><span className="brand-name">HLO</span></a>
      {!narrow && mode === "full" && (
        <nav className="nav">
          {TABS.map((t) => (
            <button key={t.tab} className={`nav-btn ${tab === t.tab ? "on" : ""}`} onClick={() => onTab(t.tab)}>{t.label}</button>
          ))}
        </nav>
      )}
      {cfg.network === "testnet" && <span className="net-pill">testnet</span>}
      <div className="topbar-actions">
        <div className="seg mode-switch" role="group" aria-label="App mode">
          <button className={mode === "full" ? "on" : ""} aria-pressed={mode === "full"} onClick={() => onMode("full")}>Trade</button>
          <button className={mode === "mine" ? "on" : ""} aria-pressed={mode === "mine"} onClick={() => onMode("mine")}>Mine</button>
        </div>
        {allowed(session.kind, "transfer") && (
          <>
            <button className="btn small hide-narrow" onClick={() => setTransfer("deposit")}>Deposit</button>
            <button className="btn small hide-narrow" onClick={() => setTransfer("withdraw")}>Withdraw</button>
          </>
        )}
        <WalletButton onTransfer={setTransfer} />
      </div>
      {transfer && (
        <ErrorBoundary scope="screen" network={cfg.network} onRetry={retryTransfer} frame={frame}>
          <Suspense fallback={frame(<Loading />)}>
            <TransferModal dir={transfer} onClose={closeTransfer} />
          </Suspense>
        </ErrorBoundary>
      )}
    </header>
  );
}

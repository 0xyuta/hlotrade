import { useState } from "react";
import { useSession } from "../wallet/session";
import { AccountMenu } from "./AccountMenu";

export function WalletButton({ onTransfer }: { onTransfer?(d: "deposit" | "withdraw"): void }) {
  const { session, wallets, connect, error } = useSession();
  const [open, setOpen] = useState(false);
  if (session.kind !== "none") return <AccountMenu onTransfer={onTransfer} />;
  return (
    <div className="menu-anchor">
      <button className="btn primary" onClick={() => setOpen(!open)}>Connect</button>
      {open && (
        <div className="menu">
          {wallets.length === 0 ? (
            <p className="muted small">No browser wallet found. Install MetaMask, Rabby or Phantom, then reload.</p>
          ) : (
            wallets.map((w) => (
              <button key={w.info.uuid} className="menu-item row" onClick={() => { setOpen(false); void connect(w); }}>
                <img src={w.info.icon} alt="" width={20} height={20} /> {w.info.name}
              </button>
            ))
          )}
          {error && <p className="error">{error}</p>}
        </div>
      )}
    </div>
  );
}

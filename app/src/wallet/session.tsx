import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { getAddress, type Hex } from "viem";
import { useConfig } from "../config/context";
import type { Address } from "../config/validate";
import { evmWrite, type WriteCall } from "../evm/clients";
import { PHONE_AGENT_NAME, browserKV, clearAgent, clearPaired, loadPaired, savePaired } from "../hl/agent";
import { plainError } from "../hl/errors";
import { injectedHlWallet, type HlUserWallet } from "../hl/injected";
import { viemChain, type EvmKind } from "./chains";
import { discoverWallets, type Discovered } from "./eip6963";
import { PAIRED_BLOCKED_TEXT } from "./permissions";

export type Session =
  | { kind: "none" }
  | { kind: "wallet"; wallet: Discovered; address: Address }
  | { kind: "paired"; address: Address };

export interface SessionApi {
  session: Session;
  wallets: Discovered[];
  error: string | null;
  connect(w: Discovered): Promise<void>;
  disconnect(): void;
  /** A contract call from the connected wallet on `kind` (switching or adding the chain first). */
  write(kind: EvmKind, call: WriteCall): Promise<Hex>;
  /** The Fix A wallet for user-signed Hyperliquid actions. Throws for a paired phone. */
  hlWallet(): HlUserWallet;
  setPaired(master: Address): void;
}

const Ctx = createContext<SessionApi | null>(null);
const LAST_WALLET = "hlo:wallet";

export function SessionProvider({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  const [wallets, setWallets] = useState<Discovered[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState<Session>(() => {
    const m = loadPaired(browserKV, cfg.network);
    return m ? { kind: "paired", address: m } : { kind: "none" };
  });

  useEffect(() => discoverWallets(window, setWallets), []);

  // Silent reconnect to the wallet used last time (eth_accounts never prompts).
  useEffect(() => {
    if (session.kind === "wallet") return;
    const rdns = browserKV.getItem(LAST_WALLET);
    const w = rdns ? wallets.find((x) => x.info.rdns === rdns) : undefined;
    if (!w) return;
    w.provider
      .request({ method: "eth_accounts" })
      .then((a) => {
        const acc = (a as string[])[0];
        if (acc) setSession({ kind: "wallet", wallet: w, address: getAddress(acc) });
      })
      .catch(() => {});
  }, [wallets, session.kind]);

  // Follow account switches inside the wallet.
  useEffect(() => {
    if (session.kind !== "wallet") return;
    const w = session.wallet;
    const onAccounts = (a: unknown) => {
      const acc = (a as string[])[0];
      setSession(acc ? { kind: "wallet", wallet: w, address: getAddress(acc) } : { kind: "none" });
    };
    w.provider.on?.("accountsChanged", onAccounts);
    return () => w.provider.removeListener?.("accountsChanged", onAccounts);
  }, [session]);

  const connect = useCallback(async (w: Discovered) => {
    setError(null);
    try {
      const a = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
      if (!a[0]) throw new Error("The wallet returned no account.");
      browserKV.setItem(LAST_WALLET, w.info.rdns);
      setSession({ kind: "wallet", wallet: w, address: getAddress(a[0]) });
    } catch (e) {
      setError(plainError(e).text);
    }
  }, []);

  const disconnect = useCallback(() => {
    if (session.kind === "paired") {
      // Only this phone's own key and pairing go; a desktop "hlo" key under the same master is not touched.
      clearPaired(browserKV, cfg.network);
      clearAgent(browserKV, cfg.network, session.address, PHONE_AGENT_NAME);
    }
    if (session.kind === "wallet") {
      // Without this the wallet keeps the site connected and Connect would come back without a prompt. Not every wallet
      // has the method; the session ends either way. The trading key stays stored, so reconnecting needs no new approval.
      try {
        session.wallet.provider.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
      } catch {
        // not supported
      }
    }
    browserKV.removeItem(LAST_WALLET);
    setSession({ kind: "none" });
  }, [session, cfg.network]);

  const write = useCallback(
    (kind: EvmKind, call: WriteCall) => {
      if (session.kind !== "wallet") return Promise.reject(new Error(PAIRED_BLOCKED_TEXT));
      return evmWrite(session.wallet.provider, session.address, viemChain(kind, cfg), call);
    },
    [session, cfg],
  );

  const hlWallet = useCallback(() => {
    if (session.kind !== "wallet") throw new Error(PAIRED_BLOCKED_TEXT);
    return injectedHlWallet(session.wallet.provider, session.address);
  }, [session]);

  const setPaired = useCallback(
    (master: Address) => {
      savePaired(browserKV, cfg.network, master);
      setSession((s) => (s.kind === "wallet" ? s : { kind: "paired", address: master }));
    },
    [cfg.network],
  );

  const api = useMemo<SessionApi>(
    () => ({ session, wallets, error, connect, disconnect, write, hlWallet, setPaired }),
    [session, wallets, error, connect, disconnect, write, hlWallet, setPaired],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const s = useContext(Ctx);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

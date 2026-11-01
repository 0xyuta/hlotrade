import type { ExchangeClient } from "@nktkas/hyperliquid";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useConfig } from "../config/context";
import type { Address } from "../config/validate";
import { useSession } from "../wallet/session";
import { AGENT_NAME, PHONE_AGENT_NAME, browserKV, loadAgent, type StoredAgent } from "./agent";
import { agentExchange } from "./clients";
import { enableTrading, readTradingStatus, type TradingStatus } from "./enable";
import { plainError } from "./errors";
import { chooseCode, loadRef } from "./referral";
import { applyDefaultReferrer, readReferral } from "./referralActions";
import { registerWallet } from "./register";

export interface TradingApi {
  master: Address | null; // the account orders are for (wallet address or paired master)
  agent: StoredAgent | null;
  status: TradingStatus | null;
  error: string | null;
  enabling: boolean;
  canEnable: boolean; // a wallet session on a build with a builder
  reSignNeeded: boolean;
  exchange: ExchangeClient | null; // agent-signed L1 actions
  /**
   * The code the Enable text names (shown under an Enable trading button); null when no text is shown. It is the only
   * code Enable trading may set, and only when the button pressed passes it back (`enable(shownCode)`).
   */
  referralCode: string | null;
  /**
   * Enable trading. `shownCode` is the referral code the Enable text beside the pressed button named (pass
   * `referralCode` exactly as rendered); without one, or when it is no longer the code shown for this account, no code is set.
   */
  enable(shownCode?: string | null): Promise<void>;
  refresh(): Promise<void>;
  markReSign(): void;
}

const Ctx = createContext<TradingApi | null>(null);

export function TradingProvider({ children }: { children: ReactNode }) {
  const cfg = useConfig();
  const { session, hlWallet } = useSession();
  const master = session.kind === "none" ? null : session.address;
  // The desktop trades with its "hlo" key; a paired phone with its own "hlo phone" key.
  const slot = session.kind === "paired" ? PHONE_AGENT_NAME : AGENT_NAME;
  const [agent, setAgent] = useState<StoredAgent | null>(null);
  // The status is tagged with the account and network it was read for, so a stale one is never shown for another account.
  const scope = master ? `${cfg.network}:${master.toLowerCase()}` : null;
  const [read, setRead] = useState<{ scope: string; status: TradingStatus } | null>(null);
  const status = read && read.scope === scope ? read.status : null;
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [reSignNeeded, setReSign] = useState(false);
  const latest = useRef(0); // a slow answer for an older account or key must not overwrite a newer one

  useEffect(() => setAgent(master ? loadAgent(browserKV, cfg.network, master, slot) : null), [master, slot, cfg.network]);
  useEffect(() => {
    setRead(null);
    setReadError(null);
    setActionError(null);
    setReSign(false);
  }, [scope]);

  const refresh = useCallback(async () => {
    const mine = ++latest.current;
    if (!master || !cfg.builder || !scope) return setRead(null);
    try {
      const s = await readTradingStatus(cfg.network, master, cfg.builder, agent, Date.now());
      if (mine !== latest.current) return;
      setRead({ scope, status: s });
      setReadError(null);
    } catch (e) {
      if (mine !== latest.current) return;
      setRead(null); // unknown is not "enabled"
      setReadError(plainError(e, agent?.address).text);
    }
  }, [master, agent, cfg.network, cfg.builder, scope]);
  useEffect(() => void refresh(), [refresh]);

  // Enable trading sets a default referral code when the account has none (spec 2026-10-30 referrals §3). While the
  // Enable button is offered, read `referral` once, so the Enable text names the code only when one will really be set.
  // That one value drives both the text and the action: Enable trading sends only the code the text showed.
  const needsEnable = status !== null && !(status.builderOk && status.agentOk);
  const [refNote, setRefNote] = useState<{ scope: string; code: string } | null>(null);
  useEffect(() => {
    setRefNote(null); // a new read starts: the previous code is not shown meanwhile
    if (!needsEnable || !master || !scope || session.kind !== "wallet") return;
    const code = chooseCode(loadRef(browserKV, cfg.network), cfg.referralCode);
    if (!code) return;
    let live = true;
    readReferral(cfg.network, master).then(
      (r) => {
        if (live) setRefNote(r.referredBy === null ? { scope, code } : null);
      },
      () => {
        if (live) setRefNote(null); // unknown: the text is not shown
      },
    );
    return () => {
      live = false;
    };
  }, [needsEnable, master, scope, session.kind, cfg.network, cfg.referralCode]);
  const referralCode = needsEnable && refNote?.scope === scope ? refNote.code : null;
  const shown = useRef<string | null>(null);
  shown.current = referralCode;

  // Rewards count a wallet's fills from its registration: tell the server once trading is enabled for this account.
  // That covers right after Enable trading, every app open, and a paired phone (its master is the main wallet).
  const builderOk = status?.builderOk === true;
  useEffect(() => {
    if (builderOk && master) void registerWallet(master);
  }, [builderOk, master]);

  const enable = useCallback(async (shownCode?: string | null) => {
    if (session.kind !== "wallet" || !cfg.builder) return;
    // Only the code the pressed button's Enable text named, and only while it is still the one shown for this account.
    const code = shownCode && shownCode === shown.current ? shownCode : null;
    setEnabling(true);
    setActionError(null);
    try {
      const a = await enableTrading({
        net: cfg.network, wallet: hlWallet(), master: session.address, builder: cfg.builder,
        builderOk: status?.builderOk ?? false, kv: browserKV, nowMs: Date.now(),
      });
      setAgent(a); // the new key changes `refresh`, which re-reads the status
      setReSign(false);
      // The shown referral code, signed by the new agent, in the background (spec referrals §3). A refusal is only
      // logged, never blocks trading and is not retried. The log carries Hyperliquid's words only, never a key.
      if (code) {
        void applyDefaultReferrer({ net: cfg.network, master: session.address, code, signer: { net: cfg.network, agentKey: a.key, wallet: hlWallet } }).catch(
          (e: unknown) => console.warn("[hlo] the default referral code was not set:", plainError(e, a.address).text),
        );
      }
    } catch (e) {
      setActionError(plainError(e, agent?.address).text);
      // The builder fee may have been approved before the agent step failed: read it again so it is not asked twice.
      await refresh();
    } finally {
      setEnabling(false);
    }
  }, [session, cfg.builder, cfg.network, hlWallet, status, agent, refresh]);

  const exchange = useMemo(() => (agent ? agentExchange(cfg.network, agent.key) : null), [agent, cfg.network]);
  const canEnable = session.kind === "wallet" && !!cfg.builder;
  const error = actionError ?? readError;
  const api = useMemo<TradingApi>(
    () => ({ master, agent, status, error, enabling, reSignNeeded, exchange, referralCode, enable, refresh, canEnable, markReSign: () => setReSign(true) }),
    [master, agent, status, error, enabling, reSignNeeded, exchange, referralCode, enable, refresh, canEnable],
  );
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useTrading(): TradingApi {
  const t = useContext(Ctx);
  if (!t) throw new Error("useTrading outside TradingProvider");
  return t;
}

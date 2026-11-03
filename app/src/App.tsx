import { Suspense, useEffect, useState } from "react";
import { ConfigProvider } from "./config/context";
import type { AppConfig } from "./config/validate";
import { AccountProvider } from "./hl/AccountProvider";
import { browserKV } from "./hl/agent";
import { HlProvider } from "./hl/HlProvider";
import { INTRO_KEY, INTRO_SEEN, INTRO_TITLE, showIntro } from "./rewards/intro";
import { captureRef } from "./hl/referral";
import { TradingProvider } from "./hl/TradingProvider";
import { BottomNav } from "./ui/BottomNav";
import { ErrorBoundary, useRetryableLazy } from "./ui/ErrorBoundary";
import { Footer } from "./ui/Footer";
import { Loading } from "./ui/Loading";
import { Modal } from "./ui/Modal";
import { MODE_KEY, parseMode, type AppMode } from "./ui/mode";
import { MoreScreen } from "./ui/MoreScreen";
import { TopBar } from "./ui/TopBar";
import { TradeScreen, type TradeView } from "./ui/trade/TradeScreen";
import { useNarrow } from "./ui/useNarrow";
import { SessionProvider } from "./wallet/session";

const loadRewards = () => import("./ui/rewards/RewardsScreen").then((m) => ({ default: m.RewardsScreen }));
const loadExplore = () => import("./ui/explore/ExploreScreen").then((m) => ({ default: m.ExploreScreen }));
const loadBots = () => import("./ui/bots/BotsScreen").then((m) => ({ default: m.BotsScreen }));
const loadTokenomics = () => import("./ui/tokenomics/TokenomicsScreen").then((m) => ({ default: m.TokenomicsScreen }));
const loadMine = () => import("./ui/mine/MineScreen").then((m) => ({ default: m.MineScreen }));
const loadReferrals = () => import("./ui/referrals/ReferralsScreen").then((m) => ({ default: m.ReferralsScreen }));
const loadIntro = () => import("./ui/intro/IntroModal").then((m) => ({ default: m.IntroModal }));

/** "markets", "positions" and "more" are phone screens (the bottom bar); a wide screen shows them as Trade. */
export type Tab = TradeView | "rewards" | "explore" | "bots" | "tokenomics" | "referrals" | "more";

const LAZY_TABS = ["rewards", "explore", "bots", "tokenomics", "referrals"] as const;
type LazyTab = (typeof LAZY_TABS)[number];
const isLazy = (t: Tab): t is LazyTab => (LAZY_TABS as readonly Tab[]).includes(t);

export function App({ config }: { config: AppConfig }) {
  const narrow = useNarrow();
  // /bots is the Bots tab's public link. The address bar is left as it is.
  const [picked, setTab] = useState<Tab>(window.location.pathname === "/bots" ? "bots" : narrow ? "markets" : "trade");
  const tab: Tab = !narrow && (picked === "markets" || picked === "positions" || picked === "more") ? "trade" : picked;
  // Rewards, Explore, Bots, Tokenomics and Referrals are lazy screens with their own retry. A Record, so a new one without a screen fails the typecheck.
  const lazy: Record<LazyTab, ReturnType<typeof useRetryableLazy>> = {
    rewards: useRetryableLazy(loadRewards),
    explore: useRetryableLazy(loadExplore),
    bots: useRetryableLazy(loadBots),
    tokenomics: useRetryableLazy(loadTokenomics),
    referrals: useRetryableLazy(loadReferrals),
  };
  // A `?ref=CODE` link (spec 2026-10-30 referrals §3) is kept for Enable trading, once, after the first render. The
  // address bar is left as it is.
  useEffect(() => {
    captureRef(window.location.search, browserKV, config.network);
  }, [config.network]);
  const mineScreen = useRetryableLazy(loadMine);
  // The public /bots link always opens the full app.
  const [mode, setMode] = useState<AppMode>(() => (window.location.pathname === "/bots" ? "full" : parseMode(browserKV.getItem(MODE_KEY))));
  const mine = mode === "mine";
  const switchMode = (m: AppMode) => {
    setMode(m);
    browserKV.setItem(MODE_KEY, m);
  };
  const [LazyScreen, retry] = mine ? mineScreen : isLazy(tab) ? lazy[tab] : [null, undefined];
  // The first-visit intro: once per browser, on mainnet; Skip, Start, ✕ or Escape all mark it seen.
  const [intro, setIntro] = useState(() => showIntro(config.network, browserKV.getItem(INTRO_KEY)));
  const [Intro, retryIntro] = useRetryableLazy(loadIntro);
  const closeIntro = () => {
    setIntro(false);
    browserKV.setItem(INTRO_KEY, INTRO_SEEN);
  };
  return (
    <ConfigProvider value={config}>
      <SessionProvider>
        <HlProvider>
          <TradingProvider>
            <AccountProvider>
              <div className={`app ${narrow && !mine ? "has-bottom-nav" : ""}`}>
                <TopBar tab={tab} onTab={setTab} mode={mode} onMode={switchMode} />
                <main className="main">
                  {/*
                    Keyed by tab: a failed screen does not take the other ones down. React keeps a failed lazy import, so
                    switching tabs alone would not load that screen again: its fallback offers Try again, which makes a fresh
                    import (final review M5) and cures a dropped connection. A file a redeploy removed needs a reload,
                    which forgets transfers held in memory (docs/APP.md §4).
                  */}
                  <ErrorBoundary key={mine ? "mine" : isLazy(tab) || tab === "more" ? tab : "trade"} scope="screen" network={config.network} onRetry={retry}>
                    {!mine && tab === "more" ? (
                      <MoreScreen onTab={setTab} />
                    ) : LazyScreen === null ? (
                      <TradeScreen view={tab as TradeView} onView={setTab} />
                    ) : (
                      <Suspense fallback={<Loading />}>
                        <LazyScreen />
                      </Suspense>
                    )}
                  </ErrorBoundary>
                </main>
                <Footer />
                {narrow && !mine && <BottomNav tab={tab} onTab={setTab} />}
                {intro && (
                  // Nothing shows while the chunk loads; a failed load offers Try again in a dialog that can be closed.
                  <ErrorBoundary scope="screen" network={config.network} onRetry={retryIntro} frame={(body) => <Modal title={INTRO_TITLE} onClose={closeIntro}>{body}</Modal>}>
                    <Suspense fallback={null}>
                      <Intro onClose={closeIntro} />
                    </Suspense>
                  </ErrorBoundary>
                )}
              </div>
            </AccountProvider>
          </TradingProvider>
        </HlProvider>
      </SessionProvider>
    </ConfigProvider>
  );
}

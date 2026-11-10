import { Suspense, useEffect, useState } from "react";
import { ConfigProvider } from "./config/context";
import type { AppConfig } from "./config/validate";
import { AccountProvider } from "./hl/AccountProvider";
import { browserKV } from "./hl/agent";
import { HlProvider } from "./hl/HlProvider";
import { INTRO_KEY, INTRO_SEEN, INTRO_TITLE, showIntro } from "./rewards/intro";
import { captureRef } from "./hl/referral";
import { coinFromLink } from "./hl/coinLink";
import { TradingProvider } from "./hl/TradingProvider";
import { BottomNav } from "./ui/BottomNav";
import { ErrorBoundary, useRetryableLazy } from "./ui/ErrorBoundary";
import { Footer } from "./ui/Footer";
import { Loading } from "./ui/Loading";
import { Modal } from "./ui/Modal";
import { MoreScreen } from "./ui/MoreScreen";
import { TopBar } from "./ui/TopBar";
import { TradeScreen, type TradeView } from "./ui/trade/TradeScreen";
import { useNarrow } from "./ui/useNarrow";
import { SessionProvider } from "./wallet/session";
import { BUY_HLO_EVENT } from "./swap/intent";

const loadRewards = () => import("./ui/rewards/RewardsScreen").then((m) => ({ default: m.RewardsScreen }));
const loadExplore = () => import("./ui/explore/ExploreScreen").then((m) => ({ default: m.ExploreScreen }));
const loadBots = () => import("./ui/bots/BotsScreen").then((m) => ({ default: m.BotsScreen }));
const loadTokenomics = () => import("./ui/tokenomics/TokenomicsScreen").then((m) => ({ default: m.TokenomicsScreen }));
const loadReferrals = () => import("./ui/referrals/ReferralsScreen").then((m) => ({ default: m.ReferralsScreen }));
const loadSwap = () => import("./ui/swap/SwapScreen").then((m) => ({ default: m.SwapScreen }));
const loadIntro = () => import("./ui/intro/IntroModal").then((m) => ({ default: m.IntroModal }));

/** "markets", "positions" and "more" are phone screens (the bottom bar); a wide screen shows them as Trade. */
export type Tab = TradeView | "rewards" | "explore" | "bots" | "tokenomics" | "referrals" | "more";

const LAZY_TABS = ["rewards", "explore", "bots", "tokenomics", "referrals"] as const;
type LazyTab = (typeof LAZY_TABS)[number];
const isLazy = (t: Tab): t is LazyTab => (LAZY_TABS as readonly Tab[]).includes(t);

export function App({ config }: { config: AppConfig }) {
  const narrow = useNarrow();
  // /bots is a public link. /swap opens Rewards with the swap card on top (the address bar stays). A ?coin= link opens Trade.
  const [linkCoin] = useState(() => coinFromLink(window.location.search));
  const [swapOpen, setSwapOpen] = useState(() => window.location.pathname === "/swap");
  const [picked, setTab] = useState<Tab>(window.location.pathname === "/bots" ? "bots" : window.location.pathname === "/swap" ? "rewards" : linkCoin || !narrow ? "trade" : "markets");
  const tab: Tab = !narrow && (picked === "markets" || picked === "positions" || picked === "more") ? "trade" : picked;
  // Rewards, Explore, Bots, Tokenomics and Referrals are lazy screens with their own retry. A Record, so a new one without a screen fails the typecheck.
  const lazy: Record<LazyTab, ReturnType<typeof useRetryableLazy>> = {
    rewards: useRetryableLazy(loadRewards),
    explore: useRetryableLazy(loadExplore),
    bots: useRetryableLazy(loadBots),
    tokenomics: useRetryableLazy(loadTokenomics),
    referrals: useRetryableLazy(loadReferrals),
  };
  const [SwapScreen, retrySwap] = useRetryableLazy(loadSwap);
  // A `?ref=CODE` link (spec 2026-10-30 referrals §3) is kept for Enable trading, once, after the first render. The
  // address bar is left as it is.
  useEffect(() => {
    captureRef(window.location.search, browserKV, config.network);
  }, [config.network]);
  useEffect(() => {
    const onBuy = () => setSwapOpen(true);
    window.addEventListener(BUY_HLO_EVENT, onBuy);
    return () => window.removeEventListener(BUY_HLO_EVENT, onBuy);
  }, []);
  const closeSwap = () => setSwapOpen(false);
  const [LazyScreen, retry] = isLazy(tab) ? lazy[tab] : [null, undefined];
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
              <div className={`app ${narrow ? "has-bottom-nav" : ""}`}>
                <TopBar tab={tab} onTab={setTab} />
                <main className="main">
                  {/*
                    Keyed by tab: a failed screen does not take the other ones down. React keeps a failed lazy import, so
                    switching tabs alone would not load that screen again: its fallback offers Try again, which makes a fresh
                    import (final review M5) and cures a dropped connection. A file a redeploy removed needs a reload,
                    which forgets transfers held in memory (docs/APP.md §4).
                  */}
                  <ErrorBoundary key={isLazy(tab) || tab === "more" ? tab : "trade"} scope="screen" network={config.network} onRetry={retry}>
                    {tab === "more" ? (
                      <MoreScreen onTab={setTab} />
                    ) : LazyScreen === null ? (
                      <TradeScreen view={tab as TradeView} onView={setTab} linkCoin={linkCoin} />
                    ) : (
                      <Suspense fallback={<Loading />}>
                        <LazyScreen />
                      </Suspense>
                    )}
                  </ErrorBoundary>
                </main>
                <Footer />
                {narrow && <BottomNav tab={tab} onTab={setTab} />}
                {swapOpen && (
                  <ErrorBoundary scope="screen" network={config.network} onRetry={retrySwap} frame={(body) => <Modal title="Swap" onClose={closeSwap}>{body}</Modal>}>
                    <Suspense fallback={<Modal title="Swap" onClose={closeSwap}><Loading /></Modal>}>
                      <Modal title="Swap" onClose={closeSwap}>
                        <SwapScreen />
                      </Modal>
                    </Suspense>
                  </ErrorBoundary>
                )}
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

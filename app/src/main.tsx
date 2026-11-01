import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { config, configProblem } from "./config/load";
import { takeEntry } from "./entry";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { Loading } from "./ui/Loading";
import { NotDeployed } from "./ui/NotDeployed";

// Each route is its own chunk: /pair on a phone never downloads the trading app.
const App = lazy(() => import("./App").then((m) => ({ default: m.App })));
const PairPage = lazy(() => import("./ui/pair/PairPage").then((m) => ({ default: m.PairPage })));

// Before React renders: on /pair, an old `/pair#…` link's fragment is dropped from the address bar, unread.
const entry = takeEntry(window);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary network={config?.network ?? null}>
      {!config ? (
        <NotDeployed problem={configProblem} />
      ) : (
        <Suspense fallback={<Loading page />}>
          {entry.page === "pair" ? <PairPage net={config.network} legacyLink={entry.legacyLink} /> : <App config={config} />}
        </Suspense>
      )}
    </ErrorBoundary>
  </StrictMode>,
);

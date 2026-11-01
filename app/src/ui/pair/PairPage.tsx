import { useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import type { Address, Network } from "../../config/validate";
import { PHONE_AGENT_VALID_DAYS } from "../../hl/agent";
import { PAIR_CODE_HEX_LENGTH } from "../../hl/pairCode";
import { LOST_TEXT, STORAGE_BLOCKED, cancelPairing, confirmPairing, resolveStagedMaster, stagePairCode } from "../../hl/pairing";
import { shortAddr } from "../format";
import { CAMERA_TEXT } from "./scan";
import { Scanner as CameraScanner, type ScannerProps } from "./Scanner";

export const LEGACY_LINK_TEXT =
  "This pairing link is no longer used, and nothing from it was saved. Scan from the pairing page instead: on your computer open Account, then Pair phone, approve, and scan the code it shows from this page.";

type Step =
  | { s: "start" }
  | { s: "scan" }
  | { s: "type"; note?: string }
  | { s: "checking" }
  | { s: "ask"; master: Address }
  | { s: "done"; master: Address }
  | { s: "declined" }
  | { s: "blocked" }
  | { s: "problem"; text: string; retry: boolean };

/**
 * The phone's page at /pair (Plan 4 A). The key arrives only by scanning the computer's code in-page or typing it,
 * never in a URL. It waits in hl/pairing.ts (module memory) until "Pair this phone"; leaving the page drops it.
 */
export function PairPage({ net, legacyLink, Scanner = CameraScanner }: { net: Network; legacyLink: boolean; Scanner?: ComponentType<ScannerProps> }) {
  const [step, setStep] = useState<Step>({ s: "start" });
  const [hint, setHint] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    window.addEventListener("pagehide", cancelPairing);
    return () => {
      alive.current = false;
      window.removeEventListener("pagehide", cancelPairing);
      cancelPairing();
    };
  }, []);

  const check = async () => {
    setStep({ s: "checking" });
    const r = await resolveStagedMaster();
    if (!alive.current) return;
    setStep(r.ok ? { s: "ask", master: r.master } : { s: "problem", text: r.reason, retry: r.retry });
  };
  const stage = (text: string) => {
    const r = stagePairCode(text, net);
    if (!r.ok) {
      setHint(r.reason);
      return r;
    }
    setHint(null);
    void check();
    return r;
  };
  const take = (text: string): boolean => stage(text).ok;
  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    const r = stage(typed);
    // Read, or a whole code that can never pair here (another network's, not a valid key): the field lets it go.
    // A typo or a short code stays, to be corrected.
    if (r.ok || r.discard) setTyped("");
  };
  /** A new step starts without the last step's hint (a scan's "not a code" must not show under the typed field). */
  const go = (next: Step) => {
    setHint(null);
    setStep(next);
  };
  const restart = () => {
    cancelPairing();
    go({ s: "start" });
  };
  const open = <a className="btn primary wide" href="/">Open HLO</a>;

  let body: JSX.Element;
  switch (step.s) {
    case "start":
      body = (
        <>
          {legacyLink && <p className="warn">{LEGACY_LINK_TEXT}</p>}
          <ol className="small">
            <li>On your computer, open HLO, then Account, then Pair phone, and approve the phone in your wallet.</li>
            <li>Scan the pairing code it shows with this page.</li>
          </ol>
          <p className="muted small">Only scan a code from your own computer. This phone will be able to trade on that account. It can never withdraw.</p>
          <div className="row wrap">
            <button className="btn primary" style={{ flex: 1 }} onClick={() => go({ s: "scan" })}>Scan the code</button>
            <button className="btn" style={{ flex: 1 }} onClick={() => go({ s: "type" })}>Type the code instead</button>
          </div>
        </>
      );
      break;
    case "scan":
      body = (
        <>
          <p className="small">Point the camera at the pairing code on your computer.</p>
          <Scanner onText={take} onProblem={(p) => go({ s: "type", note: CAMERA_TEXT[p] })} />
          {hint && <p className="error">{hint}</p>}
          <button className="btn wide" style={{ marginTop: 10 }} onClick={() => go({ s: "type" })}>Type the code instead</button>
        </>
      );
      break;
    case "type":
      body = (
        <form onSubmit={submitTyped}>
          {step.note && <p className="note">{step.note}</p>}
          <div className="field">
            <label htmlFor="paircode">Pairing code ({PAIR_CODE_HEX_LENGTH} characters, shown under the code on your computer)</label>
            <input
              id="paircode"
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
            />
          </div>
          {hint && <p className="error">{hint}</p>}
          <button className="btn primary wide" type="submit">Check code</button>
          <button className="btn wide" type="button" style={{ marginTop: 10 }} onClick={() => go({ s: "scan" })}>Scan the code instead</button>
        </form>
      );
      break;
    case "checking":
      body = <p className="muted" role="status">Checking the code with Hyperliquid…</p>;
      break;
    case "ask":
      body = (
        <>
          <p>Pair this phone with <span className="mono">{shortAddr(step.master)}</span>?</p>
          {/* the whole address too: a short form of 4 + 4 characters can be matched by a made-up address */}
          <p className="mono small muted" style={{ overflowWrap: "anywhere" }}>{step.master}</p>
          <p className="muted small">The phone will be able to trade on that account. It can never withdraw. Only continue if the code came from your own computer.</p>
          <div className="row">
            <button
              className="btn primary"
              style={{ flex: 1 }}
              onClick={() => {
                const r = confirmPairing();
                setStep(r === STORAGE_BLOCKED ? { s: "blocked" } : r ? { s: "done", master: r } : { s: "problem", text: LOST_TEXT, retry: false });
              }}
            >
              Pair this phone
            </button>
            <button className="btn" style={{ flex: 1 }} onClick={() => { cancelPairing(); setStep({ s: "declined" }); }}>Not now</button>
          </div>
        </>
      );
      break;
    case "done":
      body = (
        <>
          <p>This phone can now trade for <span className="mono">{shortAddr(step.master)}</span>.</p>
          <p className="muted small">
            Its trading key works for {PHONE_AGENT_VALID_DAYS} days. Pair again from your computer to renew it; your computer can also cut it off at any time.
            Claims, staking, deposits, withdrawals and profile changes stay on the device with your wallet.
          </p>
          {open}
        </>
      );
      break;
    case "declined":
      body = (
        <>
          <p>This phone was not paired.</p>
          {open}
        </>
      );
      break;
    case "blocked":
      body = (
        <>
          <p className="error">This browser did not save the pairing (its storage is blocked, as in some private windows). Open this page in a normal browser window and scan the code again.</p>
          {open}
        </>
      );
      break;
    case "problem":
      body = (
        <>
          <p className="error">{step.text}</p>
          {step.retry ? (
            <button className="btn primary wide" onClick={() => void check()}>Try again</button>
          ) : (
            <button className="btn primary wide" onClick={restart}>Start over</button>
          )}
        </>
      );
      break;
  }

  return (
    <div className="app">
      <main className="main" style={{ maxWidth: 520 }}>
        <div className="card">
          <h1 className="card-h">Pair phone</h1>
          {body}
        </div>
      </main>
    </div>
  );
}

import { useRef, useState } from "react";
import { useConfig } from "../../config/context";
import { browserKV } from "../../hl/agent";
import { plainError } from "../../hl/errors";
import {
  CLAIM_MINIMUM_TEXT, CODE_RULE_TEXT, MIN_REFERRAL_CLAIM, NO_LINK_TEXT, REFERRAL_INTRO_TEXT, REFERRAL_REWARDS_TEXT, REFERRED_TEXT, USE_CODE_TEXT, chooseCode, codeToOffer, enableReferralText,
  joinedText, loadRef, refLink, referralGate, remainingToCreateText, usdText, validCode,
} from "../../hl/referral";
import { REFERRAL_SIGNER, sendClaimRewards, sendRegisterReferrer, sendSetReferrer, type ReferralSigner } from "../../hl/referralActions";
import { useTrading } from "../../hl/TradingProvider";
import { useSession } from "../../wallet/session";
import { fmtUsd, shortAddr } from "../format";
import { WalletButton } from "../WalletButton";
import { useReferral } from "./useReferral";

type Busy = "use" | "create" | "claim";
const COPY_FAILED = "Could not copy. Select the link and copy it by hand.";

/** The Referrals tab (spec 2026-10-30 referrals §4): Hyperliquid's referral program for this account. Rules in hl/referral.ts. */
export function ReferralsScreen() {
  const cfg = useConfig();
  const { session, hlWallet } = useSession();
  const trading = useTrading();
  const { state, reload } = useReferral(cfg.network, trading.master);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [typedUse, setTypedUse] = useState<string | null>(null); // null: the default code
  const [typedCreate, setTypedCreate] = useState("");
  const [copied, setCopied] = useState(false);
  const sending = useRef(false); // set at once, so a double click cannot sign twice

  if (session.kind === "none" || !trading.master) {
    return (
      <section className="card">
        <h2 className="card-h">Referrals</h2>
        <p>{REFERRAL_INTRO_TEXT}</p>
        <p className="muted">Connect a wallet to see your referrals.</p>
        <WalletButton />
      </section>
    );
  }
  if (state.kind === "loading") return <section className="card"><p className="muted">Loading referrals…</p></section>;
  if (state.kind === "down") {
    return (
      <section className="card">
        <h2 className="card-h">Referrals</h2>
        {msg && <p className={msg.ok ? "note" : "error"}>{msg.text}</p>}
        <p>Hyperliquid did not answer, so your referrals cannot be shown. Trading still works.</p>
        <p className="muted small">{state.error}</p>
        <button className="btn" onClick={reload}>Try again</button>
      </section>
    );
  }

  const v = state.view;
  const st = v.referrer;
  const gate = referralGate({
    kind: session.kind,
    needsAgent: REFERRAL_SIGNER === "agent",
    agentReady: !!trading.agent && trading.status?.agentOk === true,
    checking: !!cfg.builder && !trading.status && !trading.error,
  });
  const signer: ReferralSigner = { net: cfg.network, agentKey: trading.agent?.key ?? null, wallet: hlWallet };
  const off = !gate.allowed || busy !== null;
  const codeToUse = typedUse ?? codeToOffer(chooseCode(loadRef(browserKV, cfg.network), cfg.referralCode), st.stage === "ready" ? st.code : null);
  // HLO's ?ref= capture keeps only letters and digits, so a code with anything else gets no link.
  const link = st.stage === "ready" && validCode(st.code) ? refLink(window.location.origin, st.code) : "";

  const run = async (what: Busy, action: () => Promise<void>, done: string) => {
    if (sending.current || !gate.allowed) return;
    sending.current = true;
    setBusy(what);
    setMsg(null);
    try {
      await action();
      setMsg({ ok: true, text: done });
    } catch (e) {
      const pe = plainError(e, trading.agent?.address);
      if (pe.reSign) trading.markReSign();
      setMsg({ ok: false, text: pe.text });
    } finally {
      sending.current = false;
      setBusy(null);
      reload();
    }
  };
  const copy = () => {
    try {
      if (!navigator.clipboard) return setMsg({ ok: false, text: COPY_FAILED });
      navigator.clipboard.writeText(link).then(() => setCopied(true), () => setMsg({ ok: false, text: COPY_FAILED }));
    } catch {
      setMsg({ ok: false, text: COPY_FAILED });
    }
  };

  return (
    <>
      {!gate.allowed && <p className="note">{gate.blockedText}</p>}
      {gate.offerEnable && trading.canEnable && (
        <div style={{ marginBottom: 12 }}>
          {/* The same Enable text rule as the account menu and the order form: only the code the text shows is set. */}
          <button className="btn primary" disabled={trading.enabling} onClick={() => void trading.enable(trading.referralCode)}>
            {trading.enabling ? "Confirm in your wallet…" : "Enable trading"}
          </button>
          {trading.referralCode && <p className="muted small">{enableReferralText(trading.referralCode)}</p>}
        </div>
      )}
      {msg && <p className={msg.ok ? "note" : "error"}>{msg.text}</p>}
      <div className="grid2">
        <section className="card">
          <h2 className="card-h">Referred by</h2>
          {v.referredBy ? (
            <>
              <div className="stat"><span className="k">Code</span><span className="v">{v.referredBy.code}</span></div>
              <p className="muted small">{REFERRED_TEXT}</p>
            </>
          ) : (
            <>
              <p className="card-sub">{USE_CODE_TEXT}</p>
              <div className="field">
                <label htmlFor="ref-use">Referral code</label>
                <div className="row">
                  <input id="ref-use" className="input" value={codeToUse} maxLength={20} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setTypedUse(e.target.value)} />
                  <button className="btn" disabled={off || !validCode(codeToUse)} onClick={() => void run("use", () => sendSetReferrer(signer, codeToUse), `Referral code ${codeToUse} is set.`)}>
                    {busy === "use" ? "Sending…" : "Use code"}
                  </button>
                </div>
              </div>
              {codeToUse !== "" && !validCode(codeToUse) && <p className="muted small">{CODE_RULE_TEXT}</p>}
            </>
          )}
        </section>

        <section className="card">
          <h2 className="card-h">Your code</h2>
          {st.stage === "needToTrade" ? (
            <p>{remainingToCreateText(st.required, v.cumVlm)}</p>
          ) : st.stage === "needToCreateCode" ? (
            <>
              <div className="field">
                <label htmlFor="ref-create">New code</label>
                <div className="row">
                  <input id="ref-create" className="input" value={typedCreate} maxLength={20} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setTypedCreate(e.target.value)} />
                  <button className="btn" disabled={off || !validCode(typedCreate)} onClick={() => void run("create", () => sendRegisterReferrer(signer, typedCreate), `Your code ${typedCreate} is created.`)}>
                    {busy === "create" ? "Sending…" : "Create code"}
                  </button>
                </div>
              </div>
              <p className="muted small">{CODE_RULE_TEXT}</p>
            </>
          ) : st.stage === "ready" ? (
            <>
              <div className="stat"><span className="k">Code</span><span className="v">{st.code}</span></div>
              {link ? (
                <div className="field" style={{ marginTop: 10 }}>
                  <label htmlFor="ref-link">Share link</label>
                  <div className="row">
                    <input id="ref-link" className="input mono" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
                    <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button>
                  </div>
                </div>
              ) : (
                <p className="muted small">{NO_LINK_TEXT}</p>
              )}
              <div className="stat"><span className="k">Referrals</span><span className="v">{st.count}</span></div>
              {st.referrals.length > 0 && (
                <div className="scroll-x">
                  <table className="table">
                    <thead>
                      <tr><th>Account</th><th className="num">Volume</th><th className="num">Your rewards</th><th>Joined</th></tr>
                    </thead>
                    <tbody>
                      {st.referrals.map((r) => (
                        <tr key={r.user}>
                          <td className="mono">{shortAddr(r.user)}</td>
                          <td className="num">${fmtUsd(r.volume, 0)}</td>
                          <td className="num">{usdText(r.rewarded)}</td>
                          <td>{joinedText(r.joined)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <p className="muted">Hyperliquid&apos;s answer does not say yet whether you can create a code.</p>
          )}
        </section>

        <section className="card">
          <h2 className="card-h">Referral rewards</h2>
          <div className="stat"><span className="k">Unclaimed</span><span className="v">{usdText(v.unclaimed)}</span></div>
          <div className="stat"><span className="k">Claimed</span><span className="v">{usdText(v.claimed)}</span></div>
          <p className="muted small">{REFERRAL_REWARDS_TEXT}</p>
          {v.unclaimed > 0 && v.unclaimed < MIN_REFERRAL_CLAIM && <p className="muted small">{CLAIM_MINIMUM_TEXT}</p>}
          {v.unclaimed >= MIN_REFERRAL_CLAIM && (
            <button className="btn primary" disabled={off} onClick={() => void run("claim", () => sendClaimRewards(signer), "Referral rewards claimed.")}>
              {busy === "claim" ? "Sending…" : "Claim"}
            </button>
          )}
        </section>
      </div>
    </>
  );
}

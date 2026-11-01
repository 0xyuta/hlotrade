import { Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { keccak256, toBytes, zeroAddress } from "viem";
import { useConfig } from "../config/context";
import { profilesAbi } from "../evm/abi";
import { publicClient } from "../evm/clients";
import { browserKV, clearPhoneRecord, loadPhoneRecord } from "../hl/agent";
import { cutOffPhone } from "../hl/enable";
import { plainError } from "../hl/errors";
import { enableReferralText } from "../hl/referral";
import { useTrading } from "../hl/TradingProvider";
import { AVATAR_COUNT } from "../profile/avatar";
import { validateName } from "../profile/name";
import { useProfile } from "../profile/useProfile";
import { viemChain } from "../wallet/chains";
import { allowed, PAIRED_BLOCKED_TEXT } from "../wallet/permissions";
import { useSession } from "../wallet/session";
import { Avatar } from "./Avatar";
import { ErrorBoundary, useRetryableLazy } from "./ErrorBoundary";
import { shortAddr } from "./format";
import { Loading } from "./Loading";
import { Modal } from "./Modal";

const loadPairModal = () => import("./PairModal").then((m) => ({ default: m.PairModal }));

export function AccountMenu({ onTransfer }: { onTransfer?(d: "deposit" | "withdraw"): void }) {
  const cfg = useConfig();
  const { session, disconnect, write, hlWallet } = useSession();
  const trading = useTrading();
  const address = session.kind === "none" ? null : session.address;
  const profile = useProfile(address);
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState(false); // the profile editor, folded away once a username is set
  const [msg, setMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false); // one wallet prompt at a time
  const [notice, setNotice] = useState<string | null>(null);
  const [cutting, setCutting] = useState<"idle" | "ask" | "busy">("idle");
  const [cutResult, setCutResult] = useState<{ ok: boolean; text: string } | null>(null);
  const cutInFlight = useRef(false); // a ref, so two clicks in the same tick still sign once
  const anchor = useRef<HTMLDivElement>(null);
  const pairingRef = useRef(false);
  pairingRef.current = pairing;
  const [PairModal, retryPair] = useRetryableLazy(loadPairModal);

  // A closed menu forgets a cut-off's answer and an open confirmation (Task 9 review m3); an answer still on its way shows
  // on the next open.
  useEffect(() => {
    if (open || cutInFlight.current) return;
    setCutResult(null);
    setCutting("idle");
  }, [open]);
  // Escape and a click outside close the menu (the pair dialog handles its own Escape).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || pairingRef.current) return;
      setOpen(false);
      anchor.current?.querySelector<HTMLElement>("button[aria-label='Account']")?.focus();
    };
    const onDown = (e: MouseEvent) => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  if (!address) return null;
  const kind = session.kind;
  const pairFrame = (body: ReactNode) => (
    <Modal title="Pair phone" onClose={() => setPairing(false)}>
      {body}
    </Modal>
  );
  const profiles = cfg.contracts?.profiles;

  const saveName = async () => {
    const bad = validateName(name);
    if (bad) return setMsg(bad);
    if (!profiles || busy) return;
    if (name === profile.name) return setMsg("That is already your username.");
    setBusy(true);
    try {
      setMsg("Checking the name…");
      const owner = await publicClient(viemChain("hyperEvm", cfg)).readContract({
        address: profiles, abi: profilesAbi, functionName: "ownerOfName", args: [keccak256(toBytes(name))],
      });
      if (owner !== zeroAddress && owner.toLowerCase() !== address.toLowerCase()) return setMsg("That name is taken.");
      setMsg("Confirm in your wallet (HyperEVM, needs a little HYPE for gas)…");
      await write("hyperEvm", { address: profiles, abi: profilesAbi, functionName: "setName", args: [name] });
      setMsg("Saved.");
      setName("");
      setEditing(false);
      profile.reload();
    } catch (e) {
      setMsg(plainError(e).text);
    } finally {
      setBusy(false);
    }
  };
  const setAvatar = async (id: number) => {
    if (!profiles || busy || id === profile.avatar) return;
    setBusy(true);
    try {
      setMsg("Confirm in your wallet (HyperEVM, needs a little HYPE for gas)…");
      await write("hyperEvm", { address: profiles, abi: profilesAbi, functionName: "setAvatar", args: [id] });
      setMsg("Saved.");
      profile.reload();
    } catch (e) {
      setMsg(plainError(e).text);
    } finally {
      setBusy(false);
    }
  };
  const copy = () => {
    const failed = () => setMsg("Could not copy. Select the address and copy it by hand.");
    // navigator.clipboard is missing outside a secure context; writeText may also throw at once rather than reject.
    let p: Promise<void>;
    try {
      if (!navigator.clipboard) return failed();
      p = navigator.clipboard.writeText(address);
    } catch {
      return failed();
    }
    p.then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      },
      failed, // clipboard blocked or unavailable
    );
  };
  const st = trading.status;
  const tradingOn = !!st?.builderOk && !!st.agentOk;
  // A key is stored and its status is still being read: neither "not enabled" nor an Enable button yet.
  const checking = !!cfg.builder && !st && !!trading.agent && !trading.error;
  const phone = kind === "wallet" ? loadPhoneRecord(browserKV, cfg.network, address) : null; // read each render: cheap, and current after a pairing
  // Cut off the paired phone (Plan 4 B): one signature by the main wallet replaces the phone's agent with a throwaway.
  // The record of the phone goes only on a confirmed answer; a refusal or an unconfirmed answer keeps it.
  const cutOff = async () => {
    if (cutInFlight.current || busy) return;
    cutInFlight.current = true;
    const net = cfg.network;
    setBusy(true);
    setCutting("busy");
    setCutResult(null);
    try {
      await cutOffPhone({ net, wallet: hlWallet(), nowMs: Date.now() });
      clearPhoneRecord(browserKV, net, address);
      setCutResult({ ok: true, text: "The paired phone is cut off. Its trading key no longer works. To trade on a phone again, open Pair phone (one signature)." });
    } catch (e) {
      setCutResult({ ok: false, text: plainError(e).text });
    } finally {
      cutInFlight.current = false;
      setBusy(false);
      setCutting("idle");
    }
  };

  return (
    <div className="menu-anchor" ref={anchor}>
      <button className="btn row" onClick={() => setOpen(!open)} aria-label="Account" aria-expanded={open}>
        <Avatar id={profile.avatar} size={22} />
        <span className="mono small">{profile.name || shortAddr(address)}</span>
      </button>
      {open && (
        <div className="menu">
          <div className="row between">
            <div className="row">
              <Avatar id={profile.avatar} size={34} />
              <div>
                <div>{profile.name || "no username"}</div>
                <div className="mono small muted">{shortAddr(address)}{kind === "paired" ? " · paired phone" : ""}</div>
              </div>
            </div>
            <div className="row">
              <button className="btn small" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </button>
              <button className="btn small" onClick={() => { setOpen(false); disconnect(); }}>{kind === "paired" ? "Unpair this phone" : "Disconnect"}</button>
            </div>
          </div>

          <hr />
          {allowed(kind, "transfer") && onTransfer && (
            <div className="row" style={{ marginBottom: 8 }}>
              <button className="btn small" onClick={() => { setOpen(false); onTransfer("deposit"); }}>Deposit</button>
              <button className="btn small" onClick={() => { setOpen(false); onTransfer("withdraw"); }}>Withdraw</button>
            </div>
          )}
          <div className="small">
            <strong>Trading</strong>{" "}
            {!cfg.builder ? <span className="muted">not available on this build</span>
              : tradingOn ? <span className="up">enabled{st.agentValidUntil ? ` until ${new Date(st.agentValidUntil).toLocaleDateString()}` : ""}</span>
              : checking ? <span className="muted">checking…</span>
              : <span className="muted">not enabled</span>}
          </div>
          {allowed(kind, "enable") ? (
            !tradingOn && !checking && (
              <>
                <button className="btn primary wide" style={{ marginTop: 6 }} disabled={!trading.canEnable || trading.enabling} onClick={() => void trading.enable(trading.referralCode)}>
                  {trading.enabling ? "Confirm in your wallet…" : "Enable trading"}
                </button>
                {cfg.builder && (
                  <p className="muted small" style={{ margin: "6px 0 0" }}>Your wallet asks to approve the 0.1% builder fee, then a trading key for this computer. The key can trade but never withdraw.</p>
                )}
                {cfg.builder && trading.referralCode && (
                  <p className="muted small" style={{ margin: "6px 0 0" }}>{enableReferralText(trading.referralCode)}</p>
                )}
              </>
            )
          ) : (
            <>
              <p className="note small">{PAIRED_BLOCKED_TEXT}</p>
              {cfg.builder && st && !tradingOn && (
                <p className="muted small">This phone&apos;s trading key is not approved any more. Pair it again from the device with your wallet.</p>
              )}
            </>
          )}
          {trading.error && <p className="error">{trading.error}</p>}
          {allowed(kind, "pair") && (
            <button className="menu-item" disabled={!st?.builderOk || busy} onClick={() => { setNotice(null); setCutResult(null); setPairing(true); }}>Pair phone…</button>
          )}
          {allowed(kind, "pair") && cfg.builder && (
            <>
              {phone && phone.validUntil > Date.now() && (
                <p className="muted small" style={{ margin: "4px 0" }}>Paired phone: its key works until {new Date(phone.validUntil).toLocaleDateString()}.</p>
              )}
              {cutting === "idle" ? (
                <button className="menu-item" disabled={busy} onClick={() => { setNotice(null); setCutResult(null); setCutting("ask"); }}>Cut off paired phone…</button>
              ) : (
                <div className="note small" role="group" aria-label="Cut off paired phone">
                  <p style={{ marginTop: 0 }}>
                    Your wallet signs one approval that replaces the phone&apos;s trading key with a new key nobody holds. The paired phone stops trading at
                    once. Its orders and positions stay on your account.
                  </p>
                  <div className="row">
                    <button className="btn small primary" disabled={cutting === "busy" || busy} onClick={() => void cutOff()}>
                      {cutting === "busy" ? "Confirm in your wallet…" : "Cut off the phone"}
                    </button>
                    <button className="btn small" disabled={cutting === "busy"} onClick={() => setCutting("idle")}>Cancel</button>
                  </div>
                </div>
              )}
              {cutResult && <p className={cutResult.ok ? "note small" : "error"}>{cutResult.text}</p>}
            </>
          )}

          <hr />
          {!profile.available ? (
            <p className="muted small">Profiles open when the contracts are deployed and HyperEVM answers.</p>
          ) : allowed(kind, "profile") && profile.name && !editing ? (
            <button className="menu-item" disabled={busy} onClick={() => { setMsg(null); setEditing(true); }}>Change username or picture</button>
          ) : allowed(kind, "profile") ? (
            <>
              <div className="field">
                <label htmlFor="uname">Username (3–16: a–z, 0–9, _)</label>
                <div className="row">
                  <input id="uname" className="input" value={name} placeholder={profile.name} maxLength={16} autoCapitalize="none" autoCorrect="off" spellCheck={false} onChange={(e) => setName(e.target.value.toLowerCase())} />
                  <button className="btn" disabled={busy} onClick={() => void saveName()}>Save</button>
                </div>
              </div>
              <div className="small muted">Picture</div>
              <div className="avatar-grid">
                {Array.from({ length: AVATAR_COUNT }, (_, i) => (
                  <button key={i} className={`menu-item avatar-pick ${i === profile.avatar ? "on" : ""}`} aria-label={`Avatar ${i}`} aria-pressed={i === profile.avatar} disabled={busy} onClick={() => void setAvatar(i)}>
                    <Avatar id={i} size={26} />
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="note small">{PAIRED_BLOCKED_TEXT}</p>
          )}
          {msg && <p className="muted small">{msg}</p>}
          {notice && <p className="warn">{notice}</p>}
        </div>
      )}
      {pairing && (
        // The chunk's loading and a failed load stay in a dialog that can be closed, with Try again (not the page-wide fallback).
        <ErrorBoundary scope="screen" network={cfg.network} onRetry={retryPair} frame={pairFrame}>
          <Suspense fallback={pairFrame(<Loading />)}>
            <PairModal
              onClose={() => setPairing(false)}
              onLateApproval={() => {
                setNotice("The phone approval went through after you closed the window. The phone that was paired before no longer works, and no new code was shown. Open Pair phone again to pair a phone (one more signature).");
                setOpen(true);
              }}
            />
          </Suspense>
        </ErrorBoundary>
      )}
    </div>
  );
}

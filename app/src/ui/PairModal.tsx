import QRCode from "qrcode";
import { useEffect, useRef, useState } from "react";
import { useConfig } from "../config/context";
import { PHONE_AGENT_VALID_DAYS, browserKV, clearPhoneRecord, savePhoneRecord } from "../hl/agent";
import { approvePhoneAgent } from "../hl/enable";
import { plainError } from "../hl/errors";
import { groupPairCode, pairCodeHex, pairQrText } from "../hl/pairCode";
import { useTrading } from "../hl/TradingProvider";
import { useSession } from "../wallet/session";
import { Modal } from "./Modal";

export const QR_VISIBLE_MS = 60_000;
const QR_OPTS = { errorCorrectionLevel: "M" as const, margin: 1, width: 240 };

/**
 * Pair a phone (Plan 4 A). Step 1 shows a code for the plain page /pair: no secret. Step 2: one click makes a fresh key,
 * the main wallet signs approveAgent "hlo phone" for it, and only then the pairing code appears: the key as plain text
 * (never a URL), as a QR and as 17 groups of 4 to type. The key lives in a ref for as long as the modal is open, so the
 * code can be shown again without a second signature; it hides itself after a minute and closing drops it.
 * The computer records the phone's address and expiry, never its key.
 *
 * `onLateApproval` runs when the approval lands after the modal was closed: the old phone is already cut off, and
 * the new key was thrown away, so the user must be told.
 */
export function PairModal({ onClose, onLateApproval }: { onClose(): void; onLateApproval?(): void }) {
  const cfg = useConfig();
  const { session, hlWallet } = useSession();
  const { master, status } = useTrading();
  const [linkImage, setLinkImage] = useState<string | null>(null); // the /pair link: no secret
  const code = useRef<{ image: string; groups: string[] } | null>(null); // the pairing code for this modal session
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const late = useRef(onLateApproval);
  late.current = onLateApproval;
  const link = `${window.location.origin}/pair`;
  useEffect(() => {
    alive.current = true;
    void QRCode.toDataURL(link, QR_OPTS).then((img) => alive.current && setLinkImage(img), () => {});
    return () => {
      alive.current = false;
      code.current = null;
    };
  }, [link]);
  // Only the builder fee and a wallet session are needed: the phone's key is a separate named agent.
  const ready = !!master && session.kind === "wallet" && !!status?.builderOk;

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(false), QR_VISIBLE_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const pair = async () => {
    if (!master || busy) return;
    setBusy(true);
    setError(null);
    try {
      const phone = await approvePhoneAgent({ net: cfg.network, wallet: hlWallet(), nowMs: Date.now() });
      // The approval replaced the phone paired before: its record goes now. The new one is written only once the code
      // is ready to show, so a close at any point (or a failed drawing) leaves no record of a key nobody has (Task 8 review m2).
      clearPhoneRecord(browserKV, cfg.network, master);
      if (!alive.current) return void late.current?.(); // the approved key was thrown away: no usable phone
      const image = await QRCode.toDataURL(pairQrText(cfg.network, phone.key), QR_OPTS);
      if (!alive.current) return void late.current?.();
      savePhoneRecord(browserKV, cfg.network, master, { address: phone.address, validUntil: phone.validUntil });
      code.current = { image, groups: groupPairCode(pairCodeHex(phone.key)) };
      setShown(true);
    } catch (e) {
      if (alive.current) setError(plainError(e).text);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const close = () => {
    code.current = null;
    setShown(false);
    onClose();
  };

  return (
    <Modal title="Pair phone" onClose={close}>
      <p className="warn">
        Anyone who sees the pairing code can trade on your account. They can never withdraw. The phone&apos;s key works for{" "}
        {PHONE_AGENT_VALID_DAYS} days. Showing a new code cuts off the phone that was paired before.
      </p>
      <div className="pair-step">
        <p className="small"><strong>1.</strong> On the phone, open the pairing page: scan this with the phone&apos;s camera, or type the address.</p>
        {linkImage && <img src={linkImage} alt="Link to the pairing page" width={160} height={160} />}
        <p className="mono small">{window.location.host}/pair</p>
      </div>
      {!ready && <p className="note" style={{ marginTop: 10 }}>{!master || session.kind !== "wallet" ? "Connect your wallet to pair a phone." : "Enable trading first."}</p>}
      {ready && !code.current && (
        <div className="pair-step">
          <p className="small">
            <strong>2.</strong> The phone gets its own trading key, not this computer&apos;s. Your wallet asks for one extra signature to approve it.
          </p>
          <button className="btn primary wide" disabled={busy} onClick={() => void pair()}>
            {busy ? "Confirm in your wallet…" : "Approve phone and show pairing code"}
          </button>
          {busy && <p className="muted small">If you close this window now, the approval can still go through and cut off the phone that was paired before.</p>}
        </div>
      )}
      {error && <p className="error" style={{ marginTop: 10 }}>{error}</p>}
      {code.current && shown && (
        <div className="pair-step">
          <p className="small">
            <strong>2.</strong> On the phone&apos;s pairing page, press Scan the code and point it here: scan it with that page, not with the camera app. This code is not a link; a camera app may offer to search the web for it.
          </p>
          {/* not draggable: dragging it out would make a copy of the key that outlives the dialog (final review M7) */}
          <img src={code.current.image} alt="Pairing code" width={240} height={240} draggable={false} />
          <p className="muted small">Can&apos;t scan? On the phone choose Type the code instead and type these 68 characters. The last 4 catch typos.</p>
          <p className="mono pair-code">{code.current.groups.join(" ")}</p>
          <p className="muted small">The code hides itself after a minute.</p>
        </div>
      )}
      {code.current && !shown && (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <p className="muted small">The code is hidden. Showing it again does not need another signature.</p>
          <button className="btn wide" onClick={() => setShown(true)}>Show again</button>
        </div>
      )}
    </Modal>
  );
}

import {
  isSolanaError,
  SOLANA_ERROR__SUBTLE_CRYPTO__DISALLOWED_IN_INSECURE_CONTEXT,
  SOLANA_ERROR__SUBTLE_CRYPTO__ED25519_ALGORITHM_UNIMPLEMENTED,
  SOLANA_ERROR__SUBTLE_CRYPTO__GENERATE_FUNCTION_UNIMPLEMENTED,
  SOLANA_ERROR__SUBTLE_CRYPTO__SIGN_FUNCTION_UNIMPLEMENTED,
  SOLANA_ERROR__SUBTLE_CRYPTO__VERIFY_FUNCTION_UNIMPLEMENTED,
  type Address as SolAddress,
  type SolanaErrorCode,
} from "@solana/kit";
import { useEffect, useRef, useState } from "react";
import { formatUnits } from "viem";
import { useConfig } from "../../config/context";
import type { Address } from "../../config/validate";
import { plainError } from "../../hl/errors";
import type { HlUserWallet } from "../../hl/injected";
import { SOLANA_DOMAIN } from "../../routes/addresses";
import { fetchIrisFees } from "../../routes/exec";
import { parseUsdc, quote, type IrisFee } from "../../routes/fees";
import { WITHDRAW_CLOSED_TEXT } from "../../routes/list";
import type { Pending } from "../../routes/pending";
import { usdcAta } from "../../routes/solana/ata";
import { SOLANA_CHAIN } from "../../routes/solana/constants";
import { runSolanaDeposit, SolanaSendUncertainError } from "../../routes/solana/deposit";
import { readSolanaUsdcAt } from "../../routes/solana/rpc";
import { runSolanaWithdraw } from "../../routes/solana/withdraw";
import { keepSigned, transferLock, useTransferBusy } from "../../routes/unconfirmed";
import { connectSolana, solanaSigner, watchSolanaWallets, type SolanaAccountLike, type SolanaWalletLike } from "../../wallet/solana";
import { fmtUsdc, shortAddr } from "../format";

/** Carried ruling 9: a Solana-only user still needs an EVM wallet for every Hyperliquid action. */
export const EVM_WALLET_TEXT =
  "Your Hyperliquid account is the EVM wallet you are connected with. A Solana wallet cannot sign Hyperliquid actions, so you always need an EVM wallet too.";
export const DEPOSIT_SENT_TEXT = "Sent. Circle finishes the transfer on HyperEVM; this list updates when it lands.";
/** The start of what an unconfirmed deposit says; SolanaSendUncertainError's text follows (it is watched, never sent again). */
export const DEPOSIT_UNCONFIRMED_TEXT = "unconfirmed: check your balance.";
const SAYS_NOT_SENT = /nothing (was )?(sent|moved|signed)|was not sent/i;
/** [P4 §4] A browser without WebCrypto Ed25519 cannot make the deposit's one-time event key (final review M6). */
export const NO_ED25519_TEXT = "This browser cannot create the Solana transaction. Update it, or use Chrome, Safari 17+ or Firefox 129+. Nothing was sent.";
const NO_WEBCRYPTO: SolanaErrorCode[] = [
  SOLANA_ERROR__SUBTLE_CRYPTO__DISALLOWED_IN_INSECURE_CONTEXT,
  SOLANA_ERROR__SUBTLE_CRYPTO__ED25519_ALGORITHM_UNIMPLEMENTED,
  SOLANA_ERROR__SUBTLE_CRYPTO__GENERATE_FUNCTION_UNIMPLEMENTED,
  SOLANA_ERROR__SUBTLE_CRYPTO__SIGN_FUNCTION_UNIMPLEMENTED,
  SOLANA_ERROR__SUBTLE_CRYPTO__VERIFY_FUNCTION_UNIMPLEMENTED,
];
const noEd25519 = (e: unknown) => (e as { name?: unknown } | null)?.name === "NotSupportedError" || NO_WEBCRYPTO.some((c) => isSolanaError(e, c));

type Msg = { kind: "ok" | "warn" | "error"; text: string };

/**
 * runSolanaDeposit's three outcomes, said plainly: it returned (sent); SolanaSendUncertainError (unconfirmed: recorded,
 * watched on Solana, never re-sent, so there is no retry); anything else threw before or instead of a broadcast
 * (nothing sent, see runSolanaDeposit's order).
 * The "Nothing was sent." below is true only while runSolanaDeposit keeps its contract: every throw that may follow a
 * broadcast is a SolanaSendUncertainError (Task 16 review m3). An edit there that lets another error out after the
 * wallet or the node took the transaction would make this text wrong.
 */
function depositOutcome(e: unknown): Msg {
  if (e instanceof SolanaSendUncertainError) return { kind: "warn", text: `${DEPOSIT_UNCONFIRMED_TEXT} ${e.message}` };
  if (noEd25519(e)) return { kind: "error", text: NO_ED25519_TEXT }; // thrown while building, before the lock and the prompt
  const text = plainError(e).text;
  return { kind: "error", text: SAYS_NOT_SENT.test(text) ? text : `${text} Nothing was sent.` };
}

/**
 * The Solana route (Plan 4 C), loaded lazily by TransferModal: connect a Wallet Standard wallet on the build's Solana
 * chain, then deposit (Solana → HyperCore) or withdraw (HyperCore → the wallet's USDC account). The money rules live in
 * routes/solana/*; this component wires them:
 * - deposit: runSolanaDeposit takes the page-wide lock itself (after its checks), so it is not wrapped in `go`;
 * - withdraw: runSolanaWithdraw takes no lock and checks no gate, so `go` holds the lock and the gates are checked here;
 * - the withdrawal's owner is only ever the connected Solana account, never typed.
 */
export function SolanaFlow(props: {
  dir: "deposit" | "withdraw";
  user: Address;
  locked: boolean;
  hasRoom(): boolean;
  /** The highest balance mark earlier pending Solana withdrawals to this token account wait for. */
  watching(ata: string): bigint;
  onBack(): void;
  onPending(p: Pending): void;
  /** Removes a record by id (the deposit's pre-prompt record, when the wallet says nothing was sent). */
  onForget(id: string): void;
  after(): void;
  hlWallet(): HlUserWallet;
  tradeUnits: bigint | null;
  sourceDex: "" | "spot";
}) {
  const { dir, user } = props;
  const cfg = useConfig();
  const chain = SOLANA_CHAIN[cfg.network]; // devnet for testnet and dev builds (carried ruling 7)
  const rpc = cfg.solanaRpc ?? "";
  const [wallets, setWallets] = useState<SolanaWalletLike[]>([]);
  const [conn, setConn] = useState<{ wallet: SolanaWalletLike; account: SolanaAccountLike; ata: SolAddress } | null>(null);
  const [usdc, setUsdc] = useState<bigint | null>(null);
  const [usdcFailed, setUsdcFailed] = useState(false); // the read did not answer: offer Try again (Task 16 review m8)
  const [usdcTry, setUsdcTry] = useState(0);
  const [amountText, setAmountText] = useState("");
  const [iris, setIris] = useState<IrisFee[] | null>(null);
  const [irisTry, setIrisTry] = useState(0);
  const [irisDone, setIrisDone] = useState(false);
  const [msg, setMsg] = useState<Msg | null>(null);
  const busy = useTransferBusy();
  // A deposit's checks run before runSolanaDeposit takes the lock: this keeps a second click out meanwhile.
  const depositing = useRef(false);
  const [checking, setChecking] = useState(false);
  const amount = parseUsdc(amountText) ?? 0n;

  useEffect(() => watchSolanaWallets(chain, setWallets), [chain]);
  useEffect(() => {
    let stale = false;
    if (dir === "deposit") {
      setIrisDone(false);
      void fetchIrisFees(cfg.network, SOLANA_DOMAIN).then((r) => {
        if (stale) return;
        setIris(r);
        setIrisDone(true);
      });
    }
    return () => {
      stale = true;
    };
  }, [dir, cfg.network, irisTry]);
  useEffect(() => {
    let stale = false;
    setUsdc(null);
    setUsdcFailed(false);
    if (conn && rpc && dir === "deposit") {
      void readSolanaUsdcAt(rpc, cfg.network, conn.ata).then((b) => {
        if (stale) return;
        setUsdc(b);
        setUsdcFailed(b === null);
      });
    }
    return () => {
      stale = true;
    };
  }, [conn, rpc, dir, cfg.network, usdcTry]);

  const connect = async (w: SolanaWalletLike) => {
    setMsg(null);
    try {
      const account = await connectSolana(w, chain);
      setConn({ wallet: w, account, ata: await usdcAta(cfg.network, account.address as SolAddress) });
    } catch (e) {
      setMsg({ kind: "error", text: plainError(e).text });
    }
  };

  const q = quote("solana", dir, amount, iris);
  // before an amount is typed, a withdrawal names its minimum ("Withdraw at least 1.50 USDC …")
  const hint = amount > 0n ? q.error : dir === "withdraw" ? quote("solana", "withdraw", 1n, null).error : null;
  const src = dir === "deposit" ? usdc : props.tradeUnits;
  const tooMuch = src !== null && amount > src;
  const working = busy || checking;

  const deposit = async () => {
    if (!conn || props.locked || depositing.current) return;
    depositing.current = true;
    setChecking(true);
    setMsg(null);
    try {
      await runSolanaDeposit({
        net: cfg.network, rpc, owner: conn.account.address, recipient: user, amount, quotedFee: q.fee,
        signer: solanaSigner(conn.wallet, conn.account, chain), nowMs: Date.now(), hasRoom: props.hasRoom, record: props.onPending, forget: props.onForget,
        fetchFees: () => fetchIrisFees(cfg.network, SOLANA_DOMAIN), lock: transferLock,
      });
      setMsg({ kind: "ok", text: DEPOSIT_SENT_TEXT });
      props.after();
      setUsdcTry((n) => n + 1);
    } catch (e) {
      setMsg(depositOutcome(e));
      if (e instanceof SolanaSendUncertainError) {
        props.after();
        setUsdcTry((n) => n + 1);
      }
    } finally {
      depositing.current = false;
      setChecking(false);
    }
  };

  /** The withdrawal: one transfer at a time, page-wide (carried ruling 3). */
  const withdraw = async () => {
    if (props.locked || !transferLock.tryBegin()) return; // synchronous: a double click cannot get two through
    setMsg(null);
    try {
      if (!cfg.withdrawEnabled || !cfg.solanaEnabled) throw new Error(WITHDRAW_CLOSED_TEXT); // carried rulings 1 and 2
      if (!conn) throw new Error("Connect a Solana wallet first.");
      await runSolanaWithdraw({
        net: cfg.network, wallet: props.hlWallet(), amount, sourceDex: props.sourceDex, owner: conn.account.address, nowMs: Date.now(),
        hasRoom: props.hasRoom, readAtaUsdc: (ata) => readSolanaUsdcAt(rpc, cfg.network, ata), watching: props.watching,
        record: props.onPending, keepSigned: (id, body) => keepSigned(cfg.network, user, id, body),
      });
      setMsg({ kind: "ok", text: "Sent. Circle delivers it to your USDC account on Solana." });
      props.after();
    } catch (e) {
      setMsg({ kind: "error", text: plainError(e).text });
    } finally {
      transferLock.end();
    }
  };

  return (
    <div>
      <button className="btn small" onClick={props.onBack}>← Routes</button>
      <p className="muted small" style={{ marginTop: 12 }}>{EVM_WALLET_TEXT}</p>
      {!conn ? (
        <div>
          {wallets.length === 0 ? (
            <p className="note">No Solana wallet found in this browser. Install Phantom, Solflare or Backpack, then open this window again.</p>
          ) : (
            wallets.map((w) => (
              <button key={w.name} className="menu-item route-row" onClick={() => void connect(w)}>
                <span>Connect {w.name}</span>
              </button>
            ))
          )}
        </div>
      ) : (
        <div>
          <p className="small">
            Solana wallet <span className="mono">{shortAddr(conn.account.address)}</span> ({conn.wallet.name})
            {dir === "deposit" && (
              <>
                {" "}· USDC{" "}
                {usdc !== null ? fmtUsdc(usdc) : usdcFailed ? (
                  <>unavailable <button className="btn small" onClick={() => setUsdcTry((n) => n + 1)}>Try again</button></>
                ) : "…"}
              </>
            )}{" "}
            <button className="btn small" disabled={working} onClick={() => setConn(null)}>Change</button>
          </p>
          <div className="field">
            <label htmlFor="samt">Amount (USDC){src !== null ? ` · available ${fmtUsdc(src)}` : ""}</label>
            <div className="row">
              <input id="samt" className="input" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
              {src ? <button className="btn small" onClick={() => setAmountText(formatUnits(src, 6))}>Max</button> : null}
            </div>
          </div>
          {amountText.trim() !== "" && parseUsdc(amountText) === null && <p className="error">Use a plain number with at most 6 decimals.</p>}
          {hint && <p className="muted small">{hint}</p>}
          {dir === "deposit" && irisDone && !iris && (
            <p className="muted small">Circle&apos;s fee service did not answer. <button className="btn small" onClick={() => setIrisTry((n) => n + 1)}>Try again</button></p>
          )}
          {!q.error && (
            <>
              <div className="stat"><span className="k">Fee</span><span className="v">{q.fee === null ? "unknown" : `${fmtUsdc(q.fee)} USDC`}</span></div>
              <div className="stat"><span className="k">You receive at least</span><span className="v">{q.receiveAtLeast === null ? "—" : `${fmtUsdc(q.receiveAtLeast)} USDC`}</span></div>
            </>
          )}
          {q.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
          {dir === "deposit" && <p className="muted small">It goes to your Hyperliquid account {shortAddr(user)}. Your Solana wallet asks for one confirmation.</p>}
          {dir === "withdraw" && <p className="muted small">It goes to your Solana wallet&apos;s USDC account ({shortAddr(conn.ata)}). Your EVM wallet signs it.</p>}
          {dir === "deposit" && cfg.network === "testnet" && (
            <p className="warn">Testnet: Circle only credits addresses that already exist on Hyperliquid mainnet, up to $1000. Deposits to other addresses fail silently.</p>
          )}
          {tooMuch && <p className="error">That is more than you have.</p>}
          {props.locked && <p className="muted small">Resolve the unconfirmed transfer above first.</p>}
          <button
            className="btn primary wide"
            disabled={working || props.locked || !!q.error || tooMuch || !rpc}
            onClick={() => void (dir === "deposit" ? deposit() : withdraw())}
          >
            {busy ? "Confirm in your wallet…" : checking ? "Checking…" : dir === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        </div>
      )}
      {msg && <p className={msg.kind === "ok" ? "note" : msg.kind} style={{ marginTop: 10 }}>{msg.text}</p>}
    </div>
  );
}

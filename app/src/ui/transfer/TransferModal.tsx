import { Suspense, useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useConfig } from "../../config/context";
import type { Address } from "../../config/validate";
import { useAccount } from "../../hl/AccountProvider";
import { browserKV } from "../../hl/agent";
import { plainError } from "../../hl/errors";
import { postSigned, UNCONFIRMED_NOTE, UnconfirmedPostError } from "../../hl/userSigned";
import { CCTP_WITHDRAW_FEE_CAP, ROUTE_ADDRESSES, USDC_SYSTEM_ADDRESS } from "../../routes/addresses";
import { BurnUncertainError, depositCctp, depositFromHyperEvm, fetchIrisFees, fetchIrisMessage, fetchPreTransfer, moveCoreUsdc, readAllowance, sourceDexFor, withdrawCctp, withdrawToHyperEvm } from "../../routes/exec";
import { cctpMaxFee, parseUsdc, quote, type IrisFee, type RouteId } from "../../routes/fees";
import { routesFor, WITHDRAW_CLOSED_TEXT } from "../../routes/list";
import { hasPendingRoom, isFinalNotSent, loadPending, savePending, saysNotSent, settleByBalance, settleCctp, upsertPending, withdrawMarks, type BalanceKind, type Pending } from "../../routes/pending";
import { beginRetry, dropSigned, endRetry, getList, hasHeld, heldBody, isRetrying, keepSigned, sendingSince, setList, transferLock, useTransferBusy, useTransferStore, WAIT_LONG_MS } from "../../routes/unconfirmed";
import { readUsdc, useBalances, type EvmBalances } from "../../routes/useBalances";
import { PAIRED_BLOCKED_TEXT } from "../../wallet/permissions";
import { useSession } from "../../wallet/session";
import { ErrorBoundary, useRetryableLazy } from "../ErrorBoundary";
import { fmtUsd, fmtUsdc } from "../format";
import { Modal } from "../Modal";

type Dir = "deposit" | "withdraw";
/**
 * Plan 4 C: all Solana code (Kit, Wallet Standard, routes/solana) sits in these chunks, loaded only when the Solana
 * route is opened (the form) or a Solana record is pending (the small poll). The chunk check enforces it.
 */
const loadSolanaFlow = () => import("./SolanaFlow").then((m) => ({ default: m.SolanaFlow }));
const loadSolanaPoll = () => import("../../routes/solana/poll");
const POLL_MS = 10_000;
const STUCK_MS = 3_600_000; // a pending record this old can be dismissed
const PENDING_FULL_TEXT = "Too many transfers in progress. Wait for one to finish.";
const ROUTE_NAME: Record<RouteId, string> = { hypercore: "HyperCore", hyperevm: "HyperEVM", arbitrum: "Arbitrum", ethereum: "Ethereum", solana: "Solana" };
/**
 * Hyperliquid balances are floats here. Floor to 1e-6 (never ask for more than there is); the 1e-4 of a micro-unit
 * keeps a value like 12.34 (which is 12.339999999999998 in binary) from losing a whole 1e-6.
 */
const toUnits = (usd: number) => BigInt(Math.max(0, Math.floor(usd * 1e6 + 1e-4)));

const CLOSE_UNCONFIRMED = "This transfer is unconfirmed. Close anyway? You can retry it from the history list until you reload the page.";
export { WITHDRAW_CLOSED_TEXT };
const NOTE_GONE = "unconfirmed: check your balance before sending again";

/** Still worth a poll: pending, and not a Solana deposit whose "not sent" can no longer change (final review M2). */
const polled = (p: Pending, now: number) => p.status === "pending" && !isFinalNotSent(p, now);

export function TransferModal({ dir, onClose }: { dir: Dir; onClose(): void }) {
  const { session } = useSession();
  const cfg = useConfig();
  const user = session.kind === "wallet" ? session.address : null;
  // closing (Escape, the backdrop, the X) with an unconfirmed transfer asks first
  const close = () => {
    if (user && hasHeld(cfg.network, user) && !window.confirm(CLOSE_UNCONFIRMED)) return;
    onClose();
  };
  return (
    <Modal title={dir === "deposit" ? "Deposit USDC" : "Withdraw USDC"} onClose={close}>
      {dir === "withdraw" && !cfg.withdrawEnabled ? (
        <p className="note">{WITHDRAW_CLOSED_TEXT}</p>
      ) : user ? (
        <Transfers key={user} dir={dir} user={user} />
      ) : session.kind === "paired" ? (
        <p className="note">{PAIRED_BLOCKED_TEXT}</p>
      ) : (
        <p className="note">Connect a wallet first.</p>
      )}
    </Modal>
  );
}

function Transfers({ dir, user }: { dir: Dir; user: Address }) {
  const cfg = useConfig();
  const { write, hlWallet } = useSession();
  const account = useAccount();
  const { balances, reload } = useBalances(user);
  const refreshAccount = account.refresh;
  const [route, setRoute] = useState<RouteId | null>(null);
  // A fresh lazy component on Try again: React keeps a failed lazy import's error, so retrying needs a new one.
  const [SolanaFlow, retrySolanaFlow] = useRetryableLazy(loadSolanaFlow);
  useTransferStore(); // the list, the held bodies and the lock live in module memory: re-render on every change, also from a closed modal's transfer
  const read = useCallback(() => getList(cfg.network, user, () => loadPending(browserKV, cfg.network, user)), [cfg.network, user]);
  const list = read();
  const [repeatMsg, setRepeatMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const busyNow = useTransferBusy();
  const [waitedLong, setWaitedLong] = useState(false);
  // No automatic release of the lock: after a minute the user is told where the way out is.
  useEffect(() => {
    setWaitedLong(false);
    const at = sendingSince();
    if (!busyNow || at === null) return;
    const t = setTimeout(() => setWaitedLong(true), Math.max(0, WAIT_LONG_MS - (Date.now() - at)));
    return () => clearTimeout(t);
  }, [busyNow]);
  // pending records whose signed body is still held: Retry re-posts it, and nothing new may start meanwhile
  const held = list.filter((p) => p.status === "pending" && heldBody(cfg.network, user, p.id));

  const commit = useCallback(
    (next: Pending[]) => {
      setList(cfg.network, user, next); // module memory first: when storage is blocked the transfer must stay visible
      savePending(browserKV, cfg.network, user, next, Date.now());
    },
    [cfg.network, user],
  );
  const record = useCallback(
    (p: Pending) => {
      let next: Pending[];
      try {
        next = upsertPending(read(), p);
      } catch {
        next = [p, ...read().filter((x) => x.id !== p.id)]; // no room in the store: keep it in memory anyway
      }
      commit(next);
    },
    [commit, read],
  );
  const hasRoom = useCallback(() => hasPendingRoom(read()), [read]);
  /**
   * Where the balance must get to before every still-pending withdrawal that watches `kind` has landed. A new withdrawal
   * starts its baseline there, so one arrival cannot complete two records. Solana balances are per token account, so
   * for "solana" only records watching that same account (`watch`) count (carried ruling 6).
   */
  const watching = useCallback(
    (kind: BalanceKind, watch?: string): bigint =>
      read().reduce((m, p) => {
        if (p.status !== "pending" || p.balanceKind !== kind || p.baseline === undefined || p.minArrive === undefined) return m;
        if (kind === "solana" && (watch === undefined || p.watch !== watch)) return m;
        const t = BigInt(p.baseline) + BigInt(p.minArrive);
        return t > m ? t : m;
      }, 0n),
    [read],
  );
  const dismiss = useCallback(
    (id: string) => {
      dropSigned(cfg.network, user, id);
      commit(read().filter((p) => p.id !== id));
    },
    [cfg.network, user, commit, read],
  );
  const after = useCallback(() => {
    refreshAccount();
    reload();
  }, [refreshAccount, reload]);
  /**
   * Whether a row offers Dismiss: one with a note, or over an hour old. Never on a Solana row while a transfer is being
   * signed or sent: the deposit's record is written before its broadcast, and dismissing it then would drop the only
   * watch on it (final review M4). Not on an unconfirmed Solana deposit in its first hour either: the chain decides it
   * within minutes (EXPIRE_GRACE_MS), and dismissing ends that watch for good (Task 16 review m1).
   */
  const canDismiss = (p: Pending, now: number): boolean => {
    if (p.status !== "pending") return false;
    if (p.route === "solana" && (busyNow || (p.dir === "deposit" && !!p.note?.startsWith("unconfirmed") && now - p.startedAt <= STUCK_MS))) return false;
    return p.note !== undefined || now - p.startedAt > STUCK_MS;
  };

  // Poll every pending transfer: CCTP deposits through Iris, withdrawals through the destination balance.
  const anyPending = list.some((p) => polled(p, Date.now()));
  useEffect(() => {
    if (!anyPending) return;
    let dead = false;
    let running = false;
    const pollOne = async (p: Pending): Promise<Pending> => {
      if (p.route === "solana") {
        // Its own chunk, loaded only now. A chunk that fails to load, or a poll that throws, leaves the record as it was; the next round tries again.
        try {
          return await (await loadSolanaPoll()).pollSolana(cfg, p);
        } catch {
          return p;
        }
      }
      if ((p.srcDomain === 0 || p.srcDomain === 3) && p.txHash) return settleCctp(p, await fetchIrisMessage(cfg.network, p.srcDomain, p.txHash), Date.now());
      if (p.balanceKind && p.balanceKind !== "solana") {
        const b = await readUsdc(cfg, p.balanceKind, user);
        return b === null ? p : settleByBalance(p, b);
      }
      return p;
    };
    const tick = async () => {
      if (running) return; // a slow answer must not stack another round on top
      running = true;
      try {
        const updates = new Map<string, Pending>();
        for (const p of read().filter((x) => polled(x, Date.now()))) {
          const n = await pollOne(p);
          if (n.status !== p.status || n.note !== p.note || n.txHash !== p.txHash) updates.set(p.id, n); // a Solana read may adopt the signature
        }
        if (dead || updates.size === 0) return;
        // merge by id into the newest list: a transfer added while we were waiting must not be lost
        commit(read().map((p) => (p.status === "pending" && updates.has(p.id) ? updates.get(p.id)! : p)));
        for (const u of updates.values()) if (u.status === "done") dropSigned(cfg.network, user, u.id); // it landed: the held body is moot
        if ([...updates.values()].some((u) => u.status === "done")) after();
      } finally {
        running = false;
      }
    };
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [anyPending, cfg, user, commit, after, read]);

  /** Re-post the signed body that was not confirmed. Never signs again. At most one post per record at a time, even across close and reopen. */
  const repeat = async (id: string) => {
    const body = heldBody(cfg.network, user, id);
    if (!body || !beginRetry(cfg.network, user, id)) return;
    setRepeatMsg(null);
    try {
      await postSigned(cfg.network, body);
      const rec = read().find((p) => p.id === id);
      // a withdrawal keeps being watched by its balance; a spot/perps move has nothing to wait for
      if (rec) record(rec.balanceKind ? { ...rec, note: undefined } : { ...rec, status: "done", note: undefined });
      dropSigned(cfg.network, user, id);
      setRepeatMsg({ ok: true, text: "Hyperliquid answered: the transfer is sent." });
      after();
    } catch (e) {
      if (e instanceof UnconfirmedPostError) setRepeatMsg({ ok: false, text: "Still not confirmed by Hyperliquid. Try again in a moment." });
      else {
        // an answer, but not ok. The first post may have been accepted (the repeat is then refused as a duplicate), so the balance decides.
        dropSigned(cfg.network, user, id);
        setRepeatMsg({ ok: false, text: `Hyperliquid answered the repeat with: ${plainError(e).text} Check your balance. If it changed, the first send went through.` });
      }
    } finally {
      endRetry(cfg.network, user, id);
    }
  };
  const noteOf = (p: Pending) => (p.note === UNCONFIRMED_NOTE && !heldBody(cfg.network, user, p.id) ? NOTE_GONE : p.note); // after a reload the body is gone

  return (
    <div>
      {held.length > 0 && (
        <div className="warn" style={{ marginBottom: 12 }} role="alert">
          <strong>A transfer may not have gone through.</strong> Hyperliquid did not confirm it, so it may have accepted it. Check your balance first. Nothing is signed again: &quot;Retry (same request)&quot; in the list below sends the same signed request, which Hyperliquid ignores if it already has it. No new transfer can start until this is retried or dismissed.
        </div>
      )}
      {busyNow && waitedLong && (
        <p className="warn" style={{ marginBottom: 12 }} role="status">Waiting for your wallet. Approve or reject it there, or reload the page to start over.</p>
      )}
      {repeatMsg && <p className={repeatMsg.ok ? "note" : "error"} style={{ marginBottom: 12 }}>{repeatMsg.text}</p>}
      {!route ? (
        <RouteList dir={dir} balances={balances} trade={account.balances?.trade ?? null} onPick={setRoute} />
      ) : route === "solana" ? (
        cfg.solanaEnabled ? (
          // A failed chunk (a dropped connection, or a file a redeploy removed) or a render error stays inside the form's place, with Try again.
          <ErrorBoundary scope="screen" network={cfg.network} onRetry={retrySolanaFlow}>
            <Suspense fallback={<p className="muted small">Loading Solana…</p>}>
              <SolanaFlow
                dir={dir}
                user={user}
                locked={held.length > 0}
                hasRoom={hasRoom}
                watching={(ata) => watching("solana", ata)}
                onBack={() => setRoute(null)}
                onPending={record}
                onForget={dismiss}
                after={after}
                hlWallet={hlWallet}
                tradeUnits={account.balances ? toUnits(account.balances.trade) : null}
                sourceDex={sourceDexFor(account.abstraction)}
              />
            </Suspense>
          </ErrorBoundary>
        ) : (
          <p className="note">Solana transfers are not open in this build.</p>
        )
      ) : (
        <RouteFlow
          key={route}
          dir={dir}
          route={route}
          user={user}
          balances={balances}
          locked={held.length > 0}
          hasRoom={hasRoom}
          watching={watching}
          onBack={() => setRoute(null)}
          onPending={record}
          after={after}
          write={write}
          hlWallet={hlWallet}
        />
      )}
      {list.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div className="small muted">Recent transfers</div>
          {list.map((p) => {
            const stuck = canDismiss(p, Date.now());
            const note = noteOf(p);
            const retryable = p.status === "pending" && heldBody(cfg.network, user, p.id) !== undefined;
            return (
              <div key={p.id} className="stat small">
                <span className="k">{p.dir} · {ROUTE_NAME[p.route]} · {fmtUsdc(BigInt(p.amount))} USDC{note ? ` · ${note}` : ""}</span>
                <span className={`v ${p.status === "done" ? "up" : ""}`}>
                  {p.status === "done" ? "done" : saysNotSent(p) ? "not sent" : "pending…"}
                  {retryable && <> <button className="btn small" disabled={isRetrying(cfg.network, user, p.id)} onClick={() => void repeat(p.id)}>{isRetrying(cfg.network, user, p.id) ? "Retrying…" : "Retry (same request)"}</button></>}
                  {stuck && <> <button className="btn small" onClick={() => dismiss(p.id)} aria-label={`Dismiss ${p.dir} ${ROUTE_NAME[p.route]} ${fmtUsdc(BigInt(p.amount))}`}>Dismiss</button></>}
                </span>
              </div>
            );
          })}
          {list.some((p) => canDismiss(p, Date.now())) && (
            <p className="muted small">Dismiss only removes the entry from this list. It does not cancel anything on chain.</p>
          )}
        </div>
      )}
    </div>
  );
}

function RouteList({ dir, balances, trade, onPick }: { dir: Dir; balances: EvmBalances | null; trade: number | null; onPick(r: RouteId): void }) {
  const cfg = useConfig();
  const bal = (id: RouteId): string => {
    if (id === "hypercore") return trade === null ? "—" : `$${fmtUsd(trade)}`;
    if (id === "solana") return ""; // read on the Solana form, once a Solana wallet is connected
    const v = balances?.[id === "hyperevm" ? "hyperEvm" : id];
    return v === undefined ? "…" : v === null ? "unavailable" : `$${fmtUsdc(v)}`;
  };
  return (
    <div>
      <p className="muted small">{dir === "deposit" ? "Where is the USDC now?" : "Where should the USDC go?"} Your trading balance: {trade === null ? "—" : `$${fmtUsd(trade)}`}.</p>
      {routesFor(cfg).map((r) => (
        <button key={r.id} className="menu-item route-row" disabled={!r.enabled} onClick={() => r.enabled && onPick(r.id as RouteId)}>
          <span>{r.label}{r.note ? <span className="faint small"> · {r.note}</span> : null}</span>
          <span className="num small">{r.enabled ? bal(r.id as RouteId) : ""}</span>
        </button>
      ))}
    </div>
  );
}

function RouteFlow(props: {
  dir: Dir; route: RouteId; user: Address; balances: EvmBalances | null; locked: boolean;
  hasRoom(): boolean; watching(kind: BalanceKind, watch?: string): bigint; onBack(): void; onPending(p: Pending): void; after(): void;
  write: ReturnType<typeof useSession>["write"]; hlWallet: ReturnType<typeof useSession>["hlWallet"];
}) {
  const { dir, route, user, balances } = props;
  const cfg = useConfig();
  const account = useAccount();
  const [amountText, setAmountText] = useState("");
  const [iris, setIris] = useState<IrisFee[] | null>(null);
  const [irisTry, setIrisTry] = useState(0);
  const [irisDone, setIrisDone] = useState(false);
  const [activation, setActivation] = useState<number | null>(null);
  const busy = useTransferBusy(); // one lock for the whole page: it survives "back" and re-picking a route, and closing the modal
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const amount = parseUsdc(amountText) ?? 0n;
  const isCctp = route === "arbitrum" || route === "ethereum";
  const cctpRoute = isCctp ? route : null;
  const domain = cctpRoute ? ROUTE_ADDRESSES[cfg.network][cctpRoute].domain : null; // [R §2.5] 3 Arbitrum, 0 Ethereum
  const sourceDex = sourceDexFor(account.abstraction);
  const tradeUnits = account.balances ? toUnits(account.balances.trade) : null;

  useEffect(() => {
    let stale = false;
    if (dir === "deposit" && domain !== null) {
      setIrisDone(false);
      void fetchIrisFees(cfg.network, domain).then((r) => {
        if (stale) return;
        setIris(r);
        setIrisDone(true);
      });
    }
    if (dir === "withdraw" && route === "hyperevm") void fetchPreTransfer(cfg.network, USDC_SYSTEM_ADDRESS, user).then((r) => !stale && setActivation(r?.fee ?? null));
    return () => {
      stale = true;
    };
  }, [dir, route, domain, cfg.network, user, irisTry]);

  const q = route === "hypercore" ? null : quote(route, dir, amount, iris);
  const minHint = dir === "withdraw" && isCctp ? quote(route, "withdraw", 1n, null).error : null; // "Withdraw at least 6.20 USDC (…)" from fees.ts
  const srcBalance = dir === "withdraw" ? tradeUnits : route === "hyperevm" ? balances?.hyperEvm : cctpRoute ? balances?.[cctpRoute] : null;
  const tooMuch = srcBalance !== null && srcBalance !== undefined && amount > srcBalance;

  const go = async (f: () => Promise<string>) => {
    if (props.locked || !transferLock.tryBegin()) return; // tryBegin is synchronous: a double click cannot get two through
    setMsg(null);
    try {
      setMsg({ ok: true, text: await f() });
      props.after();
    } catch (e) {
      setMsg({ ok: false, text: plainError(e).text });
    } finally {
      transferLock.end();
    }
  };

  const submit = () => go(async () => {
    const now = Date.now();
    // Every transfer that will leave a record needs room for it BEFORE the wallet is asked to sign.
    const needsRecord = !(dir === "deposit" && route === "hyperevm");
    if (needsRecord && !props.hasRoom()) throw new Error(PENDING_FULL_TEXT);

    if (dir === "deposit" && route === "hyperevm") {
      const allowance = await readAllowance(cfg, "hyperEvm", user); // an approval left from an earlier try is reused
      await depositFromHyperEvm(props.write, cfg.network, amount, allowance);
      return "Deposited. It shows in your Hyperliquid balance in a moment.";
    }
    if (dir === "deposit" && cctpRoute && domain !== null) {
      const fresh = await fetchIrisFees(cfg.network, domain); // re-query right before the burn [R §2.5]
      if (!fresh) throw new Error("Circle's fee service did not answer. Try again in a moment.");
      const fq = quote(cctpRoute, "deposit", amount, fresh);
      if (fq.error) throw new Error(fq.error);
      // The burn takes the fee the user saw, or less. If Circle's fee rose since, show the new quote and stop.
      if (q?.fee != null && fq.fee !== null && fq.fee > q.fee) {
        setIris(fresh);
        throw new Error(`Circle's fee changed from ${fmtUsdc(q.fee)} to ${fmtUsdc(fq.fee)} USDC. Check it and press Deposit again.`);
      }
      const base = { id: "", dir, route, amount: amount.toString(), startedAt: now, status: "pending" as const, srcDomain: domain };
      const allowance = await readAllowance(cfg, cctpRoute, user); // an approval left from an earlier try is reused
      let tx: string;
      try {
        tx = await depositCctp(props.write, cfg.network, cctpRoute, amount, cctpMaxFee(amount, fresh), user, allowance);
      } catch (e) {
        if (e instanceof BurnUncertainError) props.onPending({ ...base, id: e.hash, txHash: e.hash, note: "unconfirmed: watching the transaction" });
        throw e;
      }
      props.onPending({ ...base, id: tx, txHash: tx });
      return "Sent. Circle finishes the transfer on HyperEVM; this list updates when it lands.";
    }
    if (dir === "withdraw" && (route === "hyperevm" || cctpRoute)) {
      const kind = route === "hyperevm" ? "hyperEvm" : (cctpRoute as "arbitrum" | "ethereum");
      const baseline = await readUsdc(cfg, kind, user);
      if (baseline === null) throw new Error(`Could not read your balance on ${ROUTE_NAME[route]}, so the arrival could not be watched. Nothing was sent. Try again in a moment.`);
      // The fee is unknown for HyperEVM [R §4.3]: count it as arrived once 99% shows up. CCTP: the amount less the fee cap.
      const raw = route === "hyperevm" ? (amount * 99n) / 100n : amount - CCTP_WITHDRAW_FEE_CAP[domain as 0 | 3];
      // Start from the highest mark of any earlier withdrawal still on its way to this balance: one arrival must not complete two records.
      const { minArrive, start } = withdrawMarks(amount, raw, baseline, props.watching(kind));
      const rec = (note?: string): Pending => ({
        id: `w-${now}`, dir, route, amount: amount.toString(), startedAt: now, status: "pending", balanceKind: kind, baseline: start.toString(), minArrive: minArrive.toString(), ...(note ? { note } : {}),
      });
      const wallet = props.hlWallet();
      try {
        if (route === "hyperevm") await withdrawToHyperEvm(wallet, cfg.network, amount, sourceDex);
        else await withdrawCctp(wallet, cfg.network, amount, sourceDex, user, domain as 0 | 3); // always to the connected address
      } catch (e) {
        if (e instanceof UnconfirmedPostError) {
          keepSigned(cfg.network, user, `w-${now}`, e.body); // module memory, outlives the modal
          props.onPending(rec(UNCONFIRMED_NOTE));
        }
        throw e;
      }
      props.onPending(rec());
      return route === "hyperevm" ? "Sent. USDC shows up on HyperEVM within seconds." : `Sent. Circle delivers it to your address on ${ROUTE_NAME[route]}.`;
    }
    throw new Error("Unknown route.");
  });

  /**
   * spot ↔ perps: nothing to wait for. A move whose post was not confirmed becomes a pending record (no balance watch) so
   * its signed body can be re-posted from the history list; a room for it is checked before signing, like every transfer.
   */
  const move = (toPerp: boolean) => go(async () => {
    if (!props.hasRoom()) throw new Error(PENDING_FULL_TEXT);
    const now = Date.now();
    try {
      await moveCoreUsdc(props.hlWallet(), cfg.network, amount, toPerp);
    } catch (e) {
      if (e instanceof UnconfirmedPostError) {
        keepSigned(cfg.network, user, `m-${now}`, e.body);
        props.onPending({ id: `m-${now}`, dir, route, amount: amount.toString(), startedAt: now, status: "pending", note: UNCONFIRMED_NOTE });
      }
      throw e;
    }
    return toPerp ? "Moved to perps." : "Moved to spot.";
  });

  // Standard accounts only [R §2.4]: unified and portfolio accounts keep one balance.
  // "default" is left out on purpose: the research says not to assume a rule for it until tested (testnet checklist A1).
  const standard = account.abstraction === "disabled" || account.abstraction === "dexAbstraction";
  const spotUnits = account.balances ? toUnits(account.balances.spot) : 0n;
  const perpsUnits = account.balances ? toUnits(account.balances.perps) : 0n;
  const amountBad = amountText.trim() !== "" && parseUsdc(amountText) === null;

  return (
    <div>
      <button className="btn small" onClick={props.onBack}>← Routes</button>
      {route === "hypercore" ? (
        <div style={{ marginTop: 12 }}>
          <p>Your Hyperliquid balance is the one you trade with. Nothing to {dir}.</p>
          {account.balances && <p className="muted small">Perps ${fmtUsd(account.balances.perps)} · spot ${fmtUsd(account.balances.spot)}</p>}
          {standard && (
            <>
              <div className="field"><label htmlFor="mv">Move between spot and perps (USDC)</label><input id="mv" className="input" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} /></div>
              {amountBad && <p className="error">Use a plain number with at most 6 decimals.</p>}
              <div className="row wrap">
                <button className="btn" disabled={busy || props.locked || amount <= 0n || amount > spotUnits} onClick={() => void move(true)}>Spot → perps</button>
                <button className="btn" disabled={busy || props.locked || amount <= 0n || amount > perpsUnits} onClick={() => void move(false)}>Perps → spot</button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="amt">Amount (USDC){srcBalance !== null && srcBalance !== undefined ? ` · available ${fmtUsdc(srcBalance)}` : ""}</label>
            <div className="row">
              <input id="amt" className="input" inputMode="decimal" placeholder="0.00" value={amountText} onChange={(e) => setAmountText(e.target.value)} />
              {srcBalance ? <button className="btn small" onClick={() => setAmountText(formatUnits(srcBalance, 6))}>Max</button> : null}
            </div>
          </div>
          {amountBad && <p className="error">Use a plain number with at most 6 decimals.</p>}
          {minHint && amount <= 0n && <p className="muted small">{minHint}</p>}
          {q?.error && amount > 0n && <p className="muted small">{q.error}</p>}
          {dir === "deposit" && isCctp && irisDone && !iris && (
            <p className="muted small">Circle&apos;s fee service did not answer. <button className="btn small" onClick={() => setIrisTry((n) => n + 1)}>Try again</button></p>
          )}
          {q && !q.error && (
            <>
              <div className="stat"><span className="k">Fee</span><span className="v">{q.fee === null ? "unknown" : `${fmtUsdc(q.fee)} USDC`}</span></div>
              <div className="stat"><span className="k">You receive at least</span><span className="v">{q.receiveAtLeast === null ? "—" : `${fmtUsdc(q.receiveAtLeast)} USDC`}</span></div>
            </>
          )}
          {q?.notes.map((n) => <p key={n} className="muted small">{n}</p>)}
          {dir === "withdraw" && <p className="muted small">It goes to your connected address ({user.slice(0, 6)}…{user.slice(-4)}) on {ROUTE_NAME[route]}.</p>}
          {activation !== null && activation > 0 && <p className="warn">Hyperliquid charges a one-time {activation} USDC account activation fee on this transfer.</p>}
          {dir === "deposit" && route === "hyperevm" && balances?.hype === 0n && <p className="warn">You have no HYPE on HyperEVM for gas.</p>}
          {dir === "deposit" && isCctp && cfg.network === "testnet" && (
            <p className="warn">Testnet: Circle only credits addresses that already exist on Hyperliquid mainnet, up to $1000. Deposits to other addresses fail silently.</p>
          )}
          {dir === "deposit" && <p className="muted small">Your wallet will switch to {ROUTE_NAME[route]} and ask for two confirmations (approve, then send).</p>}
          {tooMuch && <p className="error">That is more than you have.</p>}
          {props.locked && <p className="muted small">Resolve the unconfirmed transfer above first.</p>}
          <button className="btn primary wide" disabled={busy || props.locked || !q || !!q.error || tooMuch} onClick={() => void submit()}>
            {busy ? "Confirm in your wallet…" : dir === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        </div>
      )}
      {msg && <p className={msg.ok ? "note" : "error"} style={{ marginTop: 10 }}>{msg.text}</p>}
    </div>
  );
}

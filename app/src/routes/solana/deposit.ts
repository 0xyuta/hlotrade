import { getBase58Decoder, getTransactionEncoder } from "@solana/kit";
import type { Address, Network } from "../../config/validate";
import { fmtUsdc } from "../../ui/format";
import { SolanaNotSentError, type SolanaSigner } from "../../wallet/solana";
import { SOLANA_DOMAIN } from "../addresses";
import { cctpMaxFee, fmtSol, quote, SOLANA_DEPOSIT_SOL_ESTIMATE, type IrisFee } from "../fees";
import { PendingFullError, type Pending } from "../pending";
import { solanaOwner } from "./ata";
import { buildSolanaDeposit, checkWalletSigned, solanaTxId } from "./burn";
import { latestBlockhash, preflightNotSent, readSol, sendWire } from "./rpc";
import { SOLANA_UNCONFIRMED_NOTE, SOLANA_WATCH_NOTE } from "./settle";

/** The transaction may have been broadcast but no confirmed answer came back. It is never signed or sent again. */
export class SolanaSendUncertainError extends Error {
  /** The transaction's signature when the app knows it; null when the wallet sent it and gave no signature back. */
  constructor(readonly id: string | null, options?: { cause?: unknown }) {
    super("The deposit may have been sent, but no confirmed answer came back. It is listed below and watched on Solana; do not send it again.", options);
    this.name = "SolanaSendUncertainError";
  }
}

export const TRANSFER_BUSY_TEXT = "Another transfer is being signed or sent. Wait for it to finish. Nothing was sent.";

export interface SolanaDepositDeps {
  net: Network;
  rpc: string;
  /**
   * The account connectSolana returned (its `address`, base58): pays the fee and the event account's rent, and its USDC
   * is burned. Checked by solanaOwner, and the signer must be this same account (carried ruling 4).
   */
  owner: string;
  /** The HyperCore account that receives the USDC (the connected EVM wallet). */
  recipient: Address;
  amount: bigint;
  /** The fee the user saw; a higher fresh quote stops the deposit. */
  quotedFee: bigint | null;
  signer: SolanaSigner;
  nowMs: number;
  hasRoom(): boolean;
  record(p: Pending): void;
  /** Removes a record by id: only the one written before a signAndSend prompt, once the wallet says nothing was sent. */
  forget(id: string): void;
  fetchFees(): Promise<IrisFee[] | null>;
  /**
   * The page-wide transfer lock (`transferLock`). runSolanaDeposit takes it itself, after the transaction is built and
   * before the wallet is asked, and releases it once the wallet and the send have answered (carried ruling 1). The
   * caller must not hold it.
   */
  lock: { tryBegin(): boolean; end(): void };
  io?: Partial<{ latestBlockhash: typeof latestBlockhash; sendWire: typeof sendWire; readSol: typeof readSol }>;
}

/**
 * A Solana → HyperCore deposit under Plan 3's money rules and ruling 14, in this order:
 * 0. Only one run at a time (a second call is refused at once, before any read).
 * 1. Checks, with no wallet prompt and no lock: the owner and the signer's account, room, Circle's fee re-queried and
 *    never above the quote, enough SOL, then the transaction is built (buildSolanaDeposit validates the recipient and
 *    the amount).
 * 2. The lock is taken; room is checked again; the wallet is asked once.
 * 3. "sign": the returned transaction is verified (await checkWalletSigned), then recorded under its signature with the
 *    watch note, then broadcast once. Only a preflight refusal that proves the node never forwarded it is "not
 *    sent" (preflightNotSent); any other failure, AlreadyProcessed included, leaves the record watching, and the chain
 *    or Iris settles it.
 *    "signAndSend": recorded as unconfirmed with the event account's address before the prompt (the wallet itself
 *    broadcasts, so a browser that dies meanwhile still leaves a record, which the event account settles); a typed
 *    SolanaNotSentError removes that record again; any other failure keeps it; a signature that comes back is added.
 * Nothing is ever re-signed or re-sent. The record holds the event account's address, never a key.
 */
export async function runSolanaDeposit(d: SolanaDepositDeps): Promise<Pending> {
  // One deposit run at a time, from the first check on: the lock is taken only after the build, so without this a
  // second click could wait out slow reads, find the lock free after the first deposit, and prompt a second deposit.
  if (running) throw new Error(TRANSFER_BUSY_TEXT);
  running = true;
  try {
    return await depositOnce(d);
  } finally {
    running = false;
  }
}
let running = false;

async function depositOnce(d: SolanaDepositDeps): Promise<Pending> {
  const io = { latestBlockhash, sendWire, readSol, ...d.io };
  const owner = solanaOwner(d.owner);
  if (d.signer.address !== owner) throw new Error("The Solana wallet's signer is not the connected account. Connect the wallet again. Nothing was sent.");
  if (!d.hasRoom()) throw new PendingFullError();
  const fresh = await d.fetchFees(); // re-query right before signing [R §2.5]
  if (!fresh) throw new Error("Circle's fee service did not answer. Try again in a moment.");
  const fq = quote("solana", "deposit", d.amount, fresh);
  if (fq.error || fq.fee === null) throw new Error(fq.error ?? "Fee quote unavailable.");
  if (d.quotedFee !== null && fq.fee > d.quotedFee) {
    throw new Error(`Circle's fee changed from ${fmtUsdc(d.quotedFee)} to ${fmtUsdc(fq.fee)} USDC. Check it and press Deposit again.`);
  }
  const sol = await io.readSol(d.rpc, owner);
  if (sol !== null && sol < SOLANA_DEPOSIT_SOL_ESTIMATE) {
    throw new Error(`Your Solana wallet needs about ${fmtSol(SOLANA_DEPOSIT_SOL_ESTIMATE)} SOL for the network fee and a temporary record account for this transfer. Nothing was sent.`);
  }
  const lifetime = await io.latestBlockhash(d.rpc);
  const built = await buildSolanaDeposit({ net: d.net, owner, amount: d.amount, maxFee: cctpMaxFee(d.amount, fresh), recipient: d.recipient, lifetime });
  const base = {
    dir: "deposit" as const, route: "solana" as const, amount: d.amount.toString(), startedAt: d.nowMs, status: "pending" as const,
    srcDomain: SOLANA_DOMAIN, lastValid: built.lastValidBlockHeight.toString(), eventAccount: built.eventAddress,
  };

  if (!d.lock.tryBegin()) throw new Error(TRANSFER_BUSY_TEXT);
  try {
    if (!d.hasRoom()) throw new PendingFullError(); // under the lock, right before the prompt

    if (d.signer.kind === "signAndSend") {
      // Before the prompt (Task 15 review m5): the wallet broadcasts by itself, so the record must already stand if the
      // page dies while it does. A throw here comes before the wallet is asked: nothing was sent.
      const id = `s-${d.nowMs}`;
      d.record({ ...base, id, note: SOLANA_UNCONFIRMED_NOTE });
      let sig: Uint8Array;
      try {
        sig = await d.signer.signAndSend(built.wire);
      } catch (e) {
        if (e instanceof SolanaNotSentError) {
          // typed: nothing was broadcast (SolanaRejectedError included). A record that stays anyway only expires later.
          try {
            d.forget(id);
          } catch {
            /* kept: the chain shows it never landed */
          }
          throw e;
        }
        // SolanaUnconfirmedError, or anything untyped: the wallet may have broadcast. The record stands; the event account settles it.
        throw new SolanaSendUncertainError(null, { cause: e });
      }
      const txHash = getBase58Decoder().decode(sig);
      const rec: Pending = { ...base, id, txHash };
      try {
        d.record(rec);
      } catch (e) {
        throw new SolanaSendUncertainError(txHash, { cause: e }); // the wallet sent it; only the save failed (the unconfirmed record stands)
      }
      return rec;
    }

    // solana:signTransaction never broadcasts: any throw from here to the record means nothing was sent.
    const signed = await checkWalletSigned(built.tx, await d.signer.sign(built.wire));
    const id = solanaTxId(signed);
    const watching: Pending = { ...base, id, txHash: id, note: SOLANA_WATCH_NOTE };
    d.record(watching); // before the broadcast: from here on the transfer is never lost
    try {
      await io.sendWire(d.rpc, Uint8Array.from(getTransactionEncoder().encode(signed)));
    } catch (e) {
      // Only a preflight error that proves the node never forwarded it is "not sent" (preflightNotSent). AlreadyProcessed
      // and every error it cannot classify stay unconfirmed: the record keeps the watch note; the chain and Iris settle it.
      if (preflightNotSent(e)) {
        const why = (e as Error).message.slice(0, 120);
        d.record({ ...watching, note: `not sent: Solana refused it (${why})` });
        throw new Error(`Solana refused the transaction before sending it, so nothing moved. ${why}`);
      }
      throw new SolanaSendUncertainError(id, { cause: e });
    }
    const sent: Pending = { ...base, id, txHash: id }; // the node took it: the watch note goes
    try {
      d.record(sent);
    } catch (e) {
      throw new SolanaSendUncertainError(id, { cause: e }); // it was sent; the watch record already stored settles it
    }
    return sent;
  } finally {
    d.lock.end();
  }
}

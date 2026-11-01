import type { Address as SolAddress } from "@solana/kit";
import { toHex, type Hex } from "viem";
import type { Network } from "../../config/validate";
import type { HlUserWallet } from "../../hl/injected";
import { UNCONFIRMED_NOTE, UnconfirmedPostError, normalizeUsdcAmount, postSigned, signSendToEvmAction, type SendToEvmAction, type SignedBody } from "../../hl/userSigned";
import { CCTP_WITHDRAW_FEE_CAP, SOLANA_DOMAIN } from "../addresses";
import { usdcString } from "../exec";
import { quote } from "../fees";
import { PendingFullError, withdrawMarks, type Pending } from "../pending";
import { BAD_SOLANA_ADDRESS, solanaOwner, usdcAta } from "./ata";
import { solanaAtaHook } from "./hook";

/**
 * [P4 §2.1; C-W-SOL Step 2] sendToEvmWithData to Solana: destination domain 5, base58 encoding, the recipient's USDC
 * token account (never the wallet address), gasLimit 200000, and the createATA `data`.
 */
export function solanaWithdrawAction(o: {
  net: Network; signatureChainId: number; amount: string; sourceDex: "" | "spot"; ata: SolAddress; data: Hex; nonce: number;
}): SendToEvmAction {
  return {
    type: "sendToEvmWithData",
    hyperliquidChain: o.net === "mainnet" ? "Mainnet" : "Testnet",
    signatureChainId: toHex(o.signatureChainId),
    token: "USDC",
    amount: o.amount,
    sourceDex: o.sourceDex,
    destinationRecipient: o.ata,
    addressEncoding: "base58",
    destinationChainId: SOLANA_DOMAIN,
    gasLimit: 200_000,
    data: o.data,
    nonce: o.nonce,
  };
}

export { BAD_SOLANA_ADDRESS };

/**
 * Where a withdrawal to `owner` goes: derived here from the owner every time, never taken from a caller or storage.
 * The owner passes `solanaOwner` (32 bytes, not all-zero, on the ed25519 curve) [P4 §2.1].
 */
export async function solanaWithdrawTarget(net: Network, owner: string): Promise<{ owner: SolAddress; ata: SolAddress; data: Hex }> {
  const o = solanaOwner(owner);
  return { owner: o, ata: await usdcAta(net, o), data: solanaAtaHook(o) };
}

/** Validates the amount and the owner, then signs with the main wallet (Fix A). Nothing is posted. */
export async function signSendToSolana(wallet: HlUserWallet, net: Network, o: { amount: string; sourceDex: "" | "spot"; owner: string }): Promise<SignedBody> {
  const amount = normalizeUsdcAmount(o.amount);
  const t = await solanaWithdrawTarget(net, o.owner);
  return signSendToEvmAction(wallet, (signatureChainId, nonce) =>
    solanaWithdrawAction({ net, signatureChainId, amount, sourceDex: o.sourceDex, ata: t.ata, data: t.data, nonce }),
  );
}

export interface SolanaWithdrawDeps {
  net: Network;
  wallet: HlUserWallet;
  amount: bigint; // USDC 1e6
  sourceDex: "" | "spot";
  /** The connected Solana wallet's address (base58). The USDC arrives at its token account. */
  owner: string;
  nowMs: number;
  hasRoom(): boolean;
  /** USDC (1e6) held by a Solana token account; 0n when the account does not exist yet; null when the RPC did not answer. */
  readAtaUsdc(ata: SolAddress): Promise<bigint | null>;
  /** The highest balance mark that earlier, still-pending withdrawals to this token account wait for (0n if none). */
  watching(ata: string): bigint;
  record(p: Pending): void;
  keepSigned(id: string, body: SignedBody): void;
  post?: (net: Network, body: SignedBody) => Promise<void>;
}

/**
 * A HyperCore → Solana withdrawal under Plan 3's money rules: minimum and room before the wallet is asked; the arrival is
 * watched by the token account's balance; the action is signed once; an unconfirmed post keeps the signed body for
 * "Retry (same request)" and leaves a record with UNCONFIRMED_NOTE. Returns the record it stored.
 */
export async function runSolanaWithdraw(d: SolanaWithdrawDeps): Promise<Pending> {
  const minimum = quote("solana", "withdraw", d.amount, null).error;
  if (minimum) throw new Error(minimum);
  if (!d.hasRoom()) throw new PendingFullError();
  const t = await solanaWithdrawTarget(d.net, d.owner);
  const baseline = await d.readAtaUsdc(t.ata);
  if (baseline === null) throw new Error("Could not read your USDC balance on Solana, so the arrival could not be watched. Nothing was sent. Try again in a moment.");
  // the amount less the fee cap; started above any earlier withdrawal still on its way to this token account
  const { minArrive, start } = withdrawMarks(d.amount, d.amount - CCTP_WITHDRAW_FEE_CAP[SOLANA_DOMAIN], baseline, d.watching(t.ata));
  const id = `w-${d.nowMs}`;
  const rec = (note?: string): Pending => ({
    id, dir: "withdraw", route: "solana", amount: d.amount.toString(), startedAt: d.nowMs, status: "pending",
    balanceKind: "solana", watch: t.ata, baseline: start.toString(), minArrive: minArrive.toString(), ...(note ? { note } : {}),
  });
  const body = await signSendToSolana(d.wallet, d.net, { amount: usdcString(d.amount), sourceDex: d.sourceDex, owner: t.owner });
  try {
    await (d.post ?? postSigned)(d.net, body);
  } catch (e) {
    if (e instanceof UnconfirmedPostError) {
      d.keepSigned(id, e.body); // module memory: "Retry (same request)" re-posts exactly this
      d.record(rec(UNCONFIRMED_NOTE));
    }
    throw e;
  }
  const done = rec();
  d.record(done);
  return done;
}

import { getWallets } from "@wallet-standard/app";
import { SOLANA_SIGN_PREFERENCE } from "../routes/solana/constants";

/**
 * Solana wallets through the Wallet Standard (Phantom, Solflare, Backpack, …) [P4 §3]. Only what the deposit and the
 * withdrawal need: discover, connect, and sign one transaction. Local minimal types; no @solana/wallet-adapter.
 */
export const CONNECT = "standard:connect";
export const SIGN_TX = "solana:signTransaction";
export const SIGN_AND_SEND = "solana:signAndSendTransaction";

export interface SolanaAccountLike {
  readonly address: string;
  readonly chains: readonly string[];
  readonly features: readonly string[];
}
export interface SolanaWalletLike {
  readonly name: string;
  readonly icon: string;
  readonly chains: readonly string[];
  readonly features: Readonly<Record<string, unknown>>;
  readonly accounts: readonly SolanaAccountLike[];
}
interface ConnectFeature {
  connect(input?: { silent?: boolean }): Promise<{ accounts: readonly SolanaAccountLike[] }>;
}
interface TxFeature {
  supportedTransactionVersions?: readonly (string | number)[];
}
interface SignTxFeature extends TxFeature {
  signTransaction(...inputs: { account: SolanaAccountLike; transaction: Uint8Array; chain?: string }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
}
interface SignAndSendFeature extends TxFeature {
  signAndSendTransaction(...inputs: { account: SolanaAccountLike; transaction: Uint8Array; chain: string }[]): Promise<readonly { signature: Uint8Array }[]>;
}
export interface WalletsApi {
  get(): readonly SolanaWalletLike[];
  on(event: "register" | "unregister", listener: () => void): () => void;
}

/** The feature object, only when it is an object whose `method` is a function (a feature without one is not offered). */
const feature = <T,>(w: SolanaWalletLike, name: string, method: string): T | null => {
  const f = w.features[name] as Record<string, unknown> | undefined;
  return f && typeof f === "object" && typeof f[method] === "function" ? (f as T) : null;
};
const connectFeature = (w: SolanaWalletLike) => feature<ConnectFeature>(w, CONNECT, "connect");
const signFeature = (w: SolanaWalletLike) => feature<SignTxFeature>(w, SIGN_TX, "signTransaction");
const sendFeature = (w: SolanaWalletLike) => feature<SignAndSendFeature>(w, SIGN_AND_SEND, "signAndSendTransaction");
/** [P4 §3; WS-FEAT] A version-0 transaction is what the deposit builds; a wallet that cannot sign one is not offered. */
const takesV0 = (f: TxFeature | null) => !!f && (f.supportedTransactionVersions?.includes(0) ?? false);

/** [P4 §3; PH-WS] Can connect, lists the chain, and can sign (or sign and send) a version-0 transaction. */
export function solanaCapable(w: SolanaWalletLike, chain: string): boolean {
  return !!connectFeature(w) && w.chains.includes(chain) && (takesV0(signFeature(w)) || takesV0(sendFeature(w)));
}

/** Calls `onChange` now and whenever a wallet registers or unregisters, with the wallets that can do the Solana route. */
export function watchSolanaWallets(chain: string, onChange: (ws: SolanaWalletLike[]) => void, api: WalletsApi = getWallets() as unknown as WalletsApi): () => void {
  const emit = () => onChange(api.get().filter((w) => solanaCapable(w, chain)));
  const offs = [api.on("register", emit), api.on("unregister", emit)];
  emit();
  return () => offs.forEach((off) => off());
}

const canSign = (a: SolanaAccountLike, chain: string) => a.chains.includes(chain) && (a.features.includes(SIGN_TX) || a.features.includes(SIGN_AND_SEND));

/**
 * [P4 §3; PH-WS] Connects and returns the first account this connect returned that lists the chain and a signing
 * feature. Accounts authorized earlier (`w.accounts`) are never used: the account is always one the user just approved.
 */
export async function connectSolana(w: SolanaWalletLike, chain: string): Promise<SolanaAccountLike> {
  const c = connectFeature(w);
  if (!c) throw new Error(`${w.name} cannot connect here.`);
  const { accounts } = await c.connect();
  const a = accounts.find((x) => canSign(x, chain));
  if (!a) throw new Error(`${w.name} has no account on ${chain.replace("solana:", "Solana ")} that can sign transactions.`);
  return a;
}

/**
 * Nothing was broadcast: the wallet refused, failed, or answered before anything could reach the network. Safe to
 * free the pending slot; the user may try again with a new transaction.
 */
export class SolanaNotSentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SolanaNotSentError";
  }
}
/** The user declined in the wallet (a typed rejection, see isUserRejection). Nothing was signed or sent. */
export class SolanaRejectedError extends SolanaNotSentError {
  constructor(options?: { cause?: unknown }) {
    super("You declined in your Solana wallet. Nothing was sent.", options);
    this.name = "SolanaRejectedError";
  }
}
/**
 * solana:signAndSendTransaction failed without a typed rejection: the wallet may already have broadcast the transaction.
 * Recorded as "unconfirmed", never re-signed [P4 §3 ruling 3; Plan 3 money rules].
 */
export class SolanaUnconfirmedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("Your Solana wallet gave no clear answer, so the deposit may have been sent. Check your Solana wallet's activity before trying again.", options);
    this.name = "SolanaUnconfirmedError";
  }
}

export type SolanaSigner =
  | { kind: "sign"; address: string; sign(tx: Uint8Array): Promise<Uint8Array> }
  | { kind: "signAndSend"; address: string; signAndSend(tx: Uint8Array): Promise<Uint8Array> };

/**
 * [P4 §3 ruling] "sign" (solana:signTransaction: the app gets the signed bytes back and sends them itself) when the
 * preference says so and both the wallet and the account offer it; otherwise "signAndSend" (the wallet sends and
 * returns the signature). The account must list the chain. Each call asks the wallet once and returns exactly one result.
 *
 * Failures are typed so the caller cannot confuse them:
 * - sign: solana:signTransaction never broadcasts, so every failure (including a malformed answer) is "nothing sent":
 *   SolanaRejectedError for a typed rejection, SolanaNotSentError otherwise.
 * - signAndSend: SolanaRejectedError only for a typed rejection; every other failure, including a malformed answer,
 *   is SolanaUnconfirmedError, because the wallet may already have broadcast.
 */
export function solanaSigner(w: SolanaWalletLike, account: SolanaAccountLike, chain: string, preference: "sign" | "signAndSend" = SOLANA_SIGN_PREFERENCE): SolanaSigner {
  if (!account.chains.includes(chain)) throw new Error(`${w.name} cannot sign Solana transactions for this account.`);
  const s = signFeature(w);
  const ss = sendFeature(w);
  const okSign = takesV0(s) && account.features.includes(SIGN_TX);
  const okSend = takesV0(ss) && account.features.includes(SIGN_AND_SEND);
  if (okSign && (preference === "sign" || !okSend)) {
    return {
      kind: "sign",
      address: account.address,
      sign: async (tx) => {
        let out: readonly { signedTransaction: Uint8Array }[];
        try {
          out = await s!.signTransaction({ account, transaction: tx, chain });
        } catch (e) {
          // Only signed, never broadcast: nothing was sent whatever the error.
          throw isUserRejection(e) ? new SolanaRejectedError({ cause: e }) : new SolanaNotSentError("Your Solana wallet did not sign. Nothing was sent.", { cause: e });
        }
        if (out?.length !== 1 || !(out[0]?.signedTransaction instanceof Uint8Array)) throw new SolanaNotSentError("The wallet returned no signed transaction. Nothing was sent.");
        return out[0].signedTransaction;
      },
    };
  }
  if (okSend) {
    return {
      kind: "signAndSend",
      address: account.address,
      signAndSend: async (tx) => {
        let out: readonly { signature: Uint8Array }[];
        try {
          out = await ss!.signAndSendTransaction({ account, transaction: tx, chain });
        } catch (e) {
          // The wallet may have broadcast before it failed: only a typed rejection means nothing was sent.
          throw isUserRejection(e) ? new SolanaRejectedError({ cause: e }) : new SolanaUnconfirmedError({ cause: e });
        }
        // A malformed answer came after the wallet acted, so it may have broadcast: unconfirmed, never "not sent".
        if (out?.length !== 1 || !(out[0]?.signature instanceof Uint8Array) || out[0].signature.length !== 64) {
          throw new SolanaUnconfirmedError({ cause: new Error("The wallet returned no transaction signature.") });
        }
        return out[0].signature;
      },
    };
  }
  throw new Error(`${w.name} cannot sign Solana transactions for this account.`);
}

/** `WALLET_STANDARD_ERROR__USER__REQUEST_REJECTED` of npm `@wallet-standard/errors` 0.1.1, carried in `context.__code` (not a dependency). */
export const WALLET_STANDARD_USER_REJECTED = 4001000;

/**
 * A typed user rejection only: `code === 4001` (EIP-1193 / Phantom) or a Wallet Standard error with code 4001000
 * (`context.__code`, or `code`). The error's wording is never read: an RPC's "access denied" or "request cancelled"
 * after a broadcast must not look like "nothing sent". Residual risk: the Wallet Standard defines no error codes, so a
 * buggy wallet that broadcasts and then throws 4001 would read as "nothing sent"; the cost is a second deposit to the
 * user's own HyperCore account, never a loss.
 */
export function isUserRejection(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const x = e as { code?: unknown; context?: { __code?: unknown } | null };
  return x.code === 4001 || x.code === WALLET_STANDARD_USER_REJECTED || x.context?.__code === WALLET_STANDARD_USER_REJECTED;
}

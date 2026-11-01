import { isAddress, parseSignature, toHex, type Hex } from "viem";
import { HL_HOSTS } from "../config/csp";
import type { Address, Network } from "../config/validate";
import { ROUTE_ADDRESSES } from "../routes/addresses";
import { withChainRetry, type HlUserWallet } from "./injected";

export interface SendToEvmAction {
  type: "sendToEvmWithData";
  hyperliquidChain: "Mainnet" | "Testnet";
  signatureChainId: Hex;
  token: string;
  amount: string;
  sourceDex: string;
  destinationRecipient: string;
  /** "hex" for EVM destinations; "base58" for Solana (the recipient is then a base58 token account) [P4 §2.1]. */
  addressEncoding: "hex" | "base58";
  destinationChainId: number;
  gasLimit: number;
  data: Hex;
  nonce: number;
}

/** [R §2.1] HyperliquidTransaction:SendToEvmWithData, fields in order. */
export const SEND_TO_EVM_TYPES = [
  { name: "hyperliquidChain", type: "string" },
  { name: "token", type: "string" },
  { name: "amount", type: "string" },
  { name: "sourceDex", type: "string" },
  { name: "destinationRecipient", type: "string" },
  { name: "addressEncoding", type: "string" },
  { name: "destinationChainId", type: "uint32" },
  { name: "gasLimit", type: "uint64" },
  { name: "data", type: "bytes" },
  { name: "nonce", type: "uint64" },
] as const;

const DOMAIN_TYPES = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** [R §5.5, §6.4] USDC via CCTP: data "0x" = auto-forward by Circle; gasLimit 200000; hex recipient (lowercase). */
export function sendToEvmAction(o: {
  net: Network; signatureChainId: number; amount: string; sourceDex: "" | "spot"; recipient: Address; destinationDomain: 0 | 3; nonce: number;
}): SendToEvmAction {
  return {
    type: "sendToEvmWithData",
    hyperliquidChain: o.net === "mainnet" ? "Mainnet" : "Testnet",
    signatureChainId: toHex(o.signatureChainId),
    token: "USDC",
    amount: o.amount,
    sourceDex: o.sourceDex,
    destinationRecipient: o.recipient.toLowerCase(),
    addressEncoding: "hex",
    destinationChainId: o.destinationDomain,
    gasLimit: 200_000,
    data: "0x",
    nonce: o.nonce,
  };
}

export function sendToEvmTypedData(a: SendToEvmAction) {
  const { type: _type, signatureChainId, ...message } = a;
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId: Number(signatureChainId), verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: { EIP712Domain: DOMAIN_TYPES, "HyperliquidTransaction:SendToEvmWithData": [...SEND_TO_EVM_TYPES] },
    primaryType: "HyperliquidTransaction:SendToEvmWithData",
    message,
  };
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC_DECIMALS = 6; // EVM USDC [R §2.2]

/**
 * Refuses anything that could send funds somewhere unintended, before the wallet is asked to sign. A wrong recipient
 * on the CCTP path is irrecoverable [R §5.5, §6.5].
 * - amount: positive decimal string, no sign or exponent, at most 6 decimals (EVM USDC). Normalized exactly as nktkas's
 *   `UnsignedDecimal` does (leading and trailing zeros dropped), so the signed text is the canonical one.
 * - recipient: 20-byte hex address, not the zero address.
 * - destination: a CCTP domain this network's routes use (routes/addresses.ts).
 */
export function checkSendToEvm(net: Network, o: { amount: string; recipient: string; destinationDomain: number }): { amount: string; recipient: Address } {
  const amount = normalizeUsdcAmount(o.amount);
  if (typeof o.recipient !== "string" || !isAddress(o.recipient)) throw new Error("The destination address is not a valid 20-byte address (0x followed by 40 hex characters, with a correct checksum if mixed-case).");
  if (o.recipient.toLowerCase() === ZERO_ADDRESS) throw new Error("The destination address cannot be the zero address.");
  const r = ROUTE_ADDRESSES[net];
  if (o.destinationDomain !== r.arbitrum.domain && o.destinationDomain !== r.ethereum.domain) throw new Error("That destination chain is not supported.");
  return { amount, recipient: o.recipient as Address };
}

/**
 * A positive decimal string with at most 6 decimals (USDC), normalized exactly as nktkas's `UnsignedDecimal` does
 * (leading and trailing zeros dropped), so the signed text is the canonical one. Throws a plain-words Error otherwise.
 */
export function normalizeUsdcAmount(amount: string): string {
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(typeof amount === "string" ? amount.trim() : "");
  if (!m) throw new Error("Enter the amount as a plain number, like 10 or 10.5.");
  const int = m[1].replace(/^0+/, "") || "0";
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (frac.length > USDC_DECIMALS) throw new Error(`USDC has ${USDC_DECIMALS} decimals: use at most ${USDC_DECIMALS} after the point.`);
  if (int === "0" && frac === "") throw new Error("Enter an amount above zero.");
  return frac ? `${int}.${frac}` : int;
}

/** The response body as text-or-JSON: a non-JSON error page becomes readable text, never a JSON parse error. */
function readExchange(res: Response, text: string): { status?: string; response?: unknown } {
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object") return j as { status?: string; response?: unknown };
  } catch {
    /* not JSON */
  }
  return { status: "err", response: `Hyperliquid answered HTTP ${res.status}: ${text.replace(/\s+/g, " ").trim().slice(0, 160) || "(empty)"}` };
}

/** What /exchange receives for a user-signed action. Kept after signing, so a post that got no answer can be repeated unchanged. */
export interface SignedBody {
  action: Record<string, unknown>;
  nonce: number;
  signature: { r: Hex; s: Hex; v: number };
}

/** The note on a pending record whose post got no answer: the transfer may or may not have gone through. */
export const UNCONFIRMED_NOTE = "unconfirmed: check your balance";

/**
 * Posting a signed transfer was not confirmed: the request was rejected by fetch or timed out, or an HTTP 5xx or 408
 * came back (a gateway error can follow an accepted request), or a 2xx came back whose body is not JSON with a `status`
 * field (a garbled accepted answer). Hyperliquid may already have accepted it. Never sign again: `body` is re-posted
 * as is, with the same nonce, which Hyperliquid dedupes. Any other 4xx, or a 2xx with status "err", is a real answer
 * and is not this error.
 */
export class UnconfirmedPostError extends Error {
  readonly body: SignedBody;
  constructor(body: SignedBody, options?: { cause?: unknown }) {
    super("Hyperliquid did not confirm this transfer, so it may or may not have gone through. Check your balance before you send it again.", options);
    this.name = "UnconfirmedPostError";
    this.body = body;
  }
}

const POST_TIMEOUT_MS = 15_000;

/** A 2xx whose body is a JSON object with a string `status` is a readable answer; anything else in a 2xx is not. */
function readableAnswer(text: string): boolean {
  try {
    const j = JSON.parse(text) as unknown;
    return !!j && typeof j === "object" && typeof (j as { status?: unknown }).status === "string";
  } catch {
    return false;
  }
}

/**
 * Posts an already signed body to /exchange [R §2.1]. No answer, a 5xx, a 408, or a 2xx without a readable answer =
 * UnconfirmedPostError; any other answer that is not ok = Error with its text.
 */
export async function postSigned(net: Network, body: SignedBody): Promise<void> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${HL_HOSTS[net].api}/exchange`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    throw new UnconfirmedPostError(body, { cause: e });
  }
  if (res.status >= 500 || res.status === 408) throw new UnconfirmedPostError(body, { cause: new Error(`HTTP ${res.status}`) });
  if (res.ok && !readableAnswer(text)) throw new UnconfirmedPostError(body, { cause: new Error(`HTTP ${res.status} without a readable answer`) });
  const j = readExchange(res, text);
  if (j.status !== "ok") throw new Error(typeof j.response === "string" ? j.response : `${String(body.action.type)} failed (HTTP ${res.status})`);
}

/**
 * Signs one sendToEvmWithData action with the main wallet (Fix A) [T §1.3]. `make` builds the action from the wallet's
 * current chain id and a fresh nonce; on a chain-id mismatch it runs once more (withChainRetry). Nothing is posted.
 */
export async function signSendToEvmAction(wallet: HlUserWallet, make: (signatureChainId: number, nonce: number) => SendToEvmAction): Promise<SignedBody> {
  const { action, sig } = await withChainRetry(async () => {
    const action = make(await wallet.getChainId(), Date.now());
    return { action, sig: parseSignature(await wallet.signTypedData(sendToEvmTypedData(action))) };
  });
  const v = sig.v !== undefined ? Number(sig.v) : 27 + sig.yParity;
  return { action: action as unknown as Record<string, unknown>, nonce: action.nonce, signature: { r: sig.r, s: sig.s, v } };
}

/** Validates, then signs with the main wallet (Fix A) [T §1.3]. Nothing is posted. */
export async function signSendToEvm(
  wallet: HlUserWallet,
  net: Network,
  o: { amount: string; sourceDex: "" | "spot"; recipient: Address; destinationDomain: 0 | 3 },
): Promise<SignedBody> {
  const { amount, recipient } = checkSendToEvm(net, o);
  return signSendToEvmAction(wallet, (signatureChainId, nonce) => sendToEvmAction({ ...o, amount, recipient, net, signatureChainId, nonce }));
}

/** Signs and posts. Throws UnconfirmedPostError (with the signed body) when the post was not confirmed. The chain retry is inside signSendToEvm only: a failed post never signs again. */
export async function submitSendToEvm(
  wallet: HlUserWallet,
  net: Network,
  o: { amount: string; sourceDex: "" | "spot"; recipient: Address; destinationDomain: 0 | 3 },
): Promise<void> {
  await postSigned(net, await signSendToEvm(wallet, net, o));
}

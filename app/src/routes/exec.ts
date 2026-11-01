import type { IRequestTransport } from "@nktkas/hyperliquid";
import type { Hex } from "viem";
import type { Address, AppConfig, Network } from "../config/validate";
import { coreDepositWalletAbi, erc20Abi, tokenMessengerV2Abi } from "../evm/abi";
import { EvmTxError, publicClient, type WriteCall } from "../evm/clients";
import type { Abstraction } from "../hl/account";
import { isUnconfirmedHttp, plainError } from "../hl/errors";
import { getHl, infoPost, userExchange } from "../hl/clients";
import { withChainRetry, type HlUserWallet } from "../hl/injected";
import { submitSendToEvm, UnconfirmedPostError, type SignedBody } from "../hl/userSigned";
import { viemChain, type EvmKind } from "../wallet/chains";
import { DEX_PERPS, HYPEREVM_DOMAIN, ROUTE_ADDRESSES, USDC_SYSTEM_ADDRESS } from "./addresses";
import { burnArgs } from "./cctp";
import type { IrisFee } from "./fees";
import { parseIrisMessage, type IrisMessage } from "./pending";

export type Write = (kind: EvmKind, call: WriteCall) => Promise<Hex>;

/** 6-decimal integer → "10.5" (Core actions take decimal strings [R §2.2]). */
export function usdcString(x: bigint): string {
  const frac = (x % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${x / 1_000_000n}.${frac}` : `${x / 1_000_000n}`;
}

/** Unified and portfolio accounts hold USDC in spot [R §2.4]; others withdraw from perps. */
export const sourceDexFor = (a: Abstraction): "" | "spot" => (a === "unifiedAccount" || a === "portfolioMargin" ? "spot" : "");

/** CCTP source domains the app deposits from or watches: Ethereum 0, Arbitrum 3, Solana 5 [R §2.5; P4 §1]. */
export type IrisDomain = 0 | 3 | 5;

export const irisFeesUrl = (net: Network, src: IrisDomain) =>
  `${ROUTE_ADDRESSES[net].iris}/v2/burn/USDC/fees/${src}/${HYPEREVM_DOMAIN}?forward=true&hyperCoreDeposit=true`;
export const irisMessageUrl = (net: Network, src: IrisDomain, tx: string) => `${ROUTE_ADDRESSES[net].iris}/v2/messages/${src}?transactionHash=${tx}`;

export function parseIrisFees(raw: unknown): IrisFee[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((x: any) =>
    x && typeof x.finalityThreshold === "number" && typeof x.minimumFee === "number" && x.forwardFee && typeof x.forwardFee.med === "number"
      ? [{ finalityThreshold: x.finalityThreshold, minimumFee: x.minimumFee, forwardFee: { low: Number(x.forwardFee.low), med: x.forwardFee.med, high: Number(x.forwardFee.high) } }]
      : [],
  );
}

export function parsePreTransfer(raw: unknown): { fee: number; userExists: boolean } | null {
  const r = raw as { fee?: unknown; userExists?: unknown } | null;
  if (!r || typeof r !== "object" || !Number.isFinite(Number(r.fee))) return null;
  return { fee: Number(r.fee), userExists: r.userExists === true };
}

/**
 * [R §4.2] never transfer USDC straight to the CoreDepositWallet: always approve + deposit. `allowance` (what the user
 * already approved to the CoreDepositWallet, as with the CCTP path) at or above `amount` skips the approve. A second press
 * after a timeout skips the approval only if the approval landed and the deposit did not; if the deposit landed, the
 * second press approves and deposits again (to the user's own account).
 */
export async function depositFromHyperEvm(write: Write, net: Network, amount: bigint, allowance: bigint | null = null): Promise<Hex> {
  const a = ROUTE_ADDRESSES[net].hyperEvm;
  if (allowance === null || allowance < amount) {
    await write("hyperEvm", { address: a.usdc, abi: erc20Abi, functionName: "approve", args: [a.coreDepositWallet, amount] });
  }
  return write("hyperEvm", { address: a.coreDepositWallet, abi: coreDepositWalletAbi, functionName: "deposit", args: [amount, DEX_PERPS] });
}

/** The burn was sent but its receipt did not arrive: it may still land. Carries the hash so the app can watch it. */
export class BurnUncertainError extends Error {
  readonly hash: Hex;
  constructor(hash: Hex, options?: { cause?: unknown }) {
    super(`The transfer was sent (${hash}) but its result is not confirmed yet. It is being watched below; do not send it again.`, options);
    this.name = "BurnUncertainError";
    this.hash = hash;
  }
}

/** The approval went through and the burn was refused before anything was sent. Nothing moved; the allowance stays for the next try. */
export class ApprovedNotSentError extends Error {
  readonly reason: unknown; // not `cause`: plainError walks causes and would swap this text for the wallet's
  constructor(reason: unknown) {
    super(`Approved, not sent. Nothing left your wallet. The next try reuses the approval. (${plainError(reason).text})`);
    this.name = "ApprovedNotSentError";
    this.reason = reason;
  }
}

/**
 * The user's current USDC allowance to the deposit spender on `src`: TokenMessengerV2 on Arbitrum and Ethereum, the
 * CoreDepositWallet on HyperEVM. null when the chain did not answer.
 */
export async function readAllowance(cfg: AppConfig, src: EvmKind, owner: Address): Promise<bigint | null> {
  const r = ROUTE_ADDRESSES[cfg.network];
  const [usdc, spender] = src === "hyperEvm" ? [r.hyperEvm.usdc, r.hyperEvm.coreDepositWallet] : [r[src].usdc, r[src].tokenMessengerV2];
  try {
    return await publicClient(viemChain(src, cfg)).readContract({ address: usdc, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });
  } catch {
    return null;
  }
}

/**
 * [R §5.3 item 7, §6.3] approve + depositForBurnWithHook; returns the burn tx hash for Iris polling.
 * `allowance` (what the user already approved) at or above `amount` skips the approve.
 * A burn that was sent but whose receipt never came (EvmTxError with a cause) becomes BurnUncertainError, because a
 * second burn would pay twice. A burn that reverted on chain (EvmTxError without a cause) moved nothing and passes through.
 * A burn refused before it was sent, right after this call's approve, becomes ApprovedNotSentError.
 */
export async function depositCctp(write: Write, net: Network, src: "arbitrum" | "ethereum", amount: bigint, maxFee: bigint, recipient: Address, allowance: bigint | null = null): Promise<Hex> {
  const a = ROUTE_ADDRESSES[net][src];
  const approved = allowance !== null && allowance >= amount;
  if (!approved) await write(src, { address: a.usdc, abi: erc20Abi, functionName: "approve", args: [a.tokenMessengerV2, amount] });
  try {
    return await write(src, { address: a.tokenMessengerV2, abi: tokenMessengerV2Abi, functionName: "depositForBurnWithHook", args: burnArgs(net, src, amount, maxFee, recipient) });
  } catch (e) {
    if (e instanceof EvmTxError) {
      if (e.cause !== undefined) throw new BurnUncertainError(e.hash, { cause: e });
      throw e;
    }
    if (!approved) throw new ApprovedNotSentError(e);
    throw e;
  }
}

const ABOVE_ZERO = "Enter an amount above zero.";

/** Marks an error from the post stage: its fixed message never matches the chain-mismatch rule, so withChainRetry cannot repeat a post (= sign again). */
class PostStageError extends Error {
  constructor(readonly inner: unknown, readonly body: SignedBody) {
    super("post stage");
  }
}

/**
 * Runs a user-signed action through the SDK and remembers the signed body it posted. If the post is then not confirmed
 * (no answer, a 5xx or 408, or a 2xx that is not JSON), throws UnconfirmedPostError with that body: the caller must NOT sign again, only re-post it
 * (same nonce, deduped). withChainRetry covers the sign step only: once the body has been handed to the transport, every
 * error leaves as a PostStageError, so a post failure can never trigger a second signature [T §1.4].
 */
async function signedViaSdk(net: Network, wallet: HlUserWallet, run: (ex: ReturnType<typeof userExchange>) => Promise<unknown>): Promise<void> {
  try {
    await withChainRetry(async () => {
      const http = getHl(net).http;
      let sent: SignedBody | null = null;
      const recording: IRequestTransport = {
        isTestnet: http.isTestnet,
        request: <T,>(ep: "info" | "exchange", payload: unknown, signal?: AbortSignal) => {
          if (ep === "exchange") sent = payload as SignedBody;
          return http.request<T>(ep, payload, signal);
        },
      };
      try {
        await run(userExchange(net, wallet, recording));
      } catch (e) {
        if (sent) throw new PostStageError(e, sent);
        throw e;
      }
    });
  } catch (e) {
    if (!(e instanceof PostStageError)) throw e;
    if (isUnconfirmedHttp(e.inner)) throw new UnconfirmedPostError(e.body, { cause: e.inner });
    throw e.inner;
  }
}

/** [R §4.3] sendAsset to the USDC system address; arrives at the same address on HyperEVM. */
export async function withdrawToHyperEvm(wallet: HlUserWallet, net: Network, amount: bigint, sourceDex: "" | "spot"): Promise<void> {
  if (amount <= 0n) throw new Error(ABOVE_ZERO);
  await signedViaSdk(net, wallet, (ex) =>
    ex.sendAsset({ destination: USDC_SYSTEM_ADDRESS, sourceDex, destinationDex: "spot", token: "USDC", amount: usdcString(amount), fromSubAccount: "" }),
  );
}

/** [R §5.5, §6.4] sendToEvmWithData through CCTP; Circle's relayer mints on the destination. Validated before signing. */
export const withdrawCctp = (wallet: HlUserWallet, net: Network, amount: bigint, sourceDex: "" | "spot", recipient: Address, domain: 0 | 3) =>
  submitSendToEvm(wallet, net, { amount: usdcString(amount > 0n ? amount : 0n), sourceDex, recipient, destinationDomain: domain });

/** [R §3] usdClassTransfer: toPerp true = spot → perps. Standard accounts only. */
export async function moveCoreUsdc(wallet: HlUserWallet, net: Network, amount: bigint, toPerp: boolean): Promise<void> {
  if (amount <= 0n) throw new Error(ABOVE_ZERO);
  await signedViaSdk(net, wallet, (ex) => ex.usdClassTransfer({ amount: usdcString(amount), toPerp }));
}

export async function fetchIrisFees(net: Network, src: IrisDomain): Promise<IrisFee[] | null> {
  try {
    const r = await fetch(irisFeesUrl(net, src));
    return r.ok ? parseIrisFees(await r.json()) : null;
  } catch {
    return null;
  }
}

/** Not indexed yet (any non-200) = null; the caller keeps polling. */
export async function fetchIrisMessage(net: Network, src: IrisDomain, tx: string): Promise<IrisMessage | null> {
  try {
    const r = await fetch(irisMessageUrl(net, src, tx));
    return r.ok ? parseIrisMessage(await r.json()) : null;
  } catch {
    return null;
  }
}

/** [R §2.3] undocumented; null when it fails. */
export const fetchPreTransfer = (net: Network, destination: Address, source: Address) =>
  infoPost<unknown>(net, { type: "preTransferCheck", user: destination, source }).then(parsePreTransfer, () => null);

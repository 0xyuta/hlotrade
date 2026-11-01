/**
 * Minimal Hyperliquid API client for the forwarder: info reads, Core spot
 * sends, perp/spot transfers and reward claims. Signing mirrors
 * hyperliquid-python-sdk (signing.py): user-signed actions are EIP-712 under
 * "HyperliquidSignTransaction"; L1 actions sign a phantom agent over
 * keccak(msgpack(action) ‖ nonce ‖ vault flag). Every signing byte is pinned
 * by test/hl.test.ts against the SDK's own vectors.
 *
 * There is no default network: every function takes the HlNet to use.
 */
import { isCorePerp, parseFeeUnits, type ApiFill, type Addr } from "@hlo/calc";
import { concat, getTypesForEIP712Domain, hashDomain, keccak256, numberToHex, parseSignature, toHex, type Address, type Hex, type PrivateKeyAccount } from "viem";

export const HL_TESTNET_API = "https://api.hyperliquid-testnet.xyz";
/** Testnet spot tokens as "name:tokenId" (info "spotMeta"); weiDecimals 8. */
export const TESTNET_USDC = "USDC:0xeb62eee3685fc4c43992febcd9e75443";

/** One Hyperliquid network: API host, user-signed chain name, L1 phantom
 *  source (signing.py: "a" mainnet, "b" testnet), USDC spot token. */
export interface HlNet {
  readonly api: string;
  readonly chain: "Testnet" | "Mainnet";
  readonly source: "a" | "b";
  readonly usdc: string;
}
export const TESTNET: HlNet = { api: HL_TESTNET_API, chain: "Testnet", source: "b", usdc: TESTNET_USDC };
/** spotMeta on api.hyperliquid.xyz (2026-10-10): USDC index 0, weiDecimals 8. */
export const MAINNET: HlNet = { api: "https://api.hyperliquid.xyz", chain: "Mainnet", source: "a", usdc: "USDC:0x6d1e7cde53ba9467b783cb7c530ce054" };
/** Any EVM chain id works for user-signed actions; the SDK uses 0x66eee. */
const SIGNATURE_CHAIN_ID = 0x66eee;

// --------------------------------------------------------------------- info

async function post<T>(path: "/info" | "/exchange", body: unknown, net: HlNet, fetchFn: typeof fetch = fetch): Promise<T> {
  const res = await fetchFn(`${net.api}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HL ${path} ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

export interface SpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
}

/** Core spot balances of `user` (decimal strings, e.g. "12.5"). */
export async function spotBalances(user: Address, net: HlNet): Promise<SpotBalance[]> {
  const r = await post<{ balances?: SpotBalance[] }>("/info", { type: "spotClearinghouseState", user }, net);
  return r.balances ?? [];
}

/** Core USDC of `user` in 1e6 units (total, hold). Absent = never a Core user. */
export async function coreUsdc(user: Address, net: HlNet): Promise<{ total: bigint; hold: bigint } | null> {
  const b = (await spotBalances(user, net)).find((x) => x.token === 0);
  return b ? { total: decimalTo1e6(b.total), hold: decimalTo1e6(b.hold) } : null;
}

export function decimalTo1e6(s: string): bigint {
  if (s.trim().startsWith("-")) throw new Error("negative amount");
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
}

export function format1e6(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / 1_000_000n}${frac ? "." + frac : ""}`;
}

// ------------------------------------------------------- user-signed actions

interface ExchangeResponse {
  status: "ok" | "err";
  response?: unknown;
}

function sigParts(sig: Hex) {
  const { r, s, v, yParity } = parseSignature(sig);
  return { r, s, v: Number(v ?? BigInt(27 + (yParity ?? 0))) };
}

async function submit(action: Record<string, unknown>, nonce: number, sig: Hex, net: HlNet): Promise<unknown> {
  const r = await post<ExchangeResponse>("/exchange", { action, nonce, signature: sigParts(sig), vaultAddress: null }, net);
  if (r.status !== "ok") throw new Error(`HL action ${String(action.type)} refused: ${JSON.stringify(r.response)}`);
  return r.response;
}

type Field = { name: string; type: string };

/**
 * EIP-712 digest of a user-signed action. Done by hand because the primary type names
 * ("HyperliquidTransaction:UsdSend") contain a colon, which viem's signTypedData rejects as an
 * invalid struct name; the SDK (eth_account) hashes them as-is, so the bytes must be the same.
 * Supports exactly the field types these actions use.
 */
function userActionDigest(primaryType: string, fields: Field[], message: Record<string, unknown>): Hex {
  const typeHash = keccak256(toHex(`${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`));
  const encoded = fields.map((f): Hex => {
    const v = message[f.name];
    switch (f.type) {
      case "string":
        return keccak256(toHex(String(v)));
      case "bool":
        return numberToHex(v ? 1n : 0n, { size: 32 });
      case "uint64":
      case "uint256":
        return numberToHex(BigInt(v as bigint | number), { size: 32 });
      default:
        throw new Error(`unsupported EIP-712 field type ${f.type}`);
    }
  });
  const structHash = keccak256(concat([typeHash, ...encoded]));
  const domain = { name: "HyperliquidSignTransaction", version: "1", chainId: SIGNATURE_CHAIN_ID, verifyingContract: "0x0000000000000000000000000000000000000000" } as const;
  const domainSeparator = hashDomain({ domain, types: { EIP712Domain: getTypesForEIP712Domain({ domain }) } } as never);
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

/** EIP-712 signature of a user-signed action (signing.py sign_user_signed_action). */
export function signUserAction(from: PrivateKeyAccount, primaryType: string, fields: Field[], message: Record<string, unknown>): Promise<Hex> {
  return from.sign!({ hash: userActionDigest(primaryType, fields, message) });
}

/**
 * Send `amount1e6` USDC from `from`'s Core spot account to `destination`'s.
 * A destination that is not yet a Core user costs a 1 USDC activation fee
 * (who pays it is open; see docs/OPS.md, section 7).
 */
export async function spotSendUsdc(from: PrivateKeyAccount, destination: Address, amount1e6: bigint, net: HlNet): Promise<unknown> {
  const time = Date.now();
  const action = {
    type: "spotSend",
    signatureChainId: toHex(SIGNATURE_CHAIN_ID),
    hyperliquidChain: net.chain,
    destination: destination.toLowerCase(),
    token: net.usdc,
    amount: format1e6(amount1e6),
    time,
  };
  const sig = await signUserAction(
    from,
    "HyperliquidTransaction:SpotSend",
    [
      { name: "hyperliquidChain", type: "string" },
      { name: "destination", type: "string" },
      { name: "token", type: "string" },
      { name: "amount", type: "string" },
      { name: "time", type: "uint64" },
    ],
    { hyperliquidChain: action.hyperliquidChain, destination: action.destination, token: action.token, amount: action.amount, time: BigInt(time) },
  );
  return submit(action, time, sig, net);
}

/**
 * `sendAsset`: the generalized Core transfer, and the only one a
 * "unifiedAccount" user may sign (`spotSend` is refused for them with "Action
 * disabled when unified account is active"). sourceDex/destinationDex "spot"
 * moves spot USDC to the destination's spot balance — where a deposit proxy
 * reads it (0x0801). Same activation fee rule as spotSend.
 */
export const SEND_ASSET_FIELDS: Field[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "sourceDex", type: "string" },
  { name: "destinationDex", type: "string" },
  { name: "token", type: "string" },
  { name: "amount", type: "string" },
  { name: "fromSubAccount", type: "string" },
  { name: "nonce", type: "uint64" },
];

export async function sendAssetUsdc(from: PrivateKeyAccount, destination: Address, amount1e6: bigint, net: HlNet): Promise<unknown> {
  const nonce = Date.now();
  const action = {
    type: "sendAsset",
    signatureChainId: toHex(SIGNATURE_CHAIN_ID),
    hyperliquidChain: net.chain,
    destination: destination.toLowerCase(),
    sourceDex: "spot",
    destinationDex: "spot",
    token: net.usdc,
    amount: format1e6(amount1e6),
    fromSubAccount: "",
    nonce,
  };
  const { type: _t, signatureChainId: _c, ...fields } = action;
  const sig = await signUserAction(from, "HyperliquidTransaction:SendAsset", SEND_ASSET_FIELDS, { ...fields, nonce: BigInt(nonce) });
  return submit(action, nonce, sig, net);
}

// ---------------------------------------------------------------- L1 actions

/** Just enough MessagePack for flat L1 actions (the SDK packs the action
 *  dict in insertion order; so do we). */
function msgpack(v: unknown): number[] {
  if (v === null) return [0xc0];
  if (typeof v === "boolean") return [v ? 0xc3 : 0xc2];
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) {
    if (v < 0x80) return [v];
    if (v <= 0xff) return [0xcc, v];
    if (v <= 0xffff) return [0xcd, v >> 8, v & 0xff];
    if (v <= 0xffffffff) return [0xce, ...be(BigInt(v), 4)];
    return [0xcf, ...be(BigInt(v), 8)];
  }
  if (typeof v === "string") {
    const b = [...new TextEncoder().encode(v)];
    if (b.length < 32) return [0xa0 | b.length, ...b];
    if (b.length <= 0xff) return [0xd9, b.length, ...b];
    return [0xda, b.length >> 8, b.length & 0xff, ...b];
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length >= 16) throw new Error("msgpack: map too large for this encoder");
    return [0x80 | entries.length, ...entries.flatMap(([k, x]) => [...msgpack(k), ...msgpack(x)])];
  }
  throw new Error(`msgpack: unsupported value ${String(v)}`);
}

function be(v: bigint, bytes: number): number[] {
  return Array.from({ length: bytes }, (_, i) => Number((v >> BigInt(8 * (bytes - 1 - i))) & 0xffn));
}

/** keccak(msgpack(action) ‖ nonce:u64be ‖ 0x00 [no vault]) — signing.py action_hash. */
export function actionHash(action: Record<string, unknown>, nonce: number): Hex {
  return keccak256(new Uint8Array([...msgpack(action), ...be(BigInt(nonce), 8), 0x00]));
}

/** Phantom-agent signature of an L1 action (signing.py sign_l1_action). */
export function signL1Action(from: PrivateKeyAccount, action: Record<string, unknown>, nonce: number, net: HlNet): Promise<Hex> {
  return from.signTypedData({
    domain: { name: "Exchange", version: "1", chainId: 1337, verifyingContract: "0x0000000000000000000000000000000000000000" },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent",
    message: { source: net.source, connectionId: actionHash(action, nonce) },
  });
}

export async function signL1(from: PrivateKeyAccount, action: Record<string, unknown>, net: HlNet): Promise<unknown> {
  const nonce = Date.now();
  return submit(action, nonce, await signL1Action(from, action, nonce, net), net);
}

/** Route this user's HyperEVM transactions into big blocks (30M gas, ~1/min)
 *  or back to small ones (~1 s). Contract creations over the small-block
 *  limit need it. The user must already be a Core user. */
export function useBigBlocks(from: PrivateKeyAccount, enable: boolean, net: HlNet): Promise<unknown> {
  return signL1(from, { type: "evmUserModify", usingBigBlocks: enable }, net);
}

// ------------------------------------------------------- forwarder additions

/** HyperCore → HyperEVM bridge for USDC (token 0): a spot send here arrives at the sender's own HyperEVM address. */
export const USDC_SYSTEM_ADDRESS = "0x2000000000000000000000000000000000000000" as const;

/** hyperliquid-python-sdk USD_CLASS_TRANSFER_SIGN_TYPES. */
export const USD_CLASS_TRANSFER_FIELDS: Field[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "amount", type: "string" },
  { name: "toPerp", type: "bool" },
  { name: "nonce", type: "uint64" },
];

/** Moves USDC between the perps and spot balances (python SDK usd_class_transfer). */
export async function usdClassTransfer(from: PrivateKeyAccount, amount1e6: bigint, toPerp: boolean, net: HlNet): Promise<unknown> {
  const nonce = Date.now();
  const action = {
    type: "usdClassTransfer",
    signatureChainId: toHex(SIGNATURE_CHAIN_ID),
    hyperliquidChain: net.chain,
    amount: format1e6(amount1e6),
    toPerp,
    nonce,
  };
  const sig = await signUserAction(from, "HyperliquidTransaction:UsdClassTransfer", USD_CLASS_TRANSFER_FIELDS, {
    hyperliquidChain: action.hyperliquidChain,
    amount: action.amount,
    toPerp,
    nonce: BigInt(nonce),
  });
  return submit(action, nonce, sig, net);
}

/** Claims referral and builder rewards into the account (L1 action). */
export const claimRewards = (from: PrivateKeyAccount, net: HlNet): Promise<unknown> => signL1(from, { type: "claimRewards" }, net);

/** Unclaimed referral/builder rewards of `user`, 1e6 units (floor). */
export async function referralUnclaimed(user: Address, net: HlNet): Promise<bigint> {
  const r = await post<{ unclaimedRewards?: string }>("/info", { type: "referral", user }, net);
  return decimalTo1e6(r.unclaimedRewards ?? "0");
}

/** Perp withdrawable USDC of `user`, 1e6 units (floor). */
export async function perpWithdrawable(user: Address, net: HlNet): Promise<bigint> {
  const r = await post<{ withdrawable?: string }>("/info", { type: "clearinghouseState", user }, net);
  return decimalTo1e6(r.withdrawable ?? "0");
}

/** Waits before the 1st, 2nd and 3rd retry of a rate-limited (HTTP 429) request. */
export const RATE_LIMIT_BACKOFF_MS = [2000, 4000, 8000] as const;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `post`, retrying an HTTP 429 after 2 s, 4 s and 8 s; the fourth 429 (like any other error) is thrown. */
async function postRetry429<T>(path: "/info" | "/exchange", body: unknown, net: HlNet, fetchFn: typeof fetch, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await post<T>(path, body, net, fetchFn);
    } catch (e) {
      if (retry >= RATE_LIMIT_BACKOFF_MS.length || !/^HL \/\w+ 429:/.test((e as Error).message)) throw e;
      await sleep(RATE_LIMIT_BACKOFF_MS[retry]);
    }
  }
}

/** Fills per `userFillsByTime` page: a full page may have more after its newest fill. */
const FILLS_PAGE = 2000;

/**
 * Every fill of `user` with time in [startMs, endMs], oldest page first, not aggregated. A page of 2000 means there
 * may be more, so the next request starts at the newest fill's time itself (fills sharing that millisecond may not have
 * fit; `tid` deduplication absorbs the repeats). A full page that cannot advance throws: never a truncated list.
 */
export async function userFillsByTime(
  user: Addr, startMs: number, endMs: number, net: HlNet, fetchFn: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<ApiFill[]> {
  const out = new Map<number, ApiFill>();
  let from = startMs;
  for (;;) {
    const page = await postRetry429<ApiFill[]>("/info", { type: "userFillsByTime", user, startTime: from, endTime: endMs, aggregateByTime: false }, net, fetchFn, sleep);
    if (!Array.isArray(page)) throw new Error(`userFillsByTime ${user}: unexpected response`);
    for (const f of page) out.set(f.tid, f);
    if (page.length < FILLS_PAGE) return [...out.values()];
    const next = Math.max(...page.map((f) => f.time));
    if (next <= from) throw new Error(`userFillsByTime ${user}: ${FILLS_PAGE} fills in one millisecond, cannot page`);
    from = next;
  }
}

/** The most `user` has approved `builder` to charge, in tenths of a basis point (100 = 0.1%). */
export async function maxBuilderFee(user: Addr, builder: Addr, net: HlNet, fetchFn: typeof fetch = fetch): Promise<number> {
  const r = await post<unknown>("/info", { type: "maxBuilderFee", user, builder }, net, fetchFn);
  if (typeof r !== "number" || !Number.isFinite(r)) throw new Error(`maxBuilderFee ${user}: unexpected response`);
  return r;
}

/** The core perps Hyperliquid lists now (`meta`), without the delisted ones. */
export async function perpCoins(net: HlNet, fetchFn: typeof fetch = fetch): Promise<string[]> {
  const r = await postRetry429<{ universe?: { name: string; isDelisted?: boolean }[] }>("/info", { type: "meta" }, net, fetchFn, defaultSleep);
  if (!Array.isArray(r?.universe)) throw new Error("meta: unexpected response");
  return r.universe.filter((c) => !c.isDelisted && isCorePerp(c.name)).map((c) => c.name);
}

/** The builder's cumulative fees as Hyperliquid counts them, in 1e-8 USDC; null when the answer has no readable total. */
export async function builderRewardsUnits(builder: Addr, net: HlNet, fetchFn: typeof fetch = fetch): Promise<bigint | null> {
  const r = await postRetry429<{ builderRewards?: unknown }>("/info", { type: "referral", user: builder }, net, fetchFn, defaultSleep);
  if (typeof r?.builderRewards !== "string") return null;
  try {
    return parseFeeUnits(r.builderRewards);
  } catch {
    return null; // not a plain decimal, or more than 8 decimals: unreadable, not a reason to stop
  }
}

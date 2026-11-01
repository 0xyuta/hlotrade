import { toFunctionSelector } from "viem";

const MAX_CAUSES = 5;

/** The error and its `cause` chain (outermost first), at most MAX_CAUSES causes deep; stops at a repeat. */
function causeChain(e: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = e;
  for (let i = 0; i <= MAX_CAUSES; i++) {
    out.push(cur);
    if (!cur || typeof cur !== "object" || out.indexOf((cur as { cause?: unknown }).cause) !== -1) break;
    const next = (cur as { cause?: unknown }).cause;
    if (next === undefined || next === null) break;
    cur = next;
  }
  return out;
}

/** EIP-1193 codes found anywhere in the chain, including `data.originalError.code` (MetaMask Mobile wraps 4902 that way). */
export function walletCodes(e: unknown): number[] {
  const codes: number[] = [];
  for (const x of causeChain(e)) {
    if (!x || typeof x !== "object") continue;
    const o = x as { code?: unknown; data?: { originalError?: { code?: unknown } } };
    for (const c of [o.code, o.data?.originalError?.code]) if (typeof c === "number") codes.push(c);
  }
  return codes;
}

/** nktkas wraps every wallet failure in AbstractWalletError("Failed to sign the typed data using the wallet", { cause }). */
const isWalletWrapper = (e: object, text: string) =>
  (e as { name?: unknown }).name === "AbstractWalletError" || /^Failed to (sign the typed data|get an address|get the chain ID)\b/i.test(text);

/** The text of anything thrown: nktkas ApiRequestError (`response` string or `{response}`), wallet errors (looking through nktkas's wrapper to the wallet's own message), Error, strings. */
export function messageOf(e: unknown): string {
  return messageAt(e, 0);
}

function messageAt(e: unknown, depth: number): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const text = ownMessage(e);
    const cause = (e as { cause?: unknown }).cause;
    if (cause !== undefined && cause !== null && depth < MAX_CAUSES && isWalletWrapper(e, text)) return messageAt(cause, depth + 1);
    return text;
  }
  return String(e);
}

function ownMessage(e: object): string {
  const r = (e as { response?: unknown }).response;
  if (typeof r === "string") return r;
  if (r && typeof r === "object" && typeof (r as { response?: unknown }).response === "string") return (r as { response: string }).response;
  const m = (e as { message?: unknown }).message;
  if (typeof m === "string") return m;
  const er = (e as { error?: unknown }).error;
  if (typeof er === "string") return er;
  try {
    const j = JSON.stringify(e);
    if (typeof j === "string") return j.length > 200 ? j.slice(0, 200) : j;
  } catch {
    /* cyclic or throwing toJSON: name the keys instead */
  }
  return `Unreadable error (fields: ${Object.keys(e).slice(0, 10).join(", ") || "none"})`;
}

/**
 * nktkas HttpRequestError with no HTTP response (fetch rejected, timed out, aborted), a 5xx or 408 one, or a 2xx one
 * (nktkas raises it for a 2xx whose body is not JSON: a garbled accepted answer): the exchange may still have the request.
 */
export const isUnconfirmedHttp = (e: unknown) => {
  if (!e || typeof e !== "object" || (e as { name?: unknown }).name !== "HttpRequestError") return false;
  const r = (e as { response?: { status?: number } }).response;
  if (!r) return true;
  const s = r.status;
  return typeof s === "number" && (s >= 500 || s === 408 || (s >= 200 && s < 300));
};

/** MetaMask: `Provided chainId "42161" must match the active chainId "999"`: the wallet's chain changed while signing [T §1.4]. */
export const isChainMismatch = (e: unknown) => /must match the active chainId|chain ?id mismatch/i.test(messageOf(e));

/** Matches a decoded custom-error name or its 4-byte selector. */
function revertRule(signature: string, name: string): RegExp {
  return new RegExp(`\\b${name}\\b|${toFunctionSelector(signature)}`);
}

/** The Rewards screen shows this while the guardian has paused settling and claiming, and it is what an IsPaused revert says. */
export const PAUSED_TEXT = "Rewards are paused while a checkpoint is checked. Your HLO is safe.";
/** Mining pays claims from one hourly allowance; this is what ClaimLimitReached says and what the Claim button shows while the allowance is empty. */
export const CLAIM_LIMIT_TEXT = "Claims are at their hourly limit. Try again in a few minutes.";
const SETTLED_FIRST_TEXT = "Someone settled a newer checkpoint first. Try again.";
const REFUSED_TEXT = "That checkpoint was refused by the contract. Try again in a minute.";

// The tick and builder rules are anchored to documented phrases / reason codes [T §3.3, §3.4, §3.5], not bare words
// ("stick", "builder" alone would match unrelated text). The real exchange wording is on the testnet checklist.
const RULES: [RegExp, string][] = [
  [/Must deposit before performing actions/i, "Deposit USDC to your Hyperliquid account before trading."],
  [/minimum value of \$10/i, "Orders must be worth at least $10."],
  [/Insufficient margin|perpMarginRejected/i, "Not enough margin for this order."],
  [/Reduce only order would increase position|reduceOnlyRejected/i, "This order would grow your position, but it is reduce-only."],
  [/could not immediately match|iocCancelRejected|marketOrderNoLiquidityRejected/i, "Nothing filled at your slippage limit. Try again or widen the slippage."],
  [/never placed, already canceled, or filled/i, "That order is no longer open."],
  [/tickRejected|divisible by tick size/i, "That price has too many digits for this market."],
  [/badTriggerPx|Invalid TP\/SL price/i, "The take-profit or stop-loss price is on the wrong side of the market."],
  [/builder.{0,40}not (?:been )?approved|approveBuilderFee/i, "The HLO builder fee is not approved for this account. Use Enable trading."],
  [/must match the active chainId|chain ?id mismatch/i, "Your wallet switched networks while signing. Try again."],
  [/Unable to recover signer/i, "The signature could not be read. Try again."],
  [/User rejected|User denied|rejected the request/i, "You cancelled the request in your wallet."],
  // Profiles.sol custom errors. viem names them once the ABI has them; a wallet that returns raw data shows the selector.
  // Case-sensitive on purpose: usernames are lowercase, so a name echoed in a viem message can never match.
  [revertRule("NameTaken()", "NameTaken"), "That name is taken. Pick another one."],
  [revertRule("BadName()", "BadName"), "Names are 3–16 characters: a–z, 0–9 and _."],
  [revertRule("BadAvatar()", "BadAvatar"), "Pick one of the built-in avatars."],
  // Mining.sol and Checkpoints.sol custom errors (settleAndClaim, claim). A settleAndClaim can revert with either contract's errors, so the write ABI carries both (settleAndClaimAbi).
  [revertRule("NothingToClaim()", "NothingToClaim"), "Nothing new to claim yet."],
  [revertRule("ClaimLimitReached()", "ClaimLimitReached"), CLAIM_LIMIT_TEXT],
  [revertRule("NotNewer()", "NotNewer"), SETTLED_FIRST_TEXT],
  [revertRule("StaleCheckpoint()", "StaleCheckpoint"), SETTLED_FIRST_TEXT],
  [revertRule("MinuteNotOver()", "MinuteNotOver"), "That minute is not over yet. Try again in a few seconds."],
  [revertRule("BadRefBlock()", "BadRefBlock"), "That checkpoint is a moment newer than the chain. Try again in a few seconds."],
  [revertRule("IsPaused()", "IsPaused"), PAUSED_TEXT],
  [revertRule("NotSettled()", "NotSettled"), "That checkpoint is not settled yet. Try again."],
  [revertRule("OverSchedule()", "OverSchedule"), REFUSED_TEXT],
  [revertRule("BadSignature()", "BadSignature"), REFUSED_TEXT],
  [revertRule("BadProof()", "BadProof"), "Your proof did not match. Reload and try again."],
  [revertRule("OverEntitled()", "OverEntitled"), "The contract refused this claim because it is above the posted limit. Try again later."],
  // Staking.sol and Buyback.sol custom errors (stake, unstake, openPool, buy). TransferFailed is SafeTransfer's.
  [revertRule("ZeroAmount()", "ZeroAmount"), "Enter an amount above zero."],
  [revertRule("InsufficientStake()", "InsufficientStake"), "You do not have that much HLO staked."],
  [revertRule("TransferFailed()", "TransferFailed"), "The HLO transfer failed. Check your HLO balance and the approval, then try again."],
  [revertRule("PoolAlreadyOpen()", "PoolAlreadyOpen"), "The pool is already open."],
  [revertRule("TooEarly()", "TooEarly"), "It is too early to open the pool."],
  [revertRule("NothingToSeed()", "NothingToSeed"), "The pool opens with the first fee deposit: there is no USDC to start it with yet."],
  [revertRule("PoolNotOpen()", "PoolNotOpen"), "The pool is not open yet."],
  [revertRule("TooSoon()", "TooSoon"), "The last buyback was less than 10 minutes ago. Try again in a moment."],
];

/**
 * Plain words for the UI. "User or API Wallet 0x… does not exist." means the agent is unknown or expired when the
 * address is our agent's (→ one re-sign), and a signing bug when it differs [T §2.4].
 */
export function plainError(e: unknown, agentAddress?: string): { text: string; reSign: boolean; raw: string } {
  const raw = messageOf(e);
  if (walletCodes(e).includes(4001)) return { text: "You cancelled the request in your wallet.", reSign: false, raw };
  // The live text may carry the full address or a shortened one such as 0xf56b…6dd2 [T §2.4]; accept both.
  const missing = /User or API Wallet (0x[0-9a-fA-F]+)(…|\.{2,3})?([0-9a-fA-F]*)\s+does not exist/i.exec(raw);
  if (missing) {
    if (!agentAddress || sameAddress(missing[1], missing[2] ? missing[3] : "", Boolean(missing[2]), agentAddress)) {
      return { text: "Your trading key is no longer approved (it expired or was replaced). Sign once to enable trading again.", reSign: true, raw };
    }
    return { text: "The signature did not match your trading key. Reload the page and try again.", reSign: false, raw };
  }
  for (const [re, text] of RULES) if (re.test(raw)) return { text, reSign: false, raw };
  if (!raw.trim()) return { text: EMPTY_ERROR_TEXT, reSign: false, raw }; // e.g. new Error(""): never an empty message
  return { text: raw.length > 200 ? `${raw.slice(0, 197)}…` : raw, reSign: false, raw };
}

/** What the UI says for an error with no text at all. */
export const EMPTY_ERROR_TEXT = "Something went wrong. Try again.";

/** A shortened address must keep at least this many hex digits on each side to count as ours (0xf56b…6dd2 keeps 4). */
const MIN_SHORT_DIGITS = 4;

/** Full address: exact match (case-insensitive). Shortened `head…tail`: the agent's start and end must match, with enough digits on each side. */
function sameAddress(head: string, tail: string, shortened: boolean, agent: string): boolean {
  const a = agent.toLowerCase();
  const h = head.toLowerCase();
  if (!shortened) return h === a;
  if (h.length - 2 < MIN_SHORT_DIGITS || tail.length < MIN_SHORT_DIGITS) return false;
  return a.startsWith(h) && a.endsWith(tail.toLowerCase());
}

import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import type { CoreChain } from "./chain";
import { contractAcceptsSig, type LatestFile, type UserFile } from "./files";
import { CLAIM_PAID_PCT, POP_MIN_UNITS, VAULT_PAY_PCT } from "./constants";
import { POP_ODDS } from "./odds";
import { verifyEntitlement } from "./proof";

/** What the Yours card shows for one account, from its user file that passed `checkSigned` and the chain's `claimed`. All HLO amounts are wei; points are fee units (1e-8 USDC). */
export interface Yours {
  earned: bigint; // cumulative entitlement in the file
  claimed: bigint; // Mining.claimed(user)
  claimable: bigint; // earned − claimed, never negative
  claimNow: bigint; // what a claim would take now: min(claimable, the hourly allowance); the rest stays claimable
  youGet: bigint; // what you receive if you claim now: Mining pays 90% of the gross (claimNow); 10% is refining for holders who have not claimed
  refined: bigint; // the refining share earned so far (display only)
  points: bigint; // points since the last pop, in fee units (1e8 units = 1 point = $1 of builder fee)
  vaultShare: bigint; // what the user would get if the vault popped now: floor(floor(vault × 9/10) × points ÷ all points)
}

/** The arguments of Mining.settleAndClaim (kind "settleAndClaim") or Mining.claim (kind "claim"): the checkpoint, the poster's signature, the cumulative entitlement and its Merkle proof. */
export interface ClaimPlan {
  kind: "settleAndClaim" | "claim";
  cp: { throughMinute: number; refBlock: bigint; root: Hex; totalEntitled: bigint };
  sig: Hex;
  entitlement: bigint;
  /** Mining.claimed(user) once this claim is mined: claimed + min(entitlement − claimed, allowance). A partial claim stops short of `entitlement`. */
  expectClaimed: bigint;
  proof: Hex[];
}

/** Checkpoints.sol's EIP-712 type (ops/src/sign.ts CHECKPOINT_TYPES); the domain is name "HLO Checkpoints", version "1". */
const CHECKPOINT_TYPES = {
  Checkpoint: [
    { name: "throughMinute", type: "uint256" },
    { name: "refBlock", type: "uint256" },
    { name: "root", type: "bytes32" },
    { name: "totalEntitled", type: "uint256" },
  ],
} as const;

/** The fields the poster signed, which latest.json and every user file carry. */
export type SignedFields = Pick<LatestFile, "throughMinute" | "refBlock" | "root" | "totalEntitled" | "sig">;

const cpOf = (f: SignedFields) => ({
  throughMinute: f.throughMinute,
  refBlock: BigInt(f.refBlock),
  root: f.root,
  totalEntitled: BigInt(f.totalEntitled),
});

/** Shown when a file is behind the chain (the store lags, or the settled minute was not a user-file round). */
export const UPDATING = "Rewards are updating…";

type Checked = { ok: true } | { ok: false; reason: string };

/**
 * Storage is untrusted (docs/OPS.md §10), so latest.json and a user file are used only if the poster really signed them and they fit the chain:
 *  - the signature recovers `chain.poster` for this chain and Checkpoints contract (an altered file does not, and neither does
 *    one signed for another chain or contract, whatever its own chainId and contract fields say);
 *  - it is not older than the chain's latest settled minute (`UPDATING`: the store lags the chain);
 *  - at the same minute its root is the chain's root.
 * A file newer than the chain is fine: `settleAndClaim` settles it. Whether its refBlock is already below the head is not decided here.
 */
export async function checkSigned(file: SignedFields, chain: CoreChain, chainId: number, contract: Address): Promise<Checked> {
  if (!contractAcceptsSig(file.sig)) return { ok: false, reason: "That checkpoint was refused by the contract's signature rules, so the file was ignored." };
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: { name: "HLO Checkpoints", version: "1", chainId, verifyingContract: contract },
      types: CHECKPOINT_TYPES,
      primaryType: "Checkpoint",
      message: { ...cpOf(file), throughMinute: BigInt(file.throughMinute) },
      signature: file.sig,
    });
  } catch {
    return { ok: false, reason: "The reward file's signature could not be read, so it was ignored." };
  }
  if (signer.toLowerCase() !== chain.poster.toLowerCase()) return { ok: false, reason: "The reward file was not signed by the rewards poster, so it was ignored." };
  if (chain.latestMinute !== null) {
    if (file.throughMinute < chain.latestMinute) return { ok: false, reason: UPDATING };
    if (file.throughMinute === chain.latestMinute && file.root.toLowerCase() !== chain.latestRoot?.toLowerCase()) {
      return { ok: false, reason: "The reward file does not match the chain, so it was ignored." };
    }
  }
  return { ok: true };
}

/** latest.json: `checkSigned`, and its vault odds are this network's (POP_ODDS). */
export async function checkLatest(latest: LatestFile, chain: CoreChain, chainId: number, contract: Address): Promise<Checked> {
  if (latest.vault.odds !== POP_ODDS[chainId]) return { ok: false, reason: "The reward file's vault odds are not this network's, so it was ignored." };
  return checkSigned(latest, chain, chainId, contract);
}

const entryOf = (file: UserFile | null, user: Address) => file?.users[user.toLowerCase()] ?? null;

export const ENTRY_MISMATCH = "Your numbers in the rewards file don't match its signed tree.";

/**
 * The user's entitlement as the signed root proves it, or null when the file contradicts itself about this user.
 * The Merkle root is covered by the poster's signature; the entry is not. So a nonzero entitlement is believed only if its proof
 * verifies against the root, and an entry with no proof must have an entitlement of 0 (wallets with points but nothing earned
 * are not in the tree). A wallet with no entry has 0.
 */
function verifiedEntitlement(file: UserFile | null, user: Address): bigint | null {
  const e = entryOf(file, user);
  if (!e) return 0n;
  const entitlement = BigInt(e.entitlement);
  if (e.proof.length === 0) return entitlement === 0n ? 0n : null;
  return verifyEntitlement(file!.root, user, entitlement, e.proof) ? entitlement : null;
}

/** Null when the user's entry agrees with the signed root (or the user has none); otherwise the text to show. */
export function entryProblem(file: UserFile | null, user: Address): string | null {
  return verifiedEntitlement(file, user) === null ? ENTRY_MISMATCH : null;
}

/**
 * `file` is the user's file and must have passed `checkSigned` (null when the store has none: a wallet with no entry). The figures are 0
 * when the file has no entry for the user, and also when the entry does not verify (`entryProblem`): then the entitlement, the
 * points, the refining and the vault share all read 0. When the entitlement verifies, it is proven by its proof; the other numbers
 * of the entry (points, refined, the file's vault) are display only and shown as the file says (a store could always change
 * them; they are never sent anywhere). The share comes from the file's own vault, so it fits the points.
 */
export function yoursFrom(file: UserFile | null, chain: Pick<CoreChain, "claimed" | "claimAvailable">, user: Address): Yours {
  const claimed = chain.claimed ?? 0n;
  const earned = verifiedEntitlement(file, user);
  const e = earned === null ? null : entryOf(file, user);
  const claimable = earned !== null && earned > claimed ? earned - claimed : 0n;
  const points = e ? BigInt(e.points) : 0n;
  const pointsTotal = file ? BigInt(file.vault.pointsTotal) : 0n;
  const vault = file ? BigInt(file.vault.amount) : 0n;
  const claimNow = claimable < chain.claimAvailable ? claimable : chain.claimAvailable; // Mining pays at most the allowance, the rest stays claimable
  return {
    earned: earned ?? 0n,
    claimed,
    claimable,
    claimNow,
    youGet: (claimNow * BigInt(CLAIM_PAID_PCT)) / 100n, // Mining: gross * 9 / 10, rounded down
    refined: e ? BigInt(e.refined) : 0n,
    points,
    vaultShare: pointsTotal > 0n && points >= POP_MIN_UNITS ? (((vault * BigInt(VAULT_PAY_PCT)) / 100n) * points) / pointsTotal : 0n,
  };
}

/** A claim that would pay less than this (0.01 HLO, what the card can show) counts as blocked by the allowance, not as a claim worth sending. */
export const MIN_CLAIM_NOW = 10n ** 16n;

/** Something is claimable but the hourly allowance lets through nothing worth sending: Claim is off and the limit text shows. */
export const claimLimited = (y: Pick<Yours, "claimable" | "claimNow">): boolean => y.claimNow < y.claimable && y.claimNow < MIN_CLAIM_NOW;

/** The allowance lets through a claim worth sending, but not all of what is claimable: the card says the rest stays claimable. */
export const claimPartial = (y: Pick<Yours, "claimable" | "claimNow">): boolean => y.claimNow >= MIN_CLAIM_NOW && y.claimNow < y.claimable;

/**
 * What to send to claim, or null when there is nothing to claim or the file cannot be used. The proof is the user file's, and is
 * checked here against the file's root (which `checkSigned` ties to the poster's signature and the chain), so a bad file never reaches the wallet.
 * `settleAndClaim` when this checkpoint is newer than the chain's latest (or nothing is settled): the contract settles it first.
 * `claim` when the chain has settled exactly this checkpoint.
 * `claim` also for a file OLDER than the chain's latest, when `settledRoot` (`rootOf(file.throughMinute)`, which the caller reads
 * only in that state) is the file's own root: Mining pays against any settled minute that is not cancelled. A zero (null) or another root
 * means that minute is unsettled, cancelled or not this file's: no plan. A file at the chain's own minute with another root gives null.
 * Mining pays from an hourly allowance and pays a bigger claim in part, so `expectClaimed` (not `entitlement`) is where `claimed` lands.
 */
export function claimPlan(file: UserFile | null, chain: CoreChain, user: Address, settledRoot: Hex | null = null): ClaimPlan | null {
  if (!file) return null;
  let kind: ClaimPlan["kind"];
  if (!chain.anySettled || chain.latestMinute === null || file.throughMinute > chain.latestMinute) kind = "settleAndClaim";
  else if (file.throughMinute === chain.latestMinute && file.root.toLowerCase() === chain.latestRoot?.toLowerCase()) kind = "claim";
  else if (file.throughMinute < chain.latestMinute && settledRoot !== null && settledRoot.toLowerCase() === file.root.toLowerCase()) kind = "claim";
  else return null;
  const e = entryOf(file, user);
  const got = verifiedEntitlement(file, user);
  if (got === null || got === 0n || !e) return null; // the file contradicts itself about this user, or there is nothing earned
  const claimed = chain.claimed ?? 0n;
  if (got <= claimed) return null;
  const rest = got - claimed;
  const expectClaimed = claimed + (rest < chain.claimAvailable ? rest : chain.claimAvailable);
  return { kind, cp: cpOf(file), sig: file.sig, entitlement: got, expectClaimed, proof: e.proof };
}

/** 1 point per $1 of builder fee (= $1,000 traded at 0.1%); the file stores fee units (1e-8 USDC), so points = units / 1e8. Two decimals, rounded down. */
export function pointsText(units: bigint): string {
  const hundredths = units / 1_000_000n;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

/** "settled through HH:MM UTC": the end of the newest settled minute that is not cancelled, launchTime + 60(m + 1). */
export function settledText(chain: Pick<CoreChain, "latestValidMinute" | "launchTime">): string {
  if (chain.latestValidMinute === null) return "not settled yet";
  const end = new Date((chain.launchTime + 60 * (chain.latestValidMinute + 1)) * 1000);
  return `settled through ${end.toISOString().slice(11, 16)} UTC`;
}

/** Staking.sol: each update releases (elapsed ÷ 1 day) of what is undripped. With an update every `step` s, the share still undripped after `seconds`. */
export const dripRemaining = (seconds: number, stepSeconds = 600) => Math.pow(1 - stepSeconds / 86_400, Math.max(0, seconds) / stepSeconds);

/** USDC per HLO from the pair's reserves (HLO 18 dec, USDC 6 dec). */
export function poolPrice(reserves: readonly [bigint, bigint], hloIsToken0: boolean): number | null {
  const [rHlo, rUsdc] = hloIsToken0 ? reserves : [reserves[1], reserves[0]];
  if (rHlo === 0n) return null;
  return Number(rUsdc) / 1e6 / (Number(rHlo) / 1e18);
}

export type PoolPhase =
  | { kind: "countdown"; secondsLeft: number }
  | { kind: "canOpen" }
  | { kind: "waitingForFees" } // due, but Buyback holds no USDC (openPool would revert NothingToSeed)
  | { kind: "waitingForDeposit" } // open, slice 0: buying starts after the next fee deposit
  | { kind: "buyDue" }
  | { kind: "nextBuy"; secondsLeft: number };

/**
 * `openAt` is `Buyback.launchTime() + OPEN_DELAY` (Buyback's launchTime, not Checkpoints').
 * Whether a buy() would really buy (the 30-minute TWAP window, the price guard, USDC to spend) is not decided here: the
 * Protocol card simulates buy() for that (see rewards/buyback.ts).
 */
export function poolPhase(o: {
  now: number;
  openAt: number;
  poolOpen: boolean;
  usdcHeld: bigint;
  slice: bigint;
  lastBuy: number;
  buyInterval: number;
}): PoolPhase {
  if (!o.poolOpen) {
    if (o.now < o.openAt) return { kind: "countdown", secondsLeft: o.openAt - o.now };
    return o.usdcHeld > 0n ? { kind: "canOpen" } : { kind: "waitingForFees" };
  }
  if (o.slice === 0n) return { kind: "waitingForDeposit" };
  const due = o.lastBuy + o.buyInterval;
  return o.now >= due ? { kind: "buyDue" } : { kind: "nextBuy", secondsLeft: due - o.now };
}

import { fmtUsdc } from "../ui/format";
import { CCTP_WITHDRAW_FEE_CAP } from "./addresses";
import { FAST_FINALITY } from "./cctp";

export type RouteId = "hypercore" | "hyperevm" | "arbitrum" | "ethereum" | "solana";

/** [R §2.5] GET /v2/burn/USDC/fees/{src}/{dst}?forward=true&hyperCoreDeposit=true. minimumFee in bps, forwardFee in subunits. */
export interface IrisFee {
  finalityThreshold: number;
  minimumFee: number;
  forwardFee: { low: number; med: number; high: number };
}

export function parseUsdc(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(s.trim());
  if (!m) return null;
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

/**
 * Exact decimal of a bps number as an integer count of 1e-12 bp, rounded UP (never under-pays).
 * Uses the shortest round-trip text of the double (what Circle's JSON said); exponent forms fall back to toFixed.
 */
const BPS_SCALE_DIGITS = 12;
function bpsScaled(x: number): bigint {
  const t = String(x).includes("e") ? x.toFixed(BPS_SCALE_DIGITS + 4) : String(x);
  const [whole, frac = ""] = t.split(".");
  const kept = frac.slice(0, BPS_SCALE_DIGITS).padEnd(BPS_SCALE_DIGITS, "0");
  const roundUp = /[1-9]/.test(frac.slice(BPS_SCALE_DIGITS));
  return BigInt(whole + kept) + (roundUp ? 1n : 0n);
}

/**
 * [R §6.3] maxFee = ceil(amount × minimumFee_bps / 10 000) + forwardFee.med. bps can be fractional [R §2.5]; the math is
 * exact in bigint and rounds up, so maxFee never under-pays (an under-paying maxFee silently downgrades to Standard [R §2.5]).
 * Throws a plain Error when the Iris numbers are unusable.
 */
export function cctpMaxFee(amount: bigint, fees: IrisFee[], threshold = FAST_FINALITY): bigint {
  const f = fees.find((x) => x?.finalityThreshold === threshold);
  if (!f) throw new Error(`no Iris fee for finality ${threshold}`);
  const bps = f.minimumFee;
  const med = f.forwardFee?.med;
  if (typeof bps !== "number" || !Number.isFinite(bps) || bps < 0) throw new Error("bad Iris minimumFee");
  if (typeof med !== "number" || !Number.isInteger(med) || med < 0) throw new Error("bad Iris forwardFee.med");
  const unit = 10_000n * 10n ** BigInt(BPS_SCALE_DIGITS);
  const protocol = (amount * bpsScaled(bps) + unit - 1n) / unit;
  return protocol + BigInt(med);
}

export interface Quote {
  fee: bigint | null; // USDC 1e6; null = unknown
  receiveAtLeast: bigint | null;
  error: string | null;
  notes: string[];
}

const q = (fee: bigint | null, amount: bigint, notes: string[]): Quote => ({ fee, receiveAtLeast: fee === null ? null : amount - fee, error: null, notes });
const QUOTE_UNAVAILABLE = "Fee quote unavailable. Try again in a moment.";
const err = (error: string): Quote => ({ fee: null, receiveAtLeast: null, error, notes: [] });

/** Display a fee rounded UP to the cent, so "send more than X" never names too small a number. */
const feeUp = (x: bigint) => fmtUsdc(((x + 9_999n) / 10_000n) * 10_000n);

/** Lamports → SOL text, up to 4 decimals, rounded up. */
export const fmtSol = (lamports: bigint) => {
  const tenThousandths = (lamports + 99_999n) / 100_000n;
  return `${tenThousandths / 10_000n}.${(tenThousandths % 10_000n).toString().padStart(4, "0")}`.replace(/\.?0+$/, "");
};

/**
 * Ruling (review M9, [R §6.4] open risk 1): an Ethereum withdrawal must clear the 1.20 USDC fee by this much,
 * so the user nets something meaningful.
 */
export const ETHEREUM_WITHDRAW_MIN_NET = 5_000_000n;
/**
 * Ruling (final polish, [R §5.5]): an Arbitrum withdrawal must clear the 0.20 USDC fee cap by 1 USDC, so a minimum
 * withdrawal nets something and its arrival is well above the 0.01 USDC dust floor.
 */
export const ARBITRUM_WITHDRAW_MIN_NET = 1_000_000n;
/** Plan 4 [P4 §2.2]: a Solana withdrawal must clear the 0.50 USDC fee cap by 1 USDC (the Arbitrum rule): minimum 1.50. */
export const SOLANA_WITHDRAW_MIN_NET = 1_000_000n;
/**
 * [P4 §1] What a Solana deposit costs in SOL, in lamports, rounded up: the event account's rent (about 0.0031 SOL for an
 * estimated 484 bytes) plus the network fee. UNCONFIRMED until SOL2 measures it; shown as "about 0.004 SOL".
 */
export const SOLANA_DEPOSIT_SOL_ESTIMATE = 4_000_000n;

/** The CCTP withdraw routes: their destination domain and how far the amount must clear the fee cap. */
const CCTP_WITHDRAW: Record<"arbitrum" | "ethereum" | "solana", { domain: 0 | 3 | 5; net: bigint }> = {
  arbitrum: { domain: 3, net: ARBITRUM_WITHDRAW_MIN_NET },
  ethereum: { domain: 0, net: ETHEREUM_WITHDRAW_MIN_NET },
  solana: { domain: 5, net: SOLANA_WITHDRAW_MIN_NET },
};

export function quote(route: RouteId, dir: "deposit" | "withdraw", amount: bigint, iris: IrisFee[] | null): Quote {
  if (amount <= 0n) return err("Enter an amount.");
  if (route === "hypercore") return q(0n, amount, ["Moves USDC between your perps and spot balances on Hyperliquid."]);
  if (route === "hyperevm") {
    // [R §4.2] same-block credit; [R §4.3] the Core to EVM fee is unknown until tested on testnet.
    return dir === "deposit"
      ? q(0n, amount, ["Needs a little HYPE on HyperEVM for gas.", "Arrives in the same block."])
      : { fee: null, receiveAtLeast: null, error: null, notes: ["Network fee: unknown. Hyperliquid charges HyperEVM gas for Core to HyperEVM transfers."] };
  }
  if (dir === "deposit") {
    if (!iris) return err(QUOTE_UNAVAILABLE);
    let fee: bigint;
    try {
      fee = cctpMaxFee(amount, iris);
    } catch {
      return err(QUOTE_UNAVAILABLE);
    }
    if (amount <= fee) return err(`Send more than ${feeUp(fee)} USDC (the fee).`);
    const notes = ["Circle CCTP fast transfer. Circle's relayer finishes it on HyperEVM; the fee is taken from the amount."];
    // [P4 §1] the event account's rent and the network fee, paid in SOL by the Solana wallet
    if (route === "solana") notes.push(`Your Solana wallet also pays about ${fmtSol(SOLANA_DEPOSIT_SOL_ESTIMATE)} SOL in network fees and a temporary record account for this transfer.`);
    return q(fee, amount, notes);
  }
  // [R §5.5, §6.4; P4 §2.2] the on-chain cap is the worst case; the amount must exceed it.
  const { domain, net } = CCTP_WITHDRAW[route];
  const cap = CCTP_WITHDRAW_FEE_CAP[domain];
  const min = cap + net;
  if (amount < min) return err(`Withdraw at least ${feeUp(min)} USDC (the ${feeUp(cap)} fee plus ${feeUp(net)}).`);
  const notes = [`The fee is at most ${feeUp(cap)} USDC; Circle may charge less.`];
  if (route === "solana") notes.push("It includes creating your USDC account on Solana if you do not have one yet.");
  return q(cap, amount, notes);
}

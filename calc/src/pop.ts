import { encodePacked, keccak256, type Hex } from "viem";

/** A minute's randomness: its seed block B(m), the first HyperEVM block at or after the minute's end, and that block's hash. */
export interface Seed {
  minute: number;
  block: bigint;
  hash: Hex;
}

const ODDS: Readonly<Record<number, number>> = { 999: 1250, 998: 60, 31337: 1 };

/**
 * Each minute the vault pops with a 1-in-popOdds chance (spec 2026-10-30 §2 rule 1): 1,250 on 999 (about once every
 * 21 hours), 60 on 998 (about hourly, so testnet sees pops), 1 on anvil (every minute: the e2e is deterministic).
 */
export function popOdds(chainId: number): number {
  const o = Object.hasOwn(ODDS, chainId) ? ODDS[chainId] : undefined;
  if (o === undefined) throw new Error(`no vault pop odds for chain ${chainId}`);
  return o;
}

/** The least a wallet needs to share in a pop: `units` of points (fee units) from minute `fromMinute` on. */
export interface PopMinimum {
  fromMinute: number;
  units: bigint;
}

const ONE_POINT = 100_000_000n;
/**
 * 1 point on 999 from launch. 998 turned it on at a minute after its launch, so a fresh verifier still replays the older
 * pops as they were paid (a new testnet deployment just starts without it until that minute). Off on anvil, whose e2e pays
 * pops every minute on small fees.
 */
const MINIMUMS: Readonly<Record<number, PopMinimum>> = {
  999: { fromMinute: 0, units: ONE_POINT },
  998: { fromMinute: 2600, units: ONE_POINT },
  31337: { fromMinute: 0, units: 0n },
};

export function popMinimum(chainId: number): PopMinimum {
  const m = Object.hasOwn(MINIMUMS, chainId) ? MINIMUMS[chainId] : undefined;
  if (m === undefined) throw new Error(`no vault pop minimum for chain ${chainId}`);
  return m;
}

export const minimumAt = (rule: PopMinimum, minute: number): bigint => (minute >= rule.fromMinute ? rule.units : 0n);

/** Spec §2 rule 3: minute m pops if uint256(keccak256(abi.encodePacked(bytes32 hash(B(m)), uint256 m))) % odds == 0. */
export function popsAt(hash: Hex, minute: number, odds: number): boolean {
  return BigInt(keccak256(encodePacked(["bytes32", "uint256"], [hash, BigInt(minute)]))) % BigInt(odds) === 0n;
}

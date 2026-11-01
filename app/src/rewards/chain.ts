import type { Abi, Hex } from "viem";
import type { Address, Contracts } from "../config/validate";
import { buybackAbi, checkpointsAbi, erc20Abi, miningAbi, pairAbi, stakingAbi, tokenAbi } from "../evm/abi";
import { poolPrice } from "./model";

/** The two viem PublicClient methods this module uses (a fake in tests). */
export interface ChainReader {
  readContract(a: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getBlock(): Promise<{ timestamp: bigint }>;
}

/** What the rewards and claim screen needs: Checkpoints and Mining reads only (so a Staking or Buyback failure cannot pause it). */
export interface CoreChain {
  now: number; // chain time, unix s: the latest block's timestamp ("now" for every chain decision)
  launchTime: number; // Checkpoints.launchTime: minute m ends at launchTime + 60(m+1) (not Buyback's, which is up to 1 h later)
  anySettled: boolean;
  latestMinute: number | null; // the newest settled checkpoint's throughMinute; null while nothing is settled (minute 0 is a real minute)
  latestValidMinute: number | null; // the newest settled minute not cancelled by the guardian (recovery); null while none
  latestRoot: Hex | null; // rootOf(latestMinute)
  paused: boolean; // the guardian paused settling and claiming
  poster: Address; // the key a checkpoint's signature must recover
  claimed: bigint | null; // Mining.claimed(user); null without a user
  claimAvailable: bigint; // Mining.claimAvailable(): the gross HLO the next claim can take (the hourly allowance, shared by everyone)
}

/** The Staking, token and Buyback reads (the staking and protocol cards). Read apart from CoreChain: either can fail alone. */
export interface ExtraChain {
  user: { hlo: bigint; staked: bigint; pending: bigint; allowance: bigint } | null; // allowance: token → Staking
  staking: { totalStaked: bigint; undripped: bigint };
  protocol: {
    totalBurned: bigint; totalSpent: bigint; totalBought: bigint; poolOpen: boolean;
    openAt: number; // Buyback.launchTime + OPEN_DELAY (Buyback's launchTime, not Checkpoints')
    slice: bigint; lastBuy: number; buyInterval: number;
    usdcHeld: bigint; price: number | null;
  };
}

/** Both groups together, the shape the staking and protocol cards take. */
export type RewardsChain = Omit<CoreChain, "claimed"> & {
  user: ({ claimed: bigint } & NonNullable<ExtraChain["user"]>) | null;
  staking: ExtraChain["staking"];
  protocol: ExtraChain["protocol"];
};

export function joinChain(core: CoreChain, extra: ExtraChain): RewardsChain {
  const { claimed, ...rest } = core;
  return { ...rest, user: claimed !== null && extra.user ? { claimed, ...extra.user } : null, staking: extra.staking, protocol: extra.protocol };
}

const ZERO_ROOT = `0x${"0".repeat(64)}`;

const reader = (c: ChainReader) => <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) =>
  c.readContract({ address, abi, functionName, args }) as Promise<T>;

export async function readCoreChain(c: ChainReader, k: Contracts, user: Address | null): Promise<CoreChain> {
  const read = reader(c);
  const cp = <T>(fn: string, args: readonly unknown[] = []) => read<T>(k.checkpoints, checkpointsAbi, fn, args);
  const [block, launchTime, anySettled, latest, anyValid, validLatest, paused, poster, claimed, claimAvailable] = await Promise.all([
    c.getBlock(),
    cp<bigint>("launchTime"),
    cp<boolean>("anySettled"),
    cp<bigint>("latestMinute"),
    cp<boolean>("anyValid"),
    cp<bigint>("latestValidMinute"),
    cp<boolean>("paused"),
    cp<Address>("poster"),
    user === null ? null : read<bigint>(k.mining, miningAbi, "claimed", [user]),
    read<bigint>(k.mining, miningAbi, "claimAvailable"),
  ]);
  // latestMinute() is 0 before the first settle: only anySettled says whether minute 0 is a settled checkpoint.
  if (anySettled && latest > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Checkpoints.latestMinute is out of range");
  const latestMinute = anySettled ? Number(latest) : null;
  // Likewise latestValidMinute() is 0 while nothing valid is settled (none settled, or every one cancelled).
  if (anyValid && validLatest > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Checkpoints.latestValidMinute is out of range");
  const root = latestMinute === null ? null : await cp<Hex>("rootOf", [latest]);
  return {
    now: Number(block.timestamp),
    launchTime: Number(launchTime),
    anySettled,
    latestMinute,
    latestValidMinute: anyValid ? Number(validLatest) : null,
    latestRoot: root && root !== ZERO_ROOT ? root : null,
    paused,
    poster,
    claimed,
    claimAvailable,
  };
}

/**
 * `Checkpoints.rootOf(minute)`: the root settled for that minute, or null while it reads zero (never settled, or cancelled).
 * Read only for a user file older than the chain's latest settled minute, which may still claim if its own minute is settled
 * at its root (Mining pays against any settled minute that is not cancelled).
 */
export async function readRootOf(c: ChainReader, k: Contracts, minute: number): Promise<Hex | null> {
  const root = await reader(c)<Hex>(k.checkpoints, checkpointsAbi, "rootOf", [BigInt(minute)]);
  return root === ZERO_ROOT ? null : root;
}

export async function readExtraChain(c: ChainReader, k: Contracts, user: Address | null): Promise<ExtraChain> {
  const read = reader(c);
  const [userVals, staking, bb] = await Promise.all([
    user === null
      ? null
      : Promise.all([
          read<bigint>(k.token, tokenAbi, "balanceOf", [user]),
          read<bigint>(k.staking, stakingAbi, "staked", [user]),
          read<bigint>(k.staking, stakingAbi, "pending", [user]),
          read<bigint>(k.token, tokenAbi, "allowance", [user, k.staking]),
        ]),
    Promise.all([read<bigint>(k.staking, stakingAbi, "totalStaked"), read<bigint>(k.staking, stakingAbi, "undripped")]),
    Promise.all([
      read<bigint>(k.token, tokenAbi, "totalBurned"),
      read<bigint>(k.buyback, buybackAbi, "totalSpent"),
      read<bigint>(k.buyback, buybackAbi, "totalBought"),
      read<boolean>(k.buyback, buybackAbi, "poolOpen"),
      read<bigint>(k.buyback, buybackAbi, "launchTime"),
      read<bigint>(k.buyback, buybackAbi, "OPEN_DELAY"),
      read<bigint>(k.buyback, buybackAbi, "slice"),
      read<bigint>(k.buyback, buybackAbi, "lastBuy"),
      read<bigint>(k.buyback, buybackAbi, "BUY_INTERVAL"),
      read<Address>(k.buyback, buybackAbi, "usdc"),
      read<boolean>(k.buyback, buybackAbi, "hloIsToken0"),
    ]),
  ]);
  const [totalBurned, totalSpent, totalBought, poolOpen, bbLaunch, openDelay, slice, lastBuy, buyInterval, usdc, hloIsToken0] = bb;
  const [usdcHeld, reserves] = await Promise.all([
    read<bigint>(usdc, erc20Abi, "balanceOf", [k.buyback]),
    poolOpen ? read<readonly [bigint, bigint, number]>(k.pair, pairAbi, "getReserves") : null,
  ]);
  return {
    user: userVals ? { hlo: userVals[0], staked: userVals[1], pending: userVals[2], allowance: userVals[3] } : null,
    staking: { totalStaked: staking[0], undripped: staking[1] },
    protocol: {
      totalBurned, totalSpent, totalBought, poolOpen, openAt: Number(bbLaunch + openDelay), slice, lastBuy: Number(lastBuy), buyInterval: Number(buyInterval), usdcHeld,
      price: reserves ? poolPrice([reserves[0], reserves[1]], hloIsToken0) : null,
    },
  };
}

import type { Abi } from "viem";
import { parseAbi } from "viem";
import type { Address } from "../config/validate";
import { erc20Abi } from "../evm/abi";
import type { SwapMarket } from "./market";
import type { SwapSnapshot } from "./plan";

export interface SwapReader {
  readContract(a: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
  getBlock(): Promise<{ timestamp: bigint }>;
}

const pairAbi = parseAbi([
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const factoryAbi = parseAbi(["function getPair(address, address) view returns (address)"]);

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export type SwapRead = { ok: true; snap: SwapSnapshot } | { ok: false; reason: "pair" };

/**
 * Reserves and token order from the deployment's pair, checked against the factory's HLO/USDC pair.
 * Balances and allowances are the connected wallet's; both are null when nobody is connected.
 */
export async function readSwapSnapshot(c: SwapReader, m: SwapMarket, user: Address | null): Promise<SwapRead> {
  const read = (address: Address, abi: Abi, functionName: string, args?: readonly unknown[]) => c.readContract({ address, abi, functionName, args });
  const [reserves, token0, token1, factoryPair, block, wallet] = await Promise.all([
    read(m.pair, pairAbi, "getReserves"),
    read(m.pair, pairAbi, "token0"),
    read(m.pair, pairAbi, "token1"),
    read(m.factory, factoryAbi, "getPair", [m.hlo, m.usdc]),
    c.getBlock(),
    user === null
      ? null
      : Promise.all([
          read(m.hlo, erc20Abi, "balanceOf", [user]),
          read(m.usdc, erc20Abi, "balanceOf", [user]),
          read(m.hlo, erc20Abi, "allowance", [user, m.router]),
          read(m.usdc, erc20Abi, "allowance", [user, m.router]),
        ]),
  ]);
  const pair = reserves as readonly [bigint, bigint, number];
  const t0 = String(token0);
  const t1 = String(token1);
  const hlo0 = same(t0, m.hlo);
  const tokensOk = (hlo0 && same(t1, m.usdc)) || (same(t0, m.usdc) && same(t1, m.hlo));
  if (!tokensOk || !same(String(factoryPair), m.pair)) return { ok: false, reason: "pair" };
  return {
    ok: true,
    snap: {
      reserve0: pair[0],
      reserve1: pair[1],
      hloIsToken0: hlo0,
      blockTime: block.timestamp,
      hloBalance: wallet ? (wallet[0] as bigint) : null,
      usdcBalance: wallet ? (wallet[1] as bigint) : null,
      hloAllowance: wallet ? (wallet[2] as bigint) : null,
      usdcAllowance: wallet ? (wallet[3] as bigint) : null,
    },
  };
}

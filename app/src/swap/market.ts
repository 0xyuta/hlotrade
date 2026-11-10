import type { Address, Contracts } from "../config/validate";
import { ROUTE_ADDRESSES } from "../routes/addresses";

/**
 * Official Uniswap V2 on HyperEVM (chain 999). Buyback created the HLO/USDC pair on this factory
 * (`0x89e5…9eba`). Router02's `factory()` is that factory, so a two-token path swaps that pair.
 * There is no HLO-owned router. Testnet's pair is not this market, so it is not offered here.
 * https://developers.uniswap.org/docs/protocols/v2/deployments
 */
export const V2_ROUTER_999: Address = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
export const V2_FACTORY_999: Address = "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba";

export type SwapSide = "buy" | "sell";

export interface SwapMarket {
  router: Address;
  factory: Address;
  hlo: Address;
  usdc: Address;
  pair: Address;
  hloDecimals: 18;
  usdcDecimals: 6;
}

/** Mainnet only, and only when the deployment names the token and the pair. */
export function swapMarket(chainId: number, contracts: Pick<Contracts, "token" | "pair"> | null): SwapMarket | null {
  if (chainId !== 999 || !contracts?.token || !contracts.pair) return null;
  return {
    router: V2_ROUTER_999,
    factory: V2_FACTORY_999,
    hlo: contracts.token,
    usdc: ROUTE_ADDRESSES.mainnet.hyperEvm.usdc,
    pair: contracts.pair,
    hloDecimals: 18,
    usdcDecimals: 6,
  };
}

export function tokensFor(side: SwapSide, m: SwapMarket): {
  pay: Address;
  receive: Address;
  payDecimals: number;
  receiveDecimals: number;
  paySymbol: "HLO" | "USDC";
  receiveSymbol: "HLO" | "USDC";
} {
  const hlo = { address: m.hlo, decimals: m.hloDecimals, symbol: "HLO" as const };
  const usdc = { address: m.usdc, decimals: m.usdcDecimals, symbol: "USDC" as const };
  const pay = side === "buy" ? usdc : hlo;
  const receive = side === "buy" ? hlo : usdc;
  return {
    pay: pay.address,
    receive: receive.address,
    payDecimals: pay.decimals,
    receiveDecimals: receive.decimals,
    paySymbol: pay.symbol,
    receiveSymbol: receive.symbol,
  };
}

/** Which reserve is sold and which is bought. `hloIsToken0` comes from the pair, not a constant. */
export function reservesOf(side: SwapSide, hloIsToken0: boolean, reserve0: bigint, reserve1: bigint): { reserveIn: bigint; reserveOut: bigint } {
  const hlo = hloIsToken0 ? reserve0 : reserve1;
  const usdc = hloIsToken0 ? reserve1 : reserve0;
  return side === "buy" ? { reserveIn: usdc, reserveOut: hlo } : { reserveIn: hlo, reserveOut: usdc };
}

import { parseAbi } from "viem";
import type { Address } from "../config/validate";
import { erc20Abi } from "../evm/abi";
import type { WriteCall } from "../evm/clients";
import type { SwapMarket } from "./market";
import type { SwapQuote } from "./plan";

export const routerAbi = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)",
]);

/** Approve the router for the exact amount, then `swapExactTokensForTokens` along the two-token path. */
export function swapCalls(market: SwapMarket, quote: SwapQuote, to: Address): WriteCall[] {
  return quote.steps.map((step) =>
    step === "approve"
      ? { address: quote.pay, abi: erc20Abi, functionName: "approve", args: [market.router, quote.amountIn] }
      : {
          address: market.router,
          abi: routerAbi,
          functionName: "swapExactTokensForTokens",
          args: [quote.amountIn, quote.amountOutMin, [...quote.path], to, quote.deadline],
        },
  );
}

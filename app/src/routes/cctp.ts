import { concat, isAddress, numberToHex, pad, type Hex } from "viem";
import type { Address, Network } from "../config/validate";
import { DEX_PERPS, HYPEREVM_DOMAIN, ROUTE_ADDRESSES } from "./addresses";

/** [R §2.5] "cctp-forward" padded to 24 bytes: opts in to Circle's Forwarding Service. */
export const CCTP_FORWARD_MAGIC: Hex = "0x636374702d666f7277617264000000000000000000000000";
/** [R §2.5] 1000 = Fast Transfer. */
export const FAST_FINALITY = 1000;

export const toBytes32 = (a: Address): Hex => pad(a, { size: 32 });

/** [R §2.5] 56 bytes: magic(24) | version u32 = 0 | length u32 = 24 | recipient(20) | dex u32. */
export function hyperCoreHook(recipient: Address, dex: number = DEX_PERPS): Hex {
  // a short or long recipient would shift every later byte: funds lost [R §2.5]
  if (!isAddress(recipient, { strict: false })) throw new Error("recipient must be a 20-byte hex address");
  const hook = concat([
    CCTP_FORWARD_MAGIC,
    numberToHex(0, { size: 4 }),
    numberToHex(24, { size: 4 }),
    recipient.toLowerCase() as Hex,
    numberToHex(dex, { size: 4 }),
  ]);
  if (hook.length !== 2 + 56 * 2) throw new Error("hook data must be 56 bytes");
  return hook;
}

/**
 * TokenMessengerV2.depositForBurnWithHook(amount, destinationDomain, mintRecipient, burnToken, destinationCaller,
 * maxFee, minFinalityThreshold, hookData) [R §5.3 item 6, §6.3]. Built only from constants: a wrong
 * mintRecipient or destinationCaller loses the funds [R §2.5].
 */
export function burnArgs(net: Network, src: "arbitrum" | "ethereum", amount: bigint, maxFee: bigint, recipient: Address) {
  const a = ROUTE_ADDRESSES[net];
  const forwarder = toBytes32(a.cctpForwarder);
  return [amount, HYPEREVM_DOMAIN, forwarder, a[src].usdc, forwarder, maxFee, FAST_FINALITY, hyperCoreHook(recipient, DEX_PERPS)] as const;
}

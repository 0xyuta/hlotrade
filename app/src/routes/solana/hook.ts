import { getAddressEncoder, type Address as SolAddress } from "@solana/kit";
import { bytesToHex, concat, numberToHex, size, type Hex } from "viem";
import { CCTP_FORWARD_MAGIC } from "../cctp";
import { SOLANA_WITHDRAW_HOOK_LAYOUT, type WithdrawHookLayout } from "./constants";

/**
 * [P4 §2.1] The `data` of a HyperCore → Solana withdrawal: asks Circle's Forwarding Service to create the owner's USDC
 * account if needed (flag 0x01) and to mint to it. The CoreDepositWallet wraps this in the CCTP hook itself.
 *   "withdraw-howto-57": magic(24) ‖ 0x01 ‖ owner(32)              [C-W-SOL Step 1]  (the default)
 *   "forwarding-v0-65":  magic(24) ‖ u32 0 ‖ u32 33 ‖ 0x01 ‖ owner(32) [C-FWD]     (the alternative, SOL1)
 */
export function solanaAtaHook(owner: SolAddress, layout: WithdrawHookLayout = SOLANA_WITHDRAW_HOOK_LAYOUT): Hex {
  const ownerHex = bytesToHex(Uint8Array.from(getAddressEncoder().encode(owner)));
  let out: Hex;
  let length: number;
  // Exhaustive: a third layout added to WithdrawHookLayout fails to compile here instead of passing for the 65-byte one.
  switch (layout) {
    case "withdraw-howto-57":
      out = concat([CCTP_FORWARD_MAGIC, "0x01", ownerHex]);
      length = 57;
      break;
    case "forwarding-v0-65":
      out = concat([CCTP_FORWARD_MAGIC, numberToHex(0, { size: 4 }), numberToHex(33, { size: 4 }), "0x01", ownerHex]);
      length = 65;
      break;
    default: {
      const unknown: never = layout;
      throw new Error(`Unknown Solana withdraw data layout: ${String(unknown)}`);
    }
  }
  if (size(out) !== length) throw new Error("Solana withdraw data has the wrong length");
  return out;
}

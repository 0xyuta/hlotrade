import { address, type Address as SolAddress } from "@solana/kit";
import type { Network } from "../../config/validate";

/** [P4 §1; C-SOL] Circle CCTP v2 programs: the same ids on devnet and mainnet. */
export const TOKEN_MESSENGER_MINTER_V2 = address("CCTPV2vPZJS2u2BBsUoscuikbYjnpFmbFsvVuJdgUMQe");
export const MESSAGE_TRANSMITTER_V2 = address("CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC");
/** [P4 §2.1, §4] SPL Token, Associated Token Account, System and Compute Budget programs (hard-coded, no @solana-program/*). */
export const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
export const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");

/** [P4 §5; R §7.1] Circle's USDC mint, 6 decimals (devnet for testnet builds). */
export const SOLANA_USDC: Record<Network, SolAddress> = {
  mainnet: address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  testnet: address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"),
};

/** [P4 §5] Wallet Standard chain ids. */
export const SOLANA_CHAIN: Record<Network, "solana:mainnet" | "solana:devnet"> = { mainnet: "solana:mainnet", testnet: "solana:devnet" };

export type WithdrawHookLayout = "withdraw-howto-57" | "forwarding-v0-65";
/**
 * [P4 §2.1] The `data` of a HyperCore → Solana sendToEvmWithData. Circle's withdraw how-to: magic ‖ 0x01 ‖ owner (57 bytes).
 * UNCONFIRMED until SOL1 (docs/APP.md §6): if SOL1 shows Circle ignoring the createATA request, switch to
 * "forwarding-v0-65" (magic ‖ u32 0 ‖ u32 33 ‖ 0x01 ‖ owner) and repeat SOL1.
 */
export const SOLANA_WITHDRAW_HOOK_LAYOUT: WithdrawHookLayout = "withdraw-howto-57";

/**
 * [P4 §3] "sign" = solana:signTransaction (the app learns the signature, records, then sends the bytes itself);
 * "signAndSend" = solana:signAndSendTransaction (the wallet sends). UNCONFIRMED until SOL2: if the wallet changes a
 * pre-signed message under "sign", switch to "signAndSend" and repeat SOL2.
 */
export const SOLANA_SIGN_PREFERENCE: "sign" | "signAndSend" = "sign";

/**
 * [P4 §1] ComputeBudget SetComputeUnitPrice, micro-lamports per compute unit. 0 = no instruction (Circle's examples
 * send none). UNCONFIRMED until SOL6 (mainnet): raise it if mainnet deposits do not land.
 */
export const SOLANA_PRIORITY_MICROLAMPORTS = 0n;

/** [P4 §1; CIRCLE-SOL-IDL] Anchor discriminator of deposit_for_burn_with_hook. */
export const DEPOSIT_FOR_BURN_WITH_HOOK = new Uint8Array([111, 245, 62, 131, 204, 108, 223, 155]);

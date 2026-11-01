import { getAddressEncoder, getProgramDerivedAddress, isAddress as isSolanaAddress, isOffCurveAddress, type Address as SolAddress } from "@solana/kit";
import type { Network } from "../../config/validate";
import { ASSOCIATED_TOKEN_PROGRAM, SOLANA_USDC, TOKEN_PROGRAM } from "./constants";

/**
 * [P4 §2.1; C-FWD "Solana mintRecipient"] The owner's USDC associated token account: the PDA of the Associated Token
 * program with seeds [owner, Token program, mint]. Withdrawals go to this address, never to the wallet address itself.
 */
export async function usdcAta(net: Network, owner: SolAddress): Promise<SolAddress> {
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [enc.encode(owner), enc.encode(TOKEN_PROGRAM), enc.encode(SOLANA_USDC[net])],
  });
  return ata;
}

export const BAD_SOLANA_ADDRESS = "The Solana wallet address is not valid.";

/**
 * A Solana wallet address that can own USDC and sign: the withdrawal's recipient and the deposit's depositor.
 * It must decode to exactly 32 bytes (Kit's isAddress), must not be the all-zero default address ("1" x 32), which no
 * wallet holds a key for, and must be on the ed25519 curve: an off-curve owner is a program-derived address no wallet
 * can sign for, so USDC sent to its token account could never be moved [P4 §2.1; Circle's how-to derives the ATA with
 * allowOwnerOffCurve = false]. The zero check stays: 32 zero bytes are on-curve.
 */
export function solanaOwner(owner: string): SolAddress {
  if (typeof owner !== "string" || !isSolanaAddress(owner)) throw new Error(BAD_SOLANA_ADDRESS);
  if (getAddressEncoder().encode(owner).every((b) => b === 0)) throw new Error(BAD_SOLANA_ADDRESS);
  if (isOffCurveAddress(owner)) throw new Error(BAD_SOLANA_ADDRESS);
  return owner;
}

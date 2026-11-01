import { IRIS_HOSTS } from "../config/csp";
import type { Address, Network } from "../config/validate";

export interface RouteAddrs {
  hyperEvm: { chainId: 999 | 998; usdc: Address; coreDepositWallet: Address };
  arbitrum: { chainId: number; domain: 3; usdc: Address; tokenMessengerV2: Address };
  ethereum: { chainId: number; domain: 0; usdc: Address; tokenMessengerV2: Address };
  /** CctpForwarder on HyperEVM (CCTP domain 19): both mintRecipient and destinationCaller. */
  cctpForwarder: Address;
  iris: string;
}

export const ROUTE_ADDRESSES: Record<Network, RouteAddrs> = {
  mainnet: {
    // [R §4.1] native USDC (6 dec) and the CoreDepositWallet proxy, checked on chain
    hyperEvm: { chainId: 999, usdc: "0xb88339CB7199b77E23DB6E890353E22632Ba630f", coreDepositWallet: "0x6B9E773128f453f5c2C60935Ee2DE2CBc5390A24" },
    // [R §5.2] Arbitrum One USDC; TokenMessengerV2 [C-EVM]
    arbitrum: { chainId: 42161, domain: 3, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" },
    // [R §6.2] Ethereum USDC; TokenMessengerV2 (same address on every EVM domain)
    ethereum: { chainId: 1, domain: 0, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", tokenMessengerV2: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d" },
    // [R §5.2, §6.2] CctpForwarder, on-chain tokenToForwardingAddress(USDC) = CoreDepositWallet
    cctpForwarder: "0xb21D281DEdb17AE5B501F6AA8256fe38C4e45757",
    iris: IRIS_HOSTS.mainnet,
  },
  testnet: {
    // [R §4.1, §8]
    hyperEvm: { chainId: 998, usdc: "0x2B3370eE501B4a559b57D449569354196457D8Ab", coreDepositWallet: "0x0B80659a4076E9E93C7DbE0f10675A16a3e5C206" },
    // [R §5.2] Arbitrum Sepolia (421614): Circle's USDC (not Bridge2's USDC2)
    arbitrum: { chainId: 421614, domain: 3, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
    // [R §6.2] Sepolia (chain id 11155111)
    ethereum: { chainId: 11155111, domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", tokenMessengerV2: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA" },
    cctpForwarder: "0x02e39ECb8368b41bF68FF99ff351aC9864e5E2a2",
    iris: IRIS_HOSTS.testnet,
  },
};

/** [R §4.1] Core → HyperEVM USDC system address (0x20… + token index 0). */
export const USDC_SYSTEM_ADDRESS: Address = "0x2000000000000000000000000000000000000000";
/** [R §2.5] CCTP domain of HyperEVM. */
export const HYPEREVM_DOMAIN = 19;
/** [R §4.2] destinationDex 0 = the default perps dex (the official front end always sends 0 [R §5.3 item 8]). */
export const DEX_PERPS = 0;
/** [P4 §1, §5] CCTP domain of Solana (devnet for testnet builds). */
export const SOLANA_DOMAIN = 5;
/**
 * [R §5.5, §6.4; P4 §2.2] on-chain CoreDepositWallet.calculateCrossChainWithdrawalFee(true, domain), the worst case.
 * Domain 5 (Solana) read on the mainnet and testnet CoreDepositWallet on 2026-10-28; it covers creating the ATA.
 */
export const CCTP_WITHDRAW_FEE_CAP: Record<0 | 3 | 5, bigint> = { 3: 200_000n, 0: 1_200_000n, 5: 500_000n };

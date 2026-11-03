import { defineChain, toHex, type Chain } from "viem";
import type { AppConfig, Network } from "../config/validate";
import { messageOf, walletCodes } from "../hl/errors";
import type { Eip1193 } from "./eip6963";

export type EvmKind = "hyperEvm" | "arbitrum" | "ethereum";

export const CHAIN_IDS: Record<EvmKind, Record<Network, number>> = {
  hyperEvm: { mainnet: 999, testnet: 998 }, // [R §4.1]
  arbitrum: { mainnet: 42161, testnet: 421614 }, // [R §5.2] Arbitrum Sepolia
  ethereum: { mainnet: 1, testnet: 11155111 }, // [R §6.2] Sepolia
};
const NAMES: Record<EvmKind, Record<Network, string>> = {
  hyperEvm: { mainnet: "HyperEVM", testnet: "HyperEVM Testnet" },
  arbitrum: { mainnet: "Arbitrum One", testnet: "Arbitrum Sepolia" },
  ethereum: { mainnet: "Ethereum", testnet: "Sepolia" },
};

/** HyperEVM mainnet's explorer (testnet has none we link to). */
export const HYPEREVM_SCAN = "https://hyperevmscan.io";

const cache = new Map<string, Chain>();

export function viemChain(kind: EvmKind, cfg: AppConfig): Chain {
  const rpc = kind === "hyperEvm" ? cfg.hyperEvmRpc : kind === "arbitrum" ? cfg.arbitrumRpc : cfg.ethereumRpc;
  const key = `${kind}:${cfg.network}:${rpc}`;
  let c = cache.get(key);
  if (!c) {
    c = defineChain({
      id: CHAIN_IDS[kind][cfg.network],
      name: NAMES[kind][cfg.network],
      nativeCurrency: kind === "hyperEvm" ? { name: "HYPE", symbol: "HYPE", decimals: 18 } : { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
      ...(kind === "hyperEvm" && cfg.network === "mainnet" ? { blockExplorers: { default: { name: "HyperEVMScan", url: HYPEREVM_SCAN } } } : {}),
    });
    cache.set(key, c);
  }
  return c;
}

export function addChainParams(c: Chain) {
  return {
    chainId: toHex(c.id),
    chainName: c.name,
    nativeCurrency: c.nativeCurrency,
    rpcUrls: [...c.rpcUrls.default.http],
    ...(c.blockExplorers ? { blockExplorerUrls: [c.blockExplorers.default.url] } : {}),
  };
}

/** wallet_switchEthereumChain, falling back to wallet_addEthereumChain when the wallet does not know the chain (4902). */
export async function ensureChain(p: Eip1193, c: Chain): Promise<void> {
  if (Number(await p.request({ method: "eth_chainId" })) === c.id) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(c.id) }] });
  } catch (e) {
    if (!walletCodes(e).includes(4902) && !/unrecognized chain|not been added|unknown chain/i.test(messageOf(e))) throw e;
    await p.request({ method: "wallet_addEthereumChain", params: [addChainParams(c)] });
  }
  const now = Number(await p.request({ method: "eth_chainId" }));
  if (now !== c.id) throw new Error(`Your wallet is on chain ${now}, not ${c.name}. Switch networks in the wallet and try again.`);
}

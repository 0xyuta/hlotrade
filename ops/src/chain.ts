import { createPublicClient, createWalletClient, defineChain, fallback, http, type Chain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainId, Config } from "./config.js";

export function makeChain(id: ChainId, rpcUrls: string[]): Chain {
  return defineChain({
    id,
    name: id === 999 ? "HyperEVM" : id === 998 ? "HyperEVM testnet" : "anvil",
    nativeCurrency: id === 31337 ? { name: "ETH", symbol: "ETH", decimals: 18 } : { name: "HYPE", symbol: "HYPE", decimals: 18 },
    rpcUrls: { default: { http: rpcUrls } },
  });
}

const transport = (cfg: Config) => fallback(cfg.rpcUrls.map((u) => http(u, { retryCount: 3 })));

export function makePublic(cfg: Config) {
  return createPublicClient({ chain: makeChain(cfg.chainId, cfg.rpcUrls), transport: transport(cfg) });
}

export function makeWallet(cfg: Config, key: Hex) {
  return createWalletClient({ account: privateKeyToAccount(key), chain: makeChain(cfg.chainId, cfg.rpcUrls), transport: transport(cfg) });
}

/** Refuse to run against an RPC that is on a different chain than CHAIN_ID. */
export async function assertChainId(client: { getChainId(): Promise<number> }, expected: ChainId): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) throw new Error(`RPC is on chain ${actual} but CHAIN_ID is ${expected}`);
}

export type PublicClient = ReturnType<typeof makePublic>;
export type WalletClient = ReturnType<typeof makeWallet>;

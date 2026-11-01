import type { Hex } from "viem";
import type { Address } from "../config/validate";
import type { Eip1193 } from "../wallet/eip6963";
import { isChainMismatch } from "./errors";

/** The shape nktkas treats as a viem JSON-RPC account [T §1.2]. */
export interface HlUserWallet {
  signTypedData(p: { domain: unknown; types: unknown; primaryType: string; message: unknown }): Promise<Hex>;
  getAddresses(): Promise<Address[]>;
  getChainId(): Promise<number>;
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/**
 * Fix A [T §1.3, §1.6]: sign through eth_signTypedData_v4 directly, skipping viem's typed-data validation, which
 * rejects Hyperliquid's "HyperliquidTransaction:…" primary types since viem 2.57.12. getChainId is the wallet's
 * current chain, which nktkas uses as signatureChainId [T §1.4].
 */
export function injectedHlWallet(eth: Eip1193, account: Address): HlUserWallet {
  return {
    async signTypedData(p) {
      return (await eth.request({ method: "eth_signTypedData_v4", params: [account, json(p)] })) as Hex;
    },
    getAddresses: async () => [account],
    getChainId: async () => Number(await eth.request({ method: "eth_chainId" })),
  };
}

/**
 * [T §1.4] signatureChainId is read from the wallet, then the wallet signs: if the user switched networks in between,
 * MetaMask refuses with a chainId mismatch. Run `fn` again once (it re-reads the chain); any other error passes through.
 */
export async function withChainRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!isChainMismatch(e)) throw e;
    return await fn();
  }
}

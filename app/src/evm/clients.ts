import { createPublicClient, createWalletClient, custom, http, type Abi, type Chain, type Hex, type PublicClient } from "viem";
import type { Address } from "../config/validate";
import { ensureChain } from "../wallet/chains";
import type { Eip1193 } from "../wallet/eip6963";

const cache = new Map<string, PublicClient>();

/** The most calls one JSON-RPC batch may carry: Hyperliquid's HyperEVM RPC (mainnet and testnet, 2026-10-29) refuses a
 *  bigger batch whole ("Exceeded max limit of 20"), and viem's default (1000) sent the rewards screen's reads as one. */
export const RPC_BATCH_SIZE = 20;

/** One batched public client per chain + RPC. */
export function publicClient(chain: Chain): PublicClient {
  const rpc = chain.rpcUrls.default.http[0];
  const key = `${chain.id}:${rpc}`;
  let c = cache.get(key);
  if (!c) {
    c = createPublicClient({ chain, transport: http(rpc, { batch: { batchSize: RPC_BATCH_SIZE } }) }) as PublicClient;
    cache.set(key, c);
  }
  return c;
}

export interface WriteCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

/** A transaction that was sent: carries its hash, so a failure or a timeout never loses it (a retry could repeat it). */
export class EvmTxError extends Error {
  constructor(message: string, readonly hash: Hex, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EvmTxError";
  }
}

/** Switches (or adds) the chain, sends from the injected wallet, waits for success. Errors after sending are EvmTxError. */
export async function evmWrite(p: Eip1193, account: Address, chain: Chain, call: WriteCall): Promise<Hex> {
  await ensureChain(p, chain);
  const wallet = createWalletClient({ account, chain, transport: custom(p as Parameters<typeof custom>[0]) });
  const hash = await wallet.writeContract({ ...call, account, chain } as never);
  let status: string;
  try {
    status = (await publicClient(chain).waitForTransactionReceipt({ hash })).status;
  } catch (e) {
    throw new EvmTxError(`${call.functionName} was sent (${hash}) but its result is not confirmed yet. Check the transaction before trying again.`, hash, { cause: e });
  }
  if (status !== "success") throw new EvmTxError(`${call.functionName} failed on chain (${hash})`, hash);
  return hash;
}

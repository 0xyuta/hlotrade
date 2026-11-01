import { join } from "node:path";
import type { Abi, Hex } from "viem";
import { checkpointsAbi } from "./abi.js";
import { assertChainId, makePublic, type PublicClient, type WalletClient } from "./chain.js";
import type { Config } from "./config.js";
import { loadDeployments, type Deployments } from "./deployments.js";
import { makePublisher, type Publisher } from "./publish.js";
import { Store } from "./store.js";

export interface Ctx {
  cfg: Config;
  client: PublicClient;
  d: Deployments;
  store: Store;
  publisher: Publisher;
  log(s: string): void;
  alert(s: string): Promise<void>;
}

/**
 * Each process gets its own state dir and caches: the verifier never reads the poster's files.
 * The dir is namespaced by deployment identity, so an anvil restart or a testnet redeploy
 * never reuses cached state or log cursors from another deployment.
 */
export async function makeCtx(
  cfg: Config,
  name: "poster" | "verifier" | "forwarder" | "keeper",
  alert: (s: string) => Promise<void>,
): Promise<Ctx> {
  const client = makePublic(cfg);
  await assertChainId(client, cfg.chainId);
  const d = loadDeployments(cfg.deploymentsFile, cfg.chainId);
  const launchTime = await client.readContract({ address: d.checkpoints, abi: checkpointsAbi, functionName: "launchTime" });
  const identity = `${cfg.chainId}-${d.checkpoints.toLowerCase()}-${d.deployBlock}-${launchTime}`;
  const dir = join(cfg.stateDir, name, identity);
  const store = new Store(dir);
  return {
    cfg,
    client,
    d,
    store,
    publisher: makePublisher(cfg),
    log: (s) => console.log(`[${new Date().toISOString()}] ${name}: ${s}`),
    alert,
  };
}

const constants = new WeakMap<Ctx, Promise<{ launchTime: number }>>();

/** Checkpoints.launchTime is immutable on the contract: read once per ctx. (VAULT_PERIOD is not read: the vault pops by popOdds(chainId).) */
export function checkpointConstants(ctx: Ctx): Promise<{ launchTime: number }> {
  let p = constants.get(ctx);
  if (!p) {
    p = ctx.client
      .readContract({ address: ctx.d.checkpoints, abi: checkpointsAbi, functionName: "launchTime" })
      .then((l) => ({ launchTime: Number(l) }));
    constants.set(ctx, p);
    p.catch(() => constants.delete(ctx)); // do not cache a failed read
  }
  return p;
}

/** The latest HyperEVM block: "now" for every decision is its timestamp, never the wall clock. */
export async function chainNow(ctx: Ctx): Promise<{ number: bigint; timestamp: number }> {
  const b = await ctx.client.getBlock({ blockTag: "latest" });
  return { number: b.number, timestamp: Number(b.timestamp) };
}

/** Sends a contract write and waits for success. */
export async function send(
  ctx: Ctx,
  wallet: WalletClient,
  call: { address: `0x${string}`; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<Hex> {
  const hash = await wallet.writeContract({ ...call, chain: wallet.chain, account: wallet.account } as never);
  const rcpt = await ctx.client.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`${call.functionName} reverted (${hash})`);
  ctx.log(`${call.functionName}(${call.args.join(", ")}) → ${hash}`);
  return hash;
}

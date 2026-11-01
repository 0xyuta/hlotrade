import { readFileSync } from "node:fs";
import { getAddress, type Address } from "viem";
import type { ChainId } from "./config.js";

export interface Deployments {
  token: Address;
  checkpoints: Address;
  mining: Address;
  staking: Address;
  buyback: Address;
  splitter: Address;
  profiles: Address;
  pair: Address;
  chainId: number;
  deployBlock: bigint;
}

export function loadDeployments(file: string, chainId: ChainId): Deployments {
  const j = JSON.parse(readFileSync(file, "utf8"));
  if (Number(j.chainId) !== chainId) throw new Error(`${file} is for chain ${j.chainId}, not ${chainId}`);
  const a = (k: string) => getAddress(j[k]);
  return {
    token: a("token"),
    checkpoints: a("checkpoints"),
    mining: a("mining"),
    staking: a("staking"),
    buyback: a("buyback"),
    splitter: a("splitter"),
    profiles: a("profiles"),
    pair: a("pair"),
    chainId,
    deployBlock: BigInt(j.deployBlock),
  };
}

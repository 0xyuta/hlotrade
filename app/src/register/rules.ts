import { HL_HOSTS } from "../config/csp.js";
import type { Address, Network } from "../config/validate.js";

/** The least maxBuilderFee (in tenths of a basis point) that counts as "trading enabled": our 0.1% builder fee. */
export const MIN_BUILDER_FEE = 100;

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** Where a wallet's record lives in the store. ops/src/registry.ts reads the same literal. */
export const registryKey = (chainId: number, user: Address): string => `registry/${chainId}/${user.toLowerCase()}.json`;

/** The index entry written before a record: time-sorted, so a reader lists only what is new. ops/src/registry.ts reads the same literal. */
export const registryLogKey = (chainId: number, registeredAt: number, user: Address): string =>
  `registry-log/${chainId}/${String(registeredAt).padStart(10, "0")}-${user.toLowerCase()}.json`;

/** The request body: exactly `{user}` with a hex address. Returns the lowercase address, or null. */
export function parseRegisterBody(j: unknown): Address | null {
  if (typeof j !== "object" || j === null || Array.isArray(j)) return null;
  const keys = Object.keys(j);
  if (keys.length !== 1 || keys[0] !== "user") return null;
  const user = (j as { user: unknown }).user;
  if (typeof user !== "string" || !ADDR.test(user)) return null;
  return user.toLowerCase() as Address;
}

export const chainIdFor = (network: Network): 999 | 998 => (network === "mainnet" ? 999 : 998);

export const hlApiFor = (network: Network): string => HL_HOSTS[network].api;

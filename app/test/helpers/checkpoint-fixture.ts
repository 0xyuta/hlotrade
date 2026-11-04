// Test only: a real signed checkpoint built by ops (the app bundle never imports ops or calc).
import { applyCheckpoint, buildTree, newCalcState, popOdds, type Addr, type FeeRow } from "@hlo/calc";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { seedsFor } from "../../../calc/test/helpers/seeds";
import { buildFiles, buildUserFiles, userFilePath, type BuildArgs } from "../../../ops/src/checkpoint-files";
import { toJson } from "../../../ops/src/publish";
import { signCheckpoint } from "../../../ops/src/sign";

export const FIX_CHAIN_ID = 998;
export const FIX_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address;
export const FIX_LAUNCH = 1_800_000_000;
export const FIX_THROUGH = 4;
export const FIX_REF_BLOCK = 77n;
/** The vault pops at minute 1 of the fixture; minutes 2..4 build points again. */
export const FIX_POP_MINUTE = 1;
/** A throwaway test key (not a secret: it signs only these fixtures). */
export const FIX_POSTER_ACCOUNT = privateKeyToAccount(`0x${"11".repeat(32)}`);
export const FIX_OTHER_ACCOUNT = privateKeyToAccount(`0x${"22".repeat(32)}`);
export const FIX_USERS = [1, 2, 3, 4, 5].map((i) => `0x${(0xa0 + i).toString(16).padStart(40, "0")}` as Address);

/**
 * Five traders over five minutes, one checkpoint through minute 4; returns the JSON ops would publish as latest.json and, as
 * `userFiles` (by path) and `userFile(user)`, the users/<xx>.json files with each wallet's numbers and proof (all five
 * traders start with 0x00, so they share users/00.json). `userFile` is null for an address no file holds.
 */
export async function makeLatest(opts: { signer?: typeof FIX_POSTER_ACCOUNT; throughMinute?: number } = {}) {
  const through = opts.throughMinute ?? FIX_THROUGH;
  const odds = popOdds(FIX_CHAIN_ID);
  const state = newCalcState(FIX_LAUNCH, odds);
  const rows: FeeRow[] = [];
  for (let m = 0; m <= through; m++) FIX_USERS.forEach((u, i) => rows.push({ minute: m, user: u as Addr, fee: BigInt((i + 1) * 100_000_000 + m) }));
  const seeds = seedsFor(0, through, { odds, pop: [FIX_POP_MINUTE], block: (m) => 70n + BigInt(m) });
  const result = applyCheckpoint(state, { minimum: { fromMinute: 0, units: 0n }, quietFrom: null, throughMinute: through, refBlock: FIX_REF_BLOCK, rows, seeds, burned: 0n, refined: 0n, claimed: new Map() });
  const tree = buildTree(result.entitlements);
  const cp = { throughMinute: through, refBlock: FIX_REF_BLOCK, root: tree.root as Hex, totalEntitled: result.totalEntitled };
  const sig = await signCheckpoint(opts.signer ?? FIX_POSTER_ACCOUNT, FIX_CHAIN_ID, FIX_CONTRACT, cp);
  const pops = [...result.pops].reverse().map(({ minute, block, amount, kept, recipients }) => ({ minute, block, amount, kept, recipients }));
  const built: BuildArgs = {
    chainId: FIX_CHAIN_ID, contract: FIX_CONTRACT, throughMinute: through, refBlock: FIX_REF_BLOCK, sig,
    publishedAt: FIX_LAUNCH + 60 * (through + 1) + 20, rows, result, tree, pops,
  };
  const { latest, archive } = buildFiles(built);
  const userFiles = new Map([...buildUserFiles(built)].map(([path, f]) => [path, JSON.parse(toJson(f)) as Record<string, any>] as const));
  const userFile = (user: string): Record<string, any> | null => userFiles.get(userFilePath(user)) ?? null;
  return { json: JSON.parse(JSON.stringify(latest)) as Record<string, unknown>, latest, archive, cp, result, tree, sig, rows, userFiles, userFile };
}

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
/** The malleable twin of a signature: s' = n − s and the other v. It recovers the same signer, but Checkpoints.sol rejects a high s. */
export function malleate(sig: Hex): Hex {
  const s = SECP256K1_N - BigInt(`0x${sig.slice(66, 130)}`);
  const v = parseInt(sig.slice(130), 16) === 27 ? 28 : 27;
  return `${sig.slice(0, 66)}${s.toString(16).padStart(64, "0")}${v.toString(16)}` as Hex;
}

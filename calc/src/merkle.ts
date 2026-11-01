import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Hex } from "viem";
import type { Addr } from "./fills.js";

/** Every tree carries (0x0, 0) so a day without traders still has a root. Nobody can claim it. */
export const SENTINEL = "0x0000000000000000000000000000000000000000" as Addr;
const TYPES = ["address", "uint256"];

export interface RewardsTree {
  root: Hex;
  leaves: number;
  /** Every leaf's proof, computed on the first read (no hashing: the sibling path through the built tree's nodes). */
  readonly proofs: Map<Addr, { entitlement: bigint; proof: Hex[] }>;
}

interface Dump {
  tree: Hex[];
  values: { value: [string, string]; treeIndex: number }[];
}

export function buildTree(entitlements: ReadonlyMap<Addr, bigint>): RewardsTree {
  const values: [string, string][] = [[SENTINEL, "0"]];
  for (const [u, e] of [...entitlements].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (e > 0n && u !== SENTINEL) values.push([u, e.toString()]);
  }
  const tree = StandardMerkleTree.of(values, TYPES);
  let proofs: RewardsTree["proofs"] | null = null;
  return {
    root: tree.root as Hex,
    leaves: values.length,
    get proofs() {
      if (proofs) return proofs;
      const { tree: nodes, values: leaves } = tree.dump() as unknown as Dump;
      proofs = new Map();
      for (const { value, treeIndex } of leaves) {
        const proof: Hex[] = [];
        for (let i = treeIndex; i > 0; i = (i - 1) >> 1) proof.push(nodes[i % 2 === 1 ? i + 1 : i - 1]);
        proofs.set(value[0].toLowerCase() as Addr, { entitlement: BigInt(value[1]), proof });
      }
      return proofs;
    },
  };
}

export function verifyProof(root: Hex, user: Addr, entitlement: bigint, proof: Hex[]): boolean {
  return StandardMerkleTree.verify(root, TYPES, [user, entitlement.toString()], proof);
}

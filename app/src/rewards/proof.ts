import { concat, encodeAbiParameters, keccak256, type Hex } from "viem";
import type { Address } from "../config/validate";

// Local on purpose: @hlo/calc's tree code pulls in the OpenZeppelin tree library and its ethers v5 ABI stack (about 37 KB
// gzip). The vector test (contracts/test/fixtures/merkle-vector.json) and a test against calc's buildTree guard this copy.

const MAX_U256 = 2n ** 256n - 1n;
const isHex = (x: unknown, bytes: number): x is Hex => typeof x === "string" && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(x);

/** OpenZeppelin StandardMerkleTree ["address","uint256"]: leaf = keccak256(bytes.concat(keccak256(abi.encode(user, e)))). */
const leaf = (user: Address, e: bigint) => keccak256(keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [user, e])));
/** Sorted-pair (commutative) hashing, as OpenZeppelin MerkleProof. Equal-length lowercase hex sorts like the uint256 it encodes. */
const pair = (a: Hex, b: Hex) => (a.toLowerCase() < b.toLowerCase() ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

/**
 * Checks `entitlement` for `user` against an on-chain Merkle `root` (the proof file is untrusted: docs/OPS.md §10).
 * Never throws: a malformed address, root or proof entry, or an entitlement outside 0..2^256−1, is simply false.
 */
export function verifyEntitlement(root: Hex, user: Address, entitlement: bigint, proof: Hex[]): boolean {
  try {
    if (!isHex(root, 32) || !isHex(user, 20) || !Array.isArray(proof) || !proof.every((p) => isHex(p, 32))) return false;
    if (typeof entitlement !== "bigint" || entitlement < 0n || entitlement > MAX_U256) return false;
    let h = leaf(user.toLowerCase() as Address, entitlement);
    for (const p of proof) h = pair(h, p);
    return h.toLowerCase() === root.toLowerCase();
  } catch {
    return false;
  }
}

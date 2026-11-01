import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Addr } from "../src/fills.js";
import { buildTree, SENTINEL, verifyProof } from "../src/merkle.js";

const VECTOR = new URL("../../contracts/test/fixtures/merkle-vector.json", import.meta.url);
const ENTRIES: [Addr, bigint][] = [
  ["0x70997970c51812dc3a010c7d01b50e0d17dc79c8", 1_000_000_000_000_000_000n],
  ["0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", 250_000_000_000_000_000n],
  ["0x90f79bf6eb2c4f870365e785982e1f101e93b906", 1n],
  ["0x15d34aaf54267db7d7c367839aaf71a00a2c6a65", 4_999_000_000_000_000_000_000_000n],
  ["0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc", 123_456_789n],
];

describe("buildTree", () => {
  const tree = buildTree(new Map([...ENTRIES, ["0x00000000000000000000000000000000000000ff" as Addr, 0n]]));
  it("contains every non-zero entry plus the sentinel", () => {
    expect(tree.leaves).toBe(ENTRIES.length + 1);
    expect(tree.proofs.get(SENTINEL)?.entitlement).toBe(0n);
    expect(tree.proofs.has("0x00000000000000000000000000000000000000ff")).toBe(false);
  });
  it("every proof verifies; tampered values do not", () => {
    for (const [u, e] of ENTRIES) {
      const p = tree.proofs.get(u)!;
      expect(verifyProof(tree.root, u, e, p.proof)).toBe(true);
      expect(verifyProof(tree.root, u, e + 1n, p.proof)).toBe(false);
    }
  });
  it("an empty map still has a root (sentinel only)", () => {
    const t = buildTree(new Map());
    expect(t.leaves).toBe(1);
    expect(t.root).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it("is independent of insertion order", () => {
    expect(buildTree(new Map([...ENTRIES].reverse())).root).toBe(buildTree(new Map(ENTRIES)).root);
  });
  it("matches the vector the Solidity test verifies (UPDATE_VECTOR=1 rewrites it)", () => {
    const t = buildTree(new Map(ENTRIES));
    const vector = {
      root: t.root,
      leaves: [...ENTRIES, [SENTINEL, 0n] as [Addr, bigint]].map(([user, e]) => ({
        user,
        entitlement: e.toString(),
        proof: t.proofs.get(user)!.proof,
      })),
    };
    const text = JSON.stringify(vector, null, 2) + "\n";
    if (process.env.UPDATE_VECTOR === "1" || !existsSync(VECTOR)) {
      mkdirSync(new URL(".", VECTOR), { recursive: true });
      writeFileSync(VECTOR, text);
    }
    expect(readFileSync(VECTOR, "utf8")).toBe(text);
  });
});

describe("buildTree computes proofs only when asked", () => {
  const users = [1, 2, 3, 4, 5].map((i) => `0x${i.toString(16).padStart(40, "0")}` as Addr);
  const ent = new Map(users.map((u, i) => [u, BigInt(i + 1) * 10n ** 18n] as const));
  afterEach(() => vi.restoreAllMocks());

  it("does not touch getProof or the library's dump to build a root (proofs read the nodes on first use)", () => {
    const proof = vi.spyOn(StandardMerkleTree.prototype, "getProof");
    const dump = vi.spyOn(StandardMerkleTree.prototype, "dump");
    const tree = buildTree(ent);
    expect(tree.root).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proof).not.toHaveBeenCalled();
    expect(dump).not.toHaveBeenCalled();
  });

  it("offers no dump: the app reads each wallet's proof from its user file, nothing publishes the whole tree", () => {
    expect(buildTree(ent)).not.toHaveProperty("dump");
  });

  it("the lazy proofs equal the library's own and verify", () => {
    const tree = buildTree(ent);
    const lib = StandardMerkleTree.of(
      [["0x0000000000000000000000000000000000000000", "0"], ...[...ent].map(([u, e]) => [u, e.toString()])],
      ["address", "uint256"],
    );
    for (const [i, v] of lib.entries()) {
      const got = tree.proofs.get((v[0] as string).toLowerCase() as Addr)!;
      expect(got.proof).toEqual(lib.getProof(i));
      expect(got.entitlement).toBe(BigInt(v[1] as string));
      expect(verifyProof(tree.root, v[0] as Addr, got.entitlement, got.proof)).toBe(true);
    }
    expect(tree.proofs).toBe(tree.proofs); // computed once
  });
});

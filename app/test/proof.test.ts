import { readFileSync } from "node:fs";
import { buildTree, SENTINEL, type Addr } from "@hlo/calc";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { verifyEntitlement } from "../src/rewards/proof";

const vector = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/merkle-vector.json", import.meta.url), "utf8")) as {
  root: Hex;
  leaves: { user: `0x${string}`; entitlement: string; proof: Hex[] }[];
};

describe("verifyEntitlement (contracts/test/fixtures/merkle-vector.json)", () => {
  it("accepts every leaf of the vector", () => {
    for (const l of vector.leaves) expect(verifyEntitlement(vector.root, l.user, BigInt(l.entitlement), l.proof)).toBe(true);
  });
  it("rejects a changed entitlement, user or root", () => {
    const l = vector.leaves[0];
    expect(verifyEntitlement(vector.root, l.user, BigInt(l.entitlement) + 1n, l.proof)).toBe(false);
    expect(verifyEntitlement(vector.root, vector.leaves[1].user, BigInt(l.entitlement), l.proof)).toBe(false);
    expect(verifyEntitlement(("0x" + "00".repeat(32)) as Hex, l.user, BigInt(l.entitlement), l.proof)).toBe(false);
  });
});

describe("verifyEntitlement never throws on hostile input (the proof file is untrusted)", () => {
  const l = vector.leaves[0];
  const e = BigInt(l.entitlement);
  const run = (over: { root?: unknown; user?: unknown; e?: unknown; proof?: unknown[] }) =>
    verifyEntitlement((over.root ?? vector.root) as Hex, (over.user ?? l.user) as `0x${string}`, (over.e ?? e) as bigint, (over.proof ?? l.proof) as Hex[]);

  it("a proof entry that is not 32 bytes is false", () => {
    for (const bad of ["0x12", "0x" + "11".repeat(31), "0x" + "11".repeat(33), "0x", "", "zz" + "11".repeat(31), 5, null]) {
      expect(run({ proof: [...l.proof, bad] })).toBe(false);
      expect(run({ proof: [bad, ...l.proof] })).toBe(false);
    }
  });
  it("an entitlement outside 0..2^256-1 is false", () => {
    expect(run({ e: -1n })).toBe(false);
    expect(run({ e: 2n ** 256n })).toBe(false);
    expect(run({ e: 2n ** 300n })).toBe(false);
    expect(run({ e: 5 })).toBe(false); // a number, not a bigint
  });
  it("a malformed address or root is false", () => {
    for (const bad of ["0x12", "0x" + "aa".repeat(21), "not an address", "", "0x" + "zz".repeat(20)]) expect(run({ user: bad })).toBe(false);
    for (const bad of ["0x12", "0x" + "00".repeat(33), "", "root"]) expect(run({ root: bad })).toBe(false);
    expect(run({ proof: "nope" as unknown as unknown[] })).toBe(false);
  });
  it("the 2^256-1 boundary reaches the hash (false because it is not the leaf, not because it threw)", () => {
    expect(run({ e: 2n ** 256n - 1n })).toBe(false);
    expect(run({ e: 0n })).toBe(false);
  });
  it("accepts a checksummed or upper-case user and any case of a proof entry", () => {
    expect(run({ user: l.user.toLowerCase() })).toBe(true);
    expect(run({ user: ("0x" + l.user.slice(2).toUpperCase()) as string })).toBe(true);
    expect(run({ proof: l.proof.map((p) => "0x" + p.slice(2).toUpperCase()) })).toBe(true);
  });
  it("an empty proof does not verify a multi-leaf root", () => {
    expect(run({ proof: [] })).toBe(false);
  });
});

describe("verifyEntitlement agrees with @hlo/calc's StandardMerkleTree (test only: the app bundle does not import calc)", () => {
  const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Addr;
  it("every leaf of trees of 1, 2, 3, 7 and 33 entitlements verifies; a changed entitlement does not", () => {
    for (const n of [1, 2, 3, 7, 33]) {
      const ents = new Map<Addr, bigint>();
      for (let i = 1; i <= n; i++) ents.set(addr(0xabc000 + i * 7919), BigInt(i) * 10n ** 18n + BigInt(i));
      const tree = buildTree(ents);
      for (const [user, { entitlement, proof }] of tree.proofs) {
        if (user === SENTINEL) continue;
        expect(verifyEntitlement(tree.root, user, entitlement, proof)).toBe(true);
        expect(verifyEntitlement(tree.root, user, entitlement + 1n, proof)).toBe(false);
      }
    }
  });
  it("agrees on the sentinel leaf and on the largest entitlement", () => {
    const user = addr(0x1234);
    const big = 2n ** 256n - 1n;
    const tree = buildTree(new Map([[user, big], [addr(0x5678), 1n]]));
    const p = tree.proofs.get(user)!;
    expect(verifyEntitlement(tree.root, user, big, p.proof)).toBe(true);
    const s = tree.proofs.get(SENTINEL)!;
    expect(verifyEntitlement(tree.root, SENTINEL, 0n, s.proof)).toBe(true);
  });
});

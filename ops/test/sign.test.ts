import { concatHex, encodeAbiParameters, keccak256, stringToBytes, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { checkpointDigest, checkpointDomain, recoverCheckpointSigner, signCheckpoint, type Cp } from "../src/sign.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil dev key #1
const account = privateKeyToAccount(KEY);
const CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3" as const;
const cp: Cp = {
  throughMinute: 1234,
  refBlock: 987654n,
  root: "0x00000000000000000000000000000000000000000000000000000000000000ab",
  totalEntitled: 5_500_000_000_000_000_000n,
};

describe("checkpoint signing", () => {
  it("the signer is recovered from the signature", async () => {
    const sig = await signCheckpoint(account, 998, CONTRACT, cp);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(await recoverCheckpointSigner(998, CONTRACT, cp, sig)).toBe(account.address);
  });

  it("the digest is keccak256(0x1901 ‖ domainSeparator ‖ structHash) with the contract's typehash strings", () => {
    const typeHash = keccak256(stringToBytes("Checkpoint(uint256 throughMinute,uint256 refBlock,bytes32 root,uint256 totalEntitled)"));
    const domainTypeHash = keccak256(stringToBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    const separator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [domainTypeHash, keccak256(stringToBytes("HLO Checkpoints")), keccak256(stringToBytes("1")), 998n, CONTRACT],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }],
        [typeHash, BigInt(cp.throughMinute), cp.refBlock, cp.root, cp.totalEntitled],
      ),
    );
    const expected = keccak256(concatHex(["0x1901", separator, structHash]));
    expect(checkpointDigest(998, CONTRACT, cp)).toBe(expected);
  });

  it("the domain is the contract's", () => {
    expect(checkpointDomain(998, CONTRACT)).toEqual({ name: "HLO Checkpoints", version: "1", chainId: 998, verifyingContract: CONTRACT });
  });

  it("a changed field, chain or contract recovers a different address", async () => {
    const sig = await signCheckpoint(account, 998, CONTRACT, cp);
    const other = async (c: Cp, chain = 998, addr: Hex = CONTRACT) => recoverCheckpointSigner(chain, addr as `0x${string}`, c, sig);
    expect(await other({ ...cp, totalEntitled: cp.totalEntitled + 1n })).not.toBe(account.address);
    expect(await other({ ...cp, throughMinute: cp.throughMinute + 1 })).not.toBe(account.address);
    expect(await other({ ...cp, refBlock: cp.refBlock + 1n })).not.toBe(account.address);
    expect(await other(cp, 999)).not.toBe(account.address);
    expect(await other(cp, 998, "0x00000000000000000000000000000000000000f1")).not.toBe(account.address);
  });
});

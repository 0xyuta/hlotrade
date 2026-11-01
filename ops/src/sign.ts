import { hashTypedData, recoverTypedDataAddress, type Address, type Hex, type LocalAccount } from "viem";

/** Exactly Checkpoints.sol's CHECKPOINT_TYPEHASH string: `Checkpoint(uint256 throughMinute,uint256 refBlock,bytes32 root,uint256 totalEntitled)`. */
export const CHECKPOINT_TYPES = {
  Checkpoint: [
    { name: "throughMinute", type: "uint256" },
    { name: "refBlock", type: "uint256" },
    { name: "root", type: "bytes32" },
    { name: "totalEntitled", type: "uint256" },
  ],
} as const;

export interface Cp {
  throughMinute: number;
  refBlock: bigint;
  root: Hex;
  totalEntitled: bigint;
}

/** Checkpoints.sol's EIP-712 domain: name "HLO Checkpoints", version "1". */
export const checkpointDomain = (chainId: number, contract: Address) =>
  ({ name: "HLO Checkpoints", version: "1", chainId, verifyingContract: contract }) as const;

const message = (cp: Cp) => ({
  throughMinute: BigInt(cp.throughMinute),
  refBlock: cp.refBlock,
  root: cp.root,
  totalEntitled: cp.totalEntitled,
});

const typed = (chainId: number, contract: Address, cp: Cp) =>
  ({
    domain: checkpointDomain(chainId, contract),
    types: CHECKPOINT_TYPES,
    primaryType: "Checkpoint",
    message: message(cp),
  }) as const;

export function signCheckpoint(account: LocalAccount, chainId: number, contract: Address, cp: Cp): Promise<Hex> {
  return account.signTypedData(typed(chainId, contract, cp));
}

export function recoverCheckpointSigner(chainId: number, contract: Address, cp: Cp, sig: Hex): Promise<Address> {
  return recoverTypedDataAddress({ ...typed(chainId, contract, cp), signature: sig });
}

/** What Checkpoints.hashCheckpoint returns: keccak256("\x19\x01" ‖ domainSeparator ‖ structHash). */
export const checkpointDigest = (chainId: number, contract: Address, cp: Cp): Hex => hashTypedData(typed(chainId, contract, cp));

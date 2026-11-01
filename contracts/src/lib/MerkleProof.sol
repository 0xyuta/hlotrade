// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Sorted-pair Merkle verification (same hashing as OpenZeppelin).
library MerkleProof {
    function verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 p = proof[i];
            h = h < p ? keccak256(abi.encode(h, p)) : keccak256(abi.encode(p, h));
        }
        return h == root;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Test-only tree builder. An odd node at the end of a level is carried
///         up unchanged, which sorted-pair verification accepts.
library MerkleHelper {
    function leaf(address user, uint256 e) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(user, e))));
    }

    function hashPair(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }

    function rootAndProof(bytes32[] memory leaves, uint256 index)
        internal
        pure
        returns (bytes32 root, bytes32[] memory proof)
    {
        bytes32[] memory level = leaves;
        bytes32[] memory tmp = new bytes32[](64);
        uint256 n;
        uint256 idx = index;
        while (level.length > 1) {
            uint256 sib = idx ^ 1;
            if (sib < level.length) tmp[n++] = level[sib];
            bytes32[] memory next = new bytes32[]((level.length + 1) / 2);
            for (uint256 i; i < next.length; ++i) {
                uint256 l = 2 * i;
                next[i] = l + 1 < level.length ? hashPair(level[l], level[l + 1]) : level[l];
            }
            level = next;
            idx /= 2;
        }
        root = level[0];
        proof = new bytes32[](n);
        for (uint256 i; i < n; ++i) proof[i] = tmp[i];
    }
}

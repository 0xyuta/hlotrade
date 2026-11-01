// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "../src/lib/MerkleProof.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

contract MerkleProofTest is Test {
    function _leaves(uint256 n) internal pure returns (bytes32[] memory l) {
        l = new bytes32[](n);
        for (uint256 i; i < n; ++i) l[i] = MerkleHelper.leaf(address(uint160(i + 1)), (i + 1) * 1e18);
    }

    function test_SingleLeaf() public pure {
        bytes32[] memory l = _leaves(1);
        (bytes32 root, bytes32[] memory proof) = MerkleHelper.rootAndProof(l, 0);
        assertEq(root, l[0]);
        assertTrue(MerkleProof.verify(proof, root, l[0]));
    }

    function test_EveryLeafOfOddTreeVerifies() public pure {
        bytes32[] memory l = _leaves(5);
        for (uint256 i; i < 5; ++i) {
            (bytes32 root, bytes32[] memory proof) = MerkleHelper.rootAndProof(l, i);
            assertTrue(MerkleProof.verify(proof, root, l[i]));
        }
    }

    function test_WrongLeafFails() public pure {
        bytes32[] memory l = _leaves(4);
        (bytes32 root, bytes32[] memory proof) = MerkleHelper.rootAndProof(l, 1);
        assertFalse(MerkleProof.verify(proof, root, l[2]));
        assertFalse(MerkleProof.verify(proof, root, MerkleHelper.leaf(address(2), 3e18)));
    }

    /// Matches OpenZeppelin StandardMerkleTree leaf encoding for ["address","uint256"].
    function test_LeafEncoding() public pure {
        address u = address(0x1234);
        uint256 e = 42;
        assertEq(MerkleHelper.leaf(u, e), keccak256(bytes.concat(keccak256(abi.encode(u, e)))));
    }

    function testFuzz_AllLeavesVerify(uint8 n, uint8 i) public pure {
        uint256 size = bound(n, 1, 40);
        uint256 idx = bound(i, 0, size - 1);
        bytes32[] memory l = _leaves(size);
        (bytes32 root, bytes32[] memory proof) = MerkleHelper.rootAndProof(l, idx);
        assertTrue(MerkleProof.verify(proof, root, l[idx]));
    }
}

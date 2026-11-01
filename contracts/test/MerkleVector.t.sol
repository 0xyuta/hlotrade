// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MerkleProof} from "../src/lib/MerkleProof.sol";

/// @notice Proves trees built by calc/ (OpenZeppelin StandardMerkleTree) verify with
///         Mining's leaf format and MerkleProof. Regenerate the JSON with
///         `cd calc && UPDATE_VECTOR=1 npx vitest run test/merkle.test.ts`.
contract MerkleVectorTest is Test {
    function test_CalcTreeVerifiesOnChain() public view {
        string memory json = vm.readFile("test/fixtures/merkle-vector.json");
        bytes32 root = vm.parseJsonBytes32(json, ".root");
        for (uint256 i; i < 6; ++i) {
            string memory p = string.concat(".leaves[", vm.toString(i), "]");
            address user = vm.parseJsonAddress(json, string.concat(p, ".user"));
            uint256 e = vm.parseJsonUint(json, string.concat(p, ".entitlement"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(json, string.concat(p, ".proof"));
            bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(user, e))));
            assertTrue(MerkleProof.verify(proof, root, leaf), "calc proof must verify");
            assertFalse(MerkleProof.verify(proof, root, keccak256(bytes.concat(keccak256(abi.encode(user, e + 1))))));
        }
    }
}

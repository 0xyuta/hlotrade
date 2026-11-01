// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockRefined {
    uint256 public totalRefined;

    function set(uint256 v) external {
        totalRefined = v;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockV2Factory, MockV2Pair} from "./mocks/MockV2.sol";

contract MockV2Test is Test {
    MockERC20 a;
    MockERC20 b;
    MockV2Factory f;
    MockV2Pair p;

    function setUp() public {
        a = new MockERC20("A", 18);
        b = new MockERC20("B", 6);
        f = new MockV2Factory();
        p = MockV2Pair(f.createPair(address(a), address(b)));
    }

    function test_PairRegisteredBothWays() public view {
        assertEq(f.getPair(address(a), address(b)), address(p));
        assertEq(f.getPair(address(b), address(a)), address(p));
        assertEq(p.token0(), address(a) < address(b) ? address(a) : address(b));
    }

    function test_MintSwapAndCumulative() public {
        a.mint(address(p), 10_000e18);
        b.mint(address(p), 1_000e6);
        uint256 liq = p.mint(address(this));
        assertGt(liq, 0);
        assertEq(p.balanceOf(address(this)), liq);

        vm.warp(block.timestamp + 100);
        // swap 10 B in for A out
        b.mint(address(p), 10e6);
        (uint112 r0, uint112 r1,) = p.getReserves();
        bool aIs0 = p.token0() == address(a);
        (uint256 rIn, uint256 rOut) = aIs0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 out = 10e6 * 997 * rOut / (rIn * 1000 + 10e6 * 997);
        (uint256 o0, uint256 o1) = aIs0 ? (out, uint256(0)) : (uint256(0), out);
        p.swap(o0, o1, address(this), "");
        assertEq(a.balanceOf(address(this)), out);
        assertGt(p.price0CumulativeLast(), 0);
    }

    function test_SwapBreakingKReverts() public {
        a.mint(address(p), 10_000e18);
        b.mint(address(p), 1_000e6);
        p.mint(address(this));
        bool aIs0 = p.token0() == address(a);
        // 1 wei of input: a zero-input swap reverts "IN" before the K check runs
        b.mint(address(p), 1);
        (uint256 o0, uint256 o1) = aIs0 ? (uint256(1e18), uint256(0)) : (uint256(0), uint256(1e18));
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "K"));
        p.swap(o0, o1, address(this), "");
    }
}

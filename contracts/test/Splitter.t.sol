// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Splitter} from "../src/Splitter.sol";
import {MockERC20} from "./mocks/MockERC20.sol";

contract SliceSink {
    uint256 public calls;

    function refreshSlice() external {
        calls++;
    }
}

contract SplitterTest is Test {
    MockERC20 usdc;
    SliceSink sink;
    Splitter s;
    address admin = address(0xAD);

    function setUp() public {
        usdc = new MockERC20("USDC", 6);
        sink = new SliceSink();
        s = new Splitter(address(usdc), address(sink), admin);
        usdc.mint(address(this), 1_000_000e6);
        usdc.approve(address(s), type(uint256).max);
    }

    function test_DepositSplits10And90() public {
        s.deposit(1000e6);
        assertEq(s.adminBalance(), 100e6);
        assertEq(usdc.balanceOf(address(sink)), 900e6);
        assertEq(usdc.balanceOf(address(s)), 100e6);
        assertEq(sink.calls(), 1);
        assertEq(s.totalDeposited(), 1000e6);
    }

    function test_RoundingGoesToBuyback() public {
        s.deposit(7);
        assertEq(s.adminBalance(), 0);
        assertEq(usdc.balanceOf(address(sink)), 7);
    }

    function test_ZeroDepositReverts() public {
        vm.expectRevert(Splitter.ZeroAmount.selector);
        s.deposit(0);
    }

    function test_AdminClaims() public {
        s.deposit(1000e6);
        vm.prank(admin);
        assertEq(s.claimAdmin(), 100e6);
        assertEq(usdc.balanceOf(admin), 100e6);
        assertEq(s.adminBalance(), 0);
    }

    function test_OnlyAdminClaimsAndRotates() public {
        vm.expectRevert(Splitter.NotAdmin.selector);
        s.claimAdmin();
        vm.prank(admin);
        s.setAdmin(address(0xBEEF));
        assertEq(s.admin(), address(0xBEEF));
        vm.prank(address(0xBEEF));
        vm.expectRevert(Splitter.ZeroAddress.selector);
        s.setAdmin(address(0));
    }

    function testFuzz_BalanceEqualsAdminBalance(uint64 a, uint64 b) public {
        uint256 x = bound(a, 1, 1_000_000e6 / 2);
        uint256 y = bound(b, 1, 1_000_000e6 / 2);
        s.deposit(x);
        s.deposit(y);
        assertEq(usdc.balanceOf(address(s)), s.adminBalance());
        assertEq(s.adminBalance() + usdc.balanceOf(address(sink)), x + y);
    }
}

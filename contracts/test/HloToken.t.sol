// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HloToken} from "../src/HloToken.sol";

contract HloTokenTest is Test {
    HloToken t;
    address mining = address(0xA1);
    address buyback = address(0xB1);
    address pair = address(0xC1);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        t = new HloToken();
        t.setMinters(mining, buyback, pair);
    }

    function test_Metadata() public view {
        assertEq(t.name(), "HLO");
        assertEq(t.symbol(), "HLO");
        assertEq(t.decimals(), 18);
        assertEq(t.MAX_SUPPLY(), 5_000_000e18);
    }

    function test_SetMintersOnlyOnce() public {
        vm.expectRevert(HloToken.AlreadySet.selector);
        t.setMinters(mining, buyback, pair);
    }

    function test_SetMintersOnlyDeployer() public {
        HloToken t2 = new HloToken();
        vm.prank(alice);
        vm.expectRevert(HloToken.NotDeployer.selector);
        t2.setMinters(mining, buyback, pair);
    }

    function test_SetMintersRejectsZero() public {
        HloToken t2 = new HloToken();
        vm.expectRevert(HloToken.ZeroAddress.selector);
        t2.setMinters(address(0), buyback, pair);
    }

    function test_OnlyMintersMint() public {
        vm.prank(alice);
        vm.expectRevert(HloToken.NotMinter.selector);
        t.mint(alice, 1);

        vm.prank(mining);
        t.mint(alice, 5e18);
        vm.prank(buyback);
        t.mint(alice, 1e18);
        assertEq(t.balanceOf(alice), 6e18);
        assertEq(t.totalSupply(), 6e18);
    }

    function test_CapEnforced() public {
        vm.prank(mining);
        t.mint(alice, 5_000_000e18);
        vm.prank(mining);
        vm.expectRevert(HloToken.CapExceeded.selector);
        t.mint(alice, 1);
    }

    function test_BurnFreesRoomUnderCap() public {
        vm.prank(mining);
        t.mint(alice, 5_000_000e18);
        vm.prank(alice);
        t.burn(1e18);
        assertEq(t.totalBurned(), 1e18);
        assertEq(t.totalSupply(), 5_000_000e18 - 1e18);
        vm.prank(mining);
        t.mint(bob, 1e18);
        assertEq(t.totalSupply(), 5_000_000e18);
    }

    function test_BurnMoreThanBalanceReverts() public {
        vm.prank(alice);
        vm.expectRevert(HloToken.InsufficientBalance.selector);
        t.burn(1);
    }

    function test_TransferToPairLockedUntilOpen() public {
        vm.prank(mining);
        t.mint(alice, 10);
        vm.prank(alice);
        vm.expectRevert(HloToken.PairLocked.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        t.transfer(pair, 1); // reverts by design; the return value is never observable

        vm.prank(buyback);
        t.openPair();
        vm.prank(alice);
        assertTrue(t.transfer(pair, 1));
        assertEq(t.balanceOf(pair), 1);
    }

    function test_OpenPairOnlyBuyback() public {
        vm.prank(alice);
        vm.expectRevert(HloToken.NotBuyback.selector);
        t.openPair();
    }

    function test_TransferFromUsesAllowance() public {
        vm.prank(mining);
        t.mint(alice, 10);
        vm.prank(alice);
        t.approve(bob, 3);
        vm.prank(bob);
        assertTrue(t.transferFrom(alice, bob, 3));
        assertEq(t.balanceOf(bob), 3);
        assertEq(t.allowance(alice, bob), 0);
        vm.prank(bob);
        vm.expectRevert(HloToken.InsufficientAllowance.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        t.transferFrom(alice, bob, 1); // reverts by design; the return value is never observable
    }

    function test_InfiniteAllowanceNotDecreased() public {
        vm.prank(mining);
        t.mint(alice, 10);
        vm.prank(alice);
        t.approve(bob, type(uint256).max);
        vm.prank(bob);
        assertTrue(t.transferFrom(alice, bob, 4));
        assertEq(t.allowance(alice, bob), type(uint256).max);
    }

    function testFuzz_SupplyNeverAboveCap(uint256 a, uint256 b) public {
        a = bound(a, 0, 5_000_000e18);
        b = bound(b, 0, 5_000_000e18);
        vm.prank(mining);
        t.mint(alice, a);
        vm.prank(mining);
        if (a + b > 5_000_000e18) vm.expectRevert(HloToken.CapExceeded.selector);
        t.mint(alice, b);
        assertLe(t.totalSupply(), 5_000_000e18);
    }
}

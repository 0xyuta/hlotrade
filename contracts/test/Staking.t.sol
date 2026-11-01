// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HloToken} from "../src/HloToken.sol";
import {Staking} from "../src/Staking.sol";

contract StakingTest is Test {
    HloToken token;
    Staking staking;
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    function setUp() public {
        token = new HloToken();
        token.setMinters(address(this), address(this), address(0xFA1F));
        staking = new Staking(address(token));
        token.mint(alice, 1000e18);
        token.mint(bob, 1000e18);
        token.mint(address(this), 1000e18);
        vm.prank(alice);
        token.approve(address(staking), type(uint256).max);
        vm.prank(bob);
        token.approve(address(staking), type(uint256).max);
        token.approve(address(staking), type(uint256).max);
    }

    function _stake(address u, uint256 a) internal {
        vm.prank(u);
        staking.stake(a);
    }

    /// Lets one full DRIP pass so everything notified so far is released.
    function _drip() internal {
        vm.warp(block.timestamp + 1 days);
    }

    function test_StakeUnstakeRoundTrip() public {
        _stake(alice, 100e18);
        assertEq(staking.totalStaked(), 100e18);
        assertEq(token.balanceOf(alice), 900e18);
        vm.prank(alice);
        staking.unstake(100e18);
        assertEq(token.balanceOf(alice), 1000e18);
        assertEq(staking.totalStaked(), 0);
    }

    function test_SingleStakerGetsAllRewards() public {
        _stake(alice, 100e18);
        staking.notifyReward(10e18);
        _drip();
        assertEq(staking.pending(alice), 10e18);
        vm.prank(alice);
        assertEq(staking.claim(), 10e18);
        assertEq(token.balanceOf(alice), 910e18);
    }

    function test_TwoStakersProRata() public {
        _stake(alice, 100e18);
        _stake(bob, 300e18);
        staking.notifyReward(40e18);
        _drip();
        assertEq(staking.pending(alice), 10e18);
        assertEq(staking.pending(bob), 30e18);
    }

    /// Rewards that arrive while nobody stakes stay undripped and reach a later
    /// staker gradually, not at once.
    function test_RewardWithNoStakersDripsToLaterStakerGradually() public {
        staking.notifyReward(5e18);
        assertEq(staking.undripped(), 5e18);
        vm.warp(block.timestamp + 10 days); // nothing is released while nobody stakes
        _stake(alice, 1e18);
        assertEq(staking.undripped(), 5e18);
        assertEq(staking.pending(alice), 0);
        vm.warp(block.timestamp + 12 hours);
        assertEq(staking.pending(alice), 2.5e18);
        vm.warp(block.timestamp + 12 hours);
        assertEq(staking.pending(alice), 5e18);
        vm.prank(alice);
        assertEq(staking.claim(), 5e18);
        assertEq(staking.undripped(), 0);
    }

    function test_LateStakerGetsNoEarlierRewards() public {
        _stake(alice, 100e18);
        staking.notifyReward(10e18);
        _drip();
        _stake(bob, 100e18);
        assertEq(staking.pending(bob), 0);
        staking.notifyReward(10e18);
        _drip();
        assertEq(staking.pending(alice), 15e18);
        assertEq(staking.pending(bob), 5e18);
    }

    function test_UnstakeKeepsEarnedRewards() public {
        _stake(alice, 100e18);
        staking.notifyReward(10e18);
        _drip();
        vm.prank(alice);
        staking.unstake(100e18);
        assertEq(staking.pending(alice), 10e18);
        vm.prank(alice);
        staking.claim();
        assertEq(token.balanceOf(alice), 1010e18);
    }

    function test_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(Staking.ZeroAmount.selector);
        staking.stake(0);
        _stake(alice, 1e18);
        vm.prank(alice);
        vm.expectRevert(Staking.InsufficientStake.selector);
        staking.unstake(2e18);
        vm.expectRevert(Staking.ZeroAmount.selector);
        staking.notifyReward(0);
    }

    /// @dev A 1-wei stake alone takes the whole reward, which inflates accPerShare
    ///      by reward * 1e36. A later large stake must still work.
    function test_DustStakeDoesNotBrickLargeStake() public {
        _stake(alice, 1);
        staking.notifyReward(500e18);
        _drip();
        _stake(bob, 1000e18);
        assertEq(staking.pending(bob), 0);
        assertEq(staking.pending(alice), 500e18);
        vm.prank(bob);
        staking.unstake(1000e18);
        assertEq(token.balanceOf(bob), 1000e18);
    }

    function _assertSolvent() internal view {
        assertGe(token.balanceOf(address(staking)), staking.totalStaked());
    }

    /// @dev Floored debts let rounding over-credit rewards (1 wei per entry).
    ///      Rewards must never be paid out of principal.
    function test_RoundingNeverTouchesPrincipal() public {
        address carol = address(0xCA201);
        token.mint(carol, 1000e18);
        vm.prank(carol);
        token.approve(address(staking), type(uint256).max);

        _stake(bob, 10);
        staking.notifyReward(9);
        _drip();
        vm.prank(bob);
        staking.unstake(10);
        vm.prank(bob);
        assertEq(staking.claim(), 9);
        _assertSolvent();

        _stake(alice, 1);
        _stake(carol, 2);
        _assertSolvent();
        staking.notifyReward(1);
        _assertSolvent();
        _drip();

        vm.prank(alice);
        assertEq(staking.claim(), 1);
        _assertSolvent();
        vm.prank(carol);
        staking.claim();
        _assertSolvent();

        vm.prank(alice);
        staking.unstake(1);
        _assertSolvent();
        vm.prank(carol);
        staking.unstake(2);
        _assertSolvent();
        assertEq(token.balanceOf(carol), 1000e18);
        assertEq(token.balanceOf(alice), 1000e18 + 1);
    }

    function testFuzz_NeverPaysMoreThanNotified(uint96 a, uint96 b, uint96 r1, uint96 r2) public {
        uint256 sa = bound(a, 1, 1000e18);
        uint256 sb = bound(b, 1, 1000e18);
        uint256 x = bound(r1, 1, 500e18);
        uint256 y = bound(r2, 1, 400e18);
        _stake(alice, sa);
        staking.notifyReward(x);
        vm.warp(block.timestamp + 6 hours);
        _stake(bob, sb);
        staking.notifyReward(y);
        _drip();
        assertLe(staking.pending(alice) + staking.pending(bob), x + y);
        vm.prank(alice);
        staking.claim();
        vm.prank(bob);
        staking.claim();
        assertGe(token.balanceOf(address(staking)), staking.totalStaked());
        assertLe(staking.rewardBalance(), token.balanceOf(address(staking)) - staking.totalStaked());
    }

    // ------------------------------------------------ I1: rewards drip over DRIP

    /// stake -> notifyReward -> unstake -> claim in one block earns nothing.
    function test_JitStakeAroundNotifyEarnsZero() public {
        _stake(alice, 100e18);
        vm.warp(block.timestamp + 3 days);
        token.mint(bob, 9000e18);
        _stake(bob, 10_000e18);
        staking.notifyReward(10e18);
        vm.prank(bob);
        staking.unstake(10_000e18);
        vm.prank(bob);
        assertEq(staking.claim(), 0);
        assertEq(token.balanceOf(bob), 10_000e18);
        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(staking.pending(alice), 10e18, 1);
    }

    function test_FullDripGoesToStaker() public {
        _stake(alice, 100e18);
        staking.notifyReward(10e18);
        assertEq(staking.pending(alice), 0);
        vm.warp(block.timestamp + 6 hours);
        assertEq(staking.pending(alice), 2.5e18);
        vm.warp(block.timestamp + 18 hours);
        assertEq(staking.pending(alice), 10e18);
        vm.warp(block.timestamp + 5 days); // never more than notified
        assertEq(staking.pending(alice), 10e18);
        vm.prank(alice);
        assertEq(staking.claim(), 10e18);
        assertEq(staking.undripped(), 0);
        assertEq(staking.rewardBalance(), 0);
    }

    /// alice alone for half a DRIP, then bob joins with the same stake.
    function test_TwoStakersOverTimeProRata() public {
        _stake(alice, 100e18);
        staking.notifyReward(40e18);
        vm.warp(block.timestamp + 12 hours);
        _stake(bob, 100e18); // releases 20e18 to alice alone first
        assertEq(staking.pending(alice), 20e18);
        assertEq(staking.pending(bob), 0);
        assertEq(staking.undripped(), 20e18);
        vm.warp(block.timestamp + 1 days);
        assertEq(staking.pending(alice), 30e18);
        assertEq(staking.pending(bob), 10e18);
    }

    /// pending() includes the drip that has not been applied to storage yet.
    function test_PendingViewMatchesSettledState() public {
        _stake(alice, 100e18);
        staking.notifyReward(10e18);
        vm.warp(block.timestamp + 3 hours);
        uint256 viewed = staking.pending(alice);
        staking.notifyReward(1); // applies the drip
        assertEq(staking.pending(alice), viewed);
        assertEq(staking.lastDrip(), block.timestamp);
    }

    function test_DripConstant() public view {
        assertEq(staking.DRIP(), 1 days);
    }
}

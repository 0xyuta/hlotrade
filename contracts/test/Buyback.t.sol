// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HloToken} from "../src/HloToken.sol";
import {Staking} from "../src/Staking.sol";
import {Buyback} from "../src/Buyback.sol";
import {IUniswapV2Pair} from "../src/interfaces/IUniswapV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockV2Factory} from "./mocks/MockV2.sol";

contract BuybackTest is Test {
    HloToken hlo;
    MockERC20 usdc;
    MockV2Factory factory;
    Staking staking;
    Buyback bb;
    IUniswapV2Pair pair;
    uint256 launch;
    address alice = address(0xA11CE);

    event Skipped(uint256 spot, uint256 twap);

    function setUp() public {
        vm.warp(1_800_000_000);
        launch = block.timestamp;
        hlo = new HloToken();
        usdc = new MockERC20("USDC", 6);
        factory = new MockV2Factory();
        staking = new Staking(address(hlo));
        bb = new Buyback(address(hlo), address(usdc), address(factory), address(staking), launch, 30);
        pair = bb.pair();
        hlo.setMinters(address(this), address(bb), address(pair));
        // a staker so rewards are distributed, not queued
        hlo.mint(alice, 100e18);
        vm.startPrank(alice);
        hlo.approve(address(staking), type(uint256).max);
        staking.stake(100e18);
        vm.stopPrank();
    }

    function _fund(uint256 amount) internal {
        usdc.mint(address(bb), amount);
        bb.refreshSlice();
    }

    function _open(uint256 seedUsdc) internal {
        _fund(seedUsdc);
        vm.warp(launch + 7 days);
        bb.openPool();
    }

    function test_ConstructorCreatesPair() public view {
        assertEq(factory.getPair(address(hlo), address(usdc)), address(pair));
        assertEq(bb.hloIsToken0(), pair.token0() == address(hlo));
    }

    function test_BadFeeReverts() public {
        vm.expectRevert(Buyback.BadFee.selector);
        new Buyback(address(hlo), address(usdc), address(factory), address(staking), launch, 10_000);
    }

    function test_OpenPoolTooEarly() public {
        _fund(1000e6);
        vm.warp(launch + 7 days - 1);
        vm.expectRevert(Buyback.TooEarly.selector);
        bb.openPool();
    }

    function test_OpenPoolNeedsUsdc() public {
        vm.warp(launch + 7 days);
        vm.expectRevert(Buyback.NothingToSeed.selector);
        bb.openPool();
    }

    function test_OpenPoolSeedsAndLocks() public {
        _open(6300e6);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rHlo, uint256 rUsdc) = bb.hloIsToken0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        assertEq(rHlo, 10_000e18);
        assertEq(rUsdc, 6300e6);
        assertTrue(bb.poolOpen());
        assertTrue(hlo.pairOpen());
        assertGt(bb.liquidity(), 0);
        assertEq(pair.balanceOf(address(bb)), bb.liquidity());
        assertEq(usdc.balanceOf(address(bb)), 0);
        vm.expectRevert(Buyback.PoolAlreadyOpen.selector);
        bb.openPool();
    }

    function test_BuyBeforeOpenReverts() public {
        vm.expectRevert(Buyback.PoolNotOpen.selector);
        bb.buy();
    }

    function test_BuySkippedUntilTwapWindowHasHistory() public {
        _open(1000e6);
        _fund(144e6);
        vm.warp(block.timestamp + 10 minutes);
        uint256 bought = bb.buy();
        assertEq(bought, 0);
        assertEq(usdc.balanceOf(address(bb)), 144e6);
    }

    function test_BuySpendsSliceBurns90Stakes10() public {
        _open(1000e6);
        _fund(144e6);
        assertEq(bb.slice(), 1e6);
        vm.warp(block.timestamp + 31 minutes);
        uint256 supplyBefore = hlo.totalSupply();
        uint256 bought = bb.buy();
        assertGt(bought, 0);
        assertEq(usdc.balanceOf(address(bb)), 143e6);
        uint256 burned = bought * 9_000 / 10_000;
        assertEq(hlo.totalSupply(), supplyBefore - burned);
        assertEq(bb.totalToStakers(), bought - burned);
        // stakers' share drips in over Staking.DRIP
        assertEq(staking.undripped(), bought - burned);
        assertEq(staking.pending(alice), 0);
        vm.warp(block.timestamp + staking.DRIP());
        assertEq(staking.pending(alice), bought - burned);
    }

    function test_BuyTooSoonReverts() public {
        _open(1000e6);
        _fund(144e6);
        vm.warp(block.timestamp + 31 minutes);
        bb.buy();
        vm.warp(block.timestamp + 9 minutes);
        vm.expectRevert(Buyback.TooSoon.selector);
        bb.buy();
    }

    function test_ManipulatedPriceIsSkipped() public {
        _open(1000e6);
        _fund(144e6);
        vm.warp(block.timestamp + 31 minutes);
        // attacker pushes the HLO price up ~20% right before the buy
        usdc.mint(address(pair), 100e6);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool a0 = bb.hloIsToken0();
        (uint256 rIn, uint256 rOut) = a0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        uint256 out = 100e6 * 997 * rOut / (rIn * 1000 + 100e6 * 997);
        (uint256 o0, uint256 o1) = a0 ? (out, uint256(0)) : (uint256(0), out);
        pair.swap(o0, o1, address(this), "");

        uint256 bought = bb.buy();
        assertEq(bought, 0);
        assertEq(usdc.balanceOf(address(bb)), 144e6);
    }

    function test_SliceZeroSpendsRemainder() public {
        _open(1000e6);
        _fund(100); // 100 units < 144 slices -> slice 0 -> spend all
        assertEq(bb.slice(), 0);
        vm.warp(block.timestamp + 31 minutes);
        bb.buy();
        assertEq(usdc.balanceOf(address(bb)), 0);
    }

    // ------------------------------------------------------------ fix round 1

    /// Pushes the HLO price up by swapping `usdcIn` USDC in; returns the HLO taken out.
    function _pump(uint256 usdcIn) internal returns (uint256 out) {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool a0 = bb.hloIsToken0();
        (uint256 rIn, uint256 rOut) = a0 ? (uint256(r1), uint256(r0)) : (uint256(r0), uint256(r1));
        usdc.mint(address(pair), usdcIn);
        out = usdcIn * 997 * rOut / (rIn * 1000 + usdcIn * 997);
        (uint256 o0, uint256 o1) = a0 ? (out, uint256(0)) : (uint256(0), out);
        pair.swap(o0, o1, address(this), "");
    }

    /// Sells `hloIn` HLO back into the pair for USDC (undoes _pump).
    function _dump(uint256 hloIn) internal {
        (uint112 r0, uint112 r1,) = pair.getReserves();
        bool a0 = bb.hloIsToken0();
        (uint256 rIn, uint256 rOut) = a0 ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        require(hlo.transfer(address(pair), hloIn));
        uint256 out = hloIn * 997 * rOut / (rIn * 1000 + hloIn * 997);
        (uint256 o0, uint256 o1) = a0 ? (uint256(0), out) : (out, uint256(0));
        pair.swap(o0, o1, address(this), "");
    }

    function test_SkipDoesNotConsumeInterval() public {
        _open(1000e6);
        _fund(144e6);
        vm.warp(block.timestamp + 31 minutes);
        uint256 taken = _pump(100e6);
        assertEq(bb.buy(), 0); // skipped by the guard
        assertEq(bb.lastBuy(), 0);
        _dump(taken); // spot back near the TWAP, same block
        uint256 bought = bb.buy(); // must not revert TooSoon
        assertGt(bought, 0);
        assertEq(bb.lastBuy(), block.timestamp);
    }

    function test_SkipSpamDoesNotFloodObservations() public {
        _open(1000e6);
        _fund(144e6);
        uint256 base = bb.obsCount();
        vm.warp(block.timestamp + 31 minutes);
        _pump(100e6);
        for (uint256 i; i < 5; ++i) {
            assertEq(bb.buy(), 0);
        }
        assertEq(bb.obsCount(), base + 1); // one write for all five calls
        vm.warp(block.timestamp + 9 minutes);
        for (uint256 i; i < 5; ++i) {
            bb.buy();
        }
        assertEq(bb.obsCount(), base + 1); // still inside BUY_INTERVAL of the last write
        vm.warp(block.timestamp + 2 minutes);
        bb.buy();
        assertEq(bb.obsCount(), base + 2);
    }

    function test_RefreshSliceCannotShrink() public {
        _open(1000e6);
        _fund(144e6);
        assertEq(bb.slice(), 1e6);
        vm.warp(block.timestamp + 31 minutes);
        assertGt(bb.buy(), 0);
        bb.refreshSlice();
        assertEq(bb.slice(), 1e6);
        usdc.mint(address(bb), 288e6); // bigger inflow grows it
        bb.refreshSlice();
        assertEq(bb.slice(), uint256(143e6 + 288e6) / 144);
    }

    // ------------------------------------------------------------ I2: fee safety margin

    /// A fresh token/pair/Buyback with the given assumed swap fee, pool open and
    /// one slice funded, ready to buy after the TWAP window.
    function _freshOpen(uint256 feeBps) internal returns (Buyback b) {
        HloToken t = new HloToken();
        MockERC20 u = new MockERC20("USDC", 6);
        MockV2Factory f = new MockV2Factory();
        Staking st = new Staking(address(t));
        uint256 start = block.timestamp;
        b = new Buyback(address(t), address(u), address(f), address(st), start, feeBps);
        t.setMinters(address(this), address(b), address(b.pair()));
        u.mint(address(b), 1000e6);
        vm.warp(start + 7 days);
        b.openPool();
        u.mint(address(b), 144e6);
        b.refreshSlice();
        vm.warp(block.timestamp + 31 minutes);
    }

    /// swapFeeBps set a little below the pair's real 30 bps fee must not brick buy().
    function test_UnderstatedFeeStillBuys() public {
        Buyback b = _freshOpen(25);
        assertGt(b.buy(), 0);
    }

    /// With the exact fee, a buy takes SAFETY_BPS less than the exact v2 output.
    function test_ExactFeeBuysSlightlyLess() public {
        _open(1000e6);
        _fund(144e6);
        vm.warp(block.timestamp + 31 minutes);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint256 rHlo, uint256 rUsdc) = bb.hloIsToken0() ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));
        uint256 inWithFee = 1e6 * 9_970;
        uint256 exact = inWithFee * rHlo / (rUsdc * 10_000 + inWithFee);
        uint256 bought = bb.buy();
        assertEq(bb.SAFETY_BPS(), 10);
        assertEq(bought, exact * (10_000 - 10) / 10_000);
        assertLt(bought, exact);
        // the HLO left behind stays in the pair (pool reserves), not in Buyback
        assertEq(hlo.balanceOf(address(bb)), 0);
    }
}

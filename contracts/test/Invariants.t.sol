// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {HloToken} from "../src/HloToken.sol";
import {Checkpoints} from "../src/Checkpoints.sol";
import {Mining} from "../src/Mining.sol";
import {Staking} from "../src/Staking.sol";
import {Buyback} from "../src/Buyback.sol";
import {Splitter} from "../src/Splitter.sol";
import {IUniswapV2Pair} from "../src/interfaces/IUniswapV2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockV2Factory} from "./mocks/MockV2.sol";
import {MerkleHelper} from "./utils/MerkleHelper.sol";

contract Handler is Test {
    Deploy.Deployed public d;
    MockERC20 public usdc;
    uint256 internal posterKey;
    uint256[3] internal pks = [uint256(0xA1), uint256(0xA2), uint256(0xA3)];
    address[3] public actors;

    uint256[3] public ent; // current cumulative entitlement per actor (always a multiple of 10 wei)
    mapping(uint256 => uint256[3]) public entAt; // settled minute -> entitlements
    /// Independent of Mining: what each actor has claimed according to the handler's own settles.
    uint256[3] public ghostClaimed;
    uint256 public ghostGross;
    uint256 public ghostPaid;
    uint256 public claimCount; // claims that paid something (each may be partial)
    uint256 public partialClaims; // claims the allowance cut short
    uint256 public lastTotal; // totalEntitled of the latest checkpoint the handler settled
    uint256 public seenMinute; // latestMinute as last observed here; it may only grow
    bool public anySettled;
    uint256 public ghostActorBurned; // HLO burned by actors directly (Buyback's burns are counted by Buyback)
    uint256 public buys; // buy() calls that executed (returned > 0)
    uint256 public ghostRewardsClaimed; // sum of Staking.claim() return values
    uint256 public unstakes; // unstake calls that did work
    uint256 public stakeClaimsPaid; // Staking.claim() calls that paid > 0

    // Recovery (Plan 7). The guardian and the pauser act; a "bad" checkpoint inflates actor 0 (a leaked poster key).
    address internal guardian;
    address internal pauser;
    uint256[] internal settledMinutes;
    mapping(uint256 => bool) public isBad; // settled minute -> signed by the "leaked" key with an inflated actor 0
    uint256[3] public maxEntEver; // largest entitlement of each actor in any settled tree, cancelled or not
    uint256 public maxSettledTotal; // largest totalEntitled ever settled, cancelled or not
    uint256 public ghostWrittenOff;
    uint256 public cancels; // cancelAfter / cancelAll calls that cancelled something
    uint256 public cancelledClaimAttempts; // claims tried against a cancelled minute (each must revert)
    bool public cancelledClaimSucceeded; // set if one ever went through
    uint256 public blockedClaims; // claims skipped because the overall bound (plus write-off) would refuse them

    constructor(Deploy.Deployed memory d_, MockERC20 usdc_, uint256 posterKey_, address guardian_, address pauser_) {
        d = d_;
        usdc = usdc_;
        posterKey = posterKey_;
        guardian = guardian_;
        pauser = pauser_;
        for (uint256 i; i < 3; ++i) {
            actors[i] = vm.addr(pks[i]);
            vm.prank(actors[i]);
            HloToken(d.token).approve(d.staking, type(uint256).max);
        }
        usdc.approve(d.splitter, type(uint256).max);
    }

    function _leaves(uint256[3] memory e) internal view returns (bytes32[] memory l) {
        l = new bytes32[](3);
        for (uint256 i; i < 3; ++i) l[i] = MerkleHelper.leaf(actors[i], e[i]);
    }

    /// Mostly a few minutes ahead, often days ahead: enough emission for a claim to exceed the allowance.
    function _jump(uint256 seed) internal pure returns (uint256) {
        return seed % 30 + ((seed / 30) % 3 == 0 ? (seed / 90) % 30_000 : 0);
    }

    /// Settles a checkpoint for a minute a few ahead of the latest one. Entitlements only grow, in multiples of
    /// 10 wei, with a total inside what the schedule allows plus the refining so far.
    function settle(uint256 mSeed, uint256 aSeed, uint256 bSeed) external {
        Checkpoints c = Checkpoints(d.checkpoints);
        if (c.paused()) return;
        // An honest checkpoint after an unrecovered bad one could total less (EntitlementDecreased): recover first.
        if (c.anyValid() && isBad[c.latestValidMinute()]) return;
        uint256 m = c.anySettled() ? c.latestMinute() + 1 + _jump(mSeed) : _jump(mSeed);
        uint256 end = c.launchTime() + 60 * (m + 1);
        if (block.timestamp < end) vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
        uint256 total = ent[0] + ent[1] + ent[2];
        uint256 cap = c.emissionAllowedThrough(m) + Mining(d.mining).totalRefined();
        uint256 room = cap > total ? cap - total : 0;
        uint256[3] memory seeds = [aSeed, bSeed, uint256(keccak256(abi.encode(aSeed, bSeed)))];
        // forge-lint: disable-next-line(divide-before-multiply)
        for (uint256 i; i < 3; ++i) ent[i] += (bound(seeds[i], 0, room / 3) / 10) * 10;
        _settleTree(m, ent);
    }

    function _settleTree(uint256 m, uint256[3] memory e) internal {
        Checkpoints c = Checkpoints(d.checkpoints);
        (bytes32 root,) = MerkleHelper.rootAndProof(_leaves(e), 0);
        Checkpoints.Checkpoint memory cp = Checkpoints.Checkpoint(m, block.number - 1, root, e[0] + e[1] + e[2]);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(posterKey, c.hashCheckpoint(cp));
        c.settle(cp, abi.encodePacked(r, s, v));
        entAt[m] = e;
        settledMinutes.push(m);
        lastTotal = cp.totalEntitled;
        if (cp.totalEntitled > maxSettledTotal) maxSettledTotal = cp.totalEntitled;
        for (uint256 i; i < 3; ++i) {
            if (e[i] > maxEntEver[i]) maxEntEver[i] = e[i];
        }
        uint256 latest = c.latestMinute();
        if (latest > seenMinute) seenMinute = latest;
        anySettled = true;
    }

    /// A leaked poster key settles a checkpoint that gives actor 0 more than its honest entitlement, taken from the
    /// schedule's room (actors 1 and 2 keep their honest amounts). The honest `ent` does not change.
    function settleBad(uint256 mSeed, uint256 extraSeed) external {
        Checkpoints c = Checkpoints(d.checkpoints);
        if (c.paused()) return;
        uint256 m = c.anySettled() ? c.latestMinute() + 1 + _jump(mSeed) : _jump(mSeed);
        uint256 end = c.launchTime() + 60 * (m + 1);
        if (block.timestamp < end) vm.warp(end);
        vm.roll(vm.getBlockNumber() + 1);
        uint256[3] memory e = ent;
        // never below the newest live tree's actor 0, so the total never decreases (actors 1 and 2 only grow)
        if (c.anyValid() && entAt[c.latestValidMinute()][0] > e[0]) e[0] = entAt[c.latestValidMinute()][0];
        uint256 cap = c.emissionAllowedThrough(m) + Mining(d.mining).totalRefined();
        uint256 total = e[0] + e[1] + e[2];
        if (total >= cap) return;
        // forge-lint: disable-next-line(divide-before-multiply)
        e[0] += (bound(extraSeed, 1, cap - total) / 10) * 10;
        if (c.anyValid() && e[0] + e[1] + e[2] < c.totalEntitledOf(c.latestValidMinute())) return;
        _settleTree(m, e);
        isBad[m] = true;
    }

    /// Moves time forward so the claim allowance refills (and the weekly schedule moves on).
    function wait(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 6 hours));
    }

    /// An actor claims against the latest settled checkpoint, if it has anything new. The claim is paid in part when
    /// the global allowance is smaller than what is owed; with an empty allowance it is skipped.
    function claim(uint256 who) external {
        Checkpoints c = Checkpoints(d.checkpoints);
        if (!c.anyValid() || c.paused()) return;
        uint256 i = bound(who, 0, 2);
        uint256 m = c.latestValidMinute();
        uint256[3] memory e = entAt[m];
        if (e[i] <= ghostClaimed[i]) return;
        (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(e), i);
        uint256 owed = e[i] - ghostClaimed[i];
        uint256 avail = Mining(d.mining).claimAvailable();
        if (avail == 0) return;
        uint256 gross = owed < avail ? owed : avail;
        {
            // After a bad claim the overall bound can refuse honest claims until the guardian writes the loss off.
            Mining mn = Mining(d.mining);
            uint256 b = mn.maxEntitledBound();
            uint256 t = c.totalEntitledOf(m);
            if (t > b) b = t;
            if (mn.totalClaimedGross() + gross > b + c.writtenOff()) {
                ++blockedClaims;
                return;
            }
        }
        if (gross < owed) ++partialClaims;
        ghostClaimed[i] += gross;
        vm.prank(actors[i]);
        Mining(d.mining).claim(m, e[i], proof);
        ghostGross += gross;
        ghostPaid += gross * 9 / 10;
        ++claimCount;
    }

    /// Someone tries to claim against a cancelled minute with that tree's valid proof. It must always revert.
    function claimCancelled(uint256 who, uint256 idxSeed) external {
        Checkpoints c = Checkpoints(d.checkpoints);
        if (c.cancelledCount() == 0) return;
        uint256 n = settledMinutes.length;
        uint256 start = bound(idxSeed, 0, n - 1);
        for (uint256 k; k < n; ++k) {
            uint256 m = settledMinutes[(start + k) % n];
            if (!c.isCancelled(m)) continue;
            uint256 i = bound(who, 0, 2);
            uint256[3] memory e = entAt[m];
            (, bytes32[] memory proof) = MerkleHelper.rootAndProof(_leaves(e), i);
            ++cancelledClaimAttempts;
            vm.prank(actors[i]);
            try Mining(d.mining).claim(m, e[i], proof) {
                cancelledClaimSucceeded = true;
            } catch {}
            return;
        }
    }

    /// The pauser (the verifier) or the guardian pauses.
    function pause(bool byGuardian) external {
        vm.prank(byGuardian ? guardian : pauser);
        Checkpoints(d.checkpoints).pause();
    }

    function unpause() external {
        vm.prank(guardian);
        Checkpoints(d.checkpoints).setPaused(false);
    }

    function _pauseIfNeeded() internal {
        if (Checkpoints(d.checkpoints).paused()) return;
        vm.prank(guardian);
        Checkpoints(d.checkpoints).pause();
    }

    /// The guardian (paused first if needed) keeps a settled, live minute and cancels every settled minute after it.
    function cancelAfter(uint256 idxSeed) external {
        Checkpoints c = Checkpoints(d.checkpoints);
        uint256 n = settledMinutes.length;
        if (n == 0 || !c.anyValid()) return;
        uint256 start = bound(idxSeed, 0, n - 1);
        for (uint256 k; k < n; ++k) {
            uint256 keep = settledMinutes[(start + k) % n];
            if (!c.isSettled(keep) || keep >= c.latestMinute() || keep > c.latestValidMinute()) continue;
            if (keep == c.latestValidMinute() && c.isCancelled(c.latestMinute())) continue;
            _pauseIfNeeded();
            vm.prank(guardian);
            c.cancelAfter(keep);
            ++cancels;
            return;
        }
    }

    function cancelAll() external {
        Checkpoints c = Checkpoints(d.checkpoints);
        if (!c.anyValid()) return;
        _pauseIfNeeded();
        vm.prank(guardian);
        c.cancelAll();
        ++cancels;
    }

    function writeOff(uint256 amount) external {
        amount = bound(amount, 1, 1_000e18);
        _pauseIfNeeded();
        vm.prank(guardian);
        Checkpoints(d.checkpoints).writeOff(amount);
        ghostWrittenOff += amount;
    }

    /// An actor burns part of its balance, which frees supply room for the schedule.
    function burn(uint256 who, uint256 amt) external {
        uint256 i = bound(who, 0, 2);
        uint256 bal = HloToken(d.token).balanceOf(actors[i]);
        if (bal == 0) return;
        amt = bound(amt, 1, bal);
        vm.prank(actors[i]);
        HloToken(d.token).burn(amt);
        ghostActorBurned += amt;
    }

    function depositFees(uint256 amount) external {
        amount = bound(amount, 1, 10_000e6);
        usdc.mint(address(this), amount);
        Splitter(d.splitter).deposit(amount);
    }

    function openPool() external {
        Buyback b = Buyback(d.buyback);
        if (b.poolOpen()) return;
        if (block.timestamp < b.launchTime() + 7 days) vm.warp(b.launchTime() + 7 days);
        if (usdc.balanceOf(d.buyback) == 0) return;
        b.openPool();
    }

    function buy() external {
        Buyback b = Buyback(d.buyback);
        if (!b.poolOpen()) return;
        vm.warp(block.timestamp + 11 minutes);
        if (b.buy() > 0) ++buys;
    }

    function stake(uint256 who, uint256 amount) external {
        uint256 i = bound(who, 0, 2);
        uint256 bal = HloToken(d.token).balanceOf(actors[i]);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(actors[i]);
        Staking(d.staking).stake(amount);
    }

    function unstake(uint256 who, uint256 amount) external {
        uint256 i = bound(who, 0, 2);
        uint256 st = Staking(d.staking).staked(actors[i]);
        if (st == 0) return;
        amount = bound(amount, 1, st);
        vm.prank(actors[i]);
        Staking(d.staking).unstake(amount);
        ++unstakes;
    }

    function claimStake(uint256 who) external {
        uint256 i = bound(who, 0, 2);
        vm.prank(actors[i]);
        uint256 paid = Staking(d.staking).claim();
        ghostRewardsClaimed += paid;
        if (paid > 0) ++stakeClaimsPaid;
    }
}

/// forge-config: default.invariant.fail-on-revert = true
contract InvariantsTest is Test {
    uint256 constant POSTER_PK = 0x9057E4;
    Handler h;
    Deploy.Deployed d;

    function setUp() public {
        vm.warp(1_800_000_000);
        vm.roll(1000);
        MockERC20 usdc = new MockERC20("USDC", 6);
        MockV2Factory factory = new MockV2Factory();
        d = new Deploy()
            .deploy(
                address(usdc),
                address(factory),
                30,
                Deploy.Roles(vm.addr(POSTER_PK), address(this), address(0x9A), address(0xAD)),
                1 hours,
                5000 ether,
                330 ether
            );
        h = new Handler(d, usdc, POSTER_PK, address(this), address(0x9A));
        targetContract(address(h));
    }

    function invariant_SupplyNeverAboveCap() public view {
        assertLe(HloToken(d.token).totalSupply(), 5_000_000e18);
    }

    function invariant_SupplyEqualsMintedMinusBurned() public view {
        HloToken t = HloToken(d.token);
        uint256 pool = Buyback(d.buyback).poolOpen() ? 10_000e18 : 0;
        assertEq(t.totalSupply(), Mining(d.mining).totalPaid() + pool - t.totalBurned());
    }

    function invariant_ClaimsSplitExactly() public view {
        Mining m = Mining(d.mining);
        assertEq(m.totalPaid() + m.totalRefined(), h.ghostGross());
        assertEq(m.totalClaimedGross(), h.ghostGross());
        assertEq(m.totalPaid(), h.ghostPaid());
        assertEq(m.totalRefined(), h.ghostGross() - h.ghostPaid());
        assertGe(m.totalRefined() * 10, h.ghostGross());
        assertLe(m.totalClaimedGross(), m.maxEntitledBound() + Checkpoints(d.checkpoints).writtenOff());
        Checkpoints c = Checkpoints(d.checkpoints);
        // The latest minute may be cancelled (it then reads as zero), so the bound is checked against the largest
        // total ever settled rather than the latest minute's.
        assertLe(m.maxEntitledBound(), h.maxSettledTotal());
        assertEq(c.totalEntitledOf(c.latestMinute()), c.isCancelled(c.latestMinute()) ? 0 : h.lastTotal());
        assertEq(c.writtenOff(), h.ghostWrittenOff());
    }

    /// Spec §7: no claim ever succeeds against a cancelled root.
    function invariant_NoClaimAgainstACancelledRoot() public view {
        assertFalse(h.cancelledClaimSucceeded());
    }

    /// Spec §7: paid (and the gross behind it) ≤ the schedule through the latest settled minute, plus the refining
    /// checkpoints may re-share, plus the guardian's write-off.
    function invariant_PaidWithinScheduleAndWriteOff() public view {
        Checkpoints c = Checkpoints(d.checkpoints);
        Mining m = Mining(d.mining);
        uint256 schedule = c.anySettled() ? c.emissionAllowedThrough(c.latestMinute()) + m.totalRefined() : 0;
        assertLe(m.totalClaimedGross(), schedule + c.writtenOff());
        assertLe(m.totalPaid(), schedule + c.writtenOff());
    }

    function invariant_LatestValidNeverAboveLatest() public view {
        Checkpoints c = Checkpoints(d.checkpoints);
        if (c.anyValid()) assertLe(c.latestValidMinute(), c.latestMinute());
        assertLe(c.cancelledCount(), h.cancels());
    }

    /// 90% paid, rounded down per claim: a partial claim's gross need not be a multiple of 10 wei, so each claim
    /// is at most 9/10 wei short.
    function invariant_PaidIsNinetyPercentRoundedDown() public view {
        Mining m = Mining(d.mining);
        assertLe(m.totalPaid() * 10, m.totalClaimedGross() * 9);
        assertLe(m.totalClaimedGross() * 9 - m.totalPaid() * 10, 9 * h.claimCount());
    }

    /// The allowance never exceeds its cap, and the bucket only ever holds what the cap allows.
    function invariant_ClaimAllowanceWithinCap() public view {
        Mining m = Mining(d.mining);
        assertLe(m.claimAvailable(), m.CLAIM_CAP());
        assertLe(m.claimBucket(), m.CLAIM_CAP());
    }

    /// Nobody has claimed more than their largest entitlement in any settled tree. (The latest minute's tree is not
    /// the reference any more: it may be cancelled, and actor 0 may have claimed against a bad tree that was.) The
    /// honest actors 1 and 2 never claim beyond their honest entitlement.
    function invariant_ClaimedNeverAboveOwnEntitlement() public view {
        for (uint256 i; i < 3; ++i) {
            assertLe(Mining(d.mining).claimed(h.actors(i)), h.maxEntEver(i));
        }
        assertLe(Mining(d.mining).claimed(h.actors(1)), h.ent(1));
        assertLe(Mining(d.mining).claimed(h.actors(2)), h.ent(2));
    }

    function invariant_LatestMinuteNeverDecreases() public view {
        assertGe(Checkpoints(d.checkpoints).latestMinute(), h.seenMinute());
    }

    function invariant_ClaimedMatchesGhost() public view {
        for (uint256 i; i < 3; ++i) {
            assertEq(Mining(d.mining).claimed(h.actors(i)), h.ghostClaimed(i));
        }
    }

    /// The latest minute may be cancelled (its total reads as zero), so the sum of claims is checked against the
    /// largest total ever settled plus the write-off.
    function invariant_ClaimedNeverAboveLargestSettled() public view {
        uint256 claimedSum;
        for (uint256 i; i < 3; ++i) claimedSum += Mining(d.mining).claimed(h.actors(i));
        assertEq(claimedSum, Mining(d.mining).totalClaimedGross());
        assertLe(claimedSum, h.maxSettledTotal() + Checkpoints(d.checkpoints).writtenOff());
    }

    function invariant_SplitterHoldsOnlyAdminBalance() public view {
        assertEq(h.usdc().balanceOf(d.splitter), Splitter(d.splitter).adminBalance());
    }

    function invariant_PoolTokensNeverMove() public view {
        Buyback b = Buyback(d.buyback);
        assertEq(IUniswapV2Pair(d.pair).balanceOf(d.buyback), b.liquidity());
    }

    function invariant_StakingSolvent() public view {
        Staking s = Staking(d.staking);
        assertEq(HloToken(d.token).balanceOf(d.staking), s.totalStaked() + s.rewardBalance());
        assertGe(s.rewardBalance(), s.undripped());
    }

    function invariant_BuybackSplit90_10() public view {
        Buyback b = Buyback(d.buyback);
        assertEq(b.totalBurned() + b.totalToStakers(), b.totalBought());
        // each buy burns floor(bought * 9000 / 10000): at most 1 wei short of exactly 90%
        assertGe(b.totalBurned() * 10_000 + h.buys() * 10_000, b.totalBought() * 9_000);
        assertLe(b.totalBurned() * 10_000, b.totalBought() * 9_000);
        // the token's burns are Buyback's plus what actors burned themselves
        assertEq(HloToken(d.token).totalBurned(), b.totalBurned() + h.ghostActorBurned());
        // every HLO sent to stakers is either still reward balance or was claimed
        assertEq(Staking(d.staking).rewardBalance() + h.ghostRewardsClaimed(), b.totalToStakers());
    }
}
